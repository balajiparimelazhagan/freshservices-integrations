# Freshworks custom app: reference for the yora ↔ fwddeploy bridge

> Researched 2026-09-30 from developers.freshworks.com (App SDK **v3.0**). Items marked ⚠️ were
> ambiguous or contradictory in the docs. Check them against what `fdk create` generates.
> Companion to the working Python middleware in this repo (`app.py`, `README.md`).

---

## 1. Where we are (context for a new chat session)

- **Accounts:**

  | Name | Freshservice | Freshworks org |
  |---|---|---|
  | **yora** (source) | `yora.freshservice.com` | `yora.myfreshworks.com` |
  | **fwddeploy** (target) | `fwddeployhelpdesk.freshservice.com` | `fwddeploy-org.myfreshworks.com` |

  They are separate orgs. "Move Account" in the admin center only changes org membership and does not sync data.
- **Scenario (already working as Python middleware, verified live):**
  1. yora ticket with priority Urgent (4) or tag `escalate` → create a ticket in fwddeploy and add a private back-link note on yora.
  2. fwddeploy status change → mirror the status to yora and add a note.
  3. Loop guard: store `source_id ↔ target_id ↔ last_status` and ignore echoes and duplicates.
- **Goal now:** re-implement this as a **Freshworks custom app** (FDK, serverless) and later publish it to the Marketplace.

### Account quirks found in live testing (the app must handle these too)

| Account | Quirk | Handling |
|---|---|---|
| yora | Priority matrix: priority is derived from urgency × impact, and `priority` on create is ignored | Send `urgency` + `impact` (3/3 → Urgent) |
| both | `GET /tickets/{id}` omits `tags` | `GET /tickets/{id}?include=tags` |
| both | Multi-workspace (IT = 2, HR = 3 in fwddeploy; yora tickets are in ws 2) | Optional `workspace_id` |
| fwddeploy | `custom_fields.msf_multi_agent_groups` required (IT ws). It is a **custom_multi_lookup** into the custom object "Agent Groups", so its values are *record ids* | `4` = Exchange Team (group `30000423396`), `5` = Hardware Team (`30000380411`), `6` = Database Team (`30000380410`) |
| fwddeploy (and likely yora) | Business rule: Resolved/Closed requires `resolution_notes` | Always send `resolution_notes` when status is 4 or 5 |

Freshservice API: `https://<domain>/api/v2/…`, HTTP Basic auth with `<api_key>:X`. Status values: 2 Open, 3 Pending, 4 Resolved, 5 Closed. Priority values: 1–4.

---

## 2. Platform basics

| Topic | What to know |
|---|---|
| SDK | App SDK / platform **v3.0** (module-based). Freshservice modules: `common`, `service_ticket`, `service_user`, `service_asset`, `service_change`, … (MSP edition: only `service_ticket`, `service_user`) |
| CLI | **FDK** (`fdk`). Current docs: **FDK 10.x + Node 24.11.x**. Node 18 support was deprecated 2026-03-20. ⚠️ The macOS install page still says Node 18 / FDK 9.4.1; follow the newer requirement |
| App kinds | **Front-end** (UI in ticket sidebar etc.), **serverless** (`server/server.js`: product/app/scheduled/external events), or **hybrid** |
| Our app | **Serverless only.** There's no UI beyond the install settings page |

> **Installed on this Mac (2026-09-30): FDK 10.1.9 at `~/.fdk`.** It has its own Node 24.11.0 in `~/.fdk/node`, and
> the launcher `~/.fdk/bin/fdk` is on PATH through `~/.zshrc`. The system `node` stays at 22.
>
> The Homebrew formula below **fails on Homebrew 7**: its `npm config set prefix` hits `EPERM chmod /dev/null`. It also
> needs the Command Line Tools for Xcode 26.6 on macOS Tahoe. So the same steps were done by hand instead:
> 1. Download the nodejs.org tarball for Node 24.11.0 and verify its sha256.
> 2. Run `npm install -g --prefix ~/.fdk/node https://cdn.freshdev.io/fdk/latest-v24.tgz`.

