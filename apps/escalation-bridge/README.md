# Freshservice Bridge: Freshworks custom app

A serverless FDK app (platform 3.0, FDK 10.1.9, Node 24.11.0) that ports the Python prototype (`../../prototype/app.py`). It is installed in **yora**.

| Event | What happens |
|---|---|
| `onTicketCreate` / `onTicketUpdate` (yora) | If priority ≥ *Escalate at priority*, or the ticket is tagged `escalate`, create a ticket in the target and add a private back-link note on yora |
| `onExternalEvent` | The target's Workflow Automator calls it on status changes. The yora ticket gets the same status (plus a resolution note for Resolved/Closed) and a private note |
| **Ticket sidebar** (yora ticket page) | Shows the linked target ticket live: status, priority, group, agent, last update, resolution and the latest 3 replies/notes, with a link to open it. All data comes through request templates (`targetGetTicketDetails`, `targetGetAgent`, `targetGetGroup`), so the target API key never reaches the browser |
| `onAppInstall` | Generates the webhook URL for the target workflow and logs it / stores it as `$db` key `webhook_url` |

The links between tickets live in `$db`: `src:<yoraId>` → `{target_id, last_status}` and `tgt:<targetId>` → `{source_id}`. This table is also the loop guard: echo events and repeated events are no-ops. All HTTP goes through request templates (`config/requests.json`). API keys are **secure** iparams and are only ever expanded inside those templates.

## Develop

All commands run from this folder. `fdk` is at `~/.fdk/bin/fdk`, with Node 24 in `~/.fdk/node/bin`.

```sh
PATH="$HOME/.fdk/node/bin:$PATH" npx vitest run --coverage   # unit tests (15, ~100% coverage)
fdk validate
```

## Local simulation (needed before `fdk pack`)

`fdk pack` requires **≥ 50 % local simulation coverage** in addition to the unit tests.

1. Run `fdk run` and leave it running.
2. Open http://localhost:10001/custom_configs and enter the settings:
   - yora domain + API key
   - target domain + API key
   - requester email
   - group `30000423396`
   - custom fields `{"msf_multi_agent_groups":[4]}`
   - a webhook token
3. Open http://localhost:10001/web/test and fire each event: `onAppInstall`, `onTicketCreate`, `onTicketUpdate`, `onExternalEvent`. Edit the sample payload to use a **real yora ticket id** with `priority: 4`, `urgency: 3`, `impact: 3`. For `onExternalEvent`, set `data.ticket_id` to the fwddeploy id that was created and add the header `X-Bridge-Token`.
   ⚠️ These calls hit the real accounts and create a real fwddeploy ticket.
4. For the sidebar, open an escalated yora ticket with `?dev=true` appended, e.g. `https://yora.freshservice.com/a/tickets/20257?dev=true`. Allow the browser to load the local app, then click the app icon in the right sidebar. `fdk pack` also needs ≥ 50 % simulation coverage for the front end.
5. Stop `fdk run` with Ctrl+C. That writes the simulation coverage.
6. Run `fdk pack`. It produces `dist/escalation-bridge.zip`.

## Publish as a custom app (yora only, no review)

1. Open the Neo Admin Center for yora → `/developer` → **Custom App** → **+ Create New App**. Choose **yora Freshservice** as the account, then upload the zip.
2. **Save and Test** → Manage Apps → In Development → **Install** → fill in the settings.
3. Copy the webhook URL from the app's logs (or the `webhook_url` key).
4. In **fwddeploy**: Workflow Automator → Ticket updated, condition *tags contain `bridge`* → **Web Request**:
   - `POST <webhook URL>`
   - header `X-Bridge-Token: <token>`
   - body `{"ticket_id":"{{ticket.id}}"}`
5. Once testing looks good, **Promote to Live**.

See `../../docs/freshworks-custom-app.md` for platform notes and limits.
