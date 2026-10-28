# Trip Tracker

A shared cost and confirmation tracker for a group holiday split across several
families. One itinerary, one ledger, one link.

It answers the three questions a group trip actually generates: *what have we
booked*, *what did it cost*, and *who owes whom*.

## The two pages

| Page | What it is |
| --- | --- |
| `index.html?id=<plan>` | The group view. Everyone gets this link. Shows the itinerary, every confirmation number, each family's share, and the settle-up. **Editable** — see below. |
| `edit.html?id=<plan>` | The full editor. Booking details, the family roster, estimate-vs-actual, split basis. |

## How money is modelled

Every expense carries a **price mode**, because "the house is $6,780" and "park
tickets are $236 each" behave completely differently when a family drops out:

- **Total for the trip** — one flat price, split by the trip's share basis.
- **Per person** — multiplied by the head count of the participating families.
- **Per family** — multiplied by the number of participating families.

A quoted rate allocates by the thing it was quoted per, *not* by the trip-wide share
rule. A $400-per-family golf cart bills every participating family $400, including a
two-person household. Pooling it and re-splitting by share would quietly undercharge
them. Only a flat total falls back to the share basis.

Each expense also records who is in on it. Unchecking a family re-splits that line
immediately.

The **split basis** (per person, children at half, per adult, per household, or
hand-set shares) is a group decision, not a fact, so it is a setting rather than a
constant.

### Estimates, actuals, and what settle-up can move

`cost` is the estimate; `actual` is what was really charged. The effective cost drives
every total.

Settle-up only moves money somebody actually laid out. A cost nobody has fronted yet
is owed to the *vendor*, not to another family — folding it into the net would make
the transfers disagree with the stated balances. The ledger tracks those separately
and reports unfunded cost on its own.

## Who can edit, and what protects the data

**Anyone holding the link can edit the plan**, and every change writes straight to the
single shared copy. There are no personal drafts: if you remove an item, it is removed
for all fourteen people. This was a deliberate group decision — a shared ledger that
everyone can correct beat per-person sandboxes.

That choice puts the whole weight of access control on one thing: **the plan id is the
password.** So:

- **Plan ids are random**, not guessable — `trip-` followed by 24 hex characters,
  never `smith-2027`. The backend URL in `config.js` is meant to ship in client code;
  the id is the only secret, and it is not written down anywhere in this repository.
- **Plans cannot be listed.** Reads are exact-id lookups and there is no listing
  operation, so there is no way to discover what plans exist. A wrong id returns
  nothing.
- **Every save keeps the version it replaced**, so a mistaken tap or a bad-faith edit
  is recoverable.
- **Confirmation numbers never enter this repo.** They live only in the backend. This
  repo is public; anything committed here is world-readable forever.

### Concurrent editing

Fourteen people on phones means two tabs editing at once is normal, not exotic.

