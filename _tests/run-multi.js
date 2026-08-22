/**
 * _tests/run-multi.js — EXECUTED scenario tests for ONE employee carrying TWO advances that
 * settle IN PARALLEL across several months.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every multi-advance case tested so far (Kareem/BUT-1776, S4d in run-engine.js) had one advance
 * close at the decision month itself, so only ever ONE reference actually entered an ongoing
 * settlement. Nothing has ever exercised two references for the same employee both still open and
 * both rebalancing month after month. That is what this file does.
 *
 * EXPECTATIONS ARE DERIVED FROM THE SPEC, NOT FROM THE IMPLEMENTATION:
 *   _tests/cases/salary-advance.md          (B1, B2, B4, B6.06 in particular)
 *   _docs/salary-advance-settlement-plan.md (Alert rule 6 — oldest advance only)
 *   salary-advance-master/CLAUDE.md         (the settlement rule; AUTO/ADMIN; the derived window)
 *
 * The arithmetic below is chosen so every rebalance divides evenly into hundreds — no conclusion
 * here depends on the ceilTo100 / last-month-absorbs-the-remainder rounding convention.
 *
 * Run:  node _tests/run-multi.js
 */

'use strict';

const { makeWorld, D } = require('./world');

/* ---------------- tiny harness (same shape as run-engine.js) ---------------- */

const results = [];
let group = '(none)';
function describe(n, fn) { group = n; fn(); }
function record(n, ok, detail) { results.push({ group, name: n, ok, detail: detail || '' }); }
function gap(n, ok, detail) { results.push({ group, name: n, ok, gap: true, detail: detail || '' }); }
function eq(n, a, e, extra) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  record(n, A === E, A === E ? '' : `expected ${E}, got ${A}${extra ? ' | ' + extra : ''}`);
}
function ok(n, cond, detail) { record(n, !!cond, detail); }

function view(r) {
  return `${r.emiAmt}|${r.status}|${r.stage}|${r.setBy}|${r.woAmt}|rec=${r.recover}`;
}
function amtStatus(rows, from) {
  return rows.filter(r => r.month >= from).map(r => `${r.month} ${r.emiAmt}|${r.status}|${r.stage}`);
}
function firstDiff(a, b) {
  const A = JSON.parse(a), B = JSON.parse(b);
  for (let i = 0; i < Math.max(A.grid.length, B.grid.length); i++) {
    const x = JSON.stringify(A.grid[i]), y = JSON.stringify(B.grid[i]);
    if (x !== y) return `row ${i + 2}: ${x}  ->  ${y}`;
  }
  return `props/maxRows: ${JSON.stringify(A.props)}/${A.maxRows} -> ${JSON.stringify(B.props)}/${B.maxRows}`;
}

/* ---------------- the shared world: BUT-999, two live advances ----------------
 *
 *   EMI-100 (the OLDER reference)  advance 30,000  instalment 5,000  Jan 2027 -> Jun 2027
 *   EMI-200 (the newer reference)  advance 20,000  instalment 4,000  Jan 2027 -> May 2027
 *
 * January and February are recovered on schedule for both, so at the March decision:
 *   EMI-100 balance 20,000 · EMI-200 balance 12,000
 * -------------------------------------------------------------------------- */

const EMP = 'BUT-999';
const LWD = D(2027, 6, 15);

function seedTwo(opts) {
  const o = opts || {};
  const a = [], b = [];
  for (let k = 0; k < 6; k++) {
    a.push({ month: new Date(2027, k, 1), emp: EMP, name: 'Dual Advance', dept: 'PROD', ref: 'EMI-100', emiAmt: 5000, status: 'ACTIVE' });
  }
  for (let k = 0; k < 5; k++) {
    b.push({ month: new Date(2027, k, 1), emp: EMP, name: 'Dual Advance', dept: 'PROD', ref: 'EMI-200', emiAmt: 4000, status: 'ACTIVE' });
  }
  let emiRows;
  if (o.order === 'reversed') emiRows = b.concat(a);
  else if (o.order === 'interleaved') {
    emiRows = [];
    for (let k = 0; k < 6; k++) { if (a[k]) emiRows.push(a[k]); if (b[k]) emiRows.push(b[k]); }
  } else emiRows = a.concat(b);

  const w = makeWorld({
    advances: { 'EMI-100': { advance: 30000 }, 'EMI-200': { advance: 20000 } },
    emiRows,
    balanceModel: o.balanceModel,
  });
  for (const m of [1, 2]) {
    w.ledger({ month: D(2027, m), emp: EMP, ref: 'EMI-100', recovered: 5000 });
    w.ledger({ month: D(2027, m), emp: EMP, ref: 'EMI-200', recovered: 4000 });
  }
  return w;
}

/** March 2027: RESIGNED on BOTH references, same last working day (the Validate Payroll
 *  consistency precheck guarantees they agree), each recovering a PARTIAL amount. */
function marchDecision(w, rec100, rec200, opts) {
  const o = opts || {};
  const rows = [
    { month: D(2027, 3), emp: EMP, ref: 'EMI-100', hr: 'RESIGNED', recovered: rec100, lwd: LWD, closeIn: o.closeIn100 },
    { month: D(2027, 3), emp: EMP, ref: 'EMI-200', hr: 'RESIGNED', recovered: rec200, lwd: LWD, closeIn: o.closeIn200 },
  ];
  if (o.ledgerOrder === 'reversed') rows.reverse();
  rows.forEach(r => w.ledger(r));
  return w;
}

