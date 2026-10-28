/**
 * Trip tracker backend, living in a Google Sheet.
 *
 * WHY THIS EXISTS
 * The trip data was hosted on a free Supabase project three times and died three
 * times: deleted by free-tier cleanup in August 2026, paused on 2026-09-30, and gone
 * again around 2026-10-08 - the last time while a keep-alive was pinging it every
 * three days, so the usual "it went idle" explanation did not even apply. Each death
 * took the group's link down with no warning, because the site itself is static and
 * keeps serving perfectly while the data is missing.
 *
 * A Sheet in the owner's own Drive has no free tier to fall off. There is no project
 * to pause, nothing to re-create, and the file is covered by Drive's own history.
 *
 * SECURITY MODEL - unchanged from the database it replaces.
 * The Sheet stays private. This script is deployed "execute as me, available to
 * anyone", so an anonymous visitor can call it but only it can see the Sheet. That is
 * the same arrangement as the SECURITY DEFINER functions it replaces: the plan id is
 * the password, and there is deliberately NO operation that lists plan ids, so a
 * caller must already know the id. A wrong id returns null, exactly as before.
 *
 * Confirmation numbers live here and nowhere public. Do not add a listing op, and do
 * not log payloads.
 *
 * CORS NOTE (the thing that wastes an evening if you forget it)
 * Apps Script does not answer the CORS preflight OPTIONS request, so a browser on
 * another origin will refuse a POST that carries Content-Type: application/json. The
 * client therefore sends text/plain, which counts as a "simple request" and skips the
 * preflight entirely. The body is still JSON - see parseBody_().
 */

// WHICH SHEET THIS USES
//
// Leave SHEET_ID empty if this script was created from inside the Sheet itself
// (Extensions -> Apps Script). Such a script is "container-bound" and already knows
// its spreadsheet.
//
// Set SHEET_ID to the Sheet's id if this is a standalone script — one made at
// script.new or from the Apps Script home page. A standalone script has no active
// spreadsheet, so SpreadsheetApp.getActive() returns null and every single operation
// fails with an error that does not mention the real cause.
//
// The id is the long string in the Sheet's own URL:
//   https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit
//
// It is left blank in this repository on purpose: the repo is public, and there is no
// reason to publish the address of a private file holding the group's confirmation
// numbers. Fill it in in the Apps Script editor, which is private.
var SHEET_ID = '';

var PLANS_TAB = 'plans';
var VERSIONS_TAB = 'versions';

// A single Sheet cell holds at most 50,000 characters and SILENTLY TRUNCATES beyond
// that, which would corrupt a plan without any error. Plans are split across rows
// well below the limit so growth can never hit it.
var CHUNK = 40000;

// How many past versions to keep per plan. Matches the old database's behaviour:
// enough to walk back from a bad afternoon without growing without bound.
var KEEP_VERSIONS = 50;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Visiting the deployment URL in a browser lands here. It deliberately reveals
 * nothing about the data - it exists so that whoever set this up can confirm the
 * deployment is live without reading any trip information.
 */
function doGet() {
  return json_({ ok: true, service: 'trip-tracker', message: 'Backend is running.' });
}

