// Run: node tools/test-backend.js
//
// Exercises apps-script/Code.gs against fake Sheet APIs, so bugs surface here rather
// than on someone's phone mid-trip. No deployment and no network needed.
const path = require('path');
const os = require('os');
const CODE = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const fs = require('fs');
const vm = require('vm');

function makeSheet(name) {
  let data = [];
  const api = {
    name,
    _dump: () => data,
    getDataRange: () => ({
      getValues: () => (data.length ? data.map(r => r.slice()) : [['']]),
    }),
    appendRow: (r) => { data.push(r.slice()); },
    setFrozenRows: () => {},
    clearContents: () => { data = []; },
    getLastRow: () => data.length,
    getRange: (row, col, numRows, numCols) => ({
      setValues: (vals) => {
        if (vals.length !== numRows) throw new Error('setValues row count mismatch');
        for (const v of vals) {
          if (v.length !== numCols) throw new Error('setValues ragged row: ' + JSON.stringify(v));
        }
        for (let i = 0; i < numRows; i++) {
          const target = row - 1 + i;
          while (data.length <= target) data.push([]);
          const r = data[target];
          for (let j = 0; j < numCols; j++) r[col - 1 + j] = vals[i][j];
        }
      },
    }),
  };
  return api;
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
  ok('12 items', got.data.items.length === 12, got.data && got.data.items.length);
  ok('4 households', got.data.households.length === 4);
  ok('conf numbers intact', got.data.items.filter(i => i.conf).length === 4);
  ok('contributes flag intact', got.data.households.some(h => h.contributes === true));
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
