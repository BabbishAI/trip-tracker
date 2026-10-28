# Setting up the backend (about 10 minutes, once)

The trip data lives in a Google Sheet in your own Drive, reached through a small
script. Nothing here costs money and there is no account to sign up for — it is the
Google account you already have.

**Why it is built this way:** the trip was on a free Supabase database three times and
lost it three times — deleted in August 2026, paused on 2026-09-30, and gone again
around 2026-10-08 while a keep-alive was still pinging it every three days. Each time
the site kept loading perfectly and only the data vanished, because the pages are
static. A Sheet in your Drive has no free tier to fall off and nothing that gets
reclaimed for being quiet.

> Throughout this file, `<plan-id>` means the trip's plan id. It is **not written down
> in this repository**, because this repository is public and the plan id is the
> password for the whole trip. It is in `~/TripTrackerBackups/plan-id.txt` on the
> owner's PC.

---

## 1. Make the Sheet

If a Sheet for this already exists in your Drive — look for **Trip Tracker Data** —
open that one and skip to step 2. Its link is deliberately not recorded here: this
repository is public, and that file holds the confirmation numbers.

Otherwise go to [sheets.new](https://sheets.new) and name it something like
**Trip Tracker Data**.

Leave it empty. The script creates the tabs it needs (`plans` and `versions`) the
first time it runs.

Keep this Sheet **private**. Do not share it with the group — it holds the airline
record locators. The group reaches the data through the site, not the Sheet.

## 2. Add the script

There are two ways to do this, and the script works either way. Pick one.

### Either: from inside the Sheet (simplest)

In that Sheet: **Extensions → Apps Script**. This creates a *container-bound* script,
which already knows which spreadsheet it belongs to.

### Or: a standalone script

A project made at [script.new](https://script.new) or from the Apps Script home page
is *standalone* — it is not attached to anything, so it has to be told which Sheet to
use. Near the top of `Code.gs`, set:

```js
var SHEET_ID = 'the long id from the Sheet URL';
```

The id is the middle part of the Sheet's address:

```
https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit
```

Leave `SHEET_ID` empty for a bound script. If it is empty *and* the script is
standalone, every request fails with a message telling you exactly this — it does not
fail silently.

### Then, either way

1. Delete the `function myFunction() {}` stub the editor starts with.
2. Open `apps-script/Code.gs` from this project, copy **everything**, and paste it in.
3. Set `SHEET_ID` if you went the standalone route.
4. Click the save icon (floppy disk).

## 3. Publish it

Click **Deploy → New deployment**.

- Click the gear icon next to "Select type" and choose **Web app**.
- **Description:** anything, e.g. `trip tracker`
- **Execute as:** **Me**
- **Who has access:** **Anyone**

Then **Deploy**.

> **"Execute as: Me" plus "Who has access: Anyone" is the whole security design.**
> The script runs as you, so it can read your private Sheet. Visitors cannot — they
> can only ask the script about one exact plan id. There is no operation that lists
> plan ids, so the **plan id is the password**, exactly as it was before. A wrong id
> returns nothing.

### The scary warning is expected

Google will ask you to authorise, then say the app is **not verified**. That is
because it is your own script rather than a published product. Click **Advanced**,
then **Go to (unsafe)**, then **Allow**.

## 4. Copy the URL

After deploying, Google shows a **Web app URL** ending in `/exec`. It looks like:

```
https://script.google.com/macros/s/AKfycb..................../exec
```

Copy it. Paste it into `config.js`, replacing `PASTE_THE_APPS_SCRIPT_WEB_APP_URL_HERE`.

That URL is public, exactly as the old database key was — it is not the secret. The
plan id is.

To check the deployment works, open the URL in a browser. You should see:

```json
{"ok":true,"service":"trip-tracker","message":"Backend is running."}
```

That page deliberately shows nothing about the trip.

## 5. Load the trip data in

From the project folder. `ls -1t ~/TripTrackerBackups/` lists the backups newest
first — use the newest one:

```bash
bash tools/restore-plan.sh "$(cat ~/TripTrackerBackups/plan-id.txt)" ~/TripTrackerBackups/plan_YYYY-MM-DD_HHMM.json
```

It prints what it is about to do, sends it, then reads it back and confirms the item
count. It refuses to overwrite a plan that already has items unless you add
`--overwrite`.

## 6. Publish the site

Commit and push. GitHub Pages redeploys in about 16 seconds. Then open the group link
and confirm the trip is there.

---

## The one thing that will catch you later

**Editing the script does nothing to the live site until you deploy a new version.**
The `/exec` URL keeps serving the old code, which looks exactly like your change
having no effect.

After any edit to `Code.gs`:

**Deploy → Manage deployments → pencil icon → Version: New version → Deploy**

The URL stays the same, so `config.js` does not need changing.

## If you ever need to replace the deployment

If the URL itself changes, put the new one in `config.js` **and bump the `?v=` number**
on the `config.js` script tags in both `index.html` and `edit.html`. Browsers cache
that file, and without the bump the group's phones keep calling the old endpoint.

## Recovering a bad edit

Anyone with the link can edit, which is the group's deliberate choice. The backend
keeps the previous 50 copies of each plan. From the browser console on the site:

```js
tripBackend.versions('<plan-id>').then(console.log)
tripBackend.restore('<plan-id>', 12)   // the version_id you want
```

A restore is itself undoable — the copy it replaces is kept too.

The Sheet also has Google's own **File → Version history**, and
`tools/backup-plan.sh` keeps copies on your PC, outside the repo. Those backups
contain confirmation numbers, so never move them into the project folder — it is
public.

## Checking the code still works after a change

`tools/test-backend.js` runs `Code.gs` against stand-in Sheet APIs — no deployment and
no real data needed:

```bash
node tools/test-backend.js
```

It covers the round trip, chunking, version history, pruning, restore, deletion, and
that an unknown plan id reveals nothing.