function doPost(e) {
  var req;
  try {
    req = parseBody_(e);
  } catch (err) {
    return json_({ ok: false, error: 'Could not read the request body as JSON.' });
  }

  var op = String(req.op || '');
  var pid = String(req.pid || '');

  if (!pid) return json_({ ok: false, error: 'No plan id given.' });

  try {
    switch (op) {
      case 'get':      return json_({ ok: true, data: getPlan_(pid) });
      case 'save':     return json_({ ok: true, data: savePlan_(pid, req.payload) });
      case 'versions': return json_({ ok: true, data: listVersions_(pid) });
      case 'restore':  return json_({ ok: true, data: restoreVersion_(pid, req.vid) });
      case 'delete':   return json_({ ok: true, data: deletePlan_(pid) });
      default:         return json_({ ok: false, error: 'Unknown op: ' + op });
    }
  } catch (err) {
    // The message is safe to return (it never contains plan contents) and saying what
    // went wrong is what lets the site show a loud, honest failure instead of
    // pretending a save worked.
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * Browsers will not parse a JSON response whose Content-Type says text/plain, so the
 * reply is explicitly marked as JSON even though the request was not.
 */
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('empty body');
  return JSON.parse(e.postData.contents);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function getPlan_(pid) {
  var text = readChunks_(tab_(PLANS_TAB), pid);
  return text ? JSON.parse(text) : null;
}

/**
 * Insert-or-replace, keeping the copy it replaced.
 *
 * Everything runs inside a script lock. The site also merges other people's edits
 * before writing (it re-reads, merges per item, then saves), but that merge happens
 * in a browser and two phones can still interleave. The lock makes the read-then-write
 * here indivisible, so the version history can never miss a copy and two saves
 * landing together cannot produce a half-written plan.
 */
function savePlan_(pid, payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('payload must be a plan object');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('the sheet was busy - nothing was saved, try again');

  try {
    var plans = tab_(PLANS_TAB);
    var previous = readChunks_(plans, pid);
    var next = JSON.stringify(payload);

    // The site autosaves on a debounce, so identical rewrites are common. Only keep a
    // version when there was something there and it actually changed.
    if (previous && previous !== next) {
      addVersion_(pid, previous);
    }

    writeChunks_(plans, pid, next, new Date());
    return { saved: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Deliberately returns no plan contents - only when each version was taken and how
 * many items it held. Listing history must not become a second way to read the trip.
 */
function listVersions_(pid) {
  var sh = tab_(VERSIONS_TAB);
  var rows = sh.getDataRange().getValues();
  var seen = {};
  var out = [];

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== pid) continue;
    var vid = String(rows[i][1]);
    if (seen[vid]) continue;
    seen[vid] = true;
    out.push({
      version_id: Number(vid),
      saved_at: rows[i][4] ? new Date(rows[i][4]).toISOString() : '',
      items: Number(rows[i][5] || 0)
    });
  }

  out.sort(function (a, b) { return b.version_id - a.version_id; });
  return out;
}

/**
 * Put a past version back. The current contents are versioned first, so an unwanted
 * restore is itself undoable.
 */
function restoreVersion_(pid, vid) {
  var text = readVersion_(pid, String(vid));
  if (!text) throw new Error('no version ' + vid + ' for that plan');
  return savePlan_(pid, JSON.parse(text));
}

function deletePlan_(pid) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('the sheet was busy - nothing was deleted, try again');
  try {
    dropRows_(tab_(PLANS_TAB), 0, pid);
    dropRows_(tab_(VERSIONS_TAB), 0, pid);
    return { deleted: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Sheet storage
// ---------------------------------------------------------------------------

/**
 * The spreadsheet this script stores data in.
 *
 * An explicit SHEET_ID wins, because someone who set it meant it. Otherwise fall back
 * to the bound spreadsheet, and if there is neither, say exactly what is wrong — the
 * raw failure is a null-property error deep inside a storage function, which tells
 * whoever is setting this up nothing at all.
 */
function spreadsheet_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);

  var active = SpreadsheetApp.getActive();
  if (!active) {
    throw new Error(
      'This script is not attached to a Sheet. Either create it from inside the ' +
      'Sheet (Extensions -> Apps Script), or set SHEET_ID at the top of Code.gs to ' +
      'the Sheet id from its URL.'
    );
  }
  return active;
}

function tab_(name) {
  var ss = spreadsheet_();
  var sh = ss.getSheetByName(name);
  if (sh) return sh;

  sh = ss.insertSheet(name);
  if (name === PLANS_TAB) {
    sh.appendRow(['plan_id', 'seq', 'chunk', 'updated_at']);
  } else {
    sh.appendRow(['plan_id', 'version_id', 'seq', 'chunk', 'saved_at', 'items']);
  }
  sh.setFrozenRows(1);
  return sh;
}

/** Reassemble a plan from its chunk rows, or '' if the id is not present. */
function readChunks_(sh, pid) {
  var rows = sh.getDataRange().getValues();
  var parts = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== pid) continue;
    parts.push({ seq: Number(rows[i][1]), text: String(rows[i][2]) });
  }
  if (!parts.length) return '';
  parts.sort(function (a, b) { return a.seq - b.seq; });
  return parts.map(function (p) { return p.text; }).join('');
}

/**
 * Replace a plan's rows with fresh chunks.
 *
 * The tab is rewritten in one setValues() call rather than deleting rows one at a
 * time: fewer Sheets operations, and no window in which the plan exists only
 * partially. The caller holds the lock.
 */
function writeChunks_(sh, pid, text, when) {
  var rows = sh.getDataRange().getValues();
  var header = rows[0];
  var kept = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== pid) kept.push(rows[i]);
  }

  var added = [];
  for (var seq = 0, off = 0; off < text.length; seq++, off += CHUNK) {
    added.push([pid, seq, text.substr(off, CHUNK), seq === 0 ? when : '']);
  }

  var all = [header].concat(kept, added);
  sh.clearContents();
  sh.getRange(1, 1, all.length, header.length).setValues(padRows_(all, header.length));
}

