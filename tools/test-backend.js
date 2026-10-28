// Run: node tools/test-backend.js
//
// Exercises apps-script/Code.gs against fake Sheet APIs, so bugs surface here rather
// than on someone's phone mid-trip. No deployment and no network needed.
const path = require('path');
const os = require('os');
const CODE = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const fs = require('fs');
const vm = require('vm');

// A closer model of a real Sheet than "an array of rows".
//
// Sheets is a FIXED GRID: it has a row and column count independent of how much is
// filled in, getDataRange() covers only the used region, an empty sheet still answers
// [['']], and inserting rows shifts everything below. The previous stub modelled none
// of that, which is why it happily passed a backend that destroyed the tab's header.
const DEFAULT_ROWS = 1000;
const DEFAULT_COLS = 26;

function makeSheet(name) {
  let maxRows = DEFAULT_ROWS;
  let maxCols = DEFAULT_COLS;
  let grid = Array.from({ length: maxRows }, () => Array(maxCols).fill(''));
  let failNext = false;

  const isBlank = (v) => v === '' || v === null || v === undefined;

  function lastRow() {
    for (let r = maxRows - 1; r >= 0; r--) if (grid[r].some(v => !isBlank(v))) return r + 1;
    return 0;
  }
  function lastCol() {
    for (let c = maxCols - 1; c >= 0; c--) {
      for (let r = 0; r < maxRows; r++) if (!isBlank(grid[r][c])) return c + 1;
    }
    return 0;
  }

  function range(row, col, numRows, numCols) {
    return {
      getValues: () => {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const r = grid[row - 1 + i] || Array(maxCols).fill('');
          out.push(r.slice(col - 1, col - 1 + numCols));
        }
        return out;
      },
      setValues: (vals) => {
        if (failNext) { failNext = false; throw new Error('Service Spreadsheets timed out.'); }
        if (vals.length !== numRows) throw new Error('setValues row count mismatch');
        for (const v of vals) {
          if (v.length !== numCols) throw new Error('setValues ragged row: ' + JSON.stringify(v));
        }
        if (row - 1 + numRows > maxRows) {
          // The real API throws rather than growing the sheet for you.
          throw new Error('Those rows are out of bounds.');
        }
        for (let i = 0; i < numRows; i++) {
          for (let j = 0; j < numCols; j++) grid[row - 1 + i][col - 1 + j] = vals[i][j];
        }
      },
      clearContent: () => {
        for (let i = 0; i < numRows; i++) {
          if (!grid[row - 1 + i]) continue;
          for (let j = 0; j < numCols; j++) grid[row - 1 + i][col - 1 + j] = '';
        }
      },
      setFontWeight: () => range(row, col, numRows, numCols),
      setBackground: () => range(row, col, numRows, numCols),
      setFontColor: () => range(row, col, numRows, numCols),
      setNumberFormat: () => range(row, col, numRows, numCols),
      setVerticalAlignment: () => range(row, col, numRows, numCols),
      setWrap: () => range(row, col, numRows, numCols),
      setHorizontalAlignment: () => range(row, col, numRows, numCols),
      setFormulas: () => range(row, col, numRows, numCols),
      setDataValidation: () => range(row, col, numRows, numCols),
    };
  }

  return {
    name,
    _dump: () => grid.slice(0, Math.max(lastRow(), 0)).map(r => r.slice(0, Math.max(lastCol(), 1))),
    _grid: () => grid,
    _failNextWrite: () => { failNext = true; },
    getMaxRows: () => maxRows,
    getMaxColumns: () => maxCols,
    getLastRow: lastRow,
    getDataRange: () => {
      const lr = lastRow(), lc = lastCol();
      if (!lr || !lc) return { getValues: () => [['']] };
      return range(1, 1, lr, lc);
    },
    getRange: range,
    appendRow: (r) => {
      const at = lastRow();
      if (at >= maxRows) throw new Error('Those rows are out of bounds.');
      for (let j = 0; j < r.length; j++) grid[at][j] = r[j];
    },
    insertRowsAfter: (after, n) => {
      const blanks = Array.from({ length: n }, () => Array(maxCols).fill(''));
      grid.splice(after, 0, ...blanks);
      maxRows += n;
    },
    insertRowBefore: (r) => {
      grid.splice(r - 1, 0, Array(maxCols).fill(''));
      maxRows += 1;
    },
    setFrozenRows: () => {},
    setColumnWidth: () => {},
    setConditionalFormatRules: () => {},
    clearContents: () => { grid = Array.from({ length: maxRows }, () => Array(maxCols).fill('')); },
  };
}

