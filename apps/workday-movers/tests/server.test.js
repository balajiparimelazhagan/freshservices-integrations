const IPARAMS = { fs_domain: 'acme.freshservice.com', email_filter: '@acme\\.com$', it_group_id: '42', run_token: 'tok' };

function fakePlatform() {
  const store = new Map();
  const wd = { entries: [] };
  const fs = {
    requesters: [
      { id: 1, primary_email: 'asha@acme.com', job_title: 'Analyst', department_ids: [10] },
      { id: 2, primary_email: 'maria@acme.com' },
      { id: 3, primary_email: 'old.boss@acme.com' }
    ],
    departments: [{ id: 10, name: 'Finance' }, { id: 11, name: 'Engineering' }],
    tickets: [],
    updates: [],
    calls: [],
    nextId: 700
  };
  const failNext = {};
  const ok = (body) => Promise.resolve({ status: 200, response: JSON.stringify(body) });

  const $request = {
    invokeTemplate: vi.fn((name, { context = {}, body } = {}) => {
      fs.calls.push({ name, context });
      if (failNext[name]) {
        const status = failNext[name];
        delete failNext[name];
        return Promise.reject({ status, response: '{"error":"boom"}' });
      }
      const payload = body ? JSON.parse(body) : {};
      switch (name) {
        case 'wdMoves':
          return ok({ Report_Entry: wd.entries.filter((e) => e.Event_Completed > context.since) });
        case 'fsFindRequester':
          return ok({ requesters: fs.requesters.filter((r) => r.primary_email === context.email) });
        case 'fsDepartments':
          return ok({ departments: fs.departments.slice((context.page - 1) * 100, context.page * 100) });
        case 'fsUpdateRequester':
          fs.updates.push({ id: context.id, ...payload });
          return ok({ requester: {} });
        case 'fsCreateTicket': {
          const ticket = { ...payload, id: fs.nextId++ };
          fs.tickets.push(ticket);
          return ok({ ticket });
        }
        default:
          return Promise.reject({ status: 404, response: '{}' });
      }
    })
  };
  const $db = {
    get: vi.fn((key) => (store.has(key) ? Promise.resolve(store.get(key)) : Promise.reject({ status: 404 }))),
    set: vi.fn((key, value) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve({ Created: true });
    })
  };
  return { store, wd, fs, failNext, $request, $db };
}

let platform;
let server;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T09:00:00Z'));
  platform = fakePlatform();
  Object.assign(global, { $request: platform.$request, $db: platform.$db, renderData: vi.fn() });
  global.generateTargetUrl = vi.fn(() => Promise.resolve('https://hooks.example/run'));
  global.$schedule = { create: vi.fn(() => Promise.resolve({})) };
  server = require('../server/server.js');
});
afterEach(() => vi.useRealTimers());

