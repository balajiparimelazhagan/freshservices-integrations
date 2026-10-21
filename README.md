# Freshservice Integrations

Integrations that connect Freshservice with the other systems a business runs on. Each one is a Freshworks custom app (App SDK 3.0, serverless) with its own README, tests and setup steps.

| Project | What it does | Status |
|---|---|---|
| [Escalation Bridge](apps/escalation-bridge) | Escalates urgent tickets from one Freshservice account to a partner's account, syncs status and resolution back, and shows the linked ticket (details, replies, attachments) in a ticket sidebar | Live, installed in production |
| [HR Sync](apps/hr-sync) | Turns BambooHR hires and exits into Freshservice requesters plus onboarding and offboarding tickets | Built and unit-tested; live test pending |
| [Leaver Asset Recovery](apps/leaver-recovery) | For each offboarding ticket, lists the leaver's devices as tasks, tracks their return and escalates overdue ones | Built and unit-tested; live test pending |
| [Support-to-IT Escalation](apps/zendesk-escalation) | Turns tagged Zendesk tickets into Freshservice incidents and posts IT status and the resolution back to Zendesk | Built and unit-tested; live test pending |
| [Workday Movers](apps/workday-movers) | Turns Workday job changes into requester updates (title, department, manager) and access review tickets for the new manager | Built and unit-tested; needs a Workday tenant for a live test |
| [Python prototype](prototype) | The first version of the escalation bridge, as a FastAPI service | Superseded by Escalation Bridge |

[`docs/freshworks-custom-app.md`](docs/freshworks-custom-app.md) collects platform notes, account quirks and lessons learned while building these.

## Working on an app

Requirements: [Freshworks CLI](https://developers.freshworks.com/docs/getting-started/freshworks-cli-setup/) (FDK 10.x) and Node 24.

```sh
cd apps/<app>
npm install
npx vitest run --coverage   # unit tests against fake Freshservice / third-party APIs
fdk validate
fdk run                     # local simulation: http://localhost:10001/custom_configs and /web/test
fdk pack                    # dist/<app>.zip to upload as a Freshworks custom app
```

## Secrets

API keys are entered as secure installation settings or kept in `.freshservice.env`, which is git-ignored. `fdk run` writes settings in plain text to each app's `.fdk/` and `log/`; both are git-ignored and should be deleted after local testing.
