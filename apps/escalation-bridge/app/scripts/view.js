// Turns Freshservice API responses into what the sidebar shows. No DOM here so it can be unit-tested.
const STATUS_NAMES = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };
const PRIORITY_NAMES = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const MAX_CONVERSATIONS = 3;
const MAX_TEXT = 280;

function truncate(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return isNaN(date) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function agentName(agentResponse) {
  const agent = agentResponse && agentResponse.agent;
  return agent ? [agent.first_name, agent.last_name].filter(Boolean).join(' ') || agent.email : null;
}

function groupName(groupResponse) {
  return (groupResponse && groupResponse.group && groupResponse.group.name) || null;
}

function conversationLabel(conversation) {
  if (conversation.private) return 'Private note';
  return conversation.incoming ? 'Requester' : 'Agent reply';
}

function labelOr(names, value, prefix) {
  return names[value] || `${prefix} ${value}`;
}

function idOr(name, id, fallback) {
  return name || (id ? `#${id}` : fallback);
}

function resolutionText(ticket) {
  return ticket.status >= 4 ? truncate(ticket.resolution_notes, MAX_TEXT) || null : null;
}

function conversationsView(conversations) {
  return (conversations || [])
    .slice(-MAX_CONVERSATIONS)
    .reverse()
    .map((conversation) => ({
      label: conversationLabel(conversation),
      when: formatDate(conversation.created_at),
      text: truncate(conversation.body_text, MAX_TEXT)
    }));
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// attachment_url is a signed link valid for ~24h and usable without a login in the other account;
// the sidebar refetches the ticket on every open, so links are always fresh.
function attachmentsView(attachments) {
  return (attachments || [])
    .filter((attachment) => /^https:\/\//.test(attachment.attachment_url || ''))
    .map((attachment) => ({ name: attachment.name, size: formatSize(attachment.size), url: attachment.attachment_url }));
}

function linkedTicketView(ticket, { domain, agent, group }) {
  return {
    title: `#${ticket.id} ${ticket.subject}`,
    url: `https://${domain}/a/tickets/${ticket.id}`,
    status: labelOr(STATUS_NAMES, ticket.status, 'Status'),
    rows: [
      ['Priority', labelOr(PRIORITY_NAMES, ticket.priority, 'Priority')],
      ['Group', idOr(groupName(group), ticket.group_id, '—')],
      ['Agent', idOr(agentName(agent), ticket.responder_id, 'Unassigned')],
      ['Updated', formatDate(ticket.updated_at)]
    ],
    resolution: resolutionText(ticket),
    attachments: attachmentsView(ticket.attachments),
    conversations: conversationsView(ticket.conversations)
  };
}

function decisionView(seen) {
  if (!seen) return 'No ticket event has reached the app for this ticket yet.';
  const when = formatDate(seen.at);
  const outcome =
    seen.action === 'failed'
      ? `failed: ${seen.error}`
      : `${seen.action}${seen.reason ? ` (${seen.reason})` : ''}`;
  const detail = seen.threshold ? ` Priority seen ${seen.raw_priority}, needs ${seen.threshold} or above.` : '';
  return `Last check: ${seen.event} at ${when} — ${outcome}.${detail}`;
}

const BridgeView = { linkedTicketView, decisionView };

if (typeof module !== 'undefined') module.exports = BridgeView;
