/**
 * _tests/run-remove-rows.js — EXECUTED tests for Remove Request Rows
 * (salary-advance-master/6_RemoveRequestRows.gs)
 *
 * The real, unmodified functions run against the in-memory Sheets emulator in
 * _tests/sheets.js. Every assertion reads the grid the code actually wrote.
 *
 * EXPECTATIONS ARE DERIVED FROM THE STATED RULE:
 *
 *   1. A selected row may be removed only while its EMI Reference Number is
 *      EMPTY. A scheduled advance has EMI_SCHEDULE rows and possibly recovery
 *      history pointing at it; removing the ledger row orphans them.
 *
 *   2. ALL-OR-NOTHING. If any selected row fails, NOTHING is deleted — deletion
 *      is irreversible and a wrong selection must be corrected by the person.
 *
 *   3. Row 2 holds the ARRAYFORMULA / MAP anchors for thirteen columns. Removing
 *      it must never write into a formula column and never destroy an anchor.
 *
 *   4. Every removal is recorded in "Removed Requests", attributed to the caller.
 *
 * Run:  node _tests/run-remove-rows.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { Sheet, Spreadsheet, makeGlobals } = require('./sheets');
const { formatDate, forbidden, REPO_ROOT } = require('./harness');

/* ------------------------------------------------------------------ *
 * tiny assertion runner
 * ------------------------------------------------------------------ */

const results = [];
let group = '(none)';
function describe(n, fn) { group = n; fn(); }
function record(n, ok, detail) { results.push({ group, name: n, ok, detail: detail || '' }); }
function eq(n, a, e) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  record(n, A === E, A === E ? '' : `expected ${E}, got ${A}`);
}
function ok(n, cond, detail) { record(n, !!cond, cond ? '' : (detail || 'expected truthy')); }

/* ------------------------------------------------------------------ *
 * the world
 * ------------------------------------------------------------------ */

const LEDGER_HEADERS = [
  'Employee Code', 'Name', 'Department', 'Designation', 'Status', 'Aadhaar No',
  'Advance Reason Category', 'Reason Details', 'Eligible Amount', 'Eligibility Status',
  'Advance Amount', 'Tenure', 'Advance Paid Month [MM/DD/YY]', 'EMI Start Month [MM/DD/YY]',
  'EMI Amount', 'EMI Scheduled status', 'EMI Reference Number', 'Recovered Amount',
  'Balance Amount', 'HR status', 'EMI Status', 'Planned Loan Closing Month',
  'Actual Loan Closing Month', 'Deviation',
  'Eligibility Override By', 'Eligibility Override On',
];

/**
 * The thirteen formula columns of the live Advance Ledger, modelled as computed
 * so the emulator records (and refuses) any write into them — which is exactly
 * the failure the row-2 path has to avoid.
 */
function ledgerComputed() {
  const empAt = (sh, r) => String(sh._get(r, 1) || '');
  const refAt = (sh, r) => String(sh._get(r, 17) || '');
  return {
    'NAME':                      (sh, r) => (empAt(sh, r) ? `NAME-${empAt(sh, r)}` : ''),
    'DEPARTMENT':                (sh, r) => (empAt(sh, r) ? 'PRODUCTION' : ''),
    'DESIGNATION':               (sh, r) => (empAt(sh, r) ? 'TABLE WORKER' : ''),
    'STATUS':                    (sh, r) => (empAt(sh, r) ? 'ACTIVE' : ''),
    'AADHAAR NO':                (sh, r) => (empAt(sh, r) ? '000000000000' : ''),
    'ELIGIBLE AMOUNT':           (sh, r) => (empAt(sh, r) ? 20000 : ''),
    'ELIGIBILITY STATUS':        (sh, r) => (empAt(sh, r) && !refAt(sh, r) ? 'OK' : ''),
    'EMI AMOUNT':                (sh, r) => (empAt(sh, r) ? 1000 : ''),
    'RECOVERED AMOUNT':          (sh, r) => (refAt(sh, r) ? 0 : ''),
    'BALANCE AMOUNT':            (sh, r) => (refAt(sh, r) ? Number(sh._get(r, 11)) || 0 : ''),
    'HR STATUS':                 () => '',
    'EMI STATUS':                (sh, r) => (refAt(sh, r) ? 'ACTIVE' : ''),
    'PLANNED LOAN CLOSING MONTH': () => '',
    'ACTUAL LOAN CLOSING MONTH':  () => '',
    'DEVIATION':                  () => '',
  };
}