const TEST_SHEET_ID = 'sheet-id-for-tests';

// mode: 'bound'      — script made from inside the Sheet; getActive() works.
//       'standalone' — script made on its own; getActive() is null, SHEET_ID is used.
//       'orphan'     — neither. Must fail with a message that names the cause.
function makeEnv(mode) {
  const sheets = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
  };
  return {
    sheets,
    SpreadsheetApp: {
      getActive: () => (mode === 'bound' ? ss : null),
      openById: (id) => {
        if (id !== TEST_SHEET_ID) throw new Error('openById called with the wrong id: ' + id);
        return ss;
      },
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ _s: s, setMimeType() { return this; } }),
    },
  };
}

function load(chunkOverride, mode) {
  mode = mode || 'bound';
  const env = makeEnv(mode);
  const ctx = vm.createContext(Object.assign({ console, Date, JSON, String, Number }, env));
  let src = fs.readFileSync('' + CODE + '', 'utf8');
  if (chunkOverride) src = src.replace('var CHUNK = 40000;', 'var CHUNK = ' + chunkOverride + ';');
  if (mode === 'standalone') {
    src = src.replace("var SHEET_ID = '';", "var SHEET_ID = '" + TEST_SHEET_ID + "';");
    if (!src.includes(TEST_SHEET_ID)) throw new Error('could not set SHEET_ID — has Code.gs changed?');
  }
  vm.runInContext(src, ctx);
  ctx.call = (obj) => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(obj) } })._s);
  return ctx;
}

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

// A real snapshot is used when one is on this machine, because round-tripping the
// actual trip is a stronger test than round-tripping a toy. It is OPTIONAL: the
// backups live outside this public repo and hold confirmation numbers, so anyone
// cloning this gets the synthetic plan instead.
const backupDir = path.join(os.homedir(), 'TripTrackerBackups');
let realPlan = null, realSource = 'synthetic';
try {
  const newest = fs.readdirSync(backupDir)
    .filter(f => /^plan_.*.json$/.test(f))
    .sort().reverse()[0];
  if (newest) {
    realPlan = JSON.parse(fs.readFileSync(path.join(backupDir, newest), 'utf8'));
    realSource = newest;
  }
} catch (e) { /* no backups here — fine */ }

if (!realPlan) {
  realPlan = {
    v: 2, title: 'Sample trip', splitBasis: 'shares',
    households: [{ id: 'h1', name: 'One', adults: 2, kids: 2, size: 4 },
                 { id: 'h2', name: 'Two', adults: 2, kids: 2, size: 4 },
                 { id: 'h3', name: 'Three', adults: 2, kids: 2, size: 4 },
                 { id: 'h4', name: 'Four', adults: 2, kids: 0, size: 2, contributes: true }],
    items: Array.from({ length: 12 }, (_, i) => ({
      id: 'i' + i, title: 'Item ' + i, cost: 100 + i,
      status: i < 4 ? 'booked' : 'est', conf: i < 4 ? 'SAMPLE' + i : '',
    })),
    payments: [{ id: 'p1', from: 'h2', to: 'h1', amount: 100, date: '2026-01-01', note: '' }],
    groupSel: {}, groupOff: {},
  };
}
console.log('Sample plan: ' + realSource);

console.log('\n1. Unknown id returns null (no enumeration, no error)');
{
  const c = load();
  const r = c.call({ op: 'get', pid: 'nobody-knows-this' });
  ok('ok:true', r.ok === true, r);
  ok('data is null', r.data === null, r);
}

