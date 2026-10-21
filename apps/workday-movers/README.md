# Workday Movers: Workday → Freshservice access reviews

A Freshworks custom app (platform 3.0, FDK 10.1.9) installed in Freshservice.

When someone changes role, they get new access but usually keep the old one ("access creep"). This app closes that gap. Every 30 minutes (or on demand) it reads job changes from a Workday custom report and, for each person who moved:

1. **Updates the Freshservice requester:**
   - job title
   - department (matched by name)
   - reporting manager (matched by the manager's email)
2. **Opens an Access review ticket:**
   - lists every changed field, before and after
   - is raised on behalf of the new manager, so they follow it
   - is tagged `workday`, `access-review`

Moves with a future effective date wait until that date.

## Workday setup

Create an **Advanced custom report** shared with an Integration System User (ISU) and enabled as a web service (RaaS).

- **Prompt:** `Updated_From` (date and time). The app passes the time of the last change it processed.
- **Columns** (these exact aliases):

| Column | Example |
|---|---|
| `Employee_ID` | 21001 |
| `Worker` | Asha Rao |
| `Email` | asha@acme.com |
| `Effective_Date` | 2026-10-21 |
| `Event_Completed` | 2026-10-21T08:00:01Z |
| `Previous_Job_Title` / `Job_Title` | Analyst / Senior Analyst |
| `Previous_Department` / `Department` | Finance / Engineering |
| `Previous_Manager_Email` / `Manager_Email` | old.boss@acme.com / maria@acme.com |
| `Previous_Location` / `Location` | Chennai / Bengaluru |

The app calls `https://<host>/ccx/service/customreport2/<tenant>/<owner>/<report>?format=json&Updated_From=<time>` with Basic auth for the ISU.

## Rules

- **Only updates people who already exist** in Freshservice. It never creates or deletes requesters.
- **Nothing is guessed.** If the department isn't in Freshservice, or the new manager isn't a requester, that value isn't updated, and the ticket lists it under "Not updated in Freshservice".
- An email filter setting limits which workers are processed. An invalid filter processes nobody.
- Each Workday event is reviewed once (`$db move:<employee>:<event time>`), even if the report returns it again.
- At most 8 moves per run, which keeps each run within 20 s and the request rate limit. A failed move is retried on the next two runs, then dropped and logged.
- The first run looks back 24 hours only.

## Develop

```sh
npm install
npx vitest run --coverage   # 17 tests against a fake Workday report and Freshservice
fdk validate
```
