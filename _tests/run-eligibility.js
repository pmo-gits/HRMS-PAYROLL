/**
 * _tests/run-eligibility.js — executable unit tests for the advance-eligibility
 * gate in salary-advance-master/5_AdvanceEligibility.gs
 *
 * Plain Node. No framework, no npm. Run with:  node _tests/run-eligibility.js
 *
 * EXPECTATIONS ARE DERIVED FROM THE STATED RULE, NOT FROM THE CODE:
 *
 *   1. A new advance is allowed only while
 *        Advance Amount + SUM(that employee's existing ACTIVE advance balances)
 *        <= his NET SALARY
 *      Equality is allowed. Failing this is NOT overridable.
 *
 *   2. An employee is eligible only once he has completed 1 year of service,
 *      measured D.O.J + 1 year against TODAY. Failing this IS overridable.
 *
 *   3. Eligible Amount = MAX(0, net salary - existing active balances).
 *
 *   4. Only ACTIVE advances consume the ceiling. A closed/cancelled/written-off
 *      advance must not.
 *
 *   5. No active salary on record, or no D.O.J on record, blocks the advance.
 *      It must never be read as a ceiling of zero, nor as no ceiling at all.
 *
 *   6. Two NEW advances raised for the same employee in the same run must be
 *      judged together, not each against the full untouched ceiling.
 *
 * The two lookup readers and the clock are replaced with fixtures, because they
 * are Sheets I/O and a wall clock. Everything under test — the arithmetic, the
 * ACTIVE filter, the accumulation, the classification into overridable vs not —
 * is the real code.
 */

'use strict';

const { loadGsMany } = require('./harness');

// One shared global scope, exactly as Apps Script gives the real project:
// 5_AdvanceEligibility.gs uses str_/num_/req_/opt_ declared in file 1.
const SB = loadGsMany([
  'salary-advance-master/1_Advance_EMIScheduler.gs',
  'salary-advance-master/5_AdvanceEligibility.gs',
]);

/* ------------------------------------------------------------------ *
 * tiny assertion runner (same shape as run.js)
 * ------------------------------------------------------------------ */

const results = [];
let group = '(none)';

function describe(name, fn) { group = name; fn(); }
function record(name, ok, detail) { results.push({ group, name, ok, detail: detail || '' }); }
function eq(name, actual, expected) {
  const a = fmt(actual), e = fmt(expected);
  record(name, a === e, a === e ? '' : `expected ${e}, got ${a}`);
}
function ok(name, cond, detail) { record(name, !!cond, cond ? '' : (detail || 'expected truthy')); }

/**
 * Safe list access. A mutation that empties amountIssues must surface as a clean
 * FAIL on the assertion that cares, not as a TypeError that aborts the whole run
 * and hides every failure before it — which is exactly what happened the first
 * time this suite was mutation-checked.
 */