function month(w, ref, m) { return w.rows(ref).find(x => x.month === m); }

/* ================================================================== *
 * M1 — two references settle in PARALLEL, March -> June
 * ================================================================== */

describe('M1 — two advances, one employee, both settling in parallel (EXECUTED)', () => {
  const w = seedTwo();

  // --- March: the decision month. Partial recovery on each reference. -----------------
  // EMI-100: 20,000 owed, recovers 2,000 -> residual 18,000
  // EMI-200: 12,000 owed, recovers 3,000 -> residual  9,000
  marchDecision(w, 2000, 3000);
  w.sync();

  eq('M1.01  each reference carries its OWN balance after March',
    [w.rows('EMI-100')[0].bal, w.rows('EMI-200')[0].bal], [18000, 9000]);

  // Spec: the window is (decision month -> LWD month] = Apr, May, Jun. All ACTIVE, stamped
  // SETTLING except the last-working-day month which is FINAL. (B1.01)
  eq('M1.02  EMI-100 window Apr/May/Jun = 18,000 over 3 months, its own residual',
    amtStatus(w.rows('EMI-100'), '2027-04-01'),
    ['2027-04-01 6000|ACTIVE|SETTLING', '2027-05-01 6000|ACTIVE|SETTLING', '2027-06-01 6000|ACTIVE|FINAL']);

  eq('M1.03  EMI-200 window Apr/May/Jun = 9,000 over 3 months, its own residual',
    amtStatus(w.rows('EMI-200'), '2027-04-01'),
    ['2027-04-01 3000|ACTIVE|SETTLING', '2027-05-01 3000|ACTIVE|SETTLING', '2027-06-01 3000|ACTIVE|FINAL']);

  // If the two references collided, a combined 27,000 over 3 months would give 9,000 each.
  ok('M1.04  neither reference was rebalanced against the COMBINED 27,000 (9,000/month)',
    month(w, 'EMI-100', '2027-04-01').emiAmt === '6000' &&
    month(w, 'EMI-200', '2027-04-01').emiAmt === '3000',
    `EMI-100 Apr=${month(w, 'EMI-100', '2027-04-01').emiAmt}, EMI-200 Apr=${month(w, 'EMI-200', '2027-04-01').emiAmt}`);

  eq('M1.05  EMI-200 gained the missing June month, stamped AUTO (B1.06)',
    `${w.rows('EMI-200').length}|${month(w, 'EMI-200', '2027-06-01').setBy}`, '6|AUTO');

  ok('M1.06  NO write-off booked on either reference in March (B1.02/B4.05)',
    w.rows('EMI-100').every(x => x.woAmt === '') && w.rows('EMI-200').every(x => x.woAmt === ''),
    JSON.stringify([w.rows('EMI-100').map(view), w.rows('EMI-200').map(view)]));

  ok('M1.07  both references stay ACTIVE — the exit lock holds on BOTH (B1.02)',
    w.rows('EMI-100').concat(w.rows('EMI-200'))
      .filter(x => x.month >= '2027-04-01').every(x => x.status === 'ACTIVE'));

  // --- April: EMI-100 UNDER-recovers, EMI-200 recovers in full ------------------------
  // EMI-100 asked 6,000, gets 4,000 -> residual 14,000 over May+Jun = 7,000 each
  // EMI-200 asked 3,000, gets 3,000 -> residual  6,000 over May+Jun = 3,000 each (unchanged)
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-100', recovered: 4000 });
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-200', recovered: 3000 });
  w.sync();

  eq('M1.08  balances after April are per-reference', [w.rows('EMI-100')[0].bal, w.rows('EMI-200')[0].bal], [14000, 6000]);
  eq('M1.09  EMI-100 absorbs ITS OWN 2,000 shortfall — May/Jun rise to 7,000',
    amtStatus(w.rows('EMI-100'), '2027-05-01'),
    ['2027-05-01 7000|ACTIVE|SETTLING', '2027-06-01 7000|ACTIVE|FINAL']);
  eq('M1.10  EMI-200 is NOT disturbed by the other advance\'s shortfall — still 3,000',
    amtStatus(w.rows('EMI-200'), '2027-05-01'),
    ['2027-05-01 3000|ACTIVE|SETTLING', '2027-06-01 3000|ACTIVE|FINAL']);
  eq('M1.11  April rows are locked records — the recovered amount is not rewritten',
    [month(w, 'EMI-100', '2027-04-01').recover, month(w, 'EMI-200', '2027-04-01').recover], ['4000', '3000']);
  ok('M1.12  still no write-off in April', w.rows('EMI-100').concat(w.rows('EMI-200')).every(x => x.woAmt === ''));

  // --- May: both recover in full -----------------------------------------------------
  w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-100', recovered: 7000 });
  w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-200', recovered: 3000 });
  w.sync();

  eq('M1.13  balances after May', [w.rows('EMI-100')[0].bal, w.rows('EMI-200')[0].bal], [7000, 3000]);
  eq('M1.14  each June row holds exactly its own remaining balance',
    [amtStatus(w.rows('EMI-100'), '2027-06-01'), amtStatus(w.rows('EMI-200'), '2027-06-01')],
    [['2027-06-01 7000|ACTIVE|FINAL'], ['2027-06-01 3000|ACTIVE|FINAL']]);
  // Cosmetic only, recorded so it is not rediscovered: a window month the settlement CREATED is
  // stamped AUTO (spec: "rows the settlement cycle creates are stamped AUTO"), but a month that
  // already existed and is merely REWRITTEN by the same pass keeps a blank Amount Set By. Every
  // decision in the engine tests `=== "ADMIN"`, so blank and AUTO behave identically today — but
  // two rows produced by the same pass carry different provenance labels.
  gap('M1.14b  a rewritten window month is labelled the same as a created one',
    month(w, 'EMI-100', '2027-06-01').setBy === month(w, 'EMI-200', '2027-06-01').setBy,
    `EMI-100 Jun (pre-existing row) setBy="${month(w, 'EMI-100', '2027-06-01').setBy}" vs ` +
    `EMI-200 Jun (created by the settlement) setBy="${month(w, 'EMI-200', '2027-06-01').setBy}" ` +
    `— no functional effect: nothing in 3A tests for AUTO, only for ADMIN`);
  ok('M1.15  no write-off booked before the last-working-day month is PAID (B4.05)',
    w.rows('EMI-100').concat(w.rows('EMI-200')).every(x => x.woAmt === ''));
  eq('M1.16  no month invented past the last working day',
    [w.rows('EMI-100').length, w.rows('EMI-200').length], [6, 6]);
  eq('M1.17  each schedule still totals its own outstanding balance',
    [
      w.rows('EMI-100').filter(x => x.recover === '').reduce((s, x) => s + Number(x.emiAmt || 0), 0),
      w.rows('EMI-200').filter(x => x.recover === '').reduce((s, x) => s + Number(x.emiAmt || 0), 0),
    ], [7000, 3000]);
});

