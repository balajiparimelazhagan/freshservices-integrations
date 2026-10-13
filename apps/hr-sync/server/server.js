// Syncs BambooHR hires and exits into Freshservice requesters and onboarding/offboarding tickets.
// Safety rules: only touches requesters this app created (linked in $db), only deactivates (never deletes),
// and never adopts an existing requester just because the email matches.
const MAX_EMPLOYEES_PER_RUN = 8;
const MAX_ATTEMPTS = 3;
const SYNC_EVERY_MINUTES = 15;
const empKey = (id) => `emp:${id}`;

async function call(template, options) {
  try {
    const res = await $request.invokeTemplate(template, options);
    return res.response ? JSON.parse(res.response) : {};
  } catch (err) {
    const detail = typeof err.response === 'string' ? err.response.slice(0, 300) : err.message;
    const error = new Error(`${template} failed: HTTP ${err.status}: ${detail}`);
    error.status = err.status;
    error.detail = detail;
    throw error;
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

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && value !== '0000-00-00' ? value : null;
}

function emailAllowed(email, iparams) {
  if (!iparams.email_filter) return true;
  try {
    return new RegExp(iparams.email_filter, 'i').test(email || '');
  } catch {
    // An invalid filter syncs nobody rather than everybody.
    return false;
  }
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const fullName = (emp) => [emp.firstName, emp.lastName].filter(Boolean).join(' ');
const profile = (emp) => ({ first_name: emp.firstName, last_name: emp.lastName || '', job_title: emp.jobTitle || '' });
const leaving = (emp) => emp.status === 'Inactive' || Boolean(validDate(emp.terminationDate));

function ticketFields(iparams, requesterId, subject, lines) {
  const fields = {
    subject,
    description: lines.map((line) => `<p>${line}</p>`).join(''),
    requester_id: requesterId,
    status: 2,
    priority: 2,
    tags: ['bamboohr', subject.split(':')[0].toLowerCase()]
  };
  if (iparams.it_group_id) fields.group_id = Number(iparams.it_group_id);
  return fields;
}

// Returns null when the email already belongs to someone: that person is never adopted.
async function createRequester(id, emp) {
  try {
    const body = JSON.stringify({ ...profile(emp), primary_email: emp.workEmail, external_id: `bamboohr:${id}` });
    return (await call('fsCreateRequester', { body })).requester;
  } catch (err) {
    if (err.status === 409 || /duplicate|already/i.test(err.detail || '')) return null;
    throw err;
  }
}

async function onboard(id, emp, iparams) {
  const requester = await createRequester(id, emp);
  if (!requester) return { action: 'skipped', reason: 'email already belongs to an existing requester; left untouched' };
  await $db.set(empKey(id), { requester_id: requester.id, profile: profile(emp), offboarded: false });

  const start = validDate(emp.hireDate);
  const ticket = (
    await call('fsCreateTicket', {
      body: JSON.stringify(
        ticketFields(iparams, requester.id, `Onboarding: ${fullName(emp)}${start ? ` (starts ${start})` : ''}`, [
          `New hire from BambooHR: <b>${escapeHtml(fullName(emp))}</b>, ${escapeHtml(emp.jobTitle || 'no job title')}, ${escapeHtml(emp.department || 'no department')}.`,
          `Prepare accounts, access and equipment before the start date.`
        ])
      )
    })
  ).ticket;
  await $db.update(empKey(id), 'set', { onboarding_ticket: ticket.id });
  return { action: 'onboarded', requester_id: requester.id, ticket_id: ticket.id };
}

async function offboard(id, emp, link, iparams) {
  const lastDay = validDate(emp.terminationDate);
  // Raise the ticket while the requester is still active, then deactivate (DELETE deactivates; it does not erase).
  const ticket = (
    await call('fsCreateTicket', {
      body: JSON.stringify(
        ticketFields(iparams, link.requester_id, `Offboarding: ${fullName(emp)}${lastDay ? ` (last day ${lastDay})` : ''}`, [
          `Exit recorded in BambooHR for <b>${escapeHtml(fullName(emp))}</b>.`,
          `Remove access and recover equipment.`
        ])
      )
    })
  ).ticket;
  await call('fsDeactivateRequester', { context: { id: link.requester_id } });
  await $db.update(empKey(id), 'set', { offboarded: true, offboarding_ticket: ticket.id });
  return { action: 'offboarded', requester_id: link.requester_id, ticket_id: ticket.id };
}

function handleExit(id, emp, link, iparams, state) {
  if (!link) return { action: 'skipped', reason: 'not created by this app' };
  if (link.offboarded) return { action: 'ignored', reason: 'already offboarded' };
  const lastDay = validDate(emp.terminationDate);
  if (lastDay && lastDay > today()) {
    state.pending[id] = lastDay;
    return { action: 'scheduled', reason: `exit on ${lastDay}` };
  }
  return offboard(id, emp, link, iparams);
}

async function handleActive(id, emp, link, iparams) {
  if (!emp.workEmail) return { action: 'skipped', reason: 'no work email' };
  if (!link) return onboard(id, emp, iparams);

  if (JSON.stringify(link.profile) === JSON.stringify(profile(emp))) return { action: 'ignored', reason: 'no change' };
  await call('fsUpdateRequester', { context: { id: link.requester_id }, body: JSON.stringify(profile(emp)) });
  await $db.update(empKey(id), 'set', { profile: profile(emp) });
  return { action: 'updated', requester_id: link.requester_id };
}

async function processEmployee(id, iparams, state) {
  const emp = await call('bambooEmployee', { context: { id } });
  if (!emailAllowed(emp.workEmail, iparams)) return { action: 'skipped', reason: 'work email not in sync filter' };
  const link = await dbGet(empKey(id));
  return leaving(emp) ? handleExit(id, emp, link, iparams, state) : handleActive(id, emp, link, iparams);
}

async function attempt(id, iparams, state) {
  try {
    const result = await processEmployee(id, iparams, state);
    delete state.retry[id];
    return { id, ...result };
  } catch (err) {
    const tries = (state.retry[id] || 0) + 1;
    if (tries < MAX_ATTEMPTS) state.retry[id] = tries;
    else delete state.retry[id];
    return { id, action: 'failed', attempt: tries, error: err.message };
  }
}

async function loadState() {
  const saved = await dbGet('state');
  // First run looks back one day, so an install never imports the whole company history.
  const fresh = { cursor: isoSeconds(new Date(Date.now() - 24 * 3600 * 1000)), pending: {}, retry: {} };
  return { ...fresh, ...saved };
}

// Exits whose date has arrived, and earlier failures, go first.
async function processQueued(iparams, state, results) {
  const due = Object.keys(state.pending).filter((id) => state.pending[id] <= today());
  for (const id of [...due, ...Object.keys(state.retry)].slice(0, MAX_EMPLOYEES_PER_RUN)) {
    delete state.pending[id];
    results.push(await attempt(id, iparams, state));
  }
}

async function processChanged(iparams, state, results) {
  const changed = await call('bambooChanged', { context: { since: state.cursor } });
  const employees = Object.values(changed.employees || {}).sort((a, b) => String(a.lastChanged).localeCompare(String(b.lastChanged)));
  const batch = employees.slice(0, Math.max(MAX_EMPLOYEES_PER_RUN - results.length, 0));
  for (const entry of batch) {
    results.push(await attempt(String(entry.id), iparams, state));
    state.cursor = entry.lastChanged;
  }
  if (batch.length === employees.length && changed.latest) state.cursor = changed.latest;
  return employees.length - batch.length;
}

async function runSync(iparams) {
  const state = await loadState();
  const results = [];
  await processQueued(iparams, state, results);
  const waiting = await processChanged(iparams, state, results);
  await $db.set('state', state);
  const summary = { at: new Date().toISOString(), cursor: state.cursor, waiting, results };
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
        name: 'hr-sync',
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
