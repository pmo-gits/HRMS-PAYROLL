/**
 * _tests/run.js — executable unit tests for the pure helpers in
 * salary-advance-master/3A_Master_SharedEMILockSync.gs
 *
 * Plain Node. No framework, no npm. Run with:  node _tests/run.js
 *
 * EXPECTATIONS ARE DERIVED FROM THE SPEC, NOT FROM THE CODE.
 *   - _tests/cases/salary-advance.md          (the register)
 *   - _docs/salary-admin-settlement-plan.md   (design + rationale)
 *   - each helper's own documented purpose (its JSDoc contract)
 *
 * A test written by stepping through the implementation only proves the implementation
 * equals itself — including where it is wrong. Where a helper's contract is genuinely
 * ambiguous, the test says so in its name rather than pretending certainty.
 */

'use strict';

const { loadGs } = require('./harness');

const SB = loadGs('salary-advance-master/3A_Master_SharedEMILockSync.gs');

/* ------------------------------------------------------------------ *
 * tiny assertion runner
 * ------------------------------------------------------------------ */

const results = [];
let group = '(none)';

function describe(name, fn) {
  group = name;
  fn();
}

function record(name, ok, detail) {
  results.push({ group, name, ok, detail: detail || '' });
}

/**
 * A hardening gap: a safety property the spec implies but never states outright.
 * Reported loudly and counted separately, so it cannot be mistaken for a spec
 * regression and cannot silently turn the suite red either.
 */
function gap(name, ok, detail) {
  results.push({ group, name, ok, gap: true, detail: detail || '' });
}

function eq(name, actual, expected) {
  const a = fmt(actual);
  const e = fmt(expected);
  record(name, a === e, a === e ? '' : `expected ${e}, got ${a}`);
}

function isNull(name, actual) {
  const ok = actual === null;
  record(name, ok, ok ? '' : `expected null, got ${fmt(actual)}`);
}

/** Compare a Date to (y, m0, d) in LOCAL calendar terms. */
function isDate(name, actual, y, m0, d) {
  if (Object.prototype.toString.call(actual) !== '[object Date]' || isNaN(actual.getTime())) {
    record(name, false, `expected a Date, got ${fmt(actual)}`);
    return;
  }
  const ok = actual.getFullYear() === y && actual.getMonth() === m0 && actual.getDate() === d;
  record(name, ok, ok ? '' : `expected ${y}-${m0 + 1}-${d}, got ${actual.toDateString()}`);
}

function fmt(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? 'Invalid Date' : v.toDateString();
  }
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  return String(v);
}

/* ------------------------------------------------------------------ *
 * 0. harness self-check — the booby traps must actually bite
 * ------------------------------------------------------------------ */