let clock = 0;
function move(fields = {}) {
  clock += 1;
  const entry = {
    Employee_ID: '21001',
    Worker: 'Asha Rao',
    Email: 'asha@acme.com',
    Effective_Date: '2026-10-21',
    Event_Completed: new Date(Date.UTC(2026, 9, 21, 8, 0, clock)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Previous_Job_Title: 'Analyst',
    Job_Title: 'Analyst',
    Previous_Department: 'Finance',
    Department: 'Finance',
    Previous_Manager_Email: 'old.boss@acme.com',
    Manager_Email: 'old.boss@acme.com',
    Previous_Location: 'Chennai',
    Location: 'Chennai',
    ...fields
  };
  platform.wd.entries.push(entry);
  return entry;
}
const sync = () => server.onScheduledEventHandler({ iparams: IPARAMS });

describe('moves', () => {
  test('department and manager change: requester updated, review raised for the new manager', async () => {
    move({ Department: 'Engineering', Manager_Email: 'maria@acme.com' });
    const { results } = await sync();

    expect(results).toEqual([{ employee: '21001', action: 'reviewed', requester_id: 1, ticket_id: 700, changes: ['Department', 'Manager'], unmapped: [] }]);
    expect(platform.fs.updates).toEqual([{ id: 1, department_ids: [11], reporting_manager_id: 2 }]);
    const [ticket] = platform.fs.tickets;
    expect(ticket).toMatchObject({ subject: 'Access review: Asha Rao (Department, Manager change)', requester_id: 2, group_id: 42, tags: ['workday', 'access-review'] });
    expect(ticket.description).toContain('<tr><td>Department</td><td>Finance</td><td>Engineering</td></tr>');
    expect(ticket.description).toContain('effective 2026-10-21');
  });

  test('title-only change updates the title and still routes to the current manager', async () => {
    move({ Job_Title: 'Senior <Analyst>' });
    await sync();
    expect(platform.fs.updates).toEqual([{ id: 1, job_title: 'Senior <Analyst>' }]);
    expect(platform.fs.tickets[0].requester_id).toBe(3);
    expect(platform.fs.tickets[0].description).toContain('Senior &lt;Analyst&gt;');
  });

  test('location-only change raises a review without touching the requester', async () => {
    move({ Location: 'Bengaluru' });
    expect((await sync()).results[0].changes).toEqual(['Location']);
    expect(platform.fs.updates).toEqual([]);
  });

  test('unknown department and a manager outside Freshservice are reported, not guessed', async () => {
    move({ Department: 'Skunkworks', Manager_Email: 'new.boss@acme.com', Previous_Job_Title: '', Job_Title: '' });
    const { results } = await sync();
    expect(results[0].unmapped).toEqual(['department "Skunkworks"', 'manager new.boss@acme.com']);
    expect(platform.fs.updates).toEqual([]);
    expect(platform.fs.tickets[0].requester_id).toBe(1);
    expect(platform.fs.tickets[0].description).toContain('Not updated in Freshservice: department &quot;Skunkworks&quot;, manager new.boss@acme.com.');
  });

  test('manager removed entirely is reported as missing', async () => {
    move({ Manager_Email: '' });
    const { results } = await sync();
    expect(results[0].unmapped).toEqual(['manager (none)']);
    expect(platform.fs.tickets[0].description).toContain('<td>Manager</td><td>old.boss@acme.com</td><td>—</td>');
  });

  test('entries with no tracked change, people not in Freshservice, and filtered emails are skipped', async () => {
    move({});
    move({ Employee_ID: '9', Email: 'ghost@acme.com', Department: 'Engineering' });
    move({ Employee_ID: '8', Email: 'ceo@other.org', Department: 'Engineering' });
    expect((await sync()).results.map((r) => r.reason)).toEqual(['no tracked field changed', 'not a Freshservice requester', 'work email not in filter']);
    expect(platform.fs.tickets).toEqual([]);
  });

  test('an invalid filter processes nobody; an empty filter processes everyone', async () => {
    move({ Department: 'Engineering' });
    expect((await server.onScheduledEventHandler({ iparams: { ...IPARAMS, email_filter: '([' } })).results[0].reason).toBe('work email not in filter');
    platform.store.delete('state');
    expect((await server.onScheduledEventHandler({ iparams: { ...IPARAMS, email_filter: '', it_group_id: '' } })).results[0].action).toBe('reviewed');
    expect(platform.fs.tickets[0].group_id).toBeUndefined();
  });

  test('the same Workday event is never reviewed twice', async () => {
    const entry = move({ Department: 'Engineering' });
    await sync();
    platform.store.get('state').cursor = '2026-01-01T00:00:00Z';
    platform.store.set('state', { ...platform.store.get('state'), cursor: '2026-01-01T00:00:00Z' });
    expect((await sync()).results).toEqual([{ employee: entry.Employee_ID, action: 'ignored', reason: 'already reviewed' }]);
    expect(platform.fs.tickets).toHaveLength(1);
  });

  test('future-dated moves wait for their effective date', async () => {
    move({ Department: 'Engineering', Effective_Date: '2026-11-01' });
    expect((await sync()).results[0]).toMatchObject({ action: 'scheduled', reason: 'effective 2026-11-01' });
    expect((await sync()).results).toEqual([]);
    vi.setSystemTime(new Date('2026-11-01T06:00:00Z'));
    expect((await sync()).results[0].action).toBe('reviewed');
  });

  test('departments are read across pages once per run', async () => {
    platform.fs.departments = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, name: `Dept ${i}` }));
    move({ Department: 'Dept 140' });
    move({ Employee_ID: '21002', Email: 'maria@acme.com', Department: 'Dept 3' });
    await sync();
    expect(platform.fs.updates.map((u) => u.department_ids[0])).toEqual([1140, 1003]);
    expect(platform.fs.calls.filter((c) => c.name === 'fsDepartments')).toHaveLength(2);
  });
});

