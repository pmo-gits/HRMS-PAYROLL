/**
 * _tests/run-salary-watcher.js — EXECUTED tests for the Salary Master hash
 * watcher (salary-advance-master/7_SalaryMasterWatcher.gs) and the shared
 * module lock (withEmiLock_ in 0_WebApp.gs).
 *
 * The real, unmodified functions run against the in-memory Sheets emulator.
 * MD5 and base64 come from Node's crypto — the real algorithms, not stand-ins,
 * because a fake digest would make every "did the hash change?" assertion
 * meaningless.
 *
 * TWO SPREADSHEETS ARE MODELLED, which is the whole point of this watcher:
 * it reads REVISION_HISTORY from the SALARY REVISION HISTORY file and writes
 * SALARY master in the SALARY ADVANCE MASTER file. openById is keyed by id so
 * a mix-up between the two would fail rather than silently pass.
 *
 * EXPECTATIONS ARE DERIVED FROM THE STATED PURPOSE:
 *
 *   1. Re-sync when a salary the gate actually uses changes; stay quiet
 *      otherwise. Only ACTIVE_FOR_PAYROLL = ACTIVE rows, columns A:N, count.
 *   2. Advance the stored hash ONLY after a successful sync, so a failure is
 *      retried rather than silently marked as handled.
 *   3. An unreadable or empty source must never trigger a rebuild that would
 *      empty the local mirror.
 *   4. The module lock fails CLOSED: if it cannot be acquired, the operation
 *      refuses and changes nothing.
 *
 * Run:  node _tests/run-salary-watcher.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const { Sheet, Spreadsheet } = require('./sheets');
const { formatDate, forbidden, REPO_ROOT } = require('./harness');

/* ------------------------------------------------------------------ */

const results = [];
let group = '(none)';
function describe(n, fn) { group = n; fn(); }
function record(n, ok, detail) { results.push({ group, name: n, ok, detail: detail || '' }); }
function eq(n, a, e) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  record(n, A === E, A === E ? '' : `expected ${E}, got ${A}`);
}
function ok(n, cond, detail) { record(n, !!cond, cond ? '' : (detail || 'expected truthy')); }
function ne(n, a, b, detail) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  record(n, !same, same ? (detail || `expected them to differ, both were ${JSON.stringify(a)}`) : '');
}

/* ------------------------------------------------------------------ *
 * the two spreadsheets
 * ------------------------------------------------------------------ */

const ADV_ID = '172uLkW5v1Dr_fYO8rZ3GaAwYEyYyRc_n0PaVYjHDwUg';   // Salary Advance Master
const REV_ID = '1XsyWVct4LOVMvZMDq4EThD6mgoAoumN-_RNQiwy67KM';   // Salary Revision History

const REV_HEADERS = [
  'ID.NO', 'NAME', 'CATEGORY', 'DEPARTMENT', 'DESIGNATION',
  'BASIC', 'DA', 'TOTAL', 'HRA', 'CONV.ALL', 'SPL.ALL',
  'GROSS', 'CHANGE OF VALUE', 'EFFECTIVE_FROM',
  'REVISION_TYPE', 'APPROVAL_STATUS', 'PREV_EFFECTIVE_FROM',
  'ACTIVE_FOR_PAYROLL', 'APPROVED_BY', 'APPROVED_ON', 'COMMENTS',
  'REV_ID', 'AADHAAR NO',
];

const SAL_HEADERS = [
  'ID.NO', 'NAME', 'CATEGORY', 'DEPARTMENT', 'DESIGNATION',
  'BASIC', 'DA', 'TOTAL', 'HRA', 'CONV.ALL', 'SPL.ALL',
  'GROSS', 'CHANGE OF VALUE', 'EFFECTIVE_FROM', 'NET SALARY',
];

const GS_FILES = [
  'salary-advance-master/0_WebApp.gs',          // withEmiLock_
  'salary-advance-master/1_Advance_EMIScheduler.gs', // str_, num_, req_, getHeaderMap_
  'salary-advance-master/2_EmpMasterSync.gs',   // findLastDataRowByColumn_, ensureTargetHasRows_
  'salary-advance-master/4_SalaryMasterSync.gs',// syncSalaryMaster_Core_
  'salary-advance-master/7_SalaryMasterWatcher.gs',
];

/**
 * @param {Array} revRows one object per REVISION_HISTORY data row
 */