const GS_FILES = [
  // Declares withEmiLock_, the shared module lock every Core now runs under.
  // Loaded as the real file rather than stubbed: the lock is part of the
  // behaviour under test, not scaffolding around it.
  'salary-advance-master/0_WebApp.gs',
  'salary-advance-master/1_Advance_EMIScheduler.gs',
  // Loaded because files 5 and 6 call findLastDataRowByColumn_ / ensureTargetHasRows_,
  // which are declared HERE. In Apps Script every file in a project shares one
  // global scope so this works invisibly; the test has to reproduce it, and
  // loading the real file is the honest way — a hand-written stand-in would only
  // prove the stand-in agrees with itself.
  'salary-advance-master/2_EmpMasterSync.gs',
  'salary-advance-master/5_AdvanceEligibility.gs',
  'salary-advance-master/6_RemoveRequestRows.gs',
];

/**
 * @param {Array} requests one object per ledger data row, in sheet order
 */
function makeWorld(requests) {
  const ledger = new Sheet('Advance Ledger', LEDGER_HEADERS, { computed: ledgerComputed() });
  const C = ledger.colOf;

  requests.forEach((q, i) => {
    const row = i + 2;
    ledger._set(row, C['EMPLOYEE CODE'], q.emp);
    ledger._set(row, C['ADVANCE REASON CATEGORY'], q.reason || 'MEDICAL');
    ledger._set(row, C['REASON DETAILS'], q.detail || '');
    ledger._set(row, C['ADVANCE AMOUNT'], q.amt == null ? '' : q.amt);
    ledger._set(row, C['TENURE'], q.tenure == null ? '' : q.tenure);
    ledger._set(row, C['ADVANCE PAID MONTH [MM/DD/YY]'], q.paid || 'April_2026');
    ledger._set(row, C['EMI START MONTH [MM/DD/YY]'], q.start || 'May_2026');
    ledger._set(row, C['EMI REFERENCE NUMBER'], q.ref || '');
    ledger._set(row, C['EMI SCHEDULED STATUS'], q.ref ? 'Scheduled - x' : '');
  });

  const ss = new Spreadsheet({ 'Advance Ledger': ledger });

  const sandbox = {
    Utilities: { formatDate },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata',
               getEffectiveUser: () => ({ getEmail: () => 'pmo@butlerleather.com' }) },
    HtmlService: forbidden('HtmlService'),
    // 2_EmpMasterSync.gs resolves its source ID through the env registry at load
    // time. The registry is not under test here; the production fallback is
    // simply bound to the name, which is what envId_ does in production anyway.
    envDefineId_: (name, key, fallback) => { sandbox[name] = fallback; },
    DriveApp: forbidden('DriveApp'),
    UrlFetchApp: forbidden('UrlFetchApp'),
    // A real, working single-holder lock rather than a no-op: an accidental
    // nested acquire (a locked Core calling another locked Core) must surface
    // here as a failure, exactly as it would deadlock in Apps Script.
    LockService: (() => {
      let held = false;
      return {
        getScriptLock: () => ({
          tryLock: () => { if (held) return false; held = true; return true; },
          releaseLock: () => { held = false; },
        }),
      };
    })(),
    console, Date, Math, JSON, Map, Set, Array, Object, String, Number, Boolean,
    RegExp, Error, isNaN, isFinite, parseFloat, parseInt,
  };
  Object.assign(sandbox, makeGlobals(ss));
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const rel of GS_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    new vm.Script(fs.readFileSync(abs, 'utf8'), { filename: abs }).runInContext(ctx);
  }

  return {
    ss, ledger, sandbox,
    remove(rows, by) {
      return sandbox.removeRequestRows_Core_(ss, rows, by || 'hrassist@butlerleather.com');
    },
    /** employee codes still present, in sheet order */
    codes() {
      const last = ledger.getLastRow();
      const out = [];
      for (let r = 2; r <= last; r++) {
        const v = String(ledger._get(r, C['EMPLOYEE CODE']) || '');
        if (v) out.push(v);
      }
      return out;
    },
    log() {
      const sh = ss.getSheetByName('Removed Requests');
      if (!sh) return [];
      const last = sh.getLastRow();
      const out = [];
      for (let r = 2; r <= last; r++) {
        out.push({ by: sh._get(r, 2), emp: sh._get(r, 3), amt: sh._get(r, 8), srcRow: sh._get(r, 12) });
      }
      return out;
    },
  };
}

const THREE = [
  { emp: 'BUT-001', amt: 5000, tenure: 5 },
  { emp: 'BUT-002', amt: 6000, tenure: 6 },
  { emp: 'BUT-003', amt: 7000, tenure: 7 },
];