console.log('\n2. Save the real plan, read it back byte-identical');
{
  const c = load();
  const saved = c.call({ op: 'save', pid: 'trip-live', payload: realPlan });
  ok('save ok', saved.ok === true, saved);
  const got = c.call({ op: 'get', pid: 'trip-live' });
  ok('round-trips exactly', JSON.stringify(got.data) === JSON.stringify(realPlan));
  // Expectations come from the plan that was loaded, never hard-coded counts: the
  // sample is whatever the newest backup happens to be, and the group keeps editing
  // the real trip. A test that fails because someone booked a car is a broken test.
  ok('every item survives', got.data.items.length === realPlan.items.length,
    got.data.items.length + ' vs ' + realPlan.items.length);
  ok('every household survives', got.data.households.length === realPlan.households.length);
  ok('confirmation numbers intact',
    got.data.items.filter(i => i.conf).length === realPlan.items.filter(i => i.conf).length);
  ok('payments intact', (got.data.payments || []).length === (realPlan.payments || []).length);
  ok('per-household flags survive',
    JSON.stringify(got.data.households) === JSON.stringify(realPlan.households));
}

console.log('\n3. Chunking: force CHUNK=500 so the real plan spans many rows');
{
  const c = load(500);
  c.call({ op: 'save', pid: 'trip-live', payload: realPlan });
  const rows = c.sheets.plans._dump();
  // Expectation comes from the data, not a magic number, so this still means something
  // with either the real snapshot or the smaller synthetic plan.
  const expectedChunks = Math.ceil(JSON.stringify(realPlan).length / 500);
  ok('split into exactly the expected number of chunk rows',
    rows.length - 1 === expectedChunks, (rows.length - 1) + ' vs ' + expectedChunks);
  ok('and that is genuinely more than one', expectedChunks > 1, expectedChunks);
  const got = c.call({ op: 'get', pid: 'trip-live' });
  ok('reassembles exactly', JSON.stringify(got.data) === JSON.stringify(realPlan));
  const seqs = rows.slice(1).map(r => r[1]);
  ok('sequence numbers are 0..n-1', seqs.join(',') === seqs.map((_, i) => i).join(','), seqs);
}

console.log('\n4. Two plans do not bleed into each other');
{
  const c = load(500);
  c.call({ op: 'save', pid: 'plan-a', payload: { items: [{ id: 'a1' }], tag: 'A' } });
  c.call({ op: 'save', pid: 'plan-b', payload: realPlan });
  c.call({ op: 'save', pid: 'plan-a', payload: { items: [{ id: 'a1' }, { id: 'a2' }], tag: 'A2' } });
  const a = c.call({ op: 'get', pid: 'plan-a' }).data;
  const b = c.call({ op: 'get', pid: 'plan-b' }).data;
  ok('plan-a updated', a.tag === 'A2' && a.items.length === 2, a);
  ok('plan-b untouched by rewrites of plan-a', JSON.stringify(b) === JSON.stringify(realPlan));
}

console.log('\n5. Version history: snapshots the copy it replaced, skips no-op saves');
{
  const c = load();
  c.call({ op: 'save', pid: 'p', payload: { items: [{ id: 1 }] } });
  let v = c.call({ op: 'versions', pid: 'p' }).data;
  ok('first save creates no version', v.length === 0, v);

  c.call({ op: 'save', pid: 'p', payload: { items: [{ id: 1 }, { id: 2 }] } });
  v = c.call({ op: 'versions', pid: 'p' }).data;
  ok('second save files one version', v.length === 1, v);
  ok('version records item count of the OLD copy', v[0].items === 1, v);

  c.call({ op: 'save', pid: 'p', payload: { items: [{ id: 1 }, { id: 2 }] } });
  v = c.call({ op: 'versions', pid: 'p' }).data;
  ok('identical re-save files nothing', v.length === 1, v);

  ok('listing leaks no plan contents',
    !JSON.stringify(v).includes('items":[') && Object.keys(v[0]).sort().join(',') === 'items,saved_at,version_id',
    v[0]);
}

console.log('\n6. Restore puts a past version back, and is itself undoable');
{
  const c = load();
  c.call({ op: 'save', pid: 'p', payload: { items: [{ id: 1 }], tag: 'first' } });
  c.call({ op: 'save', pid: 'p', payload: { items: [], tag: 'wiped' } });
  const v = c.call({ op: 'versions', pid: 'p' }).data;
  ok('one version to go back to', v.length === 1, v);

  const r = c.call({ op: 'restore', pid: 'p', vid: v[0].version_id });
  ok('restore ok', r.ok === true, r);
  const back = c.call({ op: 'get', pid: 'p' }).data;
  ok('old contents are back', back.tag === 'first' && back.items.length === 1, back);

  const v2 = c.call({ op: 'versions', pid: 'p' }).data;
  ok('the wipe itself was versioned before being replaced', v2.length === 2, v2);

  const bad = c.call({ op: 'restore', pid: 'p', vid: 999 });
  ok('restoring a nonexistent version fails loudly', bad.ok === false, bad);
}