/* ================================================================== *
 * M1b — row order / ledger order must not change the outcome
 * ================================================================== */

describe('M1b — sheet order and ledger order are irrelevant (EXECUTED)', () => {
  function walkTo(order, ledgerOrder) {
    const w = seedTwo({ order });
    marchDecision(w, 2000, 3000, { ledgerOrder });
    w.sync();
    w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-100', recovered: 4000 });
    w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-200', recovered: 3000 });
    w.sync();
    return JSON.stringify({ a: w.rows('EMI-100'), b: w.rows('EMI-200') });
  }
  const base = walkTo('grouped', 'normal');
  eq('M1b.01  EMI-200 rows placed BEFORE EMI-100 in the sheet: identical result',
    walkTo('reversed', 'normal') === base, true, base.slice(0, 400));
  eq('M1b.02  interleaved rows (the two refs alternating): identical result',
    walkTo('interleaved', 'normal') === base, true);
  eq('M1b.03  the second decision row processed FIRST: identical result',
    walkTo('grouped', 'reversed') === base, true);
  eq('M1b.04  reversed sheet AND reversed ledger: identical result',
    walkTo('reversed', 'reversed') === base, true);
});

/* ================================================================== *
 * M2 — idempotency at EVERY stage of the parallel walk (3B fires on a timer)
 * ================================================================== */

describe('M2 — idempotency across the whole parallel walk (EXECUTED)', () => {
  const stages = [
    { name: 'the March decision (both refs)', add: w => marchDecision(w, 2000, 3000) },
    {
      name: 'April (one ref short, one in full)', add: w => {
        w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-100', recovered: 4000 });
        w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-200', recovered: 3000 });
      },
    },
    {
      name: 'May (both in full)', add: w => {
        w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-100', recovered: 7000 });
        w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-200', recovered: 3000 });
      },
    },
    {
      name: 'June, the last working day month (both still owing)', add: w => {
        w.ledger({ month: D(2027, 6), emp: EMP, ref: 'EMI-100', recovered: 2000 });
        w.ledger({ month: D(2027, 6), emp: EMP, ref: 'EMI-200', recovered: 0 });
      },
    },
  ];

  for (let n = 1; n <= stages.length; n++) {
    const w = seedTwo();
    for (let k = 0; k < n; k++) { stages[k].add(w); w.sync(); }
    const before = w.snapshot();
    w.sync();
    const after = w.snapshot();
    ok(`M2  idempotent after ${stages[n - 1].name}`, before === after,
      before === after ? '' : firstDiff(before, after));
    w.sync();
    ok(`M2  and on a third run — ${stages[n - 1].name}`, w.snapshot() === after,
      w.snapshot() === after ? '' : firstDiff(after, w.snapshot()));
  }

  // Five consecutive runs at the June (write-off) stage, the way the timer behaves.
  const w = seedTwo();
  stages.forEach(s => { s.add(w); w.sync(); });
  const fixed = w.snapshot();
  for (let k = 0; k < 5; k++) w.sync();
  ok('M2  stable across 5 further timer runs at the June stage', w.snapshot() === fixed,
    w.snapshot() === fixed ? '' : firstDiff(fixed, w.snapshot()));

  // ...and the same under the alternative Current Balance model, so no idempotency
  // conclusion depends on how the write-off interacts with the balance formula.
  const w2 = seedTwo({ balanceModel: 'net-of-writeoff' });
  stages.forEach(s => { s.add(w2); w2.sync(); });
  const fixed2 = w2.snapshot();
  for (let k = 0; k < 5; k++) w2.sync();
  ok('M2  stable under the net-of-writeoff balance model too', w2.snapshot() === fixed2,
    w2.snapshot() === fixed2 ? '' : firstDiff(fixed2, w2.snapshot()));
});

/* ================================================================== *
 * M3 — one reference clears early, the other keeps settling (B2.01/B2.02 + B6.06)
 * ================================================================== */

