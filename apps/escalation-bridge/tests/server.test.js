const IPARAMS = {
  source_domain: 'yora.freshservice.com',
  target_domain: 'fwd.freshservice.com',
  requester_email: 'bridge@example.com',
  escalate_priority: '4',
  target_group_id: '30000423396',
  target_custom_fields: '{"msf_multi_agent_groups":[4]}',
  webhook_token: 'tok'
};

function fakePlatform() {
  const store = new Map();
  const target = { tickets: new Map(), nextId: 70 };
  const source = { tickets: new Map(), notes: [] };
  const failNext = {};

  const respond = (status, body) => {
    if (status >= 400) return Promise.reject({ status, response: JSON.stringify(body) });
    return Promise.resolve({ status, response: JSON.stringify(body) });
  };

  const $request = {
    invokeTemplate: vi.fn((name, { context = {}, body } = {}) => {
      if (failNext[name]) {
        const status = failNext[name];
        delete failNext[name];
        return respond(status, { description: 'Validation failed' });
      }
      const payload = body ? JSON.parse(body) : {};
      switch (name) {
        case 'targetCreateTicket': {
          const ticket = { ...payload, id: target.nextId++ };
          if (target.matrixPriority) ticket.priority = target.matrixPriority;
          target.tickets.set(ticket.id, ticket);
          return respond(201, { ticket });
        }
        case 'targetUpdateTicket':
          Object.assign(target.tickets.get(context.id), payload);
          return respond(200, { ticket: target.tickets.get(context.id) });
        case 'targetGetTicket':
          return respond(200, { ticket: target.tickets.get(context.id) });
        case 'sourceUpdateTicket':
          Object.assign(source.tickets.get(context.id), payload);
          return respond(200, { ticket: source.tickets.get(context.id) });
        case 'sourceAddNote':
          source.notes.push({ id: context.id, ...payload });
          return respond(201, { conversation: payload });
        default:
          return respond(404, {});
      }
    })
  };

  const $db = {
    get: vi.fn((key) => (store.has(key) ? Promise.resolve(store.get(key)) : Promise.reject({ status: 404 }))),
    set: vi.fn((key, value, options) => {
      if (options && options.setIf === 'not_exist' && store.has(key)) return Promise.reject({ status: 400 });
      store.set(key, value);
      return Promise.resolve({ Created: true });
    }),
    delete: vi.fn((key) => {
      store.delete(key);
      return Promise.resolve({ Deleted: true });
    })
  };

  return { store, target, source, failNext, $request, $db };
}

let platform;
let server;

beforeEach(() => {
  platform = fakePlatform();
  global.$request = platform.$request;
  global.$db = platform.$db;
  global.renderData = vi.fn();
  global.generateTargetUrl = vi.fn(() => Promise.resolve('https://hooks.example/abc'));
  server = require('../server/server.js');
});

function yoraTicket(fields) {
  const ticket = { id: 20300, subject: 'VPN down', description: '<p>All users</p>', priority: 4, urgency: 3, impact: 3, status: 2, tags: [], ...fields };
  platform.source.tickets.set(ticket.id, ticket);
  return ticket;
}

const create = (ticket) => server.onTicketCreateHandler({ data: { ticket }, iparams: IPARAMS });
const update = (ticket) => server.onTicketUpdateHandler({ data: { ticket }, iparams: IPARAMS });
const webhook = (ticketId, token = 'tok') =>
  server.onExternalEventHandler({ data: { ticket_id: ticketId }, headers: { 'X-Bridge-Token': token }, iparams: IPARAMS });