/* ================================================================== *
 * Rule 1 — a scheduled row is not removable
 * ================================================================== */

describe('a scheduled row cannot be removed (rule 1)', () => {
  const w = makeWorld([
    { emp: 'BUT-001', amt: 5000, tenure: 5 },
    { emp: 'BUT-002', amt: 6000, tenure: 6, ref: 'EMI-50' },
  ]);

  const r = w.remove([3]);
  eq('the request is refused', r.success, false);
  eq('nothing is deleted', w.codes(), ['BUT-001', 'BUT-002']);
  ok('the message names the reference so HR knows where to look',
    /EMI-50/.test(r.message), r.message);
  ok('and points at Cancel EMI instead', /Cancel EMI/.test(r.message), r.message);
  eq('nothing is logged for a refused request', w.log().length, 0);
});

/* ================================================================== *
 * Rule 2 — all-or-nothing
 * ================================================================== */

describe('all-or-nothing (rule 2)', () => {
  const w = makeWorld([
    { emp: 'BUT-001', amt: 5000, tenure: 5 },
    { emp: 'BUT-002', amt: 6000, tenure: 6, ref: 'EMI-50' },
    { emp: 'BUT-003', amt: 7000, tenure: 7 },
  ]);

  const r = w.remove([2, 3, 4]);
  eq('one bad row refuses the whole selection', r.success, false);
  eq('the two removable rows are NOT removed either',
    w.codes(), ['BUT-001', 'BUT-002', 'BUT-003']);
  eq('nothing reaches the log', w.log().length, 0);

  // The header and rows past the data are equally terminal.
  const w2 = makeWorld(THREE);
  eq('selecting the header row refuses', w2.remove([1, 3]).success, false);
  eq('  ...and deletes nothing', w2.codes(), ['BUT-001', 'BUT-002', 'BUT-003']);

  const w3 = makeWorld(THREE);
  eq('selecting past the last data row refuses', w3.remove([3, 900]).success, false);
  eq('  ...and deletes nothing', w3.codes(), ['BUT-001', 'BUT-002', 'BUT-003']);

  const w4 = makeWorld(THREE);
  eq('an empty selection removes nothing', w4.remove([]).success, false);
  eq('  ...leaving every row', w4.codes(), ['BUT-001', 'BUT-002', 'BUT-003']);
});

/* ================================================================== *
 * Ordinary removal, below row 2
 * ================================================================== */

describe('removing rows below row 2', () => {
  let w = makeWorld(THREE);
  let r = w.remove([3]);
  eq('a single middle row goes', r.success, true);
  eq('  ...and the rest close up', w.codes(), ['BUT-001', 'BUT-003']);
  eq('  ...one removal reported', r.removed, 1);

  // Several rows at once must all go. If deletion ran top-down, the second
  // target would have shifted up by one and the WRONG row would be deleted.
  w = makeWorld([
    { emp: 'BUT-001', amt: 1000, tenure: 1 },
    { emp: 'BUT-002', amt: 2000, tenure: 2 },
    { emp: 'BUT-003', amt: 3000, tenure: 3 },
    { emp: 'BUT-004', amt: 4000, tenure: 4 },
  ]);
  r = w.remove([3, 5]);
  eq('two non-adjacent rows both go, and the right ones',
    w.codes(), ['BUT-001', 'BUT-003']);
  eq('  ...both counted', r.removed, 2);
});

/* ================================================================== *
 * Rule 3 — row 2 holds the formula anchors
 * ================================================================== */

