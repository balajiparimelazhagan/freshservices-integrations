# Leaver Asset Recovery

A Freshworks custom app (platform 3.0, FDK 10.1.9) installed in Freshservice.

**Every 15 minutes** (or on demand through the run-now webhook):

1. **Finds new offboarding tickets:** tickets tagged `offboarding` (configurable) created in the last day. HR Sync adds this tag; manual offboarding tickets work too.
2. **Starts recovery** for the ticket's requester (the leaver):
   - looks up their assigned devices (`GET /api/v2/assets?filter="user_id:<id>"`)
   - adds one **task per device** with the return deadline (ticket created + 7 days, configurable)
   - posts a private note listing the devices
   - if no devices are assigned, posts a note saying so
3. **Tracks returns.** A device counts as back when its state is **In Stock**, or it's no longer assigned to the leaver. Its task is then completed. When every device is back, a "recovery complete" note is posted.
4. **Escalates once** after the deadline: a note listing the outstanding devices, and ticket priority set to High.

## Safety and limits

- **Read-only on assets.** It never edits a device. It only writes tasks, notes and priority on the offboarding ticket.
- Per run:
  - at most 3 new tickets
  - at most 10 devices per ticket (the note says how many more there are)
  - at most 20 device checks

  This keeps each run within the 20 s run time and the request rate limit.
- A failed run leaves no partial record, so the ticket is picked up again on the next run.
- `$db` keys:
  - `state.open`: tickets being tracked
  - `rec:<ticketId>`: the devices, tasks and deadline
  - `last_run`: the last run's summary
  - `run_url`: the webhook URL

## Develop

```sh
PATH="$HOME/.fdk/node/bin:$PATH" npx vitest run --coverage   # 17 tests
fdk validate && fdk run && fdk pack
```

Delete `log/fdk.log` after `fdk run`, because it contains the API key in plain text.