describe('limits and failures', () => {
  test('at most 8 moves per run; the rest follow on the next run', async () => {
    for (let i = 0; i < 10; i++) move({ Employee_ID: String(30000 + i), Location: `Site ${i}` });
    const first = await sync();
    expect(first.results).toHaveLength(8);
    expect(first.waiting).toBe(2);
    expect((await sync()).results.map((r) => r.employee)).toEqual(['30008', '30009']);
  });

  test('a failed move is retried, then dropped after 3 attempts', async () => {
    move({ Location: 'Pune' });
    platform.failNext.fsCreateTicket = 500;
    expect((await sync()).results[0]).toMatchObject({ action: 'failed', attempt: 1 });
    expect((await sync()).results[0].action).toBe('reviewed');

    move({ Employee_ID: '40000', Location: 'Delhi' });
    const original = platform.$request.invokeTemplate.getMockImplementation();
    platform.$request.invokeTemplate.mockImplementation((name, opts) =>
      name === 'fsFindRequester' && opts.context.email === 'asha@acme.com' ? Promise.reject({ status: 503, message: 'Unavailable' }) : original(name, opts)
    );
    const attempts = [];
    for (let i = 0; i < 4; i++) attempts.push((await sync()).results.map((r) => r.attempt));
    expect(attempts).toEqual([[1], [2], [3], []]);
  });

  test('Workday being unavailable fails the run and keeps the cursor', async () => {
    platform.failNext.wdMoves = 401;
    expect(await sync()).toEqual({ action: 'failed', error: 'wdMoves failed: HTTP 401: {"error":"boom"}' });
    expect(platform.store.has('state')).toBe(false);
  });

  test('a storage outage fails the run without touching Freshservice', async () => {
    platform.$db.get.mockImplementationOnce(() => Promise.reject({ status: 500, message: 'db down' }));
    expect(await sync()).toEqual({ action: 'failed', error: 'db down' });
    expect(platform.fs.calls).toEqual([]);
  });

  test('an empty report keeps the cursor', async () => {
    const { cursor } = await sync();
    expect(cursor).toBe('2026-10-20T09:00:00Z');
  });
});

describe('run now and install', () => {
  test('run-now needs the token', async () => {
    expect(await server.onExternalEventHandler({ headers: { 'X-Run-Token': 'x' }, iparams: IPARAMS })).toMatchObject({ action: 'rejected' });
    expect(await server.onExternalEventHandler({ iparams: { ...IPARAMS, run_token: '' } })).toMatchObject({ action: 'rejected' });
    expect(await server.onExternalEventHandler({ headers: { 'x-run-token': 'tok' }, iparams: IPARAMS })).toMatchObject({ results: [] });
  });

  test('install schedules a sync every 30 minutes; failures still finish install', async () => {
    await server.onAppInstallHandler({});
    expect(global.$schedule.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'workday-movers', repeat: { time_unit: 'minutes', frequency: 30 } }));
    expect(platform.store.get('run_url')).toEqual({ url: 'https://hooks.example/run' });
    global.$schedule.create = vi.fn(() => Promise.reject(new Error('exists')));
    await server.onAppInstallHandler({});
    expect(global.renderData).toHaveBeenCalledTimes(2);
  });
});