### Install the CLI (macOS), official Homebrew route

```bash
brew tap freshworks-developers/homebrew-tap
```

```bash
brew install fdk
```

Add to `~/.zshrc`, then open a new terminal:

```bash
source "$(brew --repository freshworks-developers/homebrew-tap)/path.bash.inc"
```

```bash
fdk version
```

### CLI commands

| Command | Purpose |
|---|---|
| `fdk create` | Scaffold an app (choose the product/module and a template, e.g. `common-starter-template`) |
| `fdk run` | Local server on `http://localhost:10001`. Front-end: open the product with `?dev=true`. **Serverless events: simulate at `http://localhost:10001/web/test`** |
| `fdk validate [--fix]` | Lint and platform checks |
| `fdk pack` | Build the submission `.zip` in `dist/`. **Requires ≥ 50 % coverage** (statements, branches, functions, lines, each) from `fdk run` simulation, and ≥ 80 % if unit tests (`fdk unit-test`) are configured |
| `fdk generate` | Generate config files interactively |
| `fdk config set request.timeout 20000` | Local request timeout (15000/20000/25000/30000) |
| `fdk unit-test` | Run unit tests (`fdk test` is legacy, deprecated 2026-07-09) |

### Folder layout (serverless app)

```
manifest.json          # platform-version, modules, events, request templates, engines
server/server.js       # exports = { handlerName(payload) {...} }
config/iparams.json    # installation settings (API key, domain, routing…)
config/requests.json   # request templates (all outbound HTTP)
app/                   # front-end (not needed for us beyond icon)
```

---

## 3. Building blocks we need

### 3.1 Product events: `onTicketCreate` / `onTicketUpdate` (module `service_ticket`)

```json
"modules": {
  "common": { "requests": { "fwdCreateTicket": {}, "fwdGetTicket": {} } },
  "service_ticket": {
    "events": {
      "onTicketCreate": { "handler": "onTicketCreateHandler" },
      "onTicketUpdate": { "handler": "onTicketUpdateHandler" }
    }
  }
}
```

⚠️ Some doc snippets show `modules` as an array. The v3 examples for events and requests use the **object** form above. Trust `fdk create` output.

- **The payload** (`payload.data`) contains:
  - `ticket`: `id`, `subject`, `description`, `status`, `status_name`, `priority`, `urgency`, `impact`, `group_id`, `workspace_id`, `custom_fields`, `tags`, …
  - `requester`
  - `actor.profile_id`
  - on update only, `changes`: `{ field: [old, new] }`, e.g. `"status": [2, 4]`

  `payload.iparams` holds the non-secure settings.
- **`onTicketUpdate` fires on:** status, priority, type, source, agent/group, spam, escalation and similar changes.
- ⚠️ **It does NOT fire on custom-field or tag changes.** This means the "tag `escalate`" trigger only works if the tag is present at creation. For later tagging, use a Workflow Automator webhook into an external event (§3.4).

### 3.2 Request method: all outbound HTTP (to the other account's API)

`config/requests.json`:

```json
{
  "fwdCreateTicket": {
    "schema": {
      "method": "POST",
      "host": "<%= iparam.target_domain %>",
      "path": "/api/v2/tickets",
      "headers": {
        "Authorization": "Basic <%= encode(iparam.target_api_key + ':X') %>",
        "Content-Type": "application/json"
      }
    },
    "options": { "maxAttempts": 2, "retryDelay": 1000 }
  },
  "fwdGetTicket": {
    "schema": {
      "method": "GET",
      "host": "<%= iparam.target_domain %>",
      "path": "/api/v2/tickets/<%= context.id %>",
      "query": { "include": "tags" },
      "headers": { "Authorization": "Basic <%= encode(iparam.target_api_key + ':X') %>" }
    }
  }
}
```