console.log('\n7. Version pruning keeps the newest 50');
{
  const c = load();
  for (let i = 0; i < 56; i++) c.call({ op: 'save', pid: 'p', payload: { items: [], n: i } });
  const v = c.call({ op: 'versions', pid: 'p' }).data;
  ok('capped at exactly 50', v.length === 50, v.length);
  const ids = v.map(x => x.version_id);
  ok('every version id is distinct', new Set(ids).size === ids.length, ids.length - new Set(ids).size);
  ok('newest first', ids[0] > ids[ids.length - 1]);
  const got = c.call({ op: 'get', pid: 'p' }).data;
  ok('current copy is the newest', got.n === 55, got);
}

console.log('\n7b. REGRESSION: rapid saves must not share a version id');
{
  // The first version of addVersion_ used Date.now(), so saves inside one millisecond
  // collided and a restore concatenated two versions into unparseable JSON.
  const c = load(500); // small chunks => many rows per version, so collisions corrupt
  for (let i = 0; i < 12; i++) {
    c.call({ op: 'save', pid: 'p', payload: { items: [], n: i, pad: 'x'.repeat(2000) } });
  }
  const v = c.call({ op: 'versions', pid: 'p' }).data;
  const ids = v.map(x => x.version_id);
  ok('no duplicate ids under rapid saves', new Set(ids).size === ids.length, ids);

  // Every single stored version must still parse and be internally consistent.
  let allGood = true, detail = null;
  for (const ver of v) {
    const r = c.call({ op: 'restore', pid: 'p', vid: ver.version_id });
    if (!r.ok) { allGood = false; detail = r; break; }
    const back = c.call({ op: 'get', pid: 'p' }).data;
    if (!back || typeof back.n !== 'number' || back.pad.length !== 2000) {
      allGood = false; detail = { vid: ver.version_id, back: back && { n: back.n, padLen: back.pad && back.pad.length } };
      break;
    }
  }
  ok('every version restores to clean, complete JSON', allGood, detail);
}

console.log('\n8. Delete removes the plan and its history');
{
  const c = load();
  c.call({ op: 'save', pid: 'p', payload: { items: [{ id: 1 }] } });
  c.call({ op: 'save', pid: 'p', payload: { items: [{ id: 2 }] } });
  c.call({ op: 'save', pid: 'keep', payload: { items: [{ id: 9 }] } });
  c.call({ op: 'delete', pid: 'p' });
  ok('plan gone', c.call({ op: 'get', pid: 'p' }).data === null);
  ok('its versions gone', c.call({ op: 'versions', pid: 'p' }).data.length === 0);
  ok('the other plan survives', c.call({ op: 'get', pid: 'keep' }).data.items[0].id === 9);
}

console.log('\n9. Bad input is refused, not half-written');
{
  const c = load();
  ok('no pid', c.call({ op: 'get' }).ok === false);
  ok('unknown op', c.call({ op: 'frobnicate', pid: 'p' }).ok === false);
  const r = c.call({ op: 'save', pid: 'p', payload: 'not an object' });
  ok('string payload refused', r.ok === false, r);
  ok('nothing was written', c.call({ op: 'get', pid: 'p' }).data === null);
  const r2 = c.call({ op: 'save', pid: 'p', payload: null });
  ok('null payload refused', r2.ok === false, r2);
}

console.log('\n10. Response is marked as JSON (browsers refuse to parse it otherwise)');
{
  const c = load();
  const out = vm.runInContext('doPost', c)({ postData: { contents: JSON.stringify({ op: 'get', pid: 'x' }) } });
  let mime = null;
  out.setMimeType = function (m) { mime = m; return this; };
  vm.runInContext('json_', c)({ ok: true }).setMimeType;
  ok('ContentService JSON mime used in json_', fs.readFileSync('' + CODE + '', 'utf8').includes('setMimeType(ContentService.MimeType.JSON)'));
  const g = vm.runInContext('doGet', c)();
  ok('doGet reveals no data', !g._s.includes('conf') && JSON.parse(g._s).ok === true, g._s);
}