describe('escalation (source -> target)', () => {
  test('urgent ticket is escalated with routing, matrix fields and a back-link note', async () => {
    const result = await create(yoraTicket());

    expect(result).toEqual({ action: 'escalated', source_id: 20300, target_id: 70 });
    const created = platform.target.tickets.get(70);
    expect(created.subject).toBe('[yora #20300] VPN down');
    expect(created).toMatchObject({ priority: 4, urgency: 3, impact: 3, status: 2, email: 'bridge@example.com', group_id: 30000423396 });
    expect(created.custom_fields).toEqual({ msf_multi_agent_groups: [4] });
    expect(created.description).toContain('https://yora.freshservice.com/a/tickets/20300');
    expect(platform.source.notes[0]).toMatchObject({ id: 20300, private: true });
    expect(platform.source.notes[0].body).toContain('/a/tickets/70');
  });

  test('priority recomputed by the target matrix is corrected to the source priority', async () => {
    platform.target.matrixPriority = 2;
    await create(yoraTicket({ urgency: 1, impact: 3 }));
    expect(platform.target.tickets.get(70).priority).toBe(4);
    const updates = platform.$request.invokeTemplate.mock.calls.filter(([name]) => name === 'targetUpdateTicket');
    expect(updates).toHaveLength(1);
  });

  test('no extra update when the target keeps the priority', async () => {
    await create(yoraTicket());
    expect(platform.$request.invokeTemplate.mock.calls.some(([name]) => name === 'targetUpdateTicket')).toBe(false);
  });

  test('escalate tag triggers regardless of priority (string or object tags)', async () => {
    expect((await create(yoraTicket({ priority: 1, tags: ['escalate'] }))).action).toBe('escalated');
    expect((await create(yoraTicket({ id: 20301, priority: 1, tags: [{ name: 'escalate' }] }))).action).toBe('escalated');
  });

  test('non-urgent ticket is ignored', async () => {
    expect(await create(yoraTicket({ priority: 2 }))).toEqual({ action: 'ignored', reason: 'does not match escalation rule', threshold: 4 });
    expect(platform.target.tickets.size).toBe(0);
  });

  test('ticket raised low then updated to urgent is escalated once', async () => {
    const ticket = yoraTicket({ priority: 1 });
    await create(ticket);
    expect((await update({ ...ticket, priority: 4 })).action).toBe('escalated');
    expect((await update({ ...ticket, priority: 4 })).reason).toBe('already escalated');
    expect(platform.target.tickets.size).toBe(1);
  });

  test('concurrent claim loses cleanly', async () => {
    const ticket = yoraTicket();
    platform.$db.get.mockImplementationOnce(() => Promise.reject({ status: 404 }));
    platform.store.set('src:20300', { target_id: null, last_status: 0 });
    expect(await create(ticket)).toEqual({ action: 'ignored', reason: 'already escalated' });
  });

  test('target rejection is reported and the claim released so a retry works', async () => {
    const ticket = yoraTicket();
    platform.failNext.targetCreateTicket = 400;

    const failed = await create(ticket);

    expect(failed.action).toBe('failed');
    expect(failed.error).toContain('targetCreateTicket failed: HTTP 400');
    expect(platform.store.has('src:20300')).toBe(false);
    expect((await update(ticket)).action).toBe('escalated');
  });

  test('uses default priority threshold and skips optional routing when not configured', async () => {
    const minimal = { ...IPARAMS, escalate_priority: '', target_group_id: '', target_custom_fields: '' };
    const ticket = yoraTicket({ urgency: null, impact: null });
    await server.onTicketCreateHandler({ data: { ticket }, iparams: minimal });
    const created = platform.target.tickets.get(70);
    expect(created.group_id).toBeUndefined();
    expect(created.custom_fields).toBeUndefined();
    expect(created.urgency).toBeUndefined();
  });
});

