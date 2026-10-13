const IPARAMS = {
  fs_domain: 'yora.freshservice.com',
  zd_domain: 'acme.zendesk.com',
  requester_email: 'support@example.com',
  it_group_id: '42',
  webhook_token: 'tok'
};

function fakePlatform() {
  const store = new Map();
  const zd = { tickets: new Map(), orgs: [{ id: 9, name: 'Contoso <Ltd>' }], updates: [], refuseSolve: false };
  const fs = { tickets: new Map(), nextId: 500, matrixPriority: null, calls: [] };
  const failNext = {};
  const ok = (body) => Promise.resolve({ status: 200, response: JSON.stringify(body) });
  const fail = (status, body) => Promise.reject({ status, response: JSON.stringify(body) });

  const $request = {
    invokeTemplate: vi.fn((name, { context = {}, body } = {}) => {
      fs.calls.push(name);
      if (failNext[name]) {
        const status = failNext[name];
        delete failNext[name];
        return fail(status, { error: 'boom' });
      }
      const payload = body ? JSON.parse(body) : {};
      switch (name) {
        case 'zdGetTicket':
          return ok({ ticket: zd.tickets.get(context.id), organizations: zd.orgs });
        case 'zdUpdateTicket':
          if (payload.ticket.status === 'solved' && zd.refuseSolve) return fail(422, { error: 'RecordInvalid', details: { assignee: ['is required'] } });
          zd.updates.push({ id: context.id, ...payload.ticket });
          return ok({ ticket: {} });
        case 'fsCreateTicket': {
          const ticket = { ...payload, id: fs.nextId++ };
          if (fs.matrixPriority) ticket.priority = fs.matrixPriority;
          fs.tickets.set(ticket.id, ticket);
          return ok({ ticket });
        }
        case 'fsSetPriority':
          Object.assign(fs.tickets.get(context.id), payload);
          return ok({ ticket: fs.tickets.get(context.id) });
        case 'fsGetTicket':
          return ok({ ticket: fs.tickets.get(context.id) });
        default:
          return fail(404, {});
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
  return { store, zd, fs, failNext, $request, $db };
}

let platform;
let server;

beforeEach(() => {
  platform = fakePlatform();
  Object.assign(global, { $request: platform.$request, $db: platform.$db, renderData: vi.fn() });
  global.generateTargetUrl = vi.fn(() => Promise.resolve('https://hooks.example/zd'));
  server = require('../server/server.js');
});

function zendeskTicket(id, fields = {}) {
  platform.zd.tickets.set(id, { id, subject: 'Checkout page down', description: 'Customers see 502.\nSince 09:10.', priority: 'urgent', organization_id: 9, ...fields });
}
const webhook = (ticketId, token = 'tok') =>
  server.onExternalEventHandler({ data: { ticket_id: ticketId }, headers: { 'X-Bridge-Token': token }, iparams: IPARAMS });
const statusChange = (fsId, from, to, extra = {}) =>
  server.onTicketUpdateHandler({ data: { ticket: { id: fsId, status: to, ...extra }, changes: { status: [from, to] } }, iparams: IPARAMS });

describe('Zendesk → Freshservice', () => {
  test('a tagged Zendesk ticket becomes an IT incident with context and a note back', async () => {
    zendeskTicket(321);
    expect(await webhook('321')).toEqual({ action: 'escalated', zendesk_id: 321, freshservice_id: 500 });

    const incident = platform.fs.tickets.get(500);
    expect(incident).toMatchObject({ subject: '[Zendesk #321] Checkout page down', email: 'support@example.com', priority: 4, status: 2, group_id: 42, tags: ['zendesk'] });
    expect(incident.description).toContain('https://acme.zendesk.com/agent/tickets/321');
    expect(incident.description).toContain('customer <b>Contoso &lt;Ltd&gt;</b>');
    expect(incident.description).toContain('Customers see 502.<br>Since 09:10.');
    expect(platform.zd.updates[0]).toEqual({
      id: 321,
      comment: { body: 'Escalated to IT as Freshservice #500: https://yora.freshservice.com/a/tickets/500', public: false },
      additional_tags: ['it_escalated']
    });
    expect(platform.store.get('fs:500')).toEqual({ zd_id: 321 });
  });

  test('priority recomputed by a priority matrix is set back explicitly', async () => {
    zendeskTicket(322, { priority: 'high' });
    platform.fs.matrixPriority = 1;
    await webhook(322);
    expect(platform.fs.tickets.get(500).priority).toBe(3);
  });

  test('unknown priority defaults to Medium; no organization means no customer line; no group is fine', async () => {
    zendeskTicket(323, { priority: null, organization_id: null, description: '' });
    await server.onExternalEventHandler({ data: { ticket_id: 323 }, headers: { 'x-bridge-token': 'tok' }, iparams: { ...IPARAMS, it_group_id: '' } });
    const incident = platform.fs.tickets.get(500);
    expect(incident.priority).toBe(2);
    expect(incident.description).not.toContain('customer');
    expect(incident.group_id).toBeUndefined();
    expect(platform.fs.calls).not.toContain('fsSetPriority');
  });

  test('repeat and concurrent webhooks never create a second incident', async () => {
    zendeskTicket(324);
    await webhook(324);
    expect(await webhook(324)).toEqual({ action: 'ignored', reason: 'already escalated' });

    zendeskTicket(325);
    platform.$db.get.mockImplementationOnce(() => Promise.reject({ status: 404 }));
    platform.store.set('zd:325', { fs_id: null, last_status: 0 });
    expect(await webhook(325)).toEqual({ action: 'ignored', reason: 'already escalated' });
    expect(platform.fs.tickets.size).toBe(1);
  });

  test('a failed create releases the claim so the next webhook succeeds', async () => {
    zendeskTicket(326);
    platform.failNext.fsCreateTicket = 400;
    expect((await webhook(326)).error).toContain('fsCreateTicket failed: HTTP 400');
    expect(platform.store.has('zd:326')).toBe(false);
    expect((await webhook(326)).action).toBe('escalated');
  });

  test('webhooks without the token or a usable id are rejected', async () => {
    expect(await webhook(1, 'wrong')).toEqual({ action: 'rejected', reason: 'bad or missing X-Bridge-Token' });
    expect(await server.onExternalEventHandler({ data: {}, iparams: { ...IPARAMS, webhook_token: '' } })).toMatchObject({ action: 'rejected' });
    expect(await webhook('{{ticket.id}}')).toEqual({ action: 'rejected', reason: 'unparseable ticket_id' });
    expect(await server.onExternalEventHandler({ headers: { 'x-bridge-token': 'tok' }, iparams: IPARAMS })).toMatchObject({ reason: 'unparseable ticket_id' });
  });
});

describe('Freshservice → Zendesk', () => {
  async function escalated() {
    zendeskTicket(400);
    await webhook(400);
    platform.zd.updates.length = 0;
    return 500;
  }

  test('status changes post an internal note once', async () => {
    const fsId = await escalated();
    expect(await statusChange(fsId, 2, 3)).toEqual({ action: 'noted', zendesk_id: 400, freshservice_id: 500, status: 3 });
    expect(platform.zd.updates[0]).toEqual({ id: 400, comment: { body: 'IT status for Freshservice #500: Pending.', public: false } });
    expect(await statusChange(fsId, 3, 3)).toEqual({ action: 'ignored', reason: 'status unchanged' });
  });

  test('resolution is shared and the Zendesk ticket solved; nothing else from IT leaves Freshservice', async () => {
    const fsId = await escalated();
    platform.fs.tickets.get(fsId).resolution_notes = 'Restarted the payment gateway pool.';
    platform.fs.tickets.get(fsId).private_note_text = 'internal: root cause was our deploy';
    expect((await statusChange(fsId, 2, 4)).action).toBe('solved');
    const [update] = platform.zd.updates;
    expect(update).toMatchObject({ id: 400, status: 'solved', comment: { public: false } });
    expect(update.comment.body).toBe('IT resolved Freshservice #500.\n\nResolution: Restarted the payment gateway pool.');
    expect(JSON.stringify(update)).not.toContain('internal');
  });

  test('when Zendesk will not solve (no assignee), the resolution is still posted', async () => {
    const fsId = await escalated();
    platform.zd.refuseSolve = true;
    expect((await statusChange(fsId, 2, 5)).action).toBe('noted');
    expect(platform.zd.updates[0].comment.body).toContain('No resolution note was added.');
    expect(platform.zd.updates[0].comment.body).toContain('Could not set Solved automatically');
    expect(platform.zd.updates[0].status).toBeUndefined();
  });

  test('other Zendesk errors are reported', async () => {
    const fsId = await escalated();
    platform.failNext.zdUpdateTicket = 500;
    expect((await statusChange(fsId, 2, 4)).error).toContain('zdUpdateTicket failed: HTTP 500');
  });

  test('updates without a status change, or on unrelated tickets, are ignored', async () => {
    const fsId = await escalated();
    expect(await server.onTicketUpdateHandler({ data: { ticket: { id: fsId }, changes: { priority: [2, 3] } }, iparams: IPARAMS })).toEqual({ action: 'ignored', reason: 'no status change' });
    expect(await server.onTicketUpdateHandler({ data: { ticket: { id: fsId } }, iparams: IPARAMS })).toMatchObject({ reason: 'no status change' });
    expect(await statusChange(9999, 2, 3)).toEqual({ action: 'ignored', reason: 'not escalated from Zendesk' });
  });

  test('uses display_id when the event carries an internal id; unknown statuses are named', async () => {
    const fsId = await escalated();
    const result = await statusChange(30001234567, 2, 6, { display_id: fsId });
    expect(result).toMatchObject({ freshservice_id: 500, status: 6 });
    expect(platform.zd.updates[0].comment.body).toBe('IT status for Freshservice #500: status 6.');
  });

  test('storage outages fail cleanly', async () => {
    platform.$db.get.mockImplementationOnce(() => Promise.reject({ status: 500, message: 'db down' }));
    expect(await statusChange(500, 2, 3)).toEqual({ action: 'failed', error: 'db down' });
  });

  test('errors without a body keep their message', async () => {
    zendeskTicket(401);
    platform.$request.invokeTemplate.mockImplementationOnce(() => Promise.reject({ status: 504, message: 'Timeout error' }));
    expect((await webhook(401)).error).toBe('zdGetTicket failed: HTTP 504: Timeout error');
  });
});

describe('install', () => {
  test('stores the webhook URL; a failure still completes install', async () => {
    await server.onAppInstallHandler({});
    expect(platform.store.get('webhook_url')).toEqual({ url: 'https://hooks.example/zd' });
    global.generateTargetUrl = vi.fn(() => Promise.reject(new Error('nope')));
    await server.onAppInstallHandler({});
    expect(global.renderData).toHaveBeenCalledTimes(2);
  });
});
