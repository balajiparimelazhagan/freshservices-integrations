# Support-to-IT Escalation: Zendesk → Freshservice

A Freshworks custom app (platform 3.0, FDK 10.1.9) installed in Freshservice.

| Direction | Trigger | Result |
|---|---|---|
| Zendesk → Freshservice | A Zendesk trigger (tag `it_escalation` added) calls the app's webhook | A Freshservice incident is created with the subject, the description, a link to the Zendesk ticket, the customer organisation and the mapped priority. An internal note with the IT ticket link is posted on the Zendesk ticket, which also gets the tag `it_escalated` |
| Freshservice → Zendesk | An IT agent changes the incident's status (`onTicketUpdate`) | An internal note goes to Zendesk with the new status. On Resolved or Closed, the resolution note is posted and the Zendesk ticket is set to **Solved** |

## Rules

- **One incident per Zendesk ticket.** The link is claimed in `$db` (`zd:<id>`, `fs:<id>`) before creating, so repeated or concurrent webhooks are ignored. If the create fails, the claim is released so the next webhook retries.
- Priority is mapped: Zendesk low/normal/high/urgent → Freshservice 1–4. It is set again explicitly if the account's priority matrix changes it.
- **Only status names and the resolution note go back to Zendesk**, always as internal (non-public) comments. IT's notes never leave Freshservice.
- If Zendesk refuses to set Solved (HTTP 422, for example when the ticket has no assignee), the resolution is still posted with a request to solve the ticket by hand.
- The webhook needs the `X-Bridge-Token` header.
- `onTicketUpdate` fires for status changes made in the Freshservice UI. Changes made through the API with an API key don't trigger app events.

## Zendesk setup

1. **Webhook:** Admin Center → Apps and integrations → Webhooks → Create.
   - Endpoint: the app's webhook URL (from the install log or `$db webhook_url`), method POST, JSON.
   - Authentication: API key, header `X-Bridge-Token`, value = the token setting.
2. **Trigger:** Objects and rules → Triggers → Add.
   - Conditions: *Tags contains at least one of* `it_escalation`, and *Tags contains none of* `it_escalated`.
   - Action: Notify webhook, body `{"ticket_id": "{{ticket.id}}"}`.

## Develop

```sh
PATH="$HOME/.fdk/node/bin:$PATH" npx vitest run --coverage   # 15 tests
fdk validate    # one known false positive: "possible deprecated API usage" on resolution_notes; only /api/v2 is used
```
