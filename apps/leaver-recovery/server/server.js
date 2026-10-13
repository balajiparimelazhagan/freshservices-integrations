// Device recovery for leavers: finds new offboarding tickets, lists the leaver's assigned devices as tasks,
// closes each task once the device is back In Stock (or reassigned), and escalates after the deadline.
// Read-only on assets: it never edits a device, only the offboarding ticket.
const MAX_NEW_TICKETS_PER_RUN = 3;
const MAX_ASSETS_PER_TICKET = 10;
const MAX_ASSET_CHECKS_PER_RUN = 20;
const RUN_EVERY_MINUTES = 15;
const DAY_MS = 24 * 3600 * 1000;
const recKey = (ticketId) => `rec:${ticketId}`;

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

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const deviceLabel = (asset) => (asset.asset_tag ? `${asset.name} (${asset.asset_tag})` : asset.name);

function assetState(asset) {
  const fields = asset.type_fields || {};
  const key = Object.keys(fields).find((name) => name.startsWith('asset_state_'));
  return key ? fields[key] : null;
}

// Back in IT's hands: marked In Stock, or no longer assigned to the leaver.
const isRecovered = (asset, leaverId) => assetState(asset) === 'In Stock' || asset.user_id !== leaverId;

function note(ticket, html) {
  return call('fsAddNote', { context: { ticket }, body: JSON.stringify({ private: true, body: html }) });
}

async function startRecovery(ticket, iparams) {
  const leaverId = ticket.requester_id;
  const assets = (await call('fsUserAssets', { context: { filter: `"user_id:${leaverId}"` } })).assets || [];
  const deadline = new Date(new Date(ticket.created_at).getTime() + Number(iparams.grace_days || 7) * DAY_MS).toISOString();

  if (!assets.length) {
    await note(ticket.id, '<p>Device recovery: no devices are assigned to this person. Nothing to collect.</p>');
    await $db.set(recKey(ticket.id), { done: true, devices: [] });
    return { ticket: ticket.id, action: 'nothing to recover' };
  }

  const devices = [];
  for (const asset of assets.slice(0, MAX_ASSETS_PER_TICKET)) {
    const task = (
      await call('fsCreateTask', {
        context: { ticket: ticket.id },
        body: JSON.stringify({
          title: `Recover ${deviceLabel(asset)}`,
          description: `Collect this device and set it to In Stock in Freshservice.`,
          status: 1,
          due_date: deadline,
          notify_before: 0
        })
      })
    ).task;
    devices.push({ asset: asset.display_id, label: deviceLabel(asset), task: task.id, recovered: false });
  }
  const more = assets.length > MAX_ASSETS_PER_TICKET ? `<p>${assets.length - MAX_ASSETS_PER_TICKET} more devices are assigned; review them in the asset list.</p>` : '';
  await note(
    ticket.id,
    `<p>Device recovery started. Return by <b>${deadline.slice(0, 10)}</b>:</p><ul>${devices.map((d) => `<li>${escapeHtml(d.label)}</li>`).join('')}</ul>${more}`
  );
  await $db.set(recKey(ticket.id), { leaver: leaverId, deadline, escalated: false, done: false, devices });
  return { ticket: ticket.id, action: 'recovery started', devices: devices.length };
}

async function refreshDevices(ticketId, rec, budget) {
  for (const device of rec.devices.filter((d) => !d.recovered)) {
    if (budget.checks <= 0) return;
    budget.checks -= 1;
    const asset = (await call('fsGetAsset', { context: { id: device.asset } })).asset;
    if (isRecovered(asset, rec.leaver)) {
      await call('fsCompleteTask', { context: { ticket: ticketId, task: device.task }, body: JSON.stringify({ status: 3 }) });
      device.recovered = true;
    }
  }
}

async function settle(ticketId, rec, outstanding) {
  if (!outstanding.length) {
    await note(ticketId, `<p>Device recovery complete: all ${rec.devices.length} devices are back.</p>`);
    rec.done = true;
    return;
  }
  if (rec.escalated || Date.now() <= new Date(rec.deadline).getTime()) return;
  await note(ticketId, `<p>Return deadline passed. Still outstanding:</p><ul>${outstanding.map((d) => `<li>${escapeHtml(d.label)}</li>`).join('')}</ul>`);
  await call('fsRaisePriority', { context: { ticket: ticketId }, body: JSON.stringify({ priority: 3 }) });
  rec.escalated = true;
}

async function checkRecovery(ticketId, budget) {
  const rec = await dbGet(recKey(ticketId));
  if (!rec || rec.done) return { ticket: ticketId, action: 'closed', finished: true };
  await refreshDevices(ticketId, rec, budget);
  const outstanding = rec.devices.filter((d) => !d.recovered);
  await settle(ticketId, rec, outstanding);
  await $db.set(recKey(ticketId), rec);
  return { ticket: ticketId, action: rec.done ? 'all recovered' : 'tracking', outstanding: outstanding.length, finished: rec.done };
}

async function discover(iparams, state, results) {
  const since = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  const query = `"tag:'${iparams.trigger_tag || 'offboarding'}' AND created_at:>'${since}'"`;
  const tickets = (await call('fsFindTickets', { context: { query } })).tickets || [];
  let started = 0;
  for (const ticket of tickets) {
    if (started >= MAX_NEW_TICKETS_PER_RUN) break;
    if (await dbGet(recKey(ticket.id))) continue;
    started += 1;
    const result = await startRecovery(ticket, iparams);
    if (result.action === 'recovery started') state.open.push(ticket.id);
    results.push(result);
  }
}

async function runOnce(iparams) {
  const state = { open: [], ...(await dbGet('state')) };
  const results = [];
  const budget = { checks: MAX_ASSET_CHECKS_PER_RUN };

  for (const ticketId of [...state.open]) {
    const result = await checkRecovery(ticketId, budget);
    if (result.finished) state.open = state.open.filter((id) => id !== ticketId);
    results.push(result);
  }
  await discover(iparams, state, results);

  await $db.set('state', state);
  const summary = { at: new Date().toISOString(), open: state.open.length, results };
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
  return runOnce(args.iparams);
}

exports = {
  onScheduledEventHandler: function (args) {
    return run('scheduledRecovery', () => runOnce(args.iparams));
  },

  onExternalEventHandler: function (args) {
    return run('runNow', () => runNow(args));
  },

  onAppInstallHandler: async function () {
    try {
      await $schedule.create({
        name: 'leaver-recovery',
        data: {},
        schedule_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        repeat: { time_unit: 'minutes', frequency: RUN_EVERY_MINUTES }
      });
      const url = await generateTargetUrl();
      await $db.set('run_url', { url });
      console.info('Recovery runs every', RUN_EVERY_MINUTES, 'minutes. Run-now URL:', url);
    } catch (err) {
      console.error('Install setup failed', err.message);
    }
    renderData();
  }
};

// The FDK runtime has no `module`; this export is only for the unit tests.
if (typeof module !== 'undefined') module.exports = exports;