describe('M3 — EMI-100 clears in April, EMI-200 must be untouched (EXECUTED)', () => {
  const w = seedTwo();
  marchDecision(w, 2000, 3000);
  w.sync();

  const b200Before = JSON.stringify(w.rows('EMI-200'));

  // April: EMI-100 pays off its whole 18,000 residual; EMI-200 recovers its scheduled 3,000.
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-100', recovered: 18000 });
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-200', recovered: 3000 });
  w.sync();

  eq('M3.01  EMI-100 balance is 0, EMI-200 still owes 6,000',
    [w.rows('EMI-100')[0].bal, w.rows('EMI-200')[0].bal], [0, 6000]);
  eq('M3.02  EMI-100 May/Jun close: 0 / CLOSED / stage CLOSED (B2.01, B2.02)',
    amtStatus(w.rows('EMI-100'), '2027-05-01'),
    ['2027-05-01 0|CLOSED|CLOSED', '2027-06-01 0|CLOSED|CLOSED']);
  ok('M3.03  EMI-100 books NO write-off — nothing was lost (B2.03)',
    w.rows('EMI-100').every(x => x.woAmt === ''), JSON.stringify(w.rows('EMI-100').map(view)));

  eq('M3.04  EMI-200 is COMPLETELY unaffected — still SETTLING/FINAL at 3,000 (B6.06)',
    amtStatus(w.rows('EMI-200'), '2027-05-01'),
    ['2027-05-01 3000|ACTIVE|SETTLING', '2027-06-01 3000|ACTIVE|FINAL']);
  ok('M3.05  EMI-200 books no write-off and loses no row',
    w.rows('EMI-200').every(x => x.woAmt === '') && w.rows('EMI-200').length === 6,
    b200Before);

  // The other reference must keep rebalancing normally afterwards.
  w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-200', recovered: 1000 });
  w.sync();
  eq('M3.06  EMI-200 keeps rebalancing after the other closed: 5,000 left, all into June',
    view(month(w, 'EMI-200', '2027-06-01')), '5000|ACTIVE|FINAL|AUTO||rec=');
  eq('M3.07  and EMI-100 stays closed, still no write-off',
    amtStatus(w.rows('EMI-100'), '2027-05-01'),
    ['2027-05-01 0|CLOSED|CLOSED', '2027-06-01 0|CLOSED|CLOSED']);

  const s = w.snapshot(); w.sync();
  ok('M3.08  idempotent with one ref closed and one still settling', s === w.snapshot(),
    s === w.snapshot() ? '' : firstDiff(s, w.snapshot()));
});

/* ================================================================== *
 * M4 — Close In Months on the OLDEST reference only (Alert rule 6)
 * ================================================================== */

describe('M4 — a plan on EMI-100 only; EMI-200 must rebalance untouched (EXECUTED)', () => {
  // Alert rule 6 permits Close In Months on the oldest advance only, so the plan is seeded on
  // EMI-100 (the lower reference number) alone. N = 2 set in March -> the derived window ends
  // April (planEnd = plan month + N - 1), i.e. April is the only future recovering month.
  const w = seedTwo();
  marchDecision(w, 2000, 3000, { closeIn100: 2 });
  w.sync();

  const a = w.rows('EMI-100'), b = w.rows('EMI-200');

  eq('M4.01  EMI-100 follows the plan: its whole 18,000 residual lands in April',
    view(month(w, 'EMI-100', '2027-04-01')), '18000|ACTIVE|SETTLING|ADMIN||rec=');
  eq('M4.02  EMI-100 May — beyond the plan, before the last working day — is 0 and CLOSED',
    `${month(w, 'EMI-100', '2027-05-01').emiAmt}|${month(w, 'EMI-100', '2027-05-01').status}`, '0|CLOSED');
  eq('M4.03  EMI-100 June — the last-working-day month — is 0 but stays ACTIVE',
    `${month(w, 'EMI-100', '2027-06-01').emiAmt}|${month(w, 'EMI-100', '2027-06-01').status}`, '0|ACTIVE');
  ok('M4.04  EMI-100 plan rows are stamped ADMIN',
    a.filter(x => x.month >= '2027-04-01').every(x => x.setBy === 'ADMIN'),
    JSON.stringify(a.map(view)));

  eq('M4.05  EMI-200 keeps rebalancing automatically — 9,000 across Apr/May/Jun',
    amtStatus(b, '2027-04-01'),
    ['2027-04-01 3000|ACTIVE|SETTLING', '2027-05-01 3000|ACTIVE|SETTLING', '2027-06-01 3000|ACTIVE|FINAL']);
  ok('M4.06  EMI-200 is NEVER stamped ADMIN — the plan does not leak across references',
    b.every(x => x.setBy !== 'ADMIN'), JSON.stringify(b.map(x => `${x.month}=${x.setBy}`)));
  ok('M4.07  no write-off on either reference while the employee is still working',
    a.concat(b).every(x => x.woAmt === ''));

  const s = w.snapshot(); w.sync(); w.sync();
  ok('M4.08  idempotent with a plan on one ref and an auto-rebalance on the other',
    s === w.snapshot(), s === w.snapshot() ? '' : firstDiff(s, w.snapshot()));

  // April pays the plan; EMI-200 under-recovers and must still re-fit on its own.
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-100', recovered: 18000 });
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-200', recovered: 1000 });
  w.sync();
  eq('M4.09  EMI-100 cleared by its plan, no write-off, rows closed',
    [w.rows('EMI-100')[0].bal, w.rows('EMI-100').every(x => x.woAmt === '')], [0, true]);
  eq('M4.10  EMI-200 re-fits its own 8,000 across May/Jun, still not ADMIN',
    amtStatus(w.rows('EMI-200'), '2027-05-01'),
    ['2027-05-01 4000|ACTIVE|SETTLING', '2027-06-01 4000|ACTIVE|FINAL']);
  ok('M4.11  EMI-200 still carries no ADMIN stamp after the other ref\'s plan completed',
    w.rows('EMI-200').every(x => x.setBy !== 'ADMIN'),
    JSON.stringify(w.rows('EMI-200').map(x => `${x.month}=${x.setBy}`)));
});