⚠️ Check the exact `encode()` expression syntax for Basic auth (`key:X`) in a live `fdk run`.

- Declare every template name under `modules.common.requests`. The name must match in all three places: code, `requests.json` and `manifest.json`.
- **Invoking a template:**
  - serverless: `await $request.invokeTemplate("fwdCreateTicket", { body: JSON.stringify(fields) })`
  - front-end: `client.request.invokeTemplate(...)`
- **Response:** `{ status, headers, response: "<json string>" }`. Parse `response`.
- **Substitutions:**

  | Syntax | Allowed in |
  |---|---|
  | `<%= iparam.x %>` | host, path, headers, query |
  | `<%= encode(iparam.secure) %>` | headers only |
  | `<%= context.x %>` | path, headers, query |
  | `<%= access_token %>` | OAuth |

- **Limits:**
  - HTTPS and a real FQDN only (no IPs)
  - 15 s default timeout, up to 30 s
  - **50 requests/min per app per account**
  - 100 KB request body, 6 MB response
- **Errors:** 429 (rate limit), 502 (connection), 504 (timeout), 400 "domain not whitelisted" (when IP allowlisting is on).

### 3.3 Installation parameters: `config/iparams.json`

```json
{
  "target_domain":   { "display_name": "Target Freshservice domain", "type": "text", "required": true,
                       "description": "e.g. fwddeployhelpdesk.freshservice.com" },
  "target_api_key":  { "display_name": "Target API key", "type": "text", "required": true, "secure": true },
  "source_api_key":  { "display_name": "This account's API key (for write-backs)", "type": "text", "required": true, "secure": true },
  "requester_email": { "display_name": "Requester email in target", "type": "email", "required": true },
  "target_group_id": { "display_name": "Target group id", "type": "number" },
  "target_custom_fields": { "display_name": "Target custom_fields JSON", "type": "paragraph",
                       "default_value": "{\"msf_multi_agent_groups\":[4]}" },
  "webhook_secret":  { "display_name": "Shared secret for inbound webhooks", "type": "text", "required": true, "secure": true }
}
```

- **Types:** text, paragraph, dropdown, email, number, phone_number, date, url, radio, checkbox, multiselect, and in older docs domain/api_key.
- ⚠️ v3 module apps should use `text` rather than `domain`/`api_key`.
- `regex` validation is supported.
- **Secure iparams** (FDK ≥ 9.5) are masked and **only usable inside request templates** (headers). Never read them with `client.iparams.get()`.
- ⚠️ It's unclear whether `payload.iparams` in serverless includes secure values. Design so secrets are only used in templates.
- A **custom settings page** (HTML) is possible if the plain form isn't enough, for example a dropdown populated from the target's groups.

### 3.4 External events: the reverse direction (fwddeploy → yora)

- `generateTargetUrl()` gives a per-installation webhook URL. It can only be called in `onAppInstall`, `afterAppUpdate`, or a product event handler. Store the URL with `$db` and show it to the admin, for example in logs or a note.
- **manifest:** `common.events.onExternalEvent`, `onAppInstall` and `onAppUninstall`.
- **Payload:** `data`, `headers`, `iparams`, `currentHost`, `region`, `timestamp`.
- **The platform does not authenticate inbound calls.** Check a shared-secret header yourself (`payload.headers["x-bridge-secret"]` vs the iparam).
- **Limits:** 250 triggers/min, 100 KB payload, 20 s execution.
- **Wiring:** fwddeploy Workflow Automator → Web Request → POST the target URL with body `{"ticket_id":"{{ticket.id}}"}` and header `X-Bridge-Secret`.

### 3.5 Data storage: our link table