describe('harness', () => {
  let threw = false;
  try { SB.SpreadsheetApp.openById('x'); } catch (e) { threw = /Apps Script I\/O reached/.test(e.message); }
  record('SpreadsheetApp access throws', threw, threw ? '' : 'the I/O trap did not fire');

  threw = false;
  try { SB.PropertiesService.getScriptProperties(); } catch (e) { threw = true; }
  record('PropertiesService access throws', threw);

  threw = false;
  try { SB.Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yy'); } catch (e) {
    threw = /unsupported pattern/.test(e.message);
  }
  record('formatDate rejects an unmodelled pattern', threw);

  eq('formatDate MMMM_yyyy', SB.Utilities.formatDate(new Date(2026, 8, 15), 'Asia/Kolkata', 'MMMM_yyyy'), 'September_2026');
  eq('formatDate dd-MMM-yyyy', SB.Utilities.formatDate(new Date(2026, 8, 5), 'Asia/Kolkata', 'dd-MMM-yyyy'), '05-Sep-2026');
  eq('formatDate yyyy-MM-dd HH:mm',
    SB.Utilities.formatDate(new Date(2026, 8, 5, 7, 4), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm'), '2026-09-05 07:04');
});

/* ------------------------------------------------------------------ *
 * 1. numOrZero_
 *
 * Contract: numeric coercion that does NOT use `|| ""`; a legitimate 0 survives.
 * Currency/comma formatting from a display-formatted cell must not read as NaN
 * (the plan records `Number("₹22,000") === NaN` as a real money bug).
 * ------------------------------------------------------------------ */

describe('numOrZero_', () => {
  const f = SB.numOrZero_;
  eq('number 0 -> 0', f(0), 0);
  eq('string "0" -> 0', f('0'), 0);
  eq('"" -> 0', f(''), 0);
  eq('null -> 0', f(null), 0);
  eq('undefined -> 0', f(undefined), 0);
  eq('"₹14,000" -> 14000 (currency must parse)', f('₹14,000'), 14000);
  eq('"1,234.50" -> 1234.5 (comma + decimal)', f('1,234.50'), 1234.5);
  eq('garbage text -> 0', f('not a number'), 0);
  eq('negative number passes through', f(-500), -500);
  eq('"-500" passes through', f('-500'), -500);
  eq('NaN -> 0', f(NaN), 0);
  eq('number 14000 -> 14000', f(14000), 14000);
});

/* ------------------------------------------------------------------ *
 * 2. strOrBlank_  — register case B6.03, the falsy-zero trap
 *
 * Contract, verbatim from the plan: "unlike `x || ""`, a numeric 0 becomes "0", not "".
 * A real 0 must survive." This trap has caught this file three times.
 * ------------------------------------------------------------------ */

describe('strOrBlank_ (B6.03 falsy-zero)', () => {
  const f = SB.strOrBlank_;
  eq('THE TRAP: number 0 -> "0", not ""', f(0), '0');
  eq('string "0" -> "0"', f('0'), '0');
  eq('"" -> ""', f(''), '');
  eq('null -> ""', f(null), '');
  eq('undefined -> ""', f(undefined), '');
  eq('"  12000  " -> trimmed', f('  12000  '), '12000');
  eq('number 12000 -> "12000"', f(12000), '12000');
});

/* ------------------------------------------------------------------ *
 * 3. ceilTo100_
 *
 * Contract: "Round UP to the nearest 100, matching the EMI scheduler's instalment
 * convention." A rebalance must never round DOWN — that leaves a residue that can
 * only end as a write-off. Nothing owed (0 or negative) means nothing to instal.
 * ------------------------------------------------------------------ */

describe('ceilTo100_', () => {
  const f = SB.ceilTo100_;
  eq('0 -> 0', f(0), 0);
  eq('negative -> 0 (nothing owed)', f(-50), 0);
  eq('1 -> 100 (rounds UP, never down)', f(1), 100);
  eq('100 -> 100 (exact multiple unchanged)', f(100), 100);
  eq('101 -> 200', f(101), 200);
  eq('12850 -> 12900', f(12850), 12900);
  eq('25700/2 = 12850 -> 12900', f(25700 / 2), 12900);
  eq('"12850" (string) -> 12900', f('12850'), 12900);
  eq('"" -> 0', f(''), 0);
  eq('null -> 0', f(null), 0);
});

/* ------------------------------------------------------------------ *
 * 4. toRealDate_  — register cases B6.01 / B6.02
 *
 * Contract: "Coerce to a real Date, or null. Keeps date columns as dates instead of
 * raw JS date text." B6.02 specifically: a cell holding
 * "Tue Sep 15 2026 00:00:00 GMT+0530 (India Standard Time)" must self-heal to a Date.
 * ------------------------------------------------------------------ */

describe('toRealDate_ (B6.01 / B6.02)', () => {
  const f = SB.toRealDate_;
  const d = new Date(2026, 8, 15);
  eq('a real Date is returned as-is (identity)', f(d) === d, true);
  isDate('"9/15/2026" -> 15 Sep 2026', f('9/15/2026'), 2026, 8, 15);
  isDate('B6.02: raw JS date text -> 15 Sep 2026',
    f('Tue Sep 15 2026 00:00:00 GMT+0530 (India Standard Time)'), 2026, 8, 15);
  isDate('"Sep 15 2026" -> 15 Sep 2026', f('Sep 15 2026'), 2026, 8, 15);
  isNull('"" -> null', f(''));
  isNull('null -> null', f(null));
  isNull('garbage -> null', f('not a date'));
  isNull('an Invalid Date object -> null', f(new Date('nonsense')));
});

/* ------------------------------------------------------------------ *
 * 5. toFirstOfMonthDate_
 *
 * Contract: collapse any month-ish value to the 1st of that month, as a Date, or null.
 * It is the basis of every settlement-window comparison
 * (`lwdMonth <= decisionMonth`), so month granularity must be exact and a value it
 * cannot understand must be null rather than a guess.
 * ------------------------------------------------------------------ */

describe('toFirstOfMonthDate_', () => {
  const f = SB.toFirstOfMonthDate_;
  isDate('a Date mid-month -> 1st of that month', f(new Date(2026, 8, 15)), 2026, 8, 1);
  isDate('"September_2026" -> 1 Sep 2026', f('September_2026'), 2026, 8, 1);
  isDate('"SEPTEMBER_2026" -> 1 Sep 2026', f('SEPTEMBER_2026'), 2026, 8, 1);
  isDate('"9/15/2026" -> 1 Sep 2026', f('9/15/2026'), 2026, 8, 1);
  isDate('"Attendance_September_2026" -> 1 Sep 2026', f('Attendance_September_2026'), 2026, 8, 1);
  isDate('31 Dec 2026 -> 1 Dec 2026 (no year drift)', f(new Date(2026, 11, 31)), 2026, 11, 1);
  isNull('"" -> null', f(''));
  isNull('null -> null', f(null));
  isNull('garbage -> null', f('not a month'));
});

/* ------------------------------------------------------------------ *
 * 6. normMonthKey_
 *
 * Contract: the canonical month key used to join Ledger <-> EMI_SCHEDULE <-> Shared
 * EMI Summary. Convention throughout the codebase is "MMMM_yyyy", uppercased; an
 * "Attendance_" prefix (the attendance module's file-naming convention) is stripped.
 * A blank is "" so the caller can skip the row.
 * ------------------------------------------------------------------ */

describe('normMonthKey_', () => {
  const f = SB.normMonthKey_;
  eq('a Date -> "SEPTEMBER_2026"', f(new Date(2026, 8, 15)), 'SEPTEMBER_2026');
  eq('"September_2026" -> "SEPTEMBER_2026"', f('September_2026'), 'SEPTEMBER_2026');
  eq('"Attendance_September_2026" -> "SEPTEMBER_2026"', f('Attendance_September_2026'), 'SEPTEMBER_2026');
  eq('"" -> ""', f(''), '');
  eq('null -> ""', f(null), '');
  eq('"   " -> ""', f('   '), '');
  eq('"9/1/2026" -> "SEPTEMBER_2026"', f('9/1/2026'), 'SEPTEMBER_2026');
  eq('31 Dec 2026 -> "DECEMBER_2026" (no year drift)', f(new Date(2026, 11, 31)), 'DECEMBER_2026');
  // Round-trip: the key a Date produces must resolve back to the same month.
  const k = f(new Date(2026, 8, 15));
  isDate('round-trip: key -> toFirstOfMonthDate_ -> 1 Sep 2026', SB.toFirstOfMonthDate_(k), 2026, 8, 1);
});

/* ------------------------------------------------------------------ *
 * 7. addMonths_
 *
 * Contract (from every call site): step the settlement/close-in window forward one
 * month at a time. Every window month is a FIRST-of-month anchor, so the result must
 * be normalised to the 1st and must never skip a month via the classic
 * "31 Jan + 1 month = 3 March" overflow.
 * ------------------------------------------------------------------ */

describe('addMonths_', () => {
  const f = SB.addMonths_;
  isDate('1 Sep 2026 + 1 -> 1 Oct 2026', f(new Date(2026, 8, 1), 1), 2026, 9, 1);
  isDate('YEAR BOUNDARY: 1 Dec 2026 + 1 -> 1 Jan 2027', f(new Date(2026, 11, 1), 1), 2027, 0, 1);
  isDate('1 Dec 2026 + 3 -> 1 Mar 2027', f(new Date(2026, 11, 1), 3), 2027, 2, 1);
  isDate('OVERFLOW: 31 Jan 2026 + 1 -> 1 Feb 2026, not March',
    f(new Date(2026, 0, 31), 1), 2026, 1, 1);
  isDate('31 Aug 2026 + 1 -> 1 Sep 2026', f(new Date(2026, 7, 31), 1), 2026, 8, 1);
  isDate('+ 0 normalises to the 1st', f(new Date(2026, 8, 15), 0), 2026, 8, 1);
  isDate('1 Jan 2027 + -1 -> 1 Dec 2026', f(new Date(2027, 0, 1), -1), 2026, 11, 1);
  isDate('1 Sep 2026 + 12 -> 1 Sep 2027', f(new Date(2026, 8, 1), 12), 2027, 8, 1);
});

/* ------------------------------------------------------------------ *
 * 8. norm_
 * ------------------------------------------------------------------ */

describe('norm_', () => {
  const f = SB.norm_;
  eq('"  active " -> "ACTIVE"', f('  active '), 'ACTIVE');
  eq('null -> ""', f(null), '');
  eq('undefined -> ""', f(undefined), '');
  eq('number 0 -> "0" (not "")', f(0), '0');
  eq('"WRITE OFF" -> "WRITE OFF"', f('WRITE OFF'), 'WRITE OFF');
});

/* ------------------------------------------------------------------ *
 * 9. hardening gaps — safety properties the spec implies but never states
 *
 * No payroll month in this system is in year 46266. A `Last Working Day` cell that
 * has lost its date number format reads back from getValues() as a bare SERIAL
 * NUMBER, and `new Date("46266")` parses that as a YEAR. The plan already records
 * a real incident of exactly this shape ("Month failed validation on a fresh file
 * ... the number format decides the answer"), so the input is not hypothetical.
 *
 * Consequence in 3A: `toFirstOfMonthDate_` returns a date ~44,000 years out, the
 * settlement branch takes Case B forever, and the missing-month loop
 * `while (m <= lwdMonth) { missing.push(...); m = addMonths_(m,1) }` is unbounded.
 * ------------------------------------------------------------------ */

describe('hardening gaps (spec-implied, currently unmet)', () => {
  const withinRange = d => d === null || (d.getFullYear() >= 1900 && d.getFullYear() <= 9999);

  const a = SB.toFirstOfMonthDate_(46266);
  gap('toFirstOfMonthDate_(46266) must not yield an out-of-range year',
    withinRange(a), `got ${fmt(a)} (year ${a && a.getFullYear()})`);

  const b = SB.toRealDate_(46266);
  gap('toRealDate_(46266) must not yield an out-of-range year',
    withinRange(b), `got ${fmt(b)} (year ${b && b.getFullYear()})`);

  const c = SB.normMonthKey_(46266);
  gap('normMonthKey_(46266) must not yield an out-of-range month key',
    !/_\d{5,}$/.test(c), `got ${fmt(c)}`);

  // Accounting-style negatives: "(500)" means minus 500 in every finance export.
  gap('numOrZero_("(500)") should not read an accounting negative as POSITIVE 500',
    SB.numOrZero_('(500)') <= 0, `got ${fmt(SB.numOrZero_('(500)'))}`);

  // Float noise from `residual / slots` must not push the instalment a whole ₹100 up.
  gap('ceilTo100_ should tolerate float noise (12900.0000001 -> 12900)',
    SB.ceilTo100_(12900.0000001) === 12900, `got ${fmt(SB.ceilTo100_(12900.0000001))}`);
});

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

let pass = 0, fail = 0, gaps = 0, lastGroup = null;
for (const r of results) {
  if (r.group !== lastGroup) { console.log(`\n${r.group}`); lastGroup = r.group; }
  if (r.ok) { pass++; console.log(`  PASS  ${r.name}`); }
  else if (r.gap) { gaps++; console.log(`  GAP   ${r.name}  -- ${r.detail}`); }
  else { fail++; console.log(`  FAIL  ${r.name}  -- ${r.detail}`); }
}
console.log(`\n${pass} passed, ${fail} failed, ${gaps} hardening gap(s), ${results.length} total`);
if (gaps) console.log('GAPs are not spec regressions — see _tests/RESULTS.md.');
process.exit(fail ? 1 : 0);