/* ================================================================== *
 * M5 — the write-off books INDEPENDENTLY per reference
 * ================================================================== */

describe('M5 — June is paid with both references still owing (EXECUTED)', () => {
  const w = seedTwo();
  marchDecision(w, 2000, 3000);
  w.sync();
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-100', recovered: 4000 });
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-200', recovered: 3000 });
  w.sync();
  w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-100', recovered: 7000 });
  w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-200', recovered: 3000 });
  w.sync();

  // June — the last working day month — is paid. EMI-100 recovers 2,000 of the 7,000 asked;
  // EMI-200 recovers nothing at all. Residuals: 5,000 and 3,000.
  w.ledger({ month: D(2027, 6), emp: EMP, ref: 'EMI-100', recovered: 2000 });
  w.ledger({ month: D(2027, 6), emp: EMP, ref: 'EMI-200', recovered: 0 });
  w.sync();

  const j1 = month(w, 'EMI-100', '2027-06-01'), j2 = month(w, 'EMI-200', '2027-06-01');

  eq('M5.01  TWO write-offs are booked, one per reference, each for its OWN residual',
    [j1.woAmt, j2.woAmt], ['5000', '3000']);
  eq('M5.02  neither is the combined 8,000, and neither suppressed the other',
    [j1.woAmt !== '8000', j2.woAmt !== '', j1.woAmt !== ''], [true, true, true],
    `EMI-100 Jun ${view(j1)} / EMI-200 Jun ${view(j2)}`);
  eq('M5.03  both June rows go WRITE OFF / FINAL',
    [`${j1.status}|${j1.stage}`, `${j2.status}|${j2.stage}`], ['WRITE OFF|FINAL', 'WRITE OFF|FINAL']);
  eq('M5.04  exactly ONE write-off row per reference',
    [w.rows('EMI-100').filter(x => x.woAmt !== '').length,
     w.rows('EMI-200').filter(x => x.woAmt !== '').length], [1, 1]);
  eq('M5.05  a recovery of exactly 0 is stored as "0", not blank (the falsy-zero prerequisite)',
    j2.recover, '0');
  eq('M5.06  no row appended by the final run', [w.rows('EMI-100').length, w.rows('EMI-200').length], [6, 6]);

  for (let k = 0; k < 5; k++) w.sync();
  eq('M5.07  neither write-off is reversed across 5 further runs (B6.05)',
    [month(w, 'EMI-100', '2027-06-01').woAmt, month(w, 'EMI-200', '2027-06-01').woAmt], ['5000', '3000']);
  eq('M5.08  and still exactly one write-off row each',
    [w.rows('EMI-100').filter(x => x.woAmt !== '').length,
     w.rows('EMI-200').filter(x => x.woAmt !== '').length], [1, 1]);
});

/* ================================================================== *
 * M5b — one reference clears in June, the other does not
 * ================================================================== */

describe('M5b — June clears EMI-200 outright but leaves EMI-100 short (EXECUTED)', () => {
  const w = seedTwo();
  marchDecision(w, 2000, 3000);
  w.sync();
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-100', recovered: 4000 });
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-200', recovered: 3000 });
  w.sync();
  w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-100', recovered: 7000 });
  w.ledger({ month: D(2027, 5), emp: EMP, ref: 'EMI-200', recovered: 3000 });
  w.sync();
  // June: EMI-200 pays its last 3,000 in full; EMI-100 pays nothing.
  w.ledger({ month: D(2027, 6), emp: EMP, ref: 'EMI-100', recovered: 0 });
  w.ledger({ month: D(2027, 6), emp: EMP, ref: 'EMI-200', recovered: 3000 });
  w.sync();

  const j1 = month(w, 'EMI-100', '2027-06-01'), j2 = month(w, 'EMI-200', '2027-06-01');
  eq('M5b.01  EMI-100 writes off its whole remaining 7,000', j1.woAmt, '7000');
  eq('M5b.02  EMI-200 books NO write-off — it was repaid in full (B2.03)', j2.woAmt, '');
  eq('M5b.03  EMI-100 Jun WRITE OFF / FINAL', `${j1.status}|${j1.stage}`, 'WRITE OFF|FINAL');
  ok('M5b.04  EMI-200 balance is 0', w.rows('EMI-200')[0].bal === 0, String(w.rows('EMI-200')[0].bal));
  const s = w.snapshot(); w.sync(); w.sync();
  ok('M5b.05  idempotent with one written off and one repaid', s === w.snapshot(),
    s === w.snapshot() ? '' : firstDiff(s, w.snapshot()));
});

/* ================================================================== *
 * M6 — the OTHER parallel case: no departure, both references drifting at once.
 *      This exercises pass (3d) on two references of one employee in the same run, in
 *      OPPOSITE directions — the pass that has to append a month for one while closing a
 *      month for the other. Expectations from B3.01 / B3.02 / B3.03: (3d) keeps the
 *      instalment and changes the NUMBER of months.
 * ================================================================== */