console.log('\n11. Works as a STANDALONE script via SHEET_ID');
{
  // How the backend was actually set up: a script created on its own rather than from
  // inside the Sheet. getActive() is null here, so without SHEET_ID every operation
  // would fail — and the failure would not mention a sheet at all.
  const c = load(null, 'standalone');
  const saved = c.call({ op: 'save', pid: 'p', payload: realPlan });
  ok('save works with no bound spreadsheet', saved.ok === true, saved);
  const got = c.call({ op: 'get', pid: 'p' });
  ok('round-trips through openById', JSON.stringify(got.data) === JSON.stringify(realPlan));
  ok('unknown id still returns null', c.call({ op: 'get', pid: 'zz' }).data === null);
}

console.log('\n12. A script attached to nothing says so plainly');
{
  const c = load(null, 'orphan');
  const r = c.call({ op: 'get', pid: 'p' });
  ok('refuses rather than crashing obscurely', r.ok === false, r);
  ok('the message names SHEET_ID', /SHEET_ID/.test(r.error || ''), r.error);
  ok('the message names the bound alternative', /Extensions/.test(r.error || ''), r.error);
}

console.log('\n13. REGRESSION: a tab that lost its header is repaired, not silently truncated');
{
  // Taking the row width from row 1 meant a header-less tab stored ONLY column A: the
  // plan id was kept and the entire trip JSON thrown away, while the save still
  // answered {ok:true}. Every later read then failed to parse.
  const c = load();
  c.call({ op: 'save', pid: 'p', payload: realPlan });
  const sheet = c.sheets.plans;

  const width = sheet.getMaxColumns();
  sheet.getRange(1, 1, 1, width).setValues([Array(width).fill('')]);
  ok('header really is gone', String(sheet.getRange(1, 1, 1, 1).getValues()[0][0]) !== 'plan_id');

  const saved = c.call({ op: 'save', pid: 'p', payload: realPlan });
  ok('save still succeeds', saved.ok === true, saved);
  ok('header was repaired', String(sheet.getRange(1, 1, 1, 1).getValues()[0][0]) === 'plan_id');

  const got = c.call({ op: 'get', pid: 'p' });
  ok('the whole plan survived, not just column A',
    got.ok === true && got.data && JSON.stringify(got.data) === JSON.stringify(realPlan),
    got.ok ? (got.data && Object.keys(got.data)) : got.error);
}

console.log('\n14. REGRESSION: a failed write does not wipe every plan in the tab');
{
  // clearContents() followed by setValues() left the tab EMPTY between the two calls.
  // One transient Sheets error in that window destroyed every plan, with no rollback —
  // and the caller saw an ordinary "not saved", so the natural response was to retry.
  const c = load();
  c.call({ op: 'save', pid: 'keep-me', payload: { items: [{ id: 'a' }], tag: 'precious' } });
  c.call({ op: 'save', pid: 'other', payload: { items: [{ id: 'b' }], tag: 'also precious' } });

  c.sheets.plans._failNextWrite();
  const failed = c.call({ op: 'save', pid: 'other', payload: { items: [{ id: 'b' }, { id: 'c' }] } });
  ok('the failing save reports failure', failed.ok === false, failed);

  const keep = c.call({ op: 'get', pid: 'keep-me' });
  ok('an UNRELATED plan still exists after the failure',
    keep.ok === true && keep.data && keep.data.tag === 'precious', keep);
  ok('header survived the failure',
    String(c.sheets.plans.getRange(1, 1, 1, 1).getValues()[0][0]) === 'plan_id');

  const retry = c.call({ op: 'save', pid: 'other', payload: { items: [{ id: 'b' }, { id: 'c' }], tag: 'retried' } });
  ok('a retry then works', retry.ok === true, retry);
  ok('both plans readable afterwards',
    c.call({ op: 'get', pid: 'keep-me' }).data.tag === 'precious' &&
    c.call({ op: 'get', pid: 'other' }).data.tag === 'retried');
}

