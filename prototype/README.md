# Python prototype: freshservice-bridge

Small FastAPI middleware linking two Freshservice accounts:

- **yora → fwddeploy (escalate):** a yora ticket with priority Urgent (4), or the tag `escalate`, is
  raised as a new ticket in fwddeploy. A private note on the yora ticket links to the copy.
- **fwddeploy → yora (status sync):** when the fwddeploy copy changes status, the yora ticket gets the
  same status plus a private note.
- **Loop guard / idempotency:** links are stored in SQLite (`bridge.db`), so repeated or echoed webhooks
  (including the ones the bridge's own writes trigger) are no-ops.

Webhooks carry only the ticket id. The bridge re-reads the ticket via the API, so the data it acts on is always current.

## Setup

`.freshservice.env` in the repository root (git-ignored, `chmod 600`):

```sh
export FS_YORA_KEY=...                 # yora: Profile Settings → Your API Key
export FS_FWD_KEY=...                  # fwddeploy: same
export BRIDGE_SECRET_YORA=...          # any long random string, e.g. `openssl rand -hex 16`
export BRIDGE_SECRET_FWD=...
export BRIDGE_REQUESTER_EMAIL=...      # requester used for tickets raised in fwddeploy
# optional
# export BRIDGE_TARGET_GROUP_ID=...    # fwddeploy group to assign escalations to
# export BRIDGE_TARGET_WORKSPACE_ID=...
# fwddeploy IT requires msf_multi_agent_groups: ids of records in its "Agent Groups" custom object
# (4 = Exchange Team, 5 = Hardware Team, 6 = Database Team), not agent group ids.
# export BRIDGE_TARGET_GROUP_ID=30000423396
# export BRIDGE_TARGET_CUSTOM_FIELDS='{"msf_multi_agent_groups":[4]}'
# export BRIDGE_ESCALATE_PRIORITY=4
```

## Test

```sh
python3 -m unittest discover -s tests -t . -v          # offline, fake Freshservice
set -a && source ../.freshservice.env && set +a && python3 live_smoke.py    # real accounts, creates 1 ticket in each
```

## Run

```sh
set -a && source ../.freshservice.env && set +a && python3 -m uvicorn app:main --factory --port 8787
```

Freshservice can't call `localhost`. Expose the port with a tunnel, e.g. `cloudflared tunnel --url http://localhost:8787`,
or deploy it anywhere public.

## Workflow Automator (one per account)

Admin → Workflow Automator → New (Ticket):

| | yora | fwddeploy |
|---|---|---|
| Event | Ticket is raised **or** updated | Ticket is updated (status changed) |
| Condition | Priority is Urgent, or tags contain `escalate` | Tags contain `bridge` |
| Action | Web Request / Trigger webhook | Web Request / Trigger webhook |
| URL | `POST https://<public-url>/webhook/yora` | `POST https://<public-url>/webhook/fwddeploy` |
| Header | `X-Bridge-Secret: $BRIDGE_SECRET_YORA` | `X-Bridge-Secret: $BRIDGE_SECRET_FWD` |
| Body (JSON) | `{"ticket_id": "{{ticket.id}}"}` | `{"ticket_id": "{{ticket.id}}"}` |

`{{ticket.id}}` may render as `INC-12` or `#SR-12`. The bridge uses the trailing number.

## Responses

`200 {"action": "escalated" | "synced" | "ignored", ...}` · `401` bad secret · `404` unknown tenant ·
`422` unparseable ticket id · `502` Freshservice rejected the call (body has tenant, HTTP status, detail).