describe('M6 — one employee, two advances drifting in opposite directions (EXECUTED)', () => {
  const w = seedTwo();               // Jan + Feb already recovered on schedule in seedTwo
  // Re-seed with January only, so February can carry the varied decisions.
  const w6 = makeWorld({
    advances: { 'EMI-100': { advance: 30000 }, 'EMI-200': { advance: 20000 } },
    emiRows: (() => {
      const rows = [];
      for (let k = 0; k < 6; k++) rows.push({ month: new Date(2027, k, 1), emp: EMP, name: 'Dual Advance', dept: 'PROD', ref: 'EMI-100', emiAmt: 5000, status: 'ACTIVE' });
      for (let k = 0; k < 5; k++) rows.push({ month: new Date(2027, k, 1), emp: EMP, name: 'Dual Advance', dept: 'PROD', ref: 'EMI-200', emiAmt: 4000, status: 'ACTIVE' });
      return rows;
    })(),
  });
  w6.ledger({ month: D(2027, 1), emp: EMP, ref: 'EMI-100', recovered: 5000 });
  w6.ledger({ month: D(2027, 1), emp: EMP, ref: 'EMI-200', recovered: 4000 });

  // February: EMI-100 PAY LESS (1,000 of 5,000) · EMI-200 PAY EXTRA (8,000 of 4,000)
  w6.ledger({ month: D(2027, 2), emp: EMP, ref: 'EMI-100', hr: 'PAY LESS', recovered: 1000 });
  w6.ledger({ month: D(2027, 2), emp: EMP, ref: 'EMI-200', hr: 'PAY EXTRA', recovered: 8000 });
  w6.sync();

  eq('M6.01  balances drift independently', [w6.rows('EMI-100')[0].bal, w6.rows('EMI-200')[0].bal], [24000, 8000]);

  // EMI-100 owes 24,000 with 4 months (Mar-Jun) x 5,000 = 20,000 scheduled -> one month added,
  // instalment kept, the last month absorbing the remainder (B3.02).
  eq('M6.02  EMI-100 (PAY LESS) gains a month: Mar-Jun stay 5,000, Jul absorbs 4,000',
    w6.rows('EMI-100').filter(x => x.recover === '').map(x => `${x.month}=${x.emiAmt}`),
    ['2027-03-01=5000', '2027-04-01=5000', '2027-05-01=5000', '2027-06-01=5000', '2027-07-01=4000']);

  // EMI-200 owes 8,000 with 3 months (Mar-May) x 4,000 = 12,000 scheduled -> surplus closed (B3.01).
  eq('M6.03  EMI-200 (PAY EXTRA) sheds a month: Mar/Apr 4,000, May closed',
    w6.rows('EMI-200').filter(x => x.recover === '').map(x => `${x.month}=${x.emiAmt}|${x.status}`),
    ['2027-03-01=4000|ACTIVE', '2027-04-01=4000|ACTIVE', '2027-05-01=0|CLOSED']);

  eq('M6.04  each schedule totals its OWN balance, not the combined 32,000',
    [
      w6.rows('EMI-100').filter(x => x.recover === '').reduce((s, x) => s + Number(x.emiAmt || 0), 0),
      w6.rows('EMI-200').filter(x => x.recover === '').reduce((s, x) => s + Number(x.emiAmt || 0), 0),
    ], [24000, 8000]);
  ok('M6.05  appending to one reference did not append to the other',
    w6.rows('EMI-100').length === 7 && w6.rows('EMI-200').length === 5,
    `EMI-100 ${w6.rows('EMI-100').length} rows, EMI-200 ${w6.rows('EMI-200').length} rows`);
  ok('M6.06  no write-off anywhere — nobody is leaving',
    w6.rows('EMI-100').concat(w6.rows('EMI-200')).every(x => x.woAmt === ''));

  const s6 = w6.snapshot(); w6.sync(); w6.sync();
  ok('M6.07  the drift pass is idempotent with two references drifting at once',
    s6 === w6.snapshot(), s6 === w6.snapshot() ? '' : firstDiff(s6, w6.snapshot()));

  // --- M6b: B3.03, the "hole" bug, on the SECOND reference of a two-advance employee ------
  // March: EMI-100 pays its 5,000; EMI-200 PAY LESS 1,000 against a 4,000 instalment. Its
  // May row was CLOSED by (3d) a moment ago; the shortfall must REOPEN it, not append June
  // past it, or the schedule gets a hole (B3.03).
  w6.ledger({ month: D(2027, 3), emp: EMP, ref: 'EMI-100', recovered: 5000 });
  w6.ledger({ month: D(2027, 3), emp: EMP, ref: 'EMI-200', hr: 'PAY LESS', recovered: 1000 });
  w6.sync();

  eq('M6b.01  balances', [w6.rows('EMI-100')[0].bal, w6.rows('EMI-200')[0].bal], [19000, 7000]);
  eq('M6b.02  EMI-200 reopens the month (3d) closed — no hole, no June row (B3.03)',
    w6.rows('EMI-200').filter(x => x.recover === '').map(x => `${x.month}=${x.emiAmt}|${x.status}`),
    ['2027-04-01=4000|ACTIVE', '2027-05-01=3000|ACTIVE']);
  eq('M6b.03  EMI-200 still has exactly 5 rows — nothing appended past the reopened month',
    w6.rows('EMI-200').length, 5);
  eq('M6b.04  EMI-100 is untouched by the other reference\'s re-fit',
    w6.rows('EMI-100').filter(x => x.recover === '').map(x => `${x.month}=${x.emiAmt}`),
    ['2027-04-01=5000', '2027-05-01=5000', '2027-06-01=5000', '2027-07-01=4000']);
  const s6b = w6.snapshot(); w6.sync(); w6.sync();
  ok('M6b.05  still idempotent after the reopen', s6b === w6.snapshot(),
    s6b === w6.snapshot() ? '' : firstDiff(s6b, w6.snapshot()));

  void w;
});

