# HR Sync: BambooHR → Freshservice

A Freshworks custom app (platform 3.0, FDK 10.1.9) installed in Freshservice.

**Every 15 minutes** (plus on demand through the run-now webhook), it asks BambooHR which employees changed since the last run (`GET /v1/employees/changed?since=`). Then:

| Change in BambooHR | In Freshservice |
|---|---|
| New active employee | Requester created with `external_id = bamboohr:<id>`, then an **Onboarding** ticket |
| Name or job title changed | That requester updated (no write if nothing changed) |
| Exit (status Inactive or a termination date) | **Offboarding** ticket, then the requester is deactivated. Future-dated exits wait for the date |

## Safety rules

- Only changes requesters this app created: the link is kept in `$db` as `emp:<bambooId>`.
- An existing requester with the same email is **never adopted**. The employee is skipped and logged.
- Deactivates only (`DELETE /requesters/{id}`), never `/forget`.
- **Only syncs work emails matching the filter setting.** An invalid filter syncs nobody.
- The first run looks back only 24 hours, so installing never imports the whole company.

## Limits and failures

- At most 8 employees per run (each run must finish in 20 s, and requests are capped at 50/min). The rest wait for the next run.
- A failed employee is retried on the next two runs, then dropped and logged.
- `$db` keys:
  - `state`: the cursor, pending exits and the retry counts
  - `last_run`: the last run's summary
  - `run_url`: the webhook URL

## Develop

```sh
PATH="$HOME/.fdk/node/bin:$PATH" npx vitest run --coverage   # 19 tests, fake BambooHR + Freshservice
fdk validate
fdk run          # then http://localhost:10001/custom_configs and /web/test (onScheduledEvent)
fdk pack
```

`fdk run` writes secure settings in plain text to `log/fdk.log`. Delete it after testing.

## Run now

`POST <run-now URL from the install log>` with the header `X-Run-Token: <token>`.
