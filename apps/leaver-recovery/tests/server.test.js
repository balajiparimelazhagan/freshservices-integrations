const IPARAMS = { fs_domain: 'yora.freshservice.com', trigger_tag: 'offboarding', grace_days: '7', run_token: 'tok' };
const LEAVER = 501;

function fakePlatform() {
  const store = new Map();
  const fs = { tickets: [], assets: new Map(), tasks: [], notes: [], priority: {}, calls: [], nextTask: 1 };
  const failNext = {};
  const ok = (body) => Promise.resolve({ status: 200, response: JSON.stringify(body) });

  const $request = {
    invokeTemplate: vi.fn((name, { context = {}, body } = {}) => {
      fs.calls.push({ name, context });
      if (failNext[name]) {
        const status = failNext[name];
        delete failNext[name];
        return Promise.reject({ status, response: '{"description":"boom"}' });
      }
      const payload = body ? JSON.parse(body) : {};
      switch (name) {
        case 'fsFindTickets':
          return ok({ tickets: fs.tickets });
        case 'fsUserAssets': {
          const userId = Number(/user_id:(\d+)/.exec(context.filter)[1]);
          return ok({ assets: [...fs.assets.values()].filter((a) => a.user_id === userId) });
        }
        case 'fsGetAsset':
          return ok({ asset: fs.assets.get(context.id) });
        case 'fsCreateTask': {
          const task = { ...payload, id: fs.nextTask++, ticket: context.ticket };
          fs.tasks.push(task);
          return ok({ task });
        }
        case 'fsCompleteTask':
          Object.assign(fs.tasks.find((t) => t.id === context.task), payload);
          return ok({ task: {} });
        case 'fsAddNote':
          fs.notes.push({ ticket: context.ticket, ...payload });
          return ok({ conversation: {} });
        case 'fsRaisePriority':
          fs.priority[context.ticket] = payload.priority;
          return ok({ ticket: {} });
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
  return { store, fs, failNext, $request, $db };
}

let platform;
let server;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T09:00:00Z'));
  platform = fakePlatform();
  Object.assign(global, { $request: platform.$request, $db: platform.$db, renderData: vi.fn() });
  global.generateTargetUrl = vi.fn(() => Promise.resolve('https://hooks.example/run'));
  global.$schedule = { create: vi.fn(() => Promise.resolve({})) };
  server = require('../server/server.js');
});
afterEach(() => vi.useRealTimers());

function device(id, fields = {}) {
  platform.fs.assets.set(id, { display_id: id, name: `Laptop ${id}`, asset_tag: `AT-${id}`, user_id: LEAVER, type_fields: { asset_state_270: 'In Use' }, ...fields });
}
function offboardingTicket(id, requester = LEAVER) {
  platform.fs.tickets.push({ id, requester_id: requester, created_at: '2026-10-14T08:00:00Z', subject: 'Offboarding: Asha Rao' });
}
const runOnce = () => server.onScheduledEventHandler({ iparams: IPARAMS });

describe('starting recovery', () => {
  test('lists every assigned device as a task with the return deadline', async () => {
    device(11);
    device(12, { name: 'iPhone <15>', asset_tag: '' });
    device(13, { user_id: 999 });
    offboardingTicket(900);

    const summary = await runOnce();

    expect(summary.results).toEqual([{ ticket: 900, action: 'recovery started', devices: 2 }]);
    expect(platform.fs.tasks.map((t) => t.title)).toEqual(['Recover Laptop 11 (AT-11)', 'Recover iPhone <15>']);
    expect(platform.fs.tasks[0]).toMatchObject({ status: 1, due_date: '2026-10-21T08:00:00.000Z', notify_before: 0, ticket: 900 });
    const [startNote] = platform.fs.notes;
    expect(startNote).toMatchObject({ ticket: 900, private: true });
    expect(startNote.body).toContain('Return by <b>2026-10-21</b>');
    expect(startNote.body).toContain('<li>iPhone &lt;15&gt;</li>');
    expect(platform.store.get('state').open).toEqual([900]);
  });

  test('searches recent tickets with the configured tag', async () => {
    await server.onScheduledEventHandler({ iparams: { ...IPARAMS, trigger_tag: 'leaver' } });
    expect(platform.fs.calls[0]).toEqual({ name: 'fsFindTickets', context: { query: `"tag:'leaver' AND created_at:>'2026-10-13'"` } });
  });

  test('no devices: a note says so and nothing is tracked', async () => {
    offboardingTicket(901);
    expect((await runOnce()).results).toEqual([{ ticket: 901, action: 'nothing to recover' }]);
    expect(platform.fs.notes[0].body).toContain('no devices are assigned');
    expect(platform.store.get('state').open).toEqual([]);
  });

  test('a ticket is never started twice', async () => {
    device(14);
    offboardingTicket(902);
    await runOnce();
    await runOnce();
    expect(platform.fs.tasks).toHaveLength(1);
  });

  test('at most 3 new tickets per run; the rest start on the next run', async () => {
    for (let i = 0; i < 5; i++) offboardingTicket(910 + i, 600 + i);
    expect((await runOnce()).results).toHaveLength(3);
    expect((await runOnce()).results.map((r) => r.ticket)).toEqual([913, 914]);
  });

  test('more than 10 devices: 10 tasks plus a pointer to the rest', async () => {
    for (let i = 0; i < 12; i++) device(100 + i);
    offboardingTicket(903);
    await runOnce();
    expect(platform.fs.tasks).toHaveLength(10);
    expect(platform.fs.notes[0].body).toContain('2 more devices are assigned');
  });

  test('defaults to 7 days when no grace period is set', async () => {
    device(15);
    offboardingTicket(904);
    await server.onScheduledEventHandler({ iparams: { ...IPARAMS, grace_days: '', trigger_tag: '' } });
    expect(platform.fs.tasks[0].due_date).toBe('2026-10-21T08:00:00.000Z');
    expect(platform.fs.calls[0].context.query).toContain("tag:'offboarding'");
  });
});

describe('tracking returns', () => {
  async function started(...ids) {
    ids.forEach((id) => device(id));
    offboardingTicket(950);
    await runOnce();
  }

  test('devices back In Stock or reassigned close their tasks; all back closes recovery', async () => {
    await started(21, 22);
    platform.fs.assets.get(21).type_fields.asset_state_270 = 'In Stock';
    const partial = await runOnce();
    expect(partial.results[0]).toEqual({ ticket: 950, action: 'tracking', outstanding: 1, finished: false });
    expect(platform.fs.tasks.map((t) => t.status)).toEqual([3, 1]);

    platform.fs.assets.get(22).user_id = 777;
    const done = await runOnce();
    expect(done.results[0]).toMatchObject({ action: 'all recovered', finished: true });
    expect(platform.fs.notes.at(-1).body).toContain('all 2 devices are back');
    expect(platform.store.get('state').open).toEqual([]);
    expect((await runOnce()).results).toEqual([]);
  });

  test('after the deadline the ticket is escalated once', async () => {
    await started(31);
    vi.setSystemTime(new Date('2026-10-22T09:00:00Z'));
    await runOnce();
    await runOnce();
    expect(platform.fs.priority[950]).toBe(3);
    const escalations = platform.fs.notes.filter((n) => n.body.includes('deadline passed'));
    expect(escalations).toHaveLength(1);
    expect(escalations[0].body).toContain('<li>Laptop 31 (AT-31)</li>');
  });

  test('checks at most 20 devices per run', async () => {
    for (let i = 0; i < 10; i++) device(200 + i);
    offboardingTicket(960);
    for (let i = 0; i < 10; i++) device(300 + i, { user_id: 502 });
    offboardingTicket(961, 502);
    for (let i = 0; i < 10; i++) device(400 + i, { user_id: 503 });
    offboardingTicket(962, 503);
    await runOnce();
    platform.fs.calls.length = 0;
    await runOnce();
    expect(platform.fs.calls.filter((c) => c.name === 'fsGetAsset')).toHaveLength(20);
  });

  test('a recovery record that disappeared is dropped from the open list', async () => {
    await started(41);
    platform.store.delete('rec:950');
    platform.fs.tickets.length = 0;
    expect((await runOnce()).results[0]).toEqual({ ticket: 950, action: 'closed', finished: true });
    expect(platform.store.get('state').open).toEqual([]);
  });

  test('assets with no state field count as returned only when reassigned', async () => {
    await started(42);
    platform.fs.assets.get(42).type_fields = undefined;
    expect((await runOnce()).results[0].outstanding).toBe(1);
  });
});

describe('failures, run now and install', () => {
  test('an API failure is reported and the ticket is retried next run', async () => {
    device(51);
    offboardingTicket(970);
    platform.failNext.fsUserAssets = 500;
    expect(await runOnce()).toEqual({ action: 'failed', error: 'fsUserAssets failed: HTTP 500: {"description":"boom"}' });
    expect((await runOnce()).results[0]).toMatchObject({ ticket: 970, action: 'recovery started' });
  });

  test('storage outages fail the run cleanly', async () => {
    platform.$db.get.mockImplementationOnce(() => Promise.reject({ status: 500, message: 'db down' }));
    expect(await runOnce()).toEqual({ action: 'failed', error: 'db down' });
  });

  test('upstream errors without a body keep their message', async () => {
    platform.$request.invokeTemplate.mockImplementationOnce(() => Promise.reject({ status: 504, message: 'Timeout error' }));
    expect((await runOnce()).error).toBe('fsFindTickets failed: HTTP 504: Timeout error');
  });

  test('run-now needs the token', async () => {
    expect(await server.onExternalEventHandler({ headers: { 'X-Run-Token': 'x' }, iparams: IPARAMS })).toMatchObject({ action: 'rejected' });
    expect(await server.onExternalEventHandler({ iparams: { ...IPARAMS, run_token: '' } })).toMatchObject({ action: 'rejected' });
    expect(await server.onExternalEventHandler({ headers: { 'x-run-token': 'tok' }, iparams: IPARAMS })).toMatchObject({ open: 0 });
  });

  test('install schedules the run and stores the URL; failures still finish install', async () => {
    await server.onAppInstallHandler({});
    expect(global.$schedule.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'leaver-recovery', repeat: { time_unit: 'minutes', frequency: 15 } }));
    expect(platform.store.get('run_url')).toEqual({ url: 'https://hooks.example/run' });
    global.$schedule.create = vi.fn(() => Promise.reject(new Error('exists')));
    await server.onAppInstallHandler({});
    expect(global.renderData).toHaveBeenCalledTimes(2);
  });
});
