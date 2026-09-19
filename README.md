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

- **Plan ids are random**, not guessable. `trip-c9d2ab...`, never `smith-2027`. The
  public key in `config.js` is meant to ship in client code; the id is the only secret.
- **The table cannot be listed.** Reads go through `get_plan(id)`, an exact-id lookup.
  There is no way to discover what plans exist.
- **Every save keeps the version it replaced** (`sql/version-history.sql`), so a
  mistaken tap or a bad-faith edit is recoverable.
- **Confirmation numbers never enter this repo.** They live only in the database. This
  repo is public; anything committed here is world-readable forever.

### The honest limit

The share link is a bearer token. Anyone who receives it — forwarded, screenshotted,
or left open on a borrowed phone — can read every confirmation number and change the
plan. An airline record locator plus a passenger surname is often enough to view or
alter a booking.

That is an accepted trade for a link that fourteen people can open without accounts or
passwords. If the link ever escapes, the fix is to move the plan to a fresh random id
and re-send it.

## Backend

Supabase Postgres, one table (`plans`), row-level security on, and **no direct table
access for the anon role**. Everything goes through `SECURITY DEFINER` functions:

- `get_plan(pid)` — read one plan by exact id
- `save_plan(pid, payload)` — upsert, snapshotting the previous version first
- `list_plan_versions(pid)` — history metadata only, never contents
- `restore_plan_version(pid, vid)` — roll back
- `delete_plan(pid)` — remove a plan and its history

Run `sql/version-history.sql` in the Supabase SQL editor to install the last four.

Two things learned the hard way, kept here so they are not rediscovered:

- Removing the read policy broke PostgREST upsert, which needs to see the row. That is
  why writes go through `save_plan` rather than direct REST.
- **A free-tier Supabase project is deleted after long disuse.** The original project
  vanished and its hostname stopped resolving, killing every share link. If links break,
  check DNS first and expect to rebuild.

## Files

```
index.html   group view (the link everyone gets)
edit.html    full editor
group.js     group view logic, including shared editing
edit.js      editor logic
booking.js   shared money model — price modes, splitting, ledger, settle-up
config.js    Supabase project URL + public anon key
sql/         backend schema and functions
```

No build step. It is a static site; open the files or serve the folder.

Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `master`.
The legacy Pages builder was abandoned after it failed twice with no logs and then hung
for 25 minutes on a two-line change.

`config.js` is cache-busted (`?v=N`) — bump it whenever the backend changes, or clients
keep talking to the old one.
