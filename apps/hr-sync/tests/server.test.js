const IPARAMS = {
  fs_domain: 'yora.freshservice.com',
  bamboo_subdomain: 'acme',
  email_filter: '^me\\+.*@example\\.com$',
  it_group_id: '42',
  run_token: 'tok'
};

function fakePlatform() {
  const store = new Map();
  const bamboo = { employees: new Map(), latest: '2026-10-14T10:00:00Z' };
  const fs = { requesters: new Map([[1, { id: 1, primary_email: 'me+existing@example.com', active: true }]]), tickets: [], nextId: 100, calls: [] };
  const failNext = {};

  const ok = (body) => Promise.resolve({ status: 200, response: body === undefined ? '' : JSON.stringify(body) });
  const fail = (status, body) => Promise.reject({ status, response: JSON.stringify(body) });

  const $request = {
    invokeTemplate: vi.fn((name, { context = {}, body } = {}) => {
      fs.calls.push(name);
      if (failNext[name]) {
        const status = failNext[name];
        delete failNext[name];
        return fail(status, { description: 'boom' });
      }
      const payload = body ? JSON.parse(body) : {};
      switch (name) {
        case 'bambooChanged': {
          const employees = {};
          for (const e of bamboo.employees.values()) {
            if (e.lastChanged > context.since) employees[e.id] = { id: e.id, action: 'Updated', lastChanged: e.lastChanged };
          }
          return ok({ latest: bamboo.latest, employees });
        }
        case 'bambooEmployee': {
          const e = bamboo.employees.get(String(context.id));
          return e ? ok(e.fields) : fail(404, {});
        }
        case 'fsCreateRequester': {
          if ([...fs.requesters.values()].some((r) => r.primary_email === payload.primary_email)) {
            return fail(409, { description: 'Validation failed', errors: [{ field: 'primary_email', code: 'duplicate_value' }] });
          }
          const requester = { ...payload, id: fs.nextId++, active: true };
          fs.requesters.set(requester.id, requester);
          return ok({ requester });
        }
        case 'fsUpdateRequester':
          Object.assign(fs.requesters.get(context.id), payload);
          return ok({ requester: fs.requesters.get(context.id) });
        case 'fsDeactivateRequester':
          fs.requesters.get(context.id).active = false;
          return ok();
        case 'fsCreateTicket': {
          const ticket = { ...payload, id: fs.nextId++ };
          fs.tickets.push(ticket);
          return ok({ ticket });
        }
        default:
          return fail(404, {});
      }
    })
  };

  const $db = {
    get: vi.fn((key) => (store.has(key) ? Promise.resolve(store.get(key)) : Promise.reject({ status: 404 }))),
    set: vi.fn((key, value) => {
      store.set(key, value);
      return Promise.resolve({ Created: true });
    }),
    update: vi.fn((key, _action, attrs) => {
      store.set(key, { ...store.get(key), ...attrs });
      return Promise.resolve({ Updated: true });
    })
  };
  return { store, bamboo, fs, failNext, $request, $db };
}

let platform;
let server;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T09:00:00Z'));
  platform = fakePlatform();
  global.$request = platform.$request;
  global.$db = platform.$db;
  global.renderData = vi.fn();
  global.generateTargetUrl = vi.fn(() => Promise.resolve('https://hooks.example/run'));
  global.$schedule = { create: vi.fn(() => Promise.resolve({})) };
  server = require('../server/server.js');
});

afterEach(() => vi.useRealTimers());