A save does **not** write whatever the browser happens to be holding. It re-reads the
stored copy, merges in only the items this browser actually touched (tracked per item,
per payment, and for the plan's structure separately), and writes that. Same-item
edits are last-write-wins; everything else survives. The page then adopts the merged
result, so saving is also how it picks up other people's changes.

A save that cannot read first **fails loudly** rather than writing blind — overwriting
a change you cannot see is worse than refusing to save.

This matters because the original version wrote the whole plan from whatever was
loaded, so a stale tab silently reverted other people's edits with no error at all. It
was reproducible in two tabs in seconds, and it had been live the entire time editing
existed.

### The honest limit

The share link is a bearer token. Anyone who receives it — forwarded, screenshotted,
or left open on a borrowed phone — can read every confirmation number and change the
plan. An airline record locator plus a passenger surname is often enough to view or
alter a booking.

That is an accepted trade for a link that fourteen people can open without accounts or
passwords. If the link ever escapes, the fix is to move the plan to a fresh random id
and re-send it.

## Backend

A **Google Apps Script web app in front of a private Google Sheet**, both in the
owner's own Drive. Setup is `apps-script/SETUP.md`; the code is `apps-script/Code.gs`.

Operations, all reached by POSTing `{op, pid, ...}` to one URL:

| op | What it does |
| --- | --- |
| `get` | read one plan by exact id, or null |
| `save` | insert-or-replace, keeping the copy it replaced |
| `versions` | history metadata only, never contents |
| `restore` | roll back to a kept version |
| `delete` | remove a plan and its history |

The Sheet stays private. The script is deployed **execute as the owner, accessible to
anyone**, which is the same arrangement as the `SECURITY DEFINER` functions it
replaced: callers can ask about an id they already know and nothing else.

Writes are serialised with `LockService`, so the read-then-write that snapshots a
version cannot interleave with another save. The browser *also* merges other people's
edits before writing — see "Concurrent editing" below — but that merge happens on a
phone, and the lock is what makes the write itself indivisible.

### Why it is not a database

The trip was hosted on a free Supabase project three times and lost three times:
deleted by free-tier cleanup in August 2026, paused on 2026-09-30, and gone again
around 2026-10-08 — the last time **while a keep-alive was successfully pinging it
every three days**, so the usual "it went idle" story did not even apply. Each death
took 98 stored versions with it and left the static pages serving HTTP 200 over
missing data.

A Sheet in a personal Drive has no free tier to fall off. There is nothing to pause,
nothing to re-create, and Drive keeps its own file history.

Things learned the hard way, kept here so they are not rediscovered:

- **Apps Script does not answer the CORS preflight.** A POST carrying
  `Content-Type: application/json` is blocked by the browser before it is sent. The
  client sends `text/plain` — a "simple request", so no preflight — and the backend
  parses the body as JSON anyway. This is why `backend.js` exists as one shared file
  rather than a header duplicated in two places.
- **The backend reports its own refusals as HTTP 200 with `{ok:false}`.** Checking
  only `res.ok` would make a refused save look like a successful one. Failures are
  read out of the body.
- **A Sheet cell holds 50,000 characters and silently truncates past it.** Plans are
  stored chunked across rows, far below the limit, so growth cannot corrupt one.
- **Editing the script changes nothing until a new version is deployed.** The `/exec`
  URL keeps serving the old code, which is indistinguishable from the change not
  working.

## Files

```
index.html         group view (the link everyone gets)
edit.html          full editor
group.js           group view logic, including shared editing
edit.js            editor logic
booking.js         shared money model — price modes, splitting, ledger, settle-up
backend.js         how both pages talk to the backend (shared on purpose)
config.js          the Apps Script web app URL
apps-script/       the backend itself, plus its setup guide
tools/             backup, restore, and the backend's test suite
sql/               the retired Supabase schema, kept for reference only
```

No build step. It is a static site; open the files or serve the folder.

Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `master`.
The legacy Pages builder was abandoned after it failed twice with no logs and then hung
for 25 minutes on a two-line change.

`config.js` is cache-busted (`?v=N`) — bump it whenever the backend changes, or clients
keep talking to the old one.

## If the links stop working

The pages are static and keep serving HTTP 200 even when the data is unreachable, so
"the site loads but the trip is missing" is the normal shape of every backend problem.

**1. Open the Apps Script URL** in `config.js` directly in a browser. A healthy
backend answers:

```json
{"ok":true,"service":"trip-tracker","message":"Backend is running."}
```

**2. If that works but the site does not,** it is the client, not the backend — check
the browser console on the group link.

**3. If it does not work,** the deployment is the thing to look at: Apps Script →
**Deploy → Manage deployments**. The usual causes are the deployment having been
deleted, or its access having been changed away from **Anyone**.

**4. If the script itself was edited and the site did not change,** a new version was
almost certainly never deployed. See `apps-script/SETUP.md`.

### Backups

```
bash tools/backup-plan.sh <plan-id>                      # one snapshot now
bash tools/restore-plan.sh <plan-id> <file> [--overwrite] # put one back
node tools/test-backend.js                               # check Code.gs still works
```

Snapshots go to `~/TripTrackerBackups/`, **outside this repo**, because they contain
confirmation numbers and this repo is public. Never move them in.

`tools/backup-task.ps1` runs the backup unattended from Windows Task Scheduler — the
install command is in its header. It exists because the manual script only ever ran
twice, on the day it was written, so when the old backend died the newest copy was
already a week old.

The plan id is the password and is deliberately absent from this repo. The tools read
it from `~/TripTrackerBackups/plan-id.txt`, next to the backups.

### Rescuing the old Supabase data

`tools/rescue-from-supabase.sh <plan-id>` pulls the plan out of the retired Supabase
project *if* it is ever restored from that dashboard, to recover the week of edits that
existed only there when it died. It reads the old URL and key from this repo's own git
history rather than re-committing a credential. If the project is gone for good, the
script has no purpose.