describe('row 2 is the formula anchor (rule 3)', () => {
  let w = makeWorld(THREE);
  let r = w.remove([2]);

  eq('removing row 2 succeeds', r.success, true);
  eq('  ...the request is gone and the rest shift up', w.codes(), ['BUT-002', 'BUT-003']);
  eq('  ...NOTHING was written into a formula column',
    w.ledger.formulaWrites.map(x => x.header), []);
  eq('  ...and the ARRAYFORMULA anchors were never deleted',
    !!w.ledger.anchorsDestroyed, false);
  eq('  ...and the formula columns still compute for the new row 2',
    w.ledger._get(2, w.ledger.colOf['NAME']), 'NAME-BUT-002');

  // Row 2 together with rows below it: bottom-up plus row-2-last must leave
  // exactly the survivors, with the anchors intact.
  w = makeWorld([
    { emp: 'BUT-001', amt: 1000, tenure: 1 },
    { emp: 'BUT-002', amt: 2000, tenure: 2 },
    { emp: 'BUT-003', amt: 3000, tenure: 3 },
  ]);
  r = w.remove([2, 3]);
  eq('row 2 and row 3 together', w.codes(), ['BUT-003']);
  eq('  ...still no formula-column write', w.ledger.formulaWrites.length, 0);
  eq('  ...anchors intact', !!w.ledger.anchorsDestroyed, false);
  eq('  ...and row 2 computes for the survivor',
    w.ledger._get(2, w.ledger.colOf['NAME']), 'NAME-BUT-003');

  // The single-row case: row 2 cannot be deleted at all without taking the
  // anchors with it, so its inputs are cleared and the row survives.
  w = makeWorld([{ emp: 'BUT-001', amt: 5000, tenure: 5 }]);
  r = w.remove([2]);
  eq('the only data row is emptied, not deleted', r.success, true);
  eq('  ...no request remains', w.codes(), []);
  eq('  ...no formula-column write', w.ledger.formulaWrites.length, 0);
  eq('  ...anchors intact — the row was emptied, never deleted',
    !!w.ledger.anchorsDestroyed, false);
  eq('  ...the Advance Amount is cleared',
    w.ledger._get(2, w.ledger.colOf['ADVANCE AMOUNT']), '');
  eq('  ...and the row is inert to the rest of the module (no Employee Code)',
    w.ledger._get(2, w.ledger.colOf['EMPLOYEE CODE']), '');

  // A row-2 removal shifts row 3 up — including a row that IS scheduled. Its
  // reference must travel with it or the advance would be orphaned in place.
  w = makeWorld([
    { emp: 'BUT-001', amt: 1000, tenure: 1 },
    { emp: 'BUT-002', amt: 2000, tenure: 2, ref: 'EMI-50' },
  ]);
  w.remove([2]);
  eq('a scheduled row shifted into row 2 keeps its EMI Reference',
    w.ledger._get(2, w.ledger.colOf['EMI REFERENCE NUMBER']), 'EMI-50');
  eq('  ...and its Advance Amount', w.ledger._get(2, w.ledger.colOf['ADVANCE AMOUNT']), 2000);
});

/* ================================================================== *
 * Rule 4 — the removal log
 * ================================================================== */

describe('removal log (rule 4)', () => {
  const w = makeWorld(THREE);
  w.remove([3, 4], 'hrassist@butlerleather.com');

  const log = w.log();
  eq('one log row per removal', log.length, 2);
  eq('  ...naming who removed them',
    log.map(x => x.by), ['hrassist@butlerleather.com', 'hrassist@butlerleather.com']);
  eq('  ...and which employees', log.map(x => x.emp).sort(), ['BUT-002', 'BUT-003']);
  eq('  ...with the amounts preserved', log.map(x => x.amt).sort(), [6000, 7000]);

  // A second removal appends rather than overwriting the first.
  w.remove([2], 'pmo@butlerleather.com');
  eq('a later removal appends to the same log', w.log().length, 3);
  eq('  ...attributed to whoever ran it',
    (w.log()[2] || {}).by, 'pmo@butlerleather.com');
});

/* ================================================================== *
 * Re-validation: the payload is a suggestion, not an instruction
 * ================================================================== */

describe('Core re-validates rather than trusting the caller', () => {
  const w = makeWorld([
    { emp: 'BUT-001', amt: 5000, tenure: 5 },
    { emp: 'BUT-002', amt: 6000, tenure: 6 },
  ]);

  // Somebody schedules BUT-002 between the confirmation dialog and the run.
  w.ledger._set(3, w.ledger.colOf['EMI REFERENCE NUMBER'], 'EMI-99');

  const r = w.remove([3]);
  eq('a row scheduled since the dialog opened is refused', r.success, false);
  eq('  ...and survives', w.codes(), ['BUT-001', 'BUT-002']);

  // A hand-edited payload cannot reach a scheduled row either — same check.
  const w2 = makeWorld([{ emp: 'BUT-001', amt: 5000, tenure: 5, ref: 'EMI-1' }]);
  eq('a crafted row number cannot remove a scheduled row', w2.remove([2]).success, false);
  eq('  ...which stays put', w2.codes(), ['BUT-001']);
});

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

let pass = 0, fail = 0, lastGroup = null;
for (const r of results) {
  if (r.group !== lastGroup) { console.log(`\n${r.group}`); lastGroup = r.group; }
  if (r.ok) { pass++; console.log(`  PASS  ${r.name}`); }
  else { fail++; console.log(`  FAIL  ${r.name}  -- ${r.detail}`); }
}
console.log(`\n${pass} passed, ${fail} failed, ${results.length} total`);
process.exit(fail ? 1 : 0);