function at(list, i) { return (list && list[i]) || {}; }
function fmt(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? 'Invalid Date'
      : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

const TODAY = new Date(2026, 7, 22); // 22 Aug 2026 — fixed so tenure tests never drift

// Synthetic ledger column layout. The real indices come from header lookups,
// so any layout is legitimate here; what matters is that the builder is told
// which index means what, the same way scheduleEMI_Core_ tells it.
const C = { emp: 0, name: 1, advAmt: 2, ref: 3, emiStatus: 4, balance: 5 };
const L = { emp: C.emp, name: C.name, advAmt: C.advAmt, ref: C.ref };

/** Build the (values, display) pair the builder expects from one row spec. */
function ledger(rows) {
  const vals = rows.map(r => [r.emp, r.name || r.emp, r.amt == null ? '' : r.amt,
    r.ref || '', r.status || '', r.bal == null ? '' : r.bal]);
  const disp = vals.map(v => v.map(x => (x === '' || x == null) ? '' : String(x)));
  return { vals, disp };
}

/**
 * Run the real builder with fixture lookups in place of Sheets reads.
 * `nets` / `dojs` are keyed by UPPERCASE employee code, matching the readers'
 * documented contract: an employee ABSENT from the map has no record, which is
 * a different thing from a recorded value of 0.
 */
function build(rows, nets, dojs) {
  SB.advElig_ReadNetSalaryByEmp_ = () => new Map(Object.entries(nets || {}));
  SB.advElig_ReadDojByEmp_ = () => new Map(
    Object.entries(dojs || {}).map(([k, v]) => [k, v])
  );
  SB.advElig_TodayDateOnly_ = () => TODAY;

  const { vals, disp } = ledger(rows);
  return SB.advElig_BuildIssues_(null, vals, disp, L, C.emiStatus, C.balance);
}

const LONG_SERVICE = new Date(2015, 0, 10);          // comfortably over a year
const JOINED_RECENTLY = new Date(2026, 2, 1);        // 1 Mar 2026 — under a year at TODAY

/* ------------------------------------------------------------------ *
 * Rule 1 + 3 — the amount ceiling
 * ------------------------------------------------------------------ */

describe('amount ceiling (rule 1 and 3)', () => {
  const nets = { 'BUT-001': 20000 };
  const dojs = { 'BUT-001': LONG_SERVICE };

  let r = build([{ emp: 'BUT-001', amt: 15000 }], nets, dojs);
  eq('within the ceiling raises no issue at all', r.byRow.size, 0);

  r = build([{ emp: 'BUT-001', amt: 25000 }], nets, dojs);
  eq('over the ceiling is flagged', r.amountIssues.length, 1);
  eq('  ...with the shortfall stated', at(r.amountIssues,0).excess, 5000);
  eq('  ...and is NOT offered as a tenure override', r.tenureIssues.length, 0);

  r = build([{ emp: 'BUT-001', amt: 20000 }], nets, dojs);
  eq('exactly equal to net salary is ALLOWED (rule says "equal or less")',
    r.byRow.size, 0);

  r = build([{ emp: 'BUT-001', amt: 20001 }], nets, dojs);
  eq('one rupee over is refused', r.amountIssues.length, 1);
});

/* ------------------------------------------------------------------ *
 * Rule 7 — the ceiling is rounded DOWN to the nearest 500
 *
 *   An advance is paid as cash, so 34,999 is not a real figure. Rounding must
 *   go DOWN: it may only ever refuse money the unrounded rule would allow,
 *   never release money it would refuse. This must agree exactly with
 *   Advance Ledger!I2's FLOOR(..., 500) — if the sheet and the gate round
 *   differently, HR is shown one ceiling and refused at another.
 * ------------------------------------------------------------------ */

describe('ceiling rounds down to 500 (rule 7)', () => {
  const dojs = { 'BUT-007': LONG_SERVICE };

  // The worked example from the requirement: a 34,999 ceiling becomes 34,500.
  let r = build([{ emp: 'BUT-007', amt: 34999 }], { 'BUT-007': 34999 }, dojs);
  eq('34,999 of headroom yields a ceiling of 34,500',
    at(r.amountIssues, 0).eligible, 34500);
  ok('  ...so a request for the unrounded 34,999 is REFUSED',
    at(r.amountIssues, 0).amountFail);

  r = build([{ emp: 'BUT-007', amt: 34500 }], { 'BUT-007': 34999 }, dojs);
  eq('a request at the rounded ceiling is allowed', r.byRow.size, 0);

  r = build([{ emp: 'BUT-007', amt: 34501 }], { 'BUT-007': 34999 }, dojs);
  eq('one rupee above the ROUNDED ceiling is refused, though under the raw net',
    r.amountIssues.length, 1);

  // An exact multiple must not be pushed down a step.
  r = build([{ emp: 'BUT-007', amt: 20000 }], { 'BUT-007': 20000 }, dojs);
  eq('an exact multiple of 500 is left alone', r.byRow.size, 0);

  // Residual headroom below one step is not a payable advance.
  r = build([{ emp: 'BUT-007', amt: 400 }], { 'BUT-007': 499 }, dojs);
  eq('headroom under 500 floors to 0 and blocks the advance',
    at(r.amountIssues, 0).eligible, 0);

  // Float noise: (net - balance) is a difference of two sheet numbers, so a
  // value that should be exactly 34500 can arrive a hair under it. It must not
  // floor a whole step further down.
  r = build([
    { emp: 'BUT-007', ref: 'EMI-1', status: 'ACTIVE', bal: 0.0000000001 },
    { emp: 'BUT-007', amt: 34500 },
  ], { 'BUT-007': 34500 }, dojs);
  eq('float noise does not knock the ceiling down a whole step', r.byRow.size, 0);

  eq('floor helper: 34,999 -> 34,500', SB.advElig_FloorTo_(34999, 500), 34500);
  eq('floor helper: 500 -> 500', SB.advElig_FloorTo_(500, 500), 500);
  eq('floor helper: 499 -> 0', SB.advElig_FloorTo_(499, 500), 0);
  eq('floor helper: 0 -> 0', SB.advElig_FloorTo_(0, 500), 0);
  eq('floor helper: negative -> 0', SB.advElig_FloorTo_(-1200, 500), 0);
});

/* ------------------------------------------------------------------ *
 * Rule 1 + 4 — existing balances consume the ceiling, but only ACTIVE ones
 * ------------------------------------------------------------------ */

describe('existing advance balances (rule 1 and 4)', () => {
  const nets = { 'BUT-002': 20000 };
  const dojs = { 'BUT-002': LONG_SERVICE };

  const withActive = [
    { emp: 'BUT-002', ref: 'EMI-7', status: 'ACTIVE', bal: 8000 },
    { emp: 'BUT-002', amt: 15000 },
  ];
  let r = build(withActive, nets, dojs);
  eq('an active balance reduces the ceiling', r.amountIssues.length, 1);
  eq('  ...ceiling is net minus that balance', at(r.amountIssues,0).eligible, 12000);
  eq('  ...shortfall is measured against the reduced ceiling',
    at(r.amountIssues,0).excess, 3000);

  r = build([
    { emp: 'BUT-002', ref: 'EMI-7', status: 'ACTIVE', bal: 8000 },
    { emp: 'BUT-002', amt: 12000 },
  ], nets, dojs);
  eq('a request that fits the reduced ceiling passes', r.byRow.size, 0);

  for (const closed of ['CLOSED', 'CANCELLED', 'WRITE OFF']) {
    r = build([
      { emp: 'BUT-002', ref: 'EMI-7', status: closed, bal: 8000 },
      { emp: 'BUT-002', amt: 15000 },
    ], nets, dojs);
    eq(`a ${closed} advance does NOT consume the ceiling`, r.byRow.size, 0);
  }

  r = build([
    { emp: 'BUT-002', ref: 'EMI-7', status: 'ACTIVE', bal: 12000 },
    { emp: 'BUT-002', ref: 'EMI-9', status: 'ACTIVE', bal: 5000 },
    { emp: 'BUT-002', amt: 6000 },
  ], nets, dojs);
  eq('several active advances are summed, not taken one at a time',
    at(r.amountIssues,0).eligible, 3000);

  r = build([
    { emp: 'BUT-002', ref: 'EMI-7', status: 'ACTIVE', bal: 25000 },
    { emp: 'BUT-002', amt: 1000 },
  ], nets, dojs);
  eq('an over-committed employee has a ceiling of 0, never negative',
    at(r.amountIssues,0).eligible, 0);
});

/* ------------------------------------------------------------------ *
 * Rule 6 — two new advances in one run
 * ------------------------------------------------------------------ */

describe('two new advances in one run (rule 6)', () => {
  const nets = { 'BUT-003': 20000 };
  const dojs = { 'BUT-003': LONG_SERVICE };

  const r = build([
    { emp: 'BUT-003', amt: 12000 },
    { emp: 'BUT-003', amt: 12000 },
  ], nets, dojs);

  eq('the first fits and is allowed', r.byRow.has(0), false);
  eq('the second is judged against what the first already took', r.byRow.has(1), true);
  eq('  ...its ceiling is the remainder, not the full salary',
    at([r.byRow.get(1)],0).eligible, 8000);
  ok('  ...and it is refused, not merely warned about', at([r.byRow.get(1)],0).amountFail);
});

/* ------------------------------------------------------------------ *
 * Rule 2 — tenure, and that it is a SEPARATE, overridable failure
 * ------------------------------------------------------------------ */

describe('one year of service (rule 2)', () => {
  const nets = { 'BUT-004': 50000 };

  let r = build([{ emp: 'BUT-004', amt: 1000 }],
    nets, { 'BUT-004': JOINED_RECENTLY });
  eq('an employee under 1 year is flagged', r.tenureIssues.length, 1);
  eq('  ...and is NOT lumped in with the un-overridable failures',
    r.amountIssues.length, 0);
  ok('  ...the row is still marked as having an issue', r.byRow.has(0));

  // Exactly one year: D.O.J + 1 year == TODAY. "Crossed 1 year" includes the day
  // the year completes, so this must PASS.
  r = build([{ emp: 'BUT-004', amt: 1000 }],
    nets, { 'BUT-004': new Date(2025, 7, 22) });
  eq('the day the year completes is eligible', r.byRow.size, 0);

  r = build([{ emp: 'BUT-004', amt: 1000 }],
    nets, { 'BUT-004': new Date(2025, 7, 23) });
  eq('one day short is not', r.tenureIssues.length, 1);

  // An employee failing BOTH rules must be refused outright, never offered as a
  // tenure override — approving the tenure would otherwise release money he
  // cannot repay.
  r = build([{ emp: 'BUT-004', amt: 90000 }],
    nets, { 'BUT-004': JOINED_RECENTLY });
  eq('failing both rules is reported as un-overridable', r.amountIssues.length, 1);
  eq('  ...and is NOT offered in the tenure dialog', r.tenureIssues.length, 0);

  // One employee, two candidate rows, both under tenure: the dialog names him once.
  r = build([
    { emp: 'BUT-004', amt: 1000 },
    { emp: 'BUT-004', amt: 1000 },
  ], nets, { 'BUT-004': JOINED_RECENTLY });
  eq('an employee is named once in the tenure dialog, not once per row',
    r.tenureIssues.length, 1);
  eq('  ...though both his rows are still held back', r.byRow.size, 2);
});

/* ------------------------------------------------------------------ *
 * Rule 5 — missing records block; they are not a ceiling of zero
 * ------------------------------------------------------------------ */

describe('missing salary / D.O.J (rule 5)', () => {
  let r = build([{ emp: 'BUT-005', amt: 1000 }], {}, { 'BUT-005': LONG_SERVICE });
  eq('no salary on record blocks the advance', r.amountIssues.length, 1);
  ok('  ...flagged as missing, not as an over-limit amount',
    at(r.amountIssues,0).noSalary && !at(r.amountIssues,0).amountFail);
  eq('  ...and is not overridable via the tenure dialog', r.tenureIssues.length, 0);

  r = build([{ emp: 'BUT-005', amt: 1000 }], { 'BUT-005': 20000 }, {});
  eq('no D.O.J on record blocks the advance', r.amountIssues.length, 1);
  ok('  ...flagged as missing D.O.J', at(r.amountIssues,0).noDoj);
  eq('  ...and is NOT silently treated as 1 year completed',
    r.byRow.has(0), true);

  // A recorded net salary of 0 is a real ceiling of zero, not a missing record.
  r = build([{ emp: 'BUT-005', amt: 1000 }],
    { 'BUT-005': 0 }, { 'BUT-005': LONG_SERVICE });
  ok('a net salary of 0 is a real ceiling, distinct from "no record"',
    at(r.amountIssues,0).amountFail && !at(r.amountIssues,0).noSalary);
});

/* ------------------------------------------------------------------ *
 * Candidate selection — an already-scheduled row is not re-judged
 * ------------------------------------------------------------------ */

describe('candidate selection', () => {
  const nets = { 'BUT-006': 10000 };
  const dojs = { 'BUT-006': LONG_SERVICE };

  const r = build([
    // Already scheduled (has a reference) AND wildly over the ceiling. It is
    // history, not a request, and must not be re-litigated on every run.
    { emp: 'BUT-006', amt: 99999, ref: 'EMI-3', status: 'ACTIVE', bal: 5000 },
  ], nets, dojs);
  eq('a row that already has an EMI Reference is not re-judged', r.byRow.size, 0);

  const r2 = build([{ emp: '', amt: 5000 }], nets, dojs);
  eq('a blank employee row is ignored', r2.byRow.size, 0);

  // Blank amount: Phase 1 field validation owns that message, so the gate must
  // not also claim it is an eligibility failure.
  const r3 = build([{ emp: 'BUT-006' }], nets, dojs);
  eq('a blank Advance Amount is not an eligibility failure', r3.byRow.size, 0);
});

/* ------------------------------------------------------------------ *
 * Date handling
 * ------------------------------------------------------------------ */

describe('date handling', () => {
  eq('a real Date is accepted', SB.advElig_ToRealDate_(new Date(2020, 4, 9)),
    new Date(2020, 4, 9));
  eq('a bare spreadsheet serial is REFUSED, not read as year 46266',
    SB.advElig_ToRealDate_('46266'), null);
  eq('a blank cell is no date', SB.advElig_ToRealDate_(''), null);
  eq('junk is no date', SB.advElig_ToRealDate_('not a date'), null);

  eq('one year after 15 Mar 2025 is 15 Mar 2026',
    SB.advElig_OneYearFrom_(new Date(2025, 2, 15)), new Date(2026, 2, 15));

  // A D.O.J of 29 Feb has no anniversary in a non-leap year. EDATE(doj,12) in
  // Sheets gives 28 Feb; the JS Date constructor rolls to 1 Mar. Recorded here
  // as the known one-day divergence between HR's screen and this gate rather
  // than asserted as correct.
  const leap = SB.advElig_OneYearFrom_(new Date(2024, 1, 29));
  record('29 Feb + 1 year — documenting the JS roll-forward to 1 Mar',
    leap.getMonth() === 2 && leap.getDate() === 1,
    `got ${fmt(leap)}`);
});

describe('money formatting', () => {
  eq('zero', SB.advElig_Money_(0), '0');
  eq('thousands are grouped', SB.advElig_Money_(22472), '22,472');
  eq('lakhs are grouped', SB.advElig_Money_(100000), '100,000');
  eq('negatives keep their sign', SB.advElig_Money_(-77528), '-77,528');
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
