// Support-to-IT escalation: a Zendesk ticket tagged for IT becomes a Freshservice incident; IT status changes
// and the resolution flow back to Zendesk as internal notes. IT's private notes never leave Freshservice.
const PRIORITY = { low: 1, normal: 2, high: 3, urgent: 4 };
const STATUS_NAMES = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };
// Webhook bodies may render ids as text; the numeric part is the API id.
const TRAILING_DIGITS = /(\d+)\s*$/;
const zdKey = (id) => `zd:${id}`;
const fsKey = (id) => `fs:${id}`;
const ticketNumber = (ticket) => ticket.display_id || ticket.id;

async function call(template, options) {
  try {
    const res = await $request.invokeTemplate(template, options);
    return res.response ? JSON.parse(res.response) : {};
  } catch (err) {
    const detail = typeof err.response === 'string' ? err.response.slice(0, 300) : err.message;
    const error = new Error(`${template} failed: HTTP ${err.status}: ${detail}`);
    error.status = err.status;
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

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function incidentFields(zdId, zt, org, iparams) {
  const customer = org ? ` · customer <b>${escapeHtml(org.name)}</b>` : '';
  const fields = {
    subject: `[Zendesk #${zdId}] ${zt.subject}`,
    description:
      `<p>Escalated from support: <a href="https://${iparams.zd_domain}/agent/tickets/${zdId}">Zendesk #${zdId}</a>${customer}.</p>` +
      `<p>${escapeHtml(zt.description).replace(/\n/g, '<br>')}</p>`,
    email: iparams.requester_email,
    priority: PRIORITY[zt.priority] || 2,
    status: 2,
    tags: ['zendesk']
  };
  if (iparams.it_group_id) fields.group_id = Number(iparams.it_group_id);
  return fields;
}

const internalNote = (body, extra = {}) => JSON.stringify({ ticket: { comment: { body, public: false }, ...extra } });

async function createIncident(zdId, iparams) {
  const { ticket: zt, organizations = [] } = await call('zdGetTicket', { context: { id: zdId } });
  const org = organizations.find((o) => o.id === zt.organization_id);
  const fields = incidentFields(zdId, zt, org, iparams);
  const created = (await call('fsCreateTicket', { body: JSON.stringify(fields) })).ticket;
  // A priority matrix can recompute priority on create; an explicit update is not overridden.
  if (created.priority !== fields.priority) {
    await call('fsSetPriority', { context: { id: created.id }, body: JSON.stringify({ priority: fields.priority }) });
  }
  return created;
}

async function escalate(zdId, iparams) {
  if (await dbGet(zdKey(zdId))) return { action: 'ignored', reason: 'already escalated' };
  // Claim first so a repeated webhook can't create a second incident.
  try {
    await $db.set(zdKey(zdId), { fs_id: null, last_status: 0 }, { setIf: 'not_exist' });
  } catch {
    return { action: 'ignored', reason: 'already escalated' };
  }

  let created;
  try {
    created = await createIncident(zdId, iparams);
  } catch (err) {
    await $db.delete(zdKey(zdId));
    throw err;
  }
  await $db.set(zdKey(zdId), { fs_id: created.id, last_status: created.status });
  await $db.set(fsKey(created.id), { zd_id: zdId });
  await call('zdUpdateTicket', {
    context: { id: zdId },
    body: internalNote(`Escalated to IT as Freshservice #${created.id}: https://${iparams.fs_domain}/a/tickets/${created.id}`, {
      additional_tags: ['it_escalated']
    })
  });
  return { action: 'escalated', zendesk_id: zdId, freshservice_id: created.id };
}

async function postResolution(link, fsId, status) {
  const fsTicket = (await call('fsGetTicket', { context: { id: fsId } })).ticket;
  const resolution = (fsTicket.resolution_notes || '').trim() || 'No resolution note was added.';
  const body = `IT ${STATUS_NAMES[status].toLowerCase()} Freshservice #${fsId}.\n\nResolution: ${resolution}`;
  try {
    await call('zdUpdateTicket', { context: { id: link.zd_id }, body: internalNote(body, { status: 'solved' }) });
    return 'solved';
  } catch (err) {
    // Zendesk refuses to solve some tickets (e.g. no assignee); the note still has to get through.
    if (err.status !== 422) throw err;
    await call('zdUpdateTicket', { context: { id: link.zd_id }, body: internalNote(`${body}\n\n(Could not set Solved automatically; please solve this ticket.)`) });
    return 'noted';
  }
}

const newStatus = (changes) => (changes && changes.status ? changes.status[1] : null);

async function postStatus(link, fsId, status) {
  if (status === 4 || status === 5) return postResolution(link, fsId, status);
  const name = STATUS_NAMES[status] || `status ${status}`;
  await call('zdUpdateTicket', { context: { id: link.zd_id }, body: internalNote(`IT status for Freshservice #${fsId}: ${name}.`) });
  return 'noted';
}

async function syncStatus(data) {
  const status = newStatus(data.changes);
  if (!status) return { action: 'ignored', reason: 'no status change' };
  const fsId = ticketNumber(data.ticket);
  const reverse = await dbGet(fsKey(fsId));
  if (!reverse) return { action: 'ignored', reason: 'not escalated from Zendesk' };
  const link = { ...(await dbGet(zdKey(reverse.zd_id))), zd_id: reverse.zd_id };
  if (link.last_status === status) return { action: 'ignored', reason: 'status unchanged' };

  const outcome = await postStatus(link, fsId, status);
  await $db.set(zdKey(link.zd_id), { fs_id: fsId, last_status: status });
  return { action: outcome, zendesk_id: link.zd_id, freshservice_id: fsId, status };
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
  return escalate(Number(match[1]), args.iparams);
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

exports = {
  onExternalEventHandler: function (args) {
    return run('zendeskWebhook', () => handleWebhook(args));
  },

  onTicketUpdateHandler: function (args) {
    return run('onTicketUpdate', () => syncStatus(args.data));
  },

  onAppInstallHandler: async function () {
    try {
      const url = await generateTargetUrl();
      await $db.set('webhook_url', { url });
      console.info('Webhook URL for the Zendesk webhook:', url);
    } catch (err) {
      console.error('Could not generate webhook URL', err.message);
    }
    renderData();
  }
};

// The FDK runtime has no `module`; this export is only for the unit tests.
if (typeof module !== 'undefined') module.exports = exports;
