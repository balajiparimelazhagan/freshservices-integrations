/* global app, BridgeView */
const MAX_HEIGHT = 700;

// Grow the sidebar to fit its content so agents don't scroll inside a short box. Resizing is best-effort.
function fit(client) {
  const height = Math.min(document.body.scrollHeight, MAX_HEIGHT);
  return Promise.resolve()
    .then(() => client.instance.resize({ height: `${height}px` }))
    .catch(() => null);
}

async function invoke(client, template, id) {
  const res = await client.request.invokeTemplate(template, { context: { id } });
  return JSON.parse(res.response);
}

function optional(promise) {
  return promise.catch(() => null);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(...nodes) {
  document.getElementById('content').replaceChildren(...nodes);
}

function showMessage(text, className = 'muted') {
  show(el('p', className, text));
}

function renderTicket(view) {
  const header = el('div', 'header');
  const link = el('a', 'title', view.title);
  link.href = view.url;
  link.target = '_blank';
  link.rel = 'noopener';
  header.append(link, el('span', `status status-${view.status.toLowerCase()}`, view.status));

  const rows = el('dl', 'rows');
  view.rows.forEach(([label, value]) => rows.append(el('dt', null, label), el('dd', null, value)));

  const nodes = [header, rows];
  if (view.resolution) nodes.push(el('h4', null, 'Resolution'), el('p', 'resolution', view.resolution));

  if (view.attachments.length) {
    const list = el('ul', 'attachments');
    view.attachments.forEach((attachment) => {
      const link = el('a', null, attachment.name);
      link.href = attachment.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const item = el('li');
      item.append(link, el('span', 'meta', attachment.size ? ` · ${attachment.size}` : ''));
      list.append(item);
    });
    nodes.push(el('h4', null, `Attachments (${view.attachments.length})`), list);
  }

  nodes.push(el('h4', null, 'Latest activity'));
  if (!view.conversations.length) nodes.push(el('p', 'muted', 'No replies or notes yet.'));
  view.conversations.forEach((conversation) => {
    const item = el('div', 'conversation');
    item.append(el('div', 'meta', `${conversation.label} · ${conversation.when}`), el('p', null, conversation.text));
    nodes.push(item);
  });
  show(...nodes);
}

async function dbGet(client, key) {
  try {
    return await client.db.get(key);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function fetchTarget(client, targetId) {
  const [{ target_domain: domain }, details] = await Promise.all([
    client.iparams.get('target_domain'),
    invoke(client, 'targetGetTicketDetails', targetId)
  ]);
  const target = details.ticket;
  const [agent, group] = await Promise.all([
    target.responder_id ? optional(invoke(client, 'targetGetAgent', target.responder_id)) : null,
    target.group_id ? optional(invoke(client, 'targetGetGroup', target.group_id)) : null
  ]);
  return BridgeView.linkedTicketView(target, { domain, agent, group });
}

async function renderFor(client) {
  const { ticket } = await client.data.get('ticket');
  const number = ticket.display_id || ticket.id;
  const link = await dbGet(client, `src:${number}`);
  if (!link) {
    const seen = await dbGet(client, `seen:${number}`);
    return show(el('p', null, 'This ticket has not been escalated.'), el('p', 'muted', BridgeView.decisionView(seen)));
  }
  if (!link.target_id) return showMessage('Escalation in progress — refresh in a moment.');
  return renderTicket(await fetchTarget(client, link.target_id));
}

async function load(client) {
  showMessage('Loading linked ticket…');
  try {
    await renderFor(client);
  } catch (err) {
    showMessage(`Could not load the linked ticket${err.status ? ` (HTTP ${err.status})` : ''}.`, 'error');
  }
  return fit(client);
}

function start(client) {
  document.getElementById('refresh').addEventListener('click', () => load(client));
  client.events.on('app.activated', () => load(client));
}

document.addEventListener('DOMContentLoaded', () => {
  app.initialized().then(start, () => showMessage('Could not start the app.', 'error'));
});