function addVersion_(pid, text) {
  var sh = tab_(VERSIONS_TAB);

  // Version ids must be unique, because a version is stored as several chunk rows
  // sharing an id and read back by joining them. A clock was used here first, and two
  // saves inside the same millisecond then shared an id — which concatenates two
  // different versions into one unparseable blob on restore. A counter cannot collide.
  // Safe to compute by scanning: the only caller holds the script lock.
  var vid = nextVersionId_(sh);

  var items = 0;
  try { items = (JSON.parse(text).items || []).length; } catch (e) { items = 0; }

  var now = new Date();
  var rows = [];
  for (var seq = 0, off = 0; off < text.length; seq++, off += CHUNK) {
    rows.push([pid, vid, seq, text.substr(off, CHUNK), seq === 0 ? now : '', seq === 0 ? items : '']);
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);

  pruneVersions_(sh, pid);
}

/** One past the highest version id in the tab, across all plans. Starts at 1. */
function nextVersionId_(sh) {
  var rows = sh.getDataRange().getValues();
  var max = 0;
  for (var i = 1; i < rows.length; i++) {
    var v = Number(rows[i][1]);
    if (v > max) max = v;
  }
  return max + 1;
}

function readVersion_(pid, vid) {
  var rows = tab_(VERSIONS_TAB).getDataRange().getValues();
  var parts = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== pid || String(rows[i][1]) !== vid) continue;
    parts.push({ seq: Number(rows[i][2]), text: String(rows[i][3]) });
  }
  if (!parts.length) return '';
  parts.sort(function (a, b) { return a.seq - b.seq; });
  return parts.map(function (p) { return p.text; }).join('');
}

/** Keep only the newest KEEP_VERSIONS versions of this plan. */
function pruneVersions_(sh, pid) {
  var rows = sh.getDataRange().getValues();
  var ids = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== pid) continue;
    var v = Number(rows[i][1]);
    if (ids.indexOf(v) === -1) ids.push(v);
  }
  if (ids.length <= KEEP_VERSIONS) return;

  ids.sort(function (a, b) { return b - a; });
  var doomed = {};
  ids.slice(KEEP_VERSIONS).forEach(function (v) { doomed[v] = true; });

  var header = rows[0];
  var kept = [];
  for (var j = 1; j < rows.length; j++) {
    if (String(rows[j][0]) === pid && doomed[Number(rows[j][1])]) continue;
    kept.push(rows[j]);
  }

  var all = [header].concat(kept);
  sh.clearContents();
  sh.getRange(1, 1, all.length, header.length).setValues(padRows_(all, header.length));
}

function dropRows_(sh, col, value) {
  var rows = sh.getDataRange().getValues();
  var header = rows[0];
  var kept = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][col]) !== value) kept.push(rows[i]);
  }
  var all = [header].concat(kept);
  sh.clearContents();
  sh.getRange(1, 1, all.length, header.length).setValues(padRows_(all, header.length));
}

/** setValues() rejects ragged input, and clearContents() can leave short rows. */
function padRows_(rows, width) {
  return rows.map(function (r) {
    var out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
}
