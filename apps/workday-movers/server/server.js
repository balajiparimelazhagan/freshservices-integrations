// Workday "movers": when a worker's job title, department, manager or location changes in Workday,
// update their Freshservice requester and open an access review ticket so access tied to the old role is removed.
// Reads a Workday RaaS custom report of job changes; only updates requesters that already exist (never creates or deletes).
const MAX_MOVES_PER_RUN = 8;
const MAX_ATTEMPTS = 3;
const SYNC_EVERY_MINUTES = 30;
const DEPARTMENT_PAGES = 3;
const TRACKED = [
  ['Job title', 'Previous_Job_Title', 'Job_Title'],
  ['Department', 'Previous_Department', 'Department'],
  ['Manager', 'Previous_Manager_Email', 'Manager_Email'],
  ['Location', 'Previous_Location', 'Location']
];

async function call(template, options) {
  try {
    const res = await $request.invokeTemplate(template, options);
    return res.response ? JSON.parse(res.response) : {};
  } catch (err) {
    const detail = typeof err.response === 'string' ? err.response.slice(0, 300) : err.message;
    throw new Error(`${template} failed: HTTP ${err.status}: ${detail}`);
  }
}

async function dbGet(key) {
  try {
    return await $db.get(key);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const today = () => new Date().toISOString().slice(0, 10);
const moveKey = (entry) => `move:${entry.Employee_ID}:${entry.Event_Completed}`;

function emailAllowed(email, iparams) {
  if (!iparams.email_filter) return true;
  try {
    return new RegExp(iparams.email_filter, 'i').test(email || '');
  } catch {
    // An invalid filter processes nobody rather than everybody.
    return false;
  }
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function changesOf(entry) {
  return TRACKED.filter(([, before, after]) => (entry[before] || '') !== (entry[after] || '')).map(([label, before, after]) => ({
    label,
    from: entry[before] || '—',
    to: entry[after] || '—'
  }));
}

async function findRequester(email) {
  if (!email) return null;
  const found = await call('fsFindRequester', { context: { email } });
  return (found.requesters || [])[0] || null;
}

async function departmentId(name, cache) {
  if (!cache.departments) {
    cache.departments = {};
    for (let page = 1; page <= DEPARTMENT_PAGES; page++) {
      const list = (await call('fsDepartments', { context: { page } })).departments || [];
      list.forEach((d) => (cache.departments[d.name.toLowerCase()] = d.id));
      if (list.length < 100) break;
    }
  }
  return cache.departments[String(name || '').toLowerCase()] || null;
}

async function addDepartment(entry, cache, update, unmapped) {
  const id = await departmentId(entry.Department, cache);
  if (id) update.department_ids = [id];
  else unmapped.push(`department "${entry.Department}"`);
}

function addManager(entry, manager, update, unmapped) {
  if (manager) update.reporting_manager_id = manager.id;
  else unmapped.push(`manager ${entry.Manager_Email || '(none)'}`);
}

// Builds the requester update; values Freshservice can't map (unknown department, manager not a requester) are reported.
async function requesterUpdate(entry, changes, manager, cache) {
  const changed = new Set(changes.map((c) => c.label));
  const update = {};
  const unmapped = [];
  if (changed.has('Job title')) update.job_title = entry.Job_Title || '';
  if (changed.has('Department')) await addDepartment(entry, cache, update, unmapped);
  if (changed.has('Manager')) addManager(entry, manager, update, unmapped);
  return { update, unmapped };
}

function reviewTicket(entry, changes, requesterId, unmapped, iparams) {
  const rows = changes.map((c) => `<tr><td>${c.label}</td><td>${escapeHtml(c.from)}</td><td>${escapeHtml(c.to)}</td></tr>`).join('');
  const note = unmapped.length ? `<p>Not updated in Freshservice: ${escapeHtml(unmapped.join(', '))}.</p>` : '';
  const fields = {
    subject: `Access review: ${entry.Worker} (${changes.map((c) => c.label).join(', ')} change)`,
    description:
      `<p>Workday recorded a job change for <b>${escapeHtml(entry.Worker)}</b>, effective ${escapeHtml(entry.Effective_Date)}.</p>` +
      `<table><tr><th>Field</th><th>Before</th><th>After</th></tr>${rows}</table>` +
      `<p>Remove access tied to the previous role and confirm what the new role needs.</p>${note}`,
    requester_id: requesterId,
    status: 2,
    priority: 2,
    tags: ['workday', 'access-review']
  };
  if (iparams.it_group_id) fields.group_id = Number(iparams.it_group_id);
  return fields;
}

async function applyMove(entry, worker, changes, iparams, cache) {
  const manager = await findRequester(entry.Manager_Email);
  const { update, unmapped } = await requesterUpdate(entry, changes, manager, cache);
  if (Object.keys(update).length) {
    await call('fsUpdateRequester', { context: { id: worker.id }, body: JSON.stringify(update) });
  }
  // Raised for the new manager so they follow the review; falls back to the worker.
  const requesterId = manager ? manager.id : worker.id;
  const ticket = (await call('fsCreateTicket', { body: JSON.stringify(reviewTicket(entry, changes, requesterId, unmapped, iparams)) })).ticket;
  await $db.set(moveKey(entry), { ticket_id: ticket.id });
  return { action: 'reviewed', requester_id: worker.id, ticket_id: ticket.id, changes: changes.map((c) => c.label), unmapped };
}

async function processMove(entry, iparams, ctx) {
  if (!emailAllowed(entry.Email, iparams)) return { action: 'skipped', reason: 'work email not in filter' };
  if (await dbGet(moveKey(entry))) return { action: 'ignored', reason: 'already reviewed' };
  if (entry.Effective_Date > today()) {
    ctx.state.pending[moveKey(entry)] = entry;
    return { action: 'scheduled', reason: `effective ${entry.Effective_Date}` };
  }
  const changes = changesOf(entry);
  if (!changes.length) return { action: 'ignored', reason: 'no tracked field changed' };
  const worker = await findRequester(entry.Email);
  if (!worker) return { action: 'skipped', reason: 'not a Freshservice requester' };
  return applyMove(entry, worker, changes, iparams, ctx.cache);
}

async function attempt(entry, iparams, ctx) {
  const key = moveKey(entry);
  try {
    const result = await processMove(entry, iparams, ctx);
    delete ctx.state.retry[key];
    return { employee: entry.Employee_ID, ...result };
  } catch (err) {
    const tries = ((ctx.state.retry[key] || {}).attempts || 0) + 1;
    if (tries < MAX_ATTEMPTS) ctx.state.retry[key] = { entry, attempts: tries };
    else delete ctx.state.retry[key];
    return { employee: entry.Employee_ID, action: 'failed', attempt: tries, error: err.message };
  }
}

async function loadState() {
  // First run looks back one day, so an install never replays the company's history.
  const fresh = { cursor: isoSeconds(new Date(Date.now() - 24 * 3600 * 1000)), pending: {}, retry: {} };
  return { ...fresh, ...(await dbGet('state')) };
}

// Moves whose effective date has arrived, and earlier failures, go first.
async function processQueued(iparams, ctx, results) {
  const due = Object.keys(ctx.state.pending).filter((key) => ctx.state.pending[key].Effective_Date <= today());
  const queued = [...due.map((key) => ctx.state.pending[key]), ...Object.values(ctx.state.retry).map((r) => r.entry)];
  for (const entry of queued.slice(0, MAX_MOVES_PER_RUN)) {
    delete ctx.state.pending[moveKey(entry)];
    results.push(await attempt(entry, iparams, ctx));
  }
}

async function processReport(iparams, ctx, results) {
  const report = await call('wdMoves', { context: { since: ctx.state.cursor } });
  const entries = (report.Report_Entry || []).sort((a, b) => String(a.Event_Completed).localeCompare(String(b.Event_Completed)));
  const batch = entries.slice(0, Math.max(MAX_MOVES_PER_RUN - results.length, 0));
  for (const entry of batch) {
    results.push(await attempt(entry, iparams, ctx));
    ctx.state.cursor = entry.Event_Completed;
  }
  return entries.length - batch.length;
}

async function runSync(iparams) {
  const ctx = { state: await loadState(), cache: {} };
  const results = [];
  await processQueued(iparams, ctx, results);
  const waiting = await processReport(iparams, ctx, results);
  await $db.set('state', ctx.state);
  const summary = { at: new Date().toISOString(), cursor: ctx.state.cursor, waiting, results };
  await $db.set('last_run', summary);
  return summary;
}

async function run(label, work) {
  try {
    const result = await work();
    console.info(label, JSON.stringify(result));
    return result;
  } catch (err) {
    console.error(label, err.message);
    return { action: 'failed', error: err.message };
  }
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((header) => header.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function runNow(args) {
  const token = headerValue(args.headers, 'x-run-token');
  if (!args.iparams.run_token || token !== args.iparams.run_token) {
    return { action: 'rejected', reason: 'bad or missing X-Run-Token' };
  }
  return runSync(args.iparams);
}

exports = {
  onScheduledEventHandler: function (args) {
    return run('scheduledSync', () => runSync(args.iparams));
  },

  onExternalEventHandler: function (args) {
    return run('runNow', () => runNow(args));
  },

  onAppInstallHandler: async function () {
    try {
      await $schedule.create({
        name: 'workday-movers',
        data: {},
        schedule_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        repeat: { time_unit: 'minutes', frequency: SYNC_EVERY_MINUTES }
      });
      const url = await generateTargetUrl();
      await $db.set('run_url', { url });
      console.info('Sync scheduled every', SYNC_EVERY_MINUTES, 'minutes. Run-now URL:', url);
    } catch (err) {
      console.error('Install setup failed', err.message);
    }
    renderData();
  }
};

// The FDK runtime has no `module`; this export is only for the unit tests.
if (typeof module !== 'undefined') module.exports = exports;