- **Key-value `$db`:**
  - `$db.set(key, value)`, `$db.get(key)`, `$db.update(key, "set", {...})`, `$db.delete(key)`
  - key ≤ 60 chars; key + value ≤ 40 KB
  - **50 ops/min per app**
- **Suggested keys:**
  - `link:src:<yoraId>` → `{ target_id, last_status }`
  - `link:tgt:<fwdId>` → `{ source_id }`
- **Idempotency:** `$db.set(key, value, { setIf: "not_exist" })` gives an atomic "create once". Use it as the duplicate-escalation guard in place of the Python lock.
  - ⚠️ Confirm that `setIf` exists in v3.
- **Entity storage** (custom objects) is an alternative: ≤ 5 entities, 10k records each, 20 fields, 100 KB per record, 50 triggers/min.

### 3.6 Other limits

| Limit | Value |
|---|---|
| Serverless handler execution | **20 s**, not extendable for product events; external events can be 40 s if configured |
| Outbound requests | 50/min per app per account (§3.2) |
| `$db` operations | 50/min per app (§3.5) |

The request and `$db` limits apply **together**. One escalation costs roughly: 1 GET + 1 create + 1 note (requests) and 2 `$db` writes.

---

## 4. Architecture for our app

**Constraint:** a **custom app is published to exactly one account**. Two options:

| Option | How | Trade-off |
|---|---|---|
| **A. One app, installed in yora** (recommended to start) | `onTicketCreate`/`onTicketUpdate` in yora → request templates to fwddeploy. fwddeploy → yora through a Workflow Automator webhook into the app's `onExternalEvent`. The app then updates yora with a template using `source_api_key` | One install and one link table. Needs one workflow in fwddeploy |
| B. Same code, two custom apps (one per account) | Each side uses its own product events | Two link tables to keep consistent. Harder loop guard |
| C. Public app | Installable in both accounts from one listing | Marketplace review, privacy questionnaire, support/privacy URLs |

### Handler logic (mirrors `app.py`)

```js
// server/server.js (sketch)
exports = {
  async onTicketCreateHandler(payload)  { await maybeEscalate(payload.data.ticket, payload.iparams); },
  async onTicketUpdateHandler(payload)  {
    // escalate if it became urgent; ignore our own echo writes (link exists)
    await maybeEscalate(payload.data.ticket, payload.iparams);
  },
  async onExternalEventHandler(payload) {
    // verify payload.headers['x-bridge-secret'] (compare against a non-secure hash, or route the check via a request template)
    // parse trailing digits of data.ticket_id → GET target ticket (fwdGetTicket)
    // look up link:tgt:<id>; if status === last_status → ignore (loop guard)
    // else PUT yora ticket {status, resolution_notes if 4/5} + private note; update last_status
  },
  async onAppInstallHandler() { const url = await generateTargetUrl(); await $db.set('webhook_url', { url }); renderData(); }
};
```

⚠️ **Secret check in `onExternalEvent`:** secure iparams may not be readable in code. Options:
- store a *hash* of the secret as a non-secure iparam, or
- put the secret in the fwddeploy workflow URL's query string and compare it against a non-secure iparam. That is weaker, but the target URL is already unguessable.

---

## 5. Test → publish flow

### 5.1 Local

1. Run `fdk run`.
2. Open `http://localhost:10001/web/test`, pick `onTicketCreate`, and edit the sample payload (priority 4, urgency 3, impact 3).
3. Fill iparams through `http://localhost:10001/custom_configs`. They're stored in `.fdk/configs.json`, which must be git-ignored.
4. Requests really go to fwddeploy, so each run creates real tickets. Use a `[bridge-test]` subject.
5. Get coverage ≥ 50 % through simulation, then `fdk validate`, then `fdk pack` → `dist/<app>.zip`.

### 5.2 Publish as a custom app (private, **no review**, live in ≤ 30 min)