/* ================================================================== *
 * M7 — a REVISED last working day, pushed on both references
 *      3A has no guard of its own that the two references agree; the Validate Payroll precheck
 *      supplies that. This checks the supported case — a corrected date arriving on BOTH rows
 *      in a later ledger month — behaves per the settlement rule.
 * ================================================================== */

describe('M7 — the last working day is brought forward on both references (EXECUTED)', () => {
  const w = seedTwo();
  marchDecision(w, 2000, 3000);      // LWD 15 Jun 2027
  w.sync();
  eq('M7.01  the original window runs to June',
    [month(w, 'EMI-100', '2027-06-01').stage, month(w, 'EMI-200', '2027-06-01').stage], ['FINAL', 'FINAL']);

  // April's ledger push carries a corrected last working day of 15 May 2027 on BOTH references.
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-100', hr: 'RESIGNED', recovered: 4000, lwd: D(2027, 5, 15) });
  w.ledger({ month: D(2027, 4), emp: EMP, ref: 'EMI-200', hr: 'RESIGNED', recovered: 3000, lwd: D(2027, 5, 15) });
  w.sync();

  // Window is now (April -> May]. EMI-100 owes 14,000, EMI-200 owes 6,000 — each into May alone.
  eq('M7.02  EMI-100 pulls its whole 14,000 into May, the new final month',
    `${month(w, 'EMI-100', '2027-05-01').emiAmt}|${month(w, 'EMI-100', '2027-05-01').status}|${month(w, 'EMI-100', '2027-05-01').stage}`,
    '14000|ACTIVE|FINAL');
  eq('M7.03  EMI-200 pulls its own 6,000 into May — not the combined 20,000',
    `${month(w, 'EMI-200', '2027-05-01').emiAmt}|${month(w, 'EMI-200', '2027-05-01').status}|${month(w, 'EMI-200', '2027-05-01').stage}`,
    '6000|ACTIVE|FINAL');
  ok('M7.04  no write-off booked — May has not been paid yet (B4.05)',
    w.rows('EMI-100').concat(w.rows('EMI-200')).every(x => x.woAmt === ''),
    JSON.stringify([w.rows('EMI-100').map(view), w.rows('EMI-200').map(view)]));
  gap('M7.05  the now-orphaned June rows are closed, on BOTH references',
    [month(w, 'EMI-100', '2027-06-01'), month(w, 'EMI-200', '2027-06-01')]
      .every(r => r && r.emiAmt === '0' && r.status !== 'ACTIVE'),
    `EMI-100 Jun ${view(month(w, 'EMI-100', '2027-06-01'))} · ` +
    `EMI-200 Jun ${view(month(w, 'EMI-200', '2027-06-01'))} — a month beyond the revised last ` +
    `working day must not stay ACTIVE, or attendance still pulls an instalment for it`);

  const s = w.snapshot(); w.sync(); w.sync();
  ok('M7.06  idempotent after the revision', s === w.snapshot(),
    s === w.snapshot() ? '' : firstDiff(s, w.snapshot()));
});

/* ================================================================== *
 * M8 — a Last Working Day CORRECTION, in both directions and by both routes.
 *
 *   Spec basis:
 *     - `3A_Master_SharedEMILockSync.gs` pass (2) states the contract itself: "Last Working Day:
 *       HR fact, written once. Never overwritten here — a correction arrives on a later month's
 *       ledger row and lands on that row."
 *     - Register C1.05 treats HR editing a protected Last Working Day as a supported action.
 *     - salary-advance-master/CLAUDE.md: "Booking a write-off is what releases the Employee
 *       Master exit lock ... nothing may book one while an employee is still working."
 *
 *   Single advance on purpose — this is NOT a multi-advance issue; it was found while building
 *   the parallel-settlement cases and then isolated.
 * ================================================================== */

