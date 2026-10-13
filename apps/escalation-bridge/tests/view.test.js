const { linkedTicketView, decisionView } = require('../app/scripts/view.js');

const ticket = {
  id: 74,
  subject: '[yora #20257] VPN down',
  status: 4,
  priority: 4,
  group_id: 30000423396,
  responder_id: 501,
  updated_at: '2026-09-30T13:54:00Z',
  resolution_notes: 'VPN restored.',
  conversations: [
    { body_text: 'first', private: false, incoming: true, created_at: '2026-09-30T10:00:00Z' },
    { body_text: 'second', private: false, incoming: false, created_at: '2026-09-30T11:00:00Z' },
    { body_text: 'third', private: true, created_at: '2026-09-30T12:00:00Z' },
    { body_text: '  fourth\n\n reply  ', private: false, incoming: true, created_at: '2026-09-30T13:00:00Z' }
  ]
};

describe('linkedTicketView', () => {
  test('summarises the target ticket with names, link and newest three conversations first', () => {
    const view = linkedTicketView(ticket, {
      domain: 'fwd.freshservice.com',
      agent: { agent: { first_name: 'Asha', last_name: 'K' } },
      group: { group: { name: 'Exchange Team' } }
    });

    expect(view.title).toBe('#74 [yora #20257] VPN down');
    expect(view.url).toBe('https://fwd.freshservice.com/a/tickets/74');
    expect(view.status).toBe('Resolved');
    expect(Object.fromEntries(view.rows)).toMatchObject({ Priority: 'Urgent', Group: 'Exchange Team', Agent: 'Asha K' });
    expect(view.resolution).toBe('VPN restored.');
    expect(view.conversations.map((c) => [c.label, c.text])).toEqual([
      ['Requester', 'fourth reply'],
      ['Private note', 'third'],
      ['Agent reply', 'second']
    ]);
  });

  test('falls back to ids, unassigned and placeholders when lookups are missing', () => {
    const view = linkedTicketView(
      { id: 9, subject: 's', status: 7, priority: 9, group_id: 5, responder_id: 6, updated_at: 'garbage' },
      { domain: 'd', agent: null, group: null }
    );
    expect(view.status).toBe('Status 7');
    expect(Object.fromEntries(view.rows)).toEqual({ Priority: 'Priority 9', Group: '#5', Agent: '#6', Updated: '—' });
    expect(view.resolution).toBeNull();
    expect(view.conversations).toEqual([]);
  });

  test('handles unassigned open tickets, agent without a name, and long text', () => {
    const long = 'x'.repeat(400);
    const view = linkedTicketView(
      { id: 1, subject: 's', status: 2, priority: 1, conversations: [{ body_text: long, created_at: null }] },
      { domain: 'd', agent: { agent: { email: 'a@b.c' } }, group: { group: {} } }
    );
    const rows = Object.fromEntries(view.rows);
    expect(rows.Group).toBe('—');
    expect(rows.Agent).toBe('a@b.c');
    expect(rows.Updated).toBe('—');
    expect(view.conversations[0].text).toHaveLength(280);
    expect(view.conversations[0].text.endsWith('…')).toBe(true);
    expect(view.conversations[0].when).toBe('—');
  });

  test('unassigned ticket and resolved ticket without notes', () => {
    const view = linkedTicketView({ id: 2, subject: 's', status: 5, priority: 2 }, { domain: 'd' });
    expect(Object.fromEntries(view.rows).Agent).toBe('Unassigned');
    expect(view.resolution).toBeNull();
  });
});

describe('attachments', () => {
  test('lists https attachments with readable sizes and drops anything else', () => {
    const view = linkedTicketView(
      {
        id: 87, subject: 's', status: 2, priority: 4,
        attachments: [
          { name: 'shot.png', size: 70, attachment_url: 'https://x.ind-attachments.freshservice.com/a?Expires=1' },
          { name: 'log.pdf', size: 2048, attachment_url: 'https://x/b' },
          { name: 'big.docx', size: 3 * 1024 * 1024, attachment_url: 'https://x/c' },
          { name: 'empty.csv', size: 0, attachment_url: 'https://x/d' },
          { name: 'evil', size: 1, attachment_url: 'javascript:alert(1)' },
          { name: 'missing', size: 1 }
        ]
      },
      { domain: 'd' }
    );
    expect(view.attachments).toEqual([
      { name: 'shot.png', size: '70 B', url: 'https://x.ind-attachments.freshservice.com/a?Expires=1' },
      { name: 'log.pdf', size: '2 KB', url: 'https://x/b' },
      { name: 'big.docx', size: '3.0 MB', url: 'https://x/c' },
      { name: 'empty.csv', size: '', url: 'https://x/d' }
    ]);
  });

  test('no attachments gives an empty list', () => {
    expect(linkedTicketView({ id: 1, subject: 's', status: 2, priority: 1 }, { domain: 'd' }).attachments).toEqual([]);
  });
});

describe('decisionView', () => {
  test('explains a missing event, an ignored check and a failure', () => {
    expect(decisionView(null)).toBe('No ticket event has reached the app for this ticket yet.');
    const ignored = decisionView({ event: 'onTicketUpdate', at: 'x', action: 'ignored', reason: 'does not match escalation rule', raw_priority: '2', threshold: 4 });
    expect(ignored).toBe('Last check: onTicketUpdate at — — ignored (does not match escalation rule). Priority seen 2, needs 4 or above.');
    expect(decisionView({ event: 'onTicketCreate', at: null, action: 'failed', error: 'targetCreateTicket failed: HTTP 400' }))
      .toBe('Last check: onTicketCreate at — — failed: targetCreateTicket failed: HTTP 400.');
    expect(decisionView({ event: 'onTicketCreate', at: null, action: 'escalated' })).toBe('Last check: onTicketCreate at — — escalated.');
  });
});