let clock = 0;
function employee(id, fields) {
  clock += 1;
  const lastChanged = new Date(Date.UTC(2026, 9, 14, 8, 0, clock)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  platform.bamboo.latest = lastChanged;
  platform.bamboo.employees.set(String(id), {
    id: String(id),
    lastChanged,
    fields: { firstName: 'Asha', lastName: 'Rao', workEmail: `me+${id}@example.com`, jobTitle: 'Analyst', department: 'Finance', status: 'Active', hireDate: '2026-11-02', terminationDate: null, ...fields }
  });
}

const sync = () => server.onScheduledEventHandler({ iparams: IPARAMS });
const only = (summary) => summary.results.map(({ id, action, reason }) => ({ id, action, ...(reason ? { reason } : {}) }));

describe('hires', () => {
  test('new hire becomes a tagged requester with an onboarding ticket', async () => {
    employee(7, {});
    const summary = await sync();

    expect(only(summary)).toEqual([{ id: '7', action: 'onboarded' }]);
    const requester = [...platform.fs.requesters.values()].find((r) => r.external_id === 'bamboohr:7');
    expect(requester).toMatchObject({ first_name: 'Asha', last_name: 'Rao', primary_email: 'me+7@example.com', job_title: 'Analyst' });
    expect(platform.fs.tickets[0]).toMatchObject({ subject: 'Onboarding: Asha Rao (starts 2026-11-02)', requester_id: requester.id, group_id: 42, tags: ['bamboohr', 'onboarding'] });
    expect(platform.store.get('emp:7')).toMatchObject({ requester_id: requester.id, offboarded: false, onboarding_ticket: platform.fs.tickets[0].id });
    expect(summary.cursor).toBe(platform.bamboo.latest);
  });

  test('names are escaped in the ticket and missing optional data reads cleanly', async () => {
    employee(8, { firstName: '<b>Zoe</b>', lastName: '', jobTitle: '', department: '', hireDate: '0000-00-00' });
    await sync();
    expect(platform.fs.tickets[0].subject).toBe('Onboarding: <b>Zoe</b>');
    expect(platform.fs.tickets[0].description).toContain('<b>&lt;b&gt;Zoe&lt;/b&gt;</b>, no job title, no department');
  });

  test('employees outside the email filter are never synced', async () => {
    employee(9, { workEmail: 'ceo@realcompany.org' });
    expect(only(await sync())).toEqual([{ id: '9', action: 'skipped', reason: 'work email not in sync filter' }]);
    expect(platform.fs.calls).not.toContain('fsCreateRequester');
  });

  test('an invalid filter syncs nobody; an empty filter syncs everyone', async () => {
    employee(10, {});
    const bad = await server.onScheduledEventHandler({ iparams: { ...IPARAMS, email_filter: '([' } });
    expect(bad.results[0].reason).toBe('work email not in sync filter');
    platform.store.delete('state');
    const open = await server.onScheduledEventHandler({ iparams: { ...IPARAMS, email_filter: '' } });
    expect(open.results[0].action).toBe('onboarded');
  });

  test('an existing requester with the same email is left untouched', async () => {
    employee('existing', { workEmail: 'me+existing@example.com' });
    expect(only(await sync())[0]).toEqual({ id: 'existing', action: 'skipped', reason: 'email already belongs to an existing requester; left untouched' });
    expect(platform.fs.tickets).toHaveLength(0);
    expect(platform.store.has('emp:existing')).toBe(false);
    expect(platform.fs.requesters.get(1)).toEqual({ id: 1, primary_email: 'me+existing@example.com', active: true });
  });

  test('no work email is skipped', async () => {
    employee(11, { workEmail: '' });
    expect(only(await server.onScheduledEventHandler({ iparams: { ...IPARAMS, email_filter: '' } }))[0].reason).toBe('no work email');
  });
});

describe('changes and exits', () => {
  async function hired(id, fields = {}) {
    employee(id, fields);
    await sync();
    return platform.store.get(`emp:${id}`);
  }

  test('unchanged employees cause no writes; profile changes update the requester', async () => {
    const link = await hired(20);
    employee(20, {});
    expect(only(await sync())[0]).toEqual({ id: '20', action: 'ignored', reason: 'no change' });

    employee(20, { jobTitle: 'Senior Analyst' });
    expect(only(await sync())[0]).toEqual({ id: '20', action: 'updated' });
    expect(platform.fs.requesters.get(link.requester_id).job_title).toBe('Senior Analyst');
  });

  test('exit today raises offboarding, then deactivates (never deletes)', async () => {
    const link = await hired(21);
    employee(21, { status: 'Inactive', terminationDate: '2026-10-14' });
    platform.fs.calls.length = 0;

    expect(only(await sync())[0]).toEqual({ id: '21', action: 'offboarded' });
    expect(platform.fs.calls.indexOf('fsCreateTicket')).toBeLessThan(platform.fs.calls.indexOf('fsDeactivateRequester'));
    expect(platform.fs.tickets.at(-1)).toMatchObject({ subject: 'Offboarding: Asha Rao (last day 2026-10-14)', requester_id: link.requester_id, tags: ['bamboohr', 'offboarding'] });
    expect(platform.fs.requesters.get(link.requester_id).active).toBe(false);

    employee(21, { status: 'Inactive', terminationDate: '2026-10-14' });
    expect(only(await sync())[0]).toEqual({ id: '21', action: 'ignored', reason: 'already offboarded' });
  });

  test('inactive without a date offboards immediately', async () => {
    await hired(22);
    employee(22, { status: 'Inactive' });
    expect(only(await sync())[0].action).toBe('offboarded');
    expect(platform.fs.tickets.at(-1).subject).toBe('Offboarding: Asha Rao');
  });

  test('future-dated exit waits, then offboards on the day', async () => {
    const link = await hired(23);
    employee(23, { terminationDate: '2026-10-20' });
    expect(only(await sync())[0]).toEqual({ id: '23', action: 'scheduled', reason: 'exit on 2026-10-20' });
    expect(platform.fs.requesters.get(link.requester_id).active).toBe(true);
    expect(only(await sync())).toEqual([]);

    vi.setSystemTime(new Date('2026-10-20T06:00:00Z'));
    expect(only(await sync())).toEqual([{ id: '23', action: 'offboarded' }]);
    expect(platform.fs.requesters.get(link.requester_id).active).toBe(false);
  });

  test('exits of people this app did not create are ignored', async () => {
    employee(24, { status: 'Inactive', terminationDate: '2026-10-01' });
    expect(only(await sync())[0]).toEqual({ id: '24', action: 'skipped', reason: 'not created by this app' });
    expect(platform.fs.calls).not.toContain('fsDeactivateRequester');
  });
});

describe('limits and failures', () => {
  test('at most 8 employees per run; the rest wait for the next run', async () => {
    for (let i = 30; i < 40; i++) employee(i, {});
    const first = await sync();
    expect(first.results).toHaveLength(8);
    expect(first.waiting).toBe(2);
    const second = await sync();
    expect(second.results.map((r) => r.id)).toEqual(['38', '39']);
    expect(second.cursor).toBe(platform.bamboo.latest);
  });

  test('a failure is retried on later runs, then given up after 3 attempts', async () => {
    employee(41, {});
    platform.failNext.fsCreateRequester = 500;
    const first = await sync();
    expect(first.results[0]).toMatchObject({ id: '41', action: 'failed', attempt: 1 });
    expect(first.results[0].error).toContain('fsCreateRequester failed: HTTP 500');

    expect((await sync()).results[0]).toMatchObject({ id: '41', action: 'onboarded' });
    expect(platform.store.get('state').retry).toEqual({});
  });

  test('gives up after three attempts', async () => {
    employee(43, {});
    const original = platform.$request.invokeTemplate.getMockImplementation();
    platform.$request.invokeTemplate.mockImplementation((name, opts) => (name === 'bambooEmployee' ? Promise.reject({ status: 403, message: 'Forbidden' }) : original(name, opts)));
    const attempts = [];
    for (let i = 0; i < 4; i++) attempts.push((await sync()).results.map((r) => r.attempt));
    expect(attempts).toEqual([[1], [2], [3], []]);
  });

  test('a storage outage fails the run without touching Freshservice', async () => {
    employee(44, {});
    platform.$db.get.mockImplementationOnce(() => Promise.reject({ status: 500, message: 'db down' }));
    expect(await sync()).toEqual({ action: 'failed', error: 'db down' });
    expect(platform.fs.calls).toEqual([]);
  });

  test('BambooHR being down fails the run cleanly and keeps the cursor', async () => {
    platform.failNext.bambooChanged = 503;
    const result = await sync();
    expect(result).toMatchObject({ action: 'failed' });
    expect(platform.store.has('state')).toBe(false);
  });
});

describe('run now and install', () => {
  test('run-now needs the token', async () => {
    employee(50, {});
    expect(await server.onExternalEventHandler({ headers: { 'X-Run-Token': 'nope' }, iparams: IPARAMS })).toEqual({ action: 'rejected', reason: 'bad or missing X-Run-Token' });
    expect(await server.onExternalEventHandler({ iparams: { ...IPARAMS, run_token: '' } })).toMatchObject({ action: 'rejected' });
    const ran = await server.onExternalEventHandler({ headers: { 'x-run-token': 'tok' }, iparams: IPARAMS });
    expect(ran.results[0].action).toBe('onboarded');
  });

  test('install schedules the sync every 15 minutes and stores the run-now URL', async () => {
    await server.onAppInstallHandler({});
    expect(global.$schedule.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'hr-sync', repeat: { time_unit: 'minutes', frequency: 15 } }));
    expect(platform.store.get('run_url')).toEqual({ url: 'https://hooks.example/run' });
    expect(global.renderData).toHaveBeenCalledWith();
  });

  test('install completes even if scheduling fails', async () => {
    global.$schedule.create = vi.fn(() => Promise.reject(new Error('exists')));
    await server.onAppInstallHandler({});
    expect(global.renderData).toHaveBeenCalledWith();
  });
});