function makeWorld(revRows) {
  const rev = new Sheet('REVISION_HISTORY', REV_HEADERS, {
    computed: {
      // A whole-column MAP() spill in the live sheet: it stamps '' into every
      // row to the end of the reference, which is exactly why the watcher must
      // count rows off ID.NO instead of getLastRow().
      'AADHAAR NO': (sh, r) => (String(sh._get(r, 1) || '') ? '999999999999' : ''),
    },
  });
  const R = rev.colOf;

  revRows.forEach((q, i) => {
    const row = i + 2;
    rev._set(row, R['ID.NO'], q.emp);
    rev._set(row, R['NAME'], q.name || `NAME-${q.emp}`);
    rev._set(row, R['CATEGORY'], q.cat || 'WORKER');
    rev._set(row, R['DEPARTMENT'], 'PRODUCTION');
    rev._set(row, R['DESIGNATION'], 'TABLE WORKER');
    rev._set(row, R['BASIC'], q.basic == null ? 10000 : q.basic);
    rev._set(row, R['DA'], q.da == null ? 5000 : q.da);
    rev._set(row, R['TOTAL'], (q.basic == null ? 10000 : q.basic) + (q.da == null ? 5000 : q.da));
    rev._set(row, R['HRA'], 2000);
    rev._set(row, R['CONV.ALL'], 1000);
    rev._set(row, R['SPL.ALL'], 500);
    rev._set(row, R['GROSS'], q.gross == null ? 18500 : q.gross);
    rev._set(row, R['CHANGE OF VALUE'], q.change || '');
    rev._set(row, R['EFFECTIVE_FROM'], q.eff || '4/1/2026');
    rev._set(row, R['ACTIVE_FOR_PAYROLL'], q.active === undefined ? 'ACTIVE' : q.active);
  });

  const sal = new Sheet('SALARY master', SAL_HEADERS, {
    computed: {
      'NET SALARY': (sh, r) => (String(sh._get(r, 1) || '') ? Number(sh._get(r, 12)) - 1000 : ''),
    },
  });

  const advSS = new Spreadsheet({ 'SALARY master': sal });
  const revSS = new Spreadsheet({ 'REVISION_HISTORY': rev });
  const byId = { [ADV_ID]: advSS, [REV_ID]: revSS };

  const props = new Map();
  let lockHeld = false;

  const sandbox = {
    Utilities: {
      formatDate,
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
      // Real MD5 over the real payload — a stubbed digest would make every
      // "hash changed / did not change" assertion vacuous.
      computeDigest: (_alg, payload) => Array.from(crypto.createHash('md5').update(payload, 'utf8').digest()),
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    },
    Session: {
      getScriptTimeZone: () => 'Asia/Kolkata',
      getEffectiveUser: () => ({ getEmail: () => 'pmo@butlerleather.com' }),
    },
    SpreadsheetApp: {
      openById: id => {
        if (!byId[id]) throw new Error(`openById: unknown spreadsheet id ${id}`);
        return byId[id];
      },
      flush: () => {},
      CopyPasteType: { PASTE_VALUES: 'PASTE_VALUES' },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, v); },
        deleteProperty: k => { props.delete(k); },
      }),
    },
    // Single-holder, like the real thing: a nested acquire inside one execution
    // must be visible as a refusal, not silently succeed.
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
        releaseLock: () => { lockHeld = false; },
      }),
    },
    envDefineId_: (name, key, fallback) => { sandbox[name] = fallback; },
    ScriptApp: forbidden('ScriptApp'),
    HtmlService: forbidden('HtmlService'),
    DriveApp: forbidden('DriveApp'),
    UrlFetchApp: forbidden('UrlFetchApp'),
    console, Date, Math, JSON, Map, Set, Array, Object, String, Number, Boolean,
    RegExp, Error, isNaN, isFinite, parseFloat, parseInt, Buffer,
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const rel of GS_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    new vm.Script(fs.readFileSync(abs, 'utf8'), { filename: abs }).runInContext(ctx);
  }

  return {
    sandbox, rev, sal, props, R,
    hash: () => sandbox.buildSalaryRevisionHash_(),
    watch: () => sandbox.watchSalaryRevisionsAndSync(),
    stored: () => props.get('SALARY_REVISION_HASH_V1') || '',
    /** employee codes currently mirrored into SALARY master */
    mirrored: () => {
      const last = sal.getLastRow();
      const out = [];
      for (let r = 2; r <= last; r++) {
        const v = String(sal._get(r, 1) || '');
        if (v) out.push(v);
      }
      return out;
    },
    holdLock: () => { lockHeld = true; },
  };
}