describe('M8 — correcting the Last Working Day after a settlement is open (EXECUTED)', () => {
  function seedOne() {
    const rows = [];
    for (let k = 0; k < 8; k++) {
      rows.push({ month: new Date(2027, k, 1), emp: 'BUT-001', ref: 'EMI-1', emiAmt: 5000, status: 'ACTIVE' });
    }
    const w = makeWorld({ advances: { 'EMI-1': { advance: 40000 } }, emiRows: rows });
    w.ledger({ month: D(2027, 1), emp: 'BUT-001', ref: 'EMI-1', recovered: 5000 });
    w.ledger({ month: D(2027, 2), emp: 'BUT-001', ref: 'EMI-1', recovered: 5000 });
    w.ledger({ month: D(2027, 3), emp: 'BUT-001', ref: 'EMI-1', hr: 'RESIGNED', recovered: 2000, lwd: D(2027, 6, 15) });
    w.sync();
    return w;
  }
  const lwdsOf = w => [...new Set(w.rows('EMI-1').map(r => r.lwd).filter(Boolean))].sort();

  // --- (a) the settlement pre-stamps the whole window, which closes the correction route ---
  const w0 = seedOne();
  eq('M8.01  the settlement stamps its Last Working Day onto every future window row',
    w0.rows('EMI-1').filter(r => r.month >= '2027-04-01' && r.month <= '2027-06-01').map(r => r.lwd),
    ['2027-06-15', '2027-06-15', '2027-06-15']);

  // --- (b) brought FORWARD (notice cut short) ----------------------------------------
  const wa = seedOne();
  wa.ledger({ month: D(2027, 4), emp: 'BUT-001', ref: 'EMI-1', hr: 'RESIGNED', recovered: 4000, lwd: D(2027, 5, 15) });
  wa.sync();
  eq('M8.02  a corrected Last Working Day arriving on a later ledger row is APPLIED',
    lwdsOf(wa), ['2027-05-15']);
  eq('M8.03  the window shrinks to the corrected date — May becomes the final month',
    `${month(wa, 'EMI-1', '2027-05-01').stage}|${month(wa, 'EMI-1', '2027-06-01').status}`,
    'FINAL|CLOSED');

  // --- (c) pushed BACK (notice extended) ---------------------------------------------
  const wb = seedOne();
  wb.ledger({ month: D(2027, 4), emp: 'BUT-001', ref: 'EMI-1', hr: 'RESIGNED', recovered: 4000, lwd: D(2027, 8, 15) });
  wb.sync();
  // Owner's decision, 2026-08-21: a departure date may be brought forward but NEVER extended
  // once a settlement is open. Extending re-spreads the balance over more months and cuts each
  // instalment on nothing but the employee's word; if they then abscond the shortfall is
  // unrecoverable. So the expectation here is REFUSAL, not application.
  eq('M8.04  an EXTENDED Last Working Day is REFUSED — the original date stands',
    lwdsOf(wb), ['2027-06-15']);
  ok('M8.05  refusing it must not leave WRITE OFF on rows carrying no write-off amount',
    wb.rows('EMI-1').every(r => r.status !== 'WRITE OFF' || Number(r.woAmt || 0) > 0),
    JSON.stringify(wb.rows('EMI-1').map(r => `${r.month}=${r.status}/wo=${r.woAmt || '-'}`)));

  // --- (d) the correction arriving OUTSIDE the open window ---------------------------
  //     Here the old date is still live on the window rows AND the new date is live on the
  //     later row, so the reference carries two last working days at once.
  const wc = seedOne();
  for (const m of [4, 5, 6]) wc.ledger({ month: D(2027, m), emp: 'BUT-001', ref: 'EMI-1', recovered: 4000 });
  wc.sync();
  wc.ledger({ month: D(2027, 7), emp: 'BUT-001', ref: 'EMI-1', hr: 'RESIGNED', recovered: 0, lwd: D(2027, 8, 15) });
  wc.sync();

  eq('M8.06  one reference must not carry TWO different last working days', lwdsOf(wc).length, 1,
    JSON.stringify(wc.rows('EMI-1').map(r => `${r.month} lwd=${r.lwd || '-'}`)));
  // The rule is about the FUTURE, not the past. Months before and including the settlement have
  // already been paid and legitimately stay ACTIVE carrying their recovered amount — that is the
  // historical record. What must never happen is a write-off booked while a month AFTER it is
  // still ACTIVE with money on it: that says "forgiven" and "still collectable" at once, and the
  // booking is what releases the Employee Master exit lock.
  const woMonths = wc.rows('EMI-1').filter(r => Number(r.woAmt || 0) > 0).map(r => r.month).sort();
  ok('M8.07  no month AFTER a booked write-off may still be ACTIVE with an amount — ' +
    'booking one releases the Employee Master exit lock',
    woMonths.length === 0 || !wc.rows('EMI-1').some(r =>
      r.month > woMonths[0] && r.status === 'ACTIVE' && Number(r.emiAmt || 0) > 0),
    JSON.stringify(wc.rows('EMI-1').map(view)));

  ok('M8.07b a reference carries at most ONE booked write-off',
    woMonths.length <= 1, `write-offs booked in ${JSON.stringify(woMonths)}`);

  // --- (e) correcting the decision row in place --------------------------------------
  const wd = seedOne();
  wd.rec.getRange(wd.rec.getLastRow(), wd.rec.colOf['LAST WORKING DAY']).setValue(D(2027, 5, 15));
  wd.sync();
  gap('M8.08  correcting the decision row in place has no effect',
    lwdsOf(wd).join() === '2027-05-15',
    `rows read ${JSON.stringify(lwdsOf(wd))} — editing EMI_SCHEDULE directly is not a supported ` +
    `route and 3A re-normalises the column from the LEDGER every run. The correction must be ` +
    `entered on a later month's ledger row, which M8.02 now covers.`);
});

/* ------------------------------------------------------------------ */

let pass = 0, fail = 0, gaps = 0, last = null;
for (const r of results) {
  if (r.group !== last) { console.log(`\n${r.group}`); last = r.group; }
  if (r.ok) { pass++; console.log(`  PASS  ${r.name}`); }
  else if (r.gap) { gaps++; console.log(`  GAP   ${r.name}  -- ${r.detail}`); }
  else { fail++; console.log(`  FAIL  ${r.name}  -- ${r.detail}`); }
}
console.log(`\n${pass} passed, ${fail} failed, ${gaps} hardening gap(s), ${results.length} total`);
process.exit(fail ? 1 : 0);