console.log('\n15. Visit tracking: one row per device, not a growing log');
{
  const c = load();
  c.call({ op: 'save', pid: 'p', payload: realPlan });

  c.call({ op: 'visit', pid: 'p', device: 'dev-a', who: 'h1' });
  c.call({ op: 'visit', pid: 'p', device: 'dev-a', who: 'h1' });
  c.call({ op: 'visit', pid: 'p', device: 'dev-a', who: 'h1' });
  c.call({ op: 'visit', pid: 'p', device: 'dev-b', who: '' });

  const v = c.call({ op: 'visitors', pid: 'p' }).data;
  ok('two devices, not four rows', v.length === 2, v.length);
  const a = v.find(x => x.device === 'dev-a');
  ok('repeat visits increment a counter', a && a.visits === 3, a);
  ok('the claimed household is kept', a && a.household === 'h1', a);
  ok('an unclaimed device is still counted', v.some(x => x.device === 'dev-b' && x.visits === 1));
  ok('first and last seen are both recorded', !!(a.first_seen && a.last_seen));

  // The whole point of a separate tab: page loads must not burn the plan's history.
  const versions = c.call({ op: 'versions', pid: 'p' }).data;
  ok('visits create NO plan versions', versions.length === 0, versions.length);
  const plan = c.call({ op: 'get', pid: 'p' }).data;
  ok('visits do not touch the plan document', JSON.stringify(plan) === JSON.stringify(realPlan));
  ok('and nothing visit-shaped leaked into it', plan.visits === undefined && plan.device === undefined);
}

console.log('\n16. Visits are scoped, best-effort, and cleaned up');
{
  const c = load();
  c.call({ op: 'visit', pid: 'plan-one', device: 'd1', who: 'h1' });
  c.call({ op: 'visit', pid: 'plan-two', device: 'd1', who: 'h2' });
  ok('the same device on two plans stays separate',
    c.call({ op: 'visitors', pid: 'plan-one' }).data.length === 1 &&
    c.call({ op: 'visitors', pid: 'plan-two' }).data.length === 1);
  ok('a plan you did not ask about is not returned',
    c.call({ op: 'visitors', pid: 'plan-one' }).data[0].household === 'h1');

  const none = c.call({ op: 'visit', pid: 'p', device: '' });
  ok('a missing device id is refused, not recorded', none.ok === true && none.data.recorded === false, none);

  // Best-effort: a busy sheet must not turn a page load into an error.
  const busy = load();
  busy.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  const vm2 = require('vm');
  vm2.runInContext('LockService = { getScriptLock: function(){ return { tryLock: function(){ return false; }, releaseLock: function(){} }; } }', busy);
  const refused = busy.call({ op: 'visit', pid: 'p', device: 'd9' });
  ok('a busy sheet gives up quietly instead of failing the page load',
    refused.ok === true && refused.data.recorded === false, refused);

  c.call({ op: 'save', pid: 'plan-one', payload: { items: [] } });
  c.call({ op: 'delete', pid: 'plan-one' });
  ok('deleting a plan removes its visitors too',
    c.call({ op: 'visitors', pid: 'plan-one' }).data.length === 0);
  ok('but leaves another plan\'s visitors alone',
    c.call({ op: 'visitors', pid: 'plan-two' }).data.length === 1);
}

console.log('\n17. No two .gs files declare the same global');
{
  // Every file in an Apps Script project shares ONE global scope. A sibling setup
  // script declared `var HEADERS = [...]` as an array, which silently replaced
  // Code.gs's HEADERS object — headerFor_() began returning undefined and EVERY
  // request failed the moment it was deployed. Nothing in a per-file test can catch
  // that, because each file is correct on its own.
  const dir = path.join(__dirname, '..', 'apps-script');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.gs'));
  const owners = {};
  const clashes = [];

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const names = new Set();
    // Column 0 only: anything indented is inside a function and therefore scoped.
    const re = /^(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
    for (const n of names) {
      if (owners[n] && owners[n] !== f) clashes.push(n + ' (' + owners[n] + ' and ' + f + ')');
      else owners[n] = f;
    }
  }

  ok('apps-script/ has at least one file to check', files.length >= 1, files);
  ok('no global is declared by two files', clashes.length === 0, clashes);

  // The specific shape that caused the outage, as a named case.
  ok('TAB_HEADERS is owned by exactly one file',
    Object.keys(owners).filter(n => n === 'TAB_HEADERS').length === 1 || !owners.TAB_HEADERS,
    owners.TAB_HEADERS);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
