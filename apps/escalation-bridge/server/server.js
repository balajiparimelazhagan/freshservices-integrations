const STATUS_NAMES = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };
// Workflow Automator placeholders render ids like "INC-12" or "#SR-12"; the numeric part is the API id.
const TRAILING_DIGITS = /(\d+)\s*$/;

const sourceKey = (id) => `src:${id}`;
const targetKey = (id) => `tgt:${id}`;
const seenKey = (id) => `seen:${id}`;
// Product events may carry an internal id alongside the agent-facing ticket number; the API and UI use the number.
const ticketNumber = (ticket) => ticket.display_id || ticket.id;

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

function tagNames(ticket) {
  return (ticket.tags || []).map((tag) => (typeof tag === 'string' ? tag : tag.name));
}

function shouldEscalate(ticket, iparams) {
  return ticket.priority >= Number(iparams.escalate_priority || 4) || tagNames(ticket).includes('escalate');
}

function targetFields(ticket, iparams) {
  const fields = {
    subject: `[${iparams.source_domain.split('.')[0]} #${ticket.id}] ${ticket.subject}`,
    description:
      `<p>Escalated from <a href="https://${iparams.source_domain}/a/tickets/${ticket.id}">` +
      `${iparams.source_domain} #${ticket.id}</a>.</p>${ticket.description || ''}`,
    email: iparams.requester_email,
    priority: ticket.priority,
    status: 2,
    tags: ['bridge']
  };
  // Accounts with a priority matrix derive priority from urgency x impact and ignore `priority`.
  if (ticket.urgency) fields.urgency = ticket.urgency;
  if (ticket.impact) fields.impact = ticket.impact;
  if (iparams.target_group_id) fields.group_id = Number(iparams.target_group_id);
  const custom = JSON.parse(iparams.target_custom_fields || '{}');
  if (Object.keys(custom).length) fields.custom_fields = custom;
  return fields;
}

async function escalate(event, iparams) {
  const ticket = { ...event, id: ticketNumber(event) };
  if (await dbGet(sourceKey(ticket.id))) return { action: 'ignored', reason: 'already escalated' };
  if (!shouldEscalate(ticket, iparams)) {
    return { action: 'ignored', reason: 'does not match escalation rule', threshold: Number(iparams.escalate_priority || 4) };
  }

  // Claim the ticket first so a concurrent create/update event for it can't escalate it twice.
  try {
    await $db.set(sourceKey(ticket.id), { target_id: null, last_status: 0 }, { setIf: 'not_exist' });
  } catch {
    return { action: 'ignored', reason: 'already escalated' };
  }

  let created;
  try {
    created = (await call('targetCreateTicket', { body: JSON.stringify(targetFields(ticket, iparams)) })).ticket;
  } catch (err) {
    await $db.delete(sourceKey(ticket.id));
    throw err;
  }
  // A priority matrix in the target recomputes priority from urgency x impact, which can differ from a
  // priority an agent set by hand; an explicit priority update is not overridden by the matrix.
  if (created.priority !== ticket.priority) {
    await call('targetUpdateTicket', { context: { id: created.id }, body: JSON.stringify({ priority: ticket.priority }) });
  }
  await $db.set(sourceKey(ticket.id), { target_id: created.id, last_status: created.status });
  await $db.set(targetKey(created.id), { source_id: ticket.id });
  await call('sourceAddNote', {
    context: { id: ticket.id },
    body: JSON.stringify({
      private: true,
      body: `Escalated to <a href="https://${iparams.target_domain}/a/tickets/${created.id}">${iparams.target_domain} #${created.id}</a>.`
    })
  });
  return { action: 'escalated', source_id: ticket.id, target_id: created.id };
}

async function syncBack(targetId, iparams) {
  const reverse = await dbGet(targetKey(targetId));
  if (!reverse) return { action: 'ignored', reason: 'not a bridged ticket' };
  const link = await dbGet(sourceKey(reverse.source_id));

  const ticket = (await call('targetGetTicket', { context: { id: targetId } })).ticket;
  // Also the loop guard: the bridge's own writes echo back as events with an unchanged status.
  if (ticket.status === link.last_status) return { action: 'ignored', reason: 'status unchanged' };

  const update = { status: ticket.status };
  // Both accounts have a business rule rejecting Resolved/Closed without a resolution note.
  if (ticket.status === 4 || ticket.status === 5) {
    update.resolution_notes = ticket.resolution_notes || `Resolved in ${iparams.target_domain} #${targetId}.`;
  }
  await call('sourceUpdateTicket', { context: { id: reverse.source_id }, body: JSON.stringify(update) });
  await $db.set(sourceKey(reverse.source_id), { target_id: targetId, last_status: ticket.status });
  await call('sourceAddNote', {
    context: { id: reverse.source_id },
    body: JSON.stringify({
      private: true,
      body: `${iparams.target_domain} #${targetId} is now ${STATUS_NAMES[ticket.status] || `status ${ticket.status}`}.`
    })
  });
  return { action: 'synced', source_id: reverse.source_id, target_id: targetId, status: ticket.status };
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

// Records the last decision per ticket so the sidebar can explain why a ticket was or wasn't escalated.
async function runTicketEvent(label, args) {
  const ticket = args.data.ticket;
  const result = await run(label, () => escalate(ticket, args.iparams));
  const seen = {
    event: label,
    at: new Date().toISOString(),
    raw_id: ticket.id,
    raw_display_id: ticket.display_id === undefined ? null : ticket.display_id,
    raw_priority: JSON.stringify(ticket.priority),
    ...result
  };
  try {
    await $db.set(seenKey(ticketNumber(ticket)), seen);
  } catch (err) {
    console.error(label, 'could not record decision', err.message);
  }
  return result;
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((header) => header.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function handleWebhook(args) {
  const token = headerValue(args.headers, 'x-bridge-token');
  if (!args.iparams.webhook_token || token !== args.iparams.webhook_token) {
    return { action: 'rejected', reason: 'bad or missing X-Bridge-Token' };
  }
  const match = TRAILING_DIGITS.exec(String((args.data || {}).ticket_id));
  if (!match) return { action: 'rejected', reason: 'unparseable ticket_id' };
  return syncBack(Number(match[1]), args.iparams);
}

exports = {
  onTicketCreateHandler: function (args) {
    return runTicketEvent('onTicketCreate', args);
  },

  // Fires on priority/status/agent changes (not tag or custom-field edits); covers "raised Low, later made Urgent".
  onTicketUpdateHandler: function (args) {
    return runTicketEvent('onTicketUpdate', args);
  },

  onExternalEventHandler: function (args) {
    return run('onExternalEvent', () => handleWebhook(args));
  },

  onAppInstallHandler: async function () {
    try {
      const url = await generateTargetUrl();
      await $db.set('webhook_url', { url });
      console.info('Webhook URL for the target Workflow Automator:', url);
    } catch (err) {
      console.error('Could not generate webhook URL', err.message);
    }
    renderData();
  }
};

// The FDK runtime has no `module`; this export is only for the unit tests.
if (typeof module !== 'undefined') module.exports = exports;