const TWO_ACTIVE = [
  { emp: 'BUT-001', basic: 10000 },
  { emp: 'BUT-002', basic: 12000 },
];

/* ================================================================== *
 * The fingerprint
 * ================================================================== */

describe('what the fingerprint covers', () => {
  let w = makeWorld(TWO_ACTIVE);
  const base = w.hash();
  ok('a hash is produced', !!base);
  eq('reading twice with nothing changed gives the same hash', w.hash(), base);

  // A salary the gate actually uses.
  w = makeWorld(TWO_ACTIVE);
  w.rev._set(2, w.R['BASIC'], 11000);
  ne('changing an ACTIVE row\'s BASIC changes the hash', w.hash(), base);

  w = makeWorld(TWO_ACTIVE);
  w.rev._set(2, w.R['GROSS'], 19500);
  ne('changing an ACTIVE row\'s GROSS changes the hash', w.hash(), base);

  // A superseded row. REVISION_HISTORY keeps every revision ever made, so this
  // must NOT provoke a rebuild — it cannot change any salary the gate reads.
  w = makeWorld([
    { emp: 'BUT-001', basic: 10000 },
    { emp: 'BUT-002', basic: 12000 },
    { emp: 'BUT-001', basic: 8000, active: 'IN-ACTIVE' },
  ]);
  const withInactive = w.hash();
  eq('an IN-ACTIVE row does not contribute to the hash', withInactive, base);

  w.rev._set(4, w.R['BASIC'], 7000);
  eq('editing that IN-ACTIVE row still does not change it', w.hash(), withInactive);

  // Flipping which revision is live IS a change.
  w = makeWorld(TWO_ACTIVE);
  w.rev._set(3, w.R['ACTIVE_FOR_PAYROLL'], 'IN-ACTIVE');
  ne('deactivating a row changes the hash', w.hash(), base);

  w = makeWorld([
    { emp: 'BUT-001', basic: 10000 },
    { emp: 'BUT-002', basic: 12000 },
    { emp: 'BUT-003', basic: 9000 },
  ]);
  ne('a newly ACTIVE employee changes the hash', w.hash(), base);

  // Both the watcher and syncSalaryMaster_Core_ resolve columns by header NAME,
  // so a renamed source column does NOT hash differently — it throws, before
  // any hashing happens. Correct: the sync could not have run either, and the
  // stored hash stays put so every tick keeps complaining until it is fixed.
  w = makeWorld(TWO_ACTIVE);
  w.rev._set(1, w.R['SPL.ALL'], 'SPECIAL ALLOWANCE');
  let renameErr = '';
  try { w.hash(); } catch (e) { renameErr = e.message; }
  ok('renaming a copied column throws rather than hashing quietly',
    /Missing required header/.test(renameErr), renameErr);
  ok('  ...naming the header that went missing', /SPL\.ALL/.test(renameErr), renameErr);

  // Nothing to hash must read as "no data", never as "changed to empty".
  w = makeWorld([]);
  eq('an empty source yields no hash at all', w.hash(), '');

  w = makeWorld([{ emp: 'BUT-001', active: 'IN-ACTIVE' }]);
  eq('a source with no ACTIVE rows yields no hash', w.hash(), '');
});

/* ================================================================== *
 * The watch cycle
 * ================================================================== */

describe('the watch cycle', () => {
  const w = makeWorld(TWO_ACTIVE);

  let r = w.watch();
  eq('the first run syncs', r.changed, true);
  eq('  ...mirroring both employees', w.mirrored(), ['BUT-001', 'BUT-002']);
  ok('  ...and stores the fingerprint', !!w.stored());

  const after = w.stored();
  r = w.watch();
  eq('an unchanged second run does nothing', r.changed, false);
  eq('  ...and says so', r.message, 'No salary changes since the last check.');
  eq('  ...leaving the stored fingerprint alone', w.stored(), after);

  // A real revision lands.
  w.rev._set(2, w.R['GROSS'], 25000);
  r = w.watch();
  eq('a changed salary re-syncs', r.changed, true);
  ne('  ...and advances the fingerprint', w.stored(), after);
  eq('  ...with the new figure mirrored', w.sal._get(2, 12), 25000);

  // An edit that cannot matter.
  const settled = w.stored();
  w.rev._set(1, w.R['COMMENTS'], 'note to self');
  r = w.watch();
  eq('an edit outside the mirrored columns is ignored', r.changed, false);
  eq('  ...fingerprint unmoved', w.stored(), settled);
});