1. Open the developer portal: **Neo Admin Center (`yora.myfreshworks.com`) → My Accounts → `/developer`**, or in Freshservice **Admin → Apps → "Build it yourself"**.
2. Go to **Custom App → + Create New App → Custom App** and **select the product account** (for option A: yora Freshservice). This can't be moved later.
3. **Upload App file** (the zip) and give it a 2–3 word name.
4. Fill in:
   - App Information: overview, short description
   - Media: PNG icon ≥ 400×400, 1:1; screenshots ≥ 1600×1000, up to 5
   - Support email
5. **Save and Test** → **Manage Apps → In Development → Install** → enter iparams → test.
6. **Promote to Live** (or **Save and Publish**). Status goes "Publishing In Progress" → **Published** within about 30 min.

**Versions:**
- **Add new version** creates a draft test version. There's only 1 test version at a time, and at most 3 published versions show.
- Installed apps show **Update**.

### 5.3 Publish as a public Marketplace app (later)

1. Go to the developer portal → **Public App** tab → **Freshworks App** and upload the zip. The product is auto-detected from modules and **the product choice is permanent**.
2. Complete the listing:
   - name, overview, short description (≤ 100 chars), up to 3 categories
   - pricing: free by default. Paid is per agent or per account per month, and **a paid app can never go back to free**.
3. Provide the required URLs:
   - demo/spec video (YouTube or Vimeo)
   - support email, alternate email, support URL
   - **privacy policy URL, terms of service URL**
4. Answer the **privacy & security questionnaire**:
   - data collected and stored, third-party domains (≤ 5)
   - encryption, OWASP compliance, EEA transfers
   - deletion on uninstall, retention period
5. Save and Publish → **"Draft Version (Under Review)"**. The review timeline isn't documented.
   - If rejected → "Draft Version (Rejected)". Fix it and upload again.
6. After approval:
   - release notes are mandatory for each new version; auto-update is optional
   - "Hide from gallery" plus shareable URLs lets you limit who can install it