describe('decision record (for the sidebar)', () => {
  test('stores what the app saw and decided, keyed by ticket number', async () => {
    await create(yoraTicket({ priority: 2 }));
    expect(platform.store.get('seen:20300')).toMatchObject({
      event: 'onTicketCreate',
      raw_id: 20300,
      raw_display_id: null,
      raw_priority: '2',
      action: 'ignored',
      threshold: 4
    });
  });

  test('uses display_id when the event carries an internal id', async () => {
    platform.source.tickets.set(20301, { id: 20301 });
    const result = await create({ id: 30001234567, display_id: 20301, subject: 's', priority: 4, status: 2 });
    expect(result).toMatchObject({ action: 'escalated', source_id: 20301 });
    expect(platform.target.tickets.get(70).subject).toBe('[yora #20301] s');
    expect(platform.store.get('seen:20301')).toMatchObject({ raw_id: 30001234567, raw_display_id: 20301, action: 'escalated' });
  });

  test('a failed decision write does not change the result', async () => {
    const ticket = yoraTicket({ priority: 2 });
    platform.$db.set.mockImplementationOnce(() => Promise.reject({ message: 'quota' }));
    expect((await create(ticket)).action).toBe('ignored');
  });
});

describe('status sync (target -> source via external event)', () => {
  async function escalated() {
    const ticket = yoraTicket();
    await create(ticket);
    return platform.target.tickets.get(70);
  }

  test('resolved target resolves the source with its resolution note', async () => {
    const copy = await escalated();
    Object.assign(copy, { status: 4, resolution_notes: 'VPN restored' });

    expect(await webhook('INC-70')).toEqual({ action: 'synced', source_id: 20300, target_id: 70, status: 4 });
    expect(platform.source.tickets.get(20300)).toMatchObject({ status: 4, resolution_notes: 'VPN restored' });
    expect(platform.source.notes.at(-1).body).toBe('fwd.freshservice.com #70 is now Resolved.');
  });

  test('default resolution note when the target has none; pending needs none', async () => {
    const copy = await escalated();
    copy.status = 3;
    await webhook(70);
    expect(platform.source.tickets.get(20300).resolution_notes).toBeUndefined();
    copy.status = 5;
    await webhook(70);
    expect(platform.source.tickets.get(20300).resolution_notes).toBe('Resolved in fwd.freshservice.com #70.');
  });

  test('echo events are no-ops (loop guard)', async () => {
    const copy = await escalated();
    expect(await webhook(70)).toEqual({ action: 'ignored', reason: 'status unchanged' });

    copy.status = 4;
    await webhook(70);
    const notes = platform.source.notes.length;
    expect((await update(platform.source.tickets.get(20300))).reason).toBe('already escalated');
    expect((await webhook(70)).reason).toBe('status unchanged');
    expect(platform.source.notes.length).toBe(notes);
    expect(platform.target.tickets.size).toBe(1);
  });

  test('unknown target ticket, bad token and bad id are rejected', async () => {
    expect((await webhook(999)).reason).toBe('not a bridged ticket');
    expect((await webhook(70, 'wrong')).action).toBe('rejected');
    expect((await server.onExternalEventHandler({ data: { ticket_id: '{{ticket.id}}' }, headers: { 'x-bridge-token': 'tok' }, iparams: IPARAMS })).reason).toBe('unparseable ticket_id');
    expect((await server.onExternalEventHandler({ iparams: IPARAMS })).action).toBe('rejected');
  });

  test('unexpected storage errors are reported, not thrown', async () => {
    platform.$db.get.mockImplementationOnce(() => Promise.reject({ status: 500, message: 'db down' }));
    expect(await webhook(70)).toEqual({ action: 'failed', error: 'db down' });
  });

  test('non-JSON upstream errors keep their message', async () => {
    platform.$request.invokeTemplate.mockImplementationOnce(() => Promise.reject({ status: 504, message: 'Timeout error' }));
    const result = await create(yoraTicket());
    expect(result.error).toBe('targetCreateTicket failed: HTTP 504: Timeout error');
  });
});

describe('install', () => {
  test('stores the generated webhook URL and completes install', async () => {
    await server.onAppInstallHandler({});
    expect(platform.store.get('webhook_url')).toEqual({ url: 'https://hooks.example/abc' });
    expect(global.renderData).toHaveBeenCalledWith();
  });

  test('install still completes if the URL cannot be generated', async () => {
    global.generateTargetUrl = vi.fn(() => Promise.reject(new Error('nope')));
    await server.onAppInstallHandler({});
    expect(global.renderData).toHaveBeenCalledWith();
  });
});