describe('an empty source never empties the mirror', () => {
  const w = makeWorld(TWO_ACTIVE);
  w.watch();
  eq('mirrored to begin with', w.mirrored(), ['BUT-001', 'BUT-002']);

  // Every revision goes inactive — e.g. mid-edit in the source file.
  w.rev._set(2, w.R['ACTIVE_FOR_PAYROLL'], 'IN-ACTIVE');
  w.rev._set(3, w.R['ACTIVE_FOR_PAYROLL'], 'IN-ACTIVE');

  const r = w.watch();
  eq('the watcher declines to act on an empty source', r.changed, false);
  eq('  ...and SALARY master is left intact, not wiped',
    w.mirrored(), ['BUT-001', 'BUT-002']);
});

describe('the fingerprint advances only after a successful sync', () => {
  const w = makeWorld(TWO_ACTIVE);
  w.watch();
  const good = w.stored();

  // Break the destination the way a renamed or deleted tab would.
  w.rev._set(2, w.R['GROSS'], 30000);
  delete w.sandbox.__nothing__;
  const advSS = w.sandbox.SpreadsheetApp.openById(ADV_ID);
  const saved = advSS.sheets['SALARY master'];
  delete advSS.sheets['SALARY master'];

  let threw = false;
  try { w.watch(); } catch (e) { threw = true; }
  ok('a failed sync throws rather than reporting success', threw);
  eq('  ...and the fingerprint is NOT advanced, so the next tick retries',
    w.stored(), good);

  advSS.sheets['SALARY master'] = saved;
  const r = w.watch();
  eq('the retry then succeeds', r.changed, true);
  ne('  ...and only now advances the fingerprint', w.stored(), good);
});

describe('seeding', () => {
  const w = makeWorld(TWO_ACTIVE);
  w.sandbox.seedSalaryMasterHash();

  ok('seeding stores a fingerprint', !!w.stored());
  eq('  ...WITHOUT syncing anything', w.mirrored(), []);
  eq('  ...so the next watch run is a no-op', w.watch().changed, false);
});

/* ================================================================== *
 * The shared lock
 * ================================================================== */

describe('the module lock fails closed', () => {
  const w = makeWorld(TWO_ACTIVE);
  w.holdLock(); // somebody else is mid-operation

  let msg = '';
  try { w.sandbox.syncSalaryMaster_Core_(w.sandbox.SpreadsheetApp.openById(ADV_ID)); }
  catch (e) { msg = e.message; }

  ok('a contended lock refuses rather than proceeding', /could not start/.test(msg), msg);
  ok('  ...and says nothing was changed', /Nothing was changed/.test(msg), msg);
  eq('  ...which is true: the mirror is untouched', w.mirrored(), []);
});

describe('the watcher does not nest the lock', () => {
  // watchSalaryRevisionsAndSync delegates to syncSalaryMaster_Core_, which takes
  // the lock. If the watcher took it too, the inner acquire would be refused by
  // this single-holder lock — the same deadlock it would cause in Apps Script,
  // where LockService is not reentrant.
  const w = makeWorld(TWO_ACTIVE);
  let threw = '';
  try { w.watch(); } catch (e) { threw = e.message; }
  eq('a full watch run completes without a nested acquire', threw, '');
  eq('  ...and did its work', w.mirrored(), ['BUT-001', 'BUT-002']);
});

/* ------------------------------------------------------------------ */

let pass = 0, fail = 0, lastGroup = null;
for (const r of results) {
  if (r.group !== lastGroup) { console.log(`\n${r.group}`); lastGroup = r.group; }
  if (r.ok) { pass++; console.log(`  PASS  ${r.name}`); }
  else { fail++; console.log(`  FAIL  ${r.name}  -- ${r.detail}`); }
}
console.log(`\n${pass} passed, ${fail} failed, ${results.length} total`);
process.exit(fail ? 1 : 0);