7. Read these first:
   - [Content guidelines](https://developers.freshworks.com/docs/guides/submission-guidelines/content-guidelines/)
   - [Code guidelines](https://developers.freshworks.com/docs/guides/submission-guidelines/code-guidelines/)

   Our risks: no hardcoded secrets, secure iparams only in templates, error handling, and no PII in logs.

---

## 6. Open questions to settle during the build

- [x] FDK/Node: **FDK 10.1.9 + Node 24.11.0** (installed at `~/.fdk`).
- [x] Manifest shape: `modules` is an **object** (`common`, `service_ticket`), and `engines` is `{"node":"24.11.0","fdk":"10.1.9"}`. `fdk create --template serverless-starter-template` defaults to Freshdesk's `support_ticket`, so switch it to `service_ticket`.
- [x] `fdk validate` only recognises handlers declared as `name: function (args) {}` (or `async function`). **Arrow-function handlers show up as "not declared"**.
- [x] `fdk pack` needs **both** unit-test coverage ≥ 80 % (vitest, via the `fdk-unit-test` script) **and** local simulation coverage ≥ 50 % from `fdk run` plus firing events at `/web/test`.
- [x] `encode(iparam.key + ':X')` works for Freshservice Basic auth in request templates (verified live 2026-09-30).
- [x] `$db.set(..., { setIf: "not_exist" })` is accepted by the local v3 runtime. A failed create released the claim, and the retry escalated.
- [ ] Secure iparams in serverless `args.iparams`. **Locally they are present, in plain text.** Production behaviour is unconfirmed, so the webhook token stays non-secure for now.
- [ ] Does `{{ticket.id}}` in Workflow Automator render as `INC-12` or `12`? Both are handled.
- [ ] Option A vs C: do we ever need it installable in accounts other than yora?

App code: `apps/escalation-bridge/` (see its README for simulation and publish steps).

**Local simulation, 2026-09-30:**
- yora #20257 → fwddeploy #74, routed correctly and with the back-link note.
- The duplicate update was ignored.
- Resolving #74 → the webhook set yora #20257 to Resolved with #74's resolution note.
- The duplicate webhook was ignored.

| Coverage | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| Simulation | 89 % | 55 % | 90 % | 93 % |
| Unit | 100 % | 93 % | 100 % | 100 % |

`fdk pack` produced `dist/fdk-app.zip` (the folder is now `apps/escalation-bridge`, so the zip is `escalation-bridge.zip`).

**Gotchas:**
- The FDK runtime has no `module` object, so guard `module.exports`.
- **`fdk run` writes secure iparams in plain text to `log/fdk.log` and `.fdk/localstore`.** Both are git-ignored; delete the log after testing.
- **Installed app, 2026-10-12:** product events fired for **UI** changes but **not** for changes made through the REST API with an API key, so test the installed app by editing tickets in the UI. The first live escalation was yora #20268 → fwddeploy #87.
- **Priority matrix:** if an agent sets priority by hand (e.g. Urgent with urgency Low × impact High), copying urgency and impact lets the target's matrix recompute a *lower* priority (#87 became Medium). The app now sends an explicit `PUT priority` when the created ticket's priority differs; a direct priority edit is not overridden by the matrix.
- The installed app's `$db` is separate from `fdk run`'s local store. Links made during simulation don't exist in production.
- The sidebar shows the last decision per ticket (`seen:<number>`), which makes debugging possible without reaching the app logs.
- **Attachments** (decided 2026-10-13: sidebar links only, original ticket files only):
  - `GET /tickets/{id}` returns `attachments[]` with `name`, `size`, `content_type` and a CloudFront-signed `attachment_url` on `<account>.ind-attachments.freshservice.com`.
  - The URL is valid for **24 h** and works **without a login**. The sidebar refetches on every open, so its links are always fresh.
  - Copying actual files was ruled out for now. FDK uploads must come from `$files` object storage, which only accepts PNG/JPG/PDF/Office/CSV/JSON, ≤ 40 MB per file and 100 MB per app, and there is no documented way to download a remote file into it.
- The `/web/test` UI is flaky to automate. Instead, write the payload to `server/test_data/<module>/<event>.json` and run `curl -X POST "localhost:10001/event/execute?name=<event>&module=<module>"`.

## 7. Sources

- [Getting started](https://developers.freshworks.com/docs/getting-started/)
- [Install Freshworks CLI](https://developers.freshworks.com/docs/getting-started/freshworks-cli-setup/)
- [Create your first Freshservice app](https://developers.freshworks.com/docs/getting-started/freshservice/create-first-app/)
- [App development process (v3.0)](https://developers.freshworks.com/docs/app-sdk/v3.0/common/app-development-process/)
- [onTicketCreate / onTicketUpdate (service_ticket, v3.0)](https://developers.freshworks.com/docs/app-sdk/v3.0/service_ticket/serverless-apps/product-events/onticket/)
- [Request method (v3.0)](https://developers.freshworks.com/docs/app-sdk/v3.0/support_ticket/advanced-interfaces/request-method/)
- [Installation settings / iparams (v3.0)](https://developers.freshworks.com/docs/app-sdk/v3.0/common/app-settings/installation-settings-page/)
- [External events (v3.0)](https://developers.freshworks.com/docs/app-sdk/v3.0/service_change/serverless-apps/external-events/)
- [Key-value storage (v3.0)](https://developers.freshworks.com/docs/app-sdk/v3.0/support_contact/data-store/key-value-storage/)
- [Entity storage (v3.0)](https://developers.freshworks.com/docs/app-sdk/v3.0/service_change/data-store/entity-storage/)
- [CLI command reference (v3.0)](https://developers.freshworks.com/docs/app-sdk/v3.0/support_ticket/basic-dev-tools/freshworks-cli/)
- [Custom apps: submission](https://developers.freshworks.com/docs/app-sdk/v2.3/freshdesk/app-submission-process/custom-apps/)
- [Public app submission process](https://developers.freshworks.com/docs/guides/submission-guidelines/submission-process/freshworks-app/)


## 8. Second app: HR Sync (BambooHR → Freshservice), started 2026-10-13

- Code is in `apps/hr-sync/`; its README covers behaviour, safety rules and limits.
- **Design:** polling, not webhooks. A recurring `$schedule` every 15 min calls BambooHR `GET /v1/employees/changed?since=` with a cursor kept in `$db`, so the trial needs no webhook setup. `onExternalEvent` with an `X-Run-Token` header runs a sync on demand.
- **yora is a real directory.** The app links only requesters it created (`external_id = bamboohr:<id>` plus `$db emp:<id>`), never adopts by email, only deactivates, and syncs only emails matching `email_filter` (set it to the user's plus-addresses for testing).
- The yora API key gets **403 on `/api/v2/onboarding_requests`**, so onboarding is a ticket. `/offboarding_requests` is readable. Requesters have `external_id`.
- BambooHR: base `api.bamboohr.com/api/gateway.php/<subdomain>/v1/`, Basic auth `key:x`, and **`Accept: application/json` is required** (the default is XML). An exit shows up as `status: Inactive` or a `terminationDate`, not as a deletion.
- An app with only `common` and an empty `service_user` module passes `fdk validate`.
- Status 2026-10-13: 19 unit tests pass and `fdk validate` is clean. Next: the user's BambooHR trial, a local `fdk run` simulation, then install.
- **Portfolio honesty:** when it ships, the page's HR card must describe what shipped: polling every 15 min, onboarding as a ticket, and no department or manager mapping in v1.


## 9. Third app: Leaver Asset Recovery, built offline 2026-10-14

- Code is in `apps/leaver-recovery/`; its README covers behaviour and limits. It polls for offboarding tickets because of the lesson from the bridge: **app events didn't fire for API-made changes**, and HR Sync creates its tickets through the API.
- yora API facts:
  - `/tickets/filter?query="tag:'x' AND created_at:>'YYYY-MM-DD'"` works.
  - `/assets?filter="user_id:<id>"&include=type_fields` works.
  - Asset state is `type_fields.asset_state_<typeId>` (`In Use` / `In Stock`).
  - Ticket tasks are available at `/tickets/{id}/tasks`.
- **Live testing caution:** yora's assets belong to real people. A live test needs a test requester (plus-address) with a test asset, and the user should agree before adding one to the CMDB. Don't raise offboarding tickets for real people, because that notifies them.
- Status: 17 unit tests pass and `fdk validate` is clean.


## 10. Fourth app: Support-to-IT Escalation (Zendesk → Freshservice), built offline 2026-10-14

- Code is in `apps/zendesk-escalation/`; its README covers the rules and the Zendesk webhook and trigger setup.
- Inbound: Zendesk webhook → `onExternalEvent`, with an `X-Bridge-Token` header (Zendesk webhook "API key" auth).
- Outbound: Freshservice `onTicketUpdate`, using `changes.status[1]`. This event fires for **UI** status changes. On Resolved or Closed the app reads `resolution_notes` (the event doesn't include it) and sets Zendesk to `solved`. If Zendesk returns 422 (e.g. no assignee), it posts the note anyway.
- Zendesk auth: Basic `email/token:API_TOKEN`. Comments go as `{"ticket":{"comment":{"body":…, "public":false}}}`. `additional_tags: ['it_escalated']` keeps the trigger from firing again.
- `fdk validate` has a **false positive**, "possible deprecated API usage", on the line reading `resolution_notes`. It is a Freshservice v1-deprecation heuristic; the app only uses `/api/v2`.
- Status: 15 unit tests pass. A live test needs a Zendesk trial (the user creates it) plus the webhook and trigger setup.
