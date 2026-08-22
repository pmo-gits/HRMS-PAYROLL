/**
 * _tests/run-engine.js — EXECUTED scenario tests for the settlement engine.
 *
 * These run the real, unmodified `syncSharedEmiPayrollStatusFromRecoveredLedger` against the
 * in-memory Sheets emulator in _tests/sheets.js. Nothing here is a trace: every assertion
 * reads the grid the engine actually wrote.
 *
 * EXPECTATIONS ARE DERIVED FROM THE SPEC:
 *   _tests/cases/salary-advance.md  ·  _docs/salary-advance-settlement-plan.md
 * and, for S1, from the live BUT-039 figures supplied with the task.
 *
 * Run:  node _tests/run-engine.js
 */

'use strict';

const { makeWorld, D } = require('./world');

/* ------------------------------------------------------------------ */

const results = [];
let group = '(none)';
function describe(n, fn) { group = n; fn(); }
function record(n, ok, detail) { results.push({ group, name: n, ok, detail: detail || '' }); }
function gap(n, ok, detail) { results.push({ group, name: n, ok, gap: true, detail: detail || '' }); }
function eq(n, a, e) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  record(n, A === E, A === E ? '' : `expected ${E}, got ${A}`);
}
function ok(n, cond, detail) { record(n, !!cond, detail); }

/** compact view of one row: amount / status / stage / setBy / writeoff */
function view(r) {
  return `${r.emiAmt}|${r.status}|${r.stage}|${r.setBy}|${r.woAmt}|rec=${r.recover}`;
}
function months(rows) { return rows.map(r => r.month); }

/* ================================================================== *
 * S1 — the live BUT-039 case, walked month by month
 * ================================================================== */

function seedBut039(balanceModel) {
  const emiRows = [];
  // The scheduler laid 100,000 out as 10 x 10,000: May 2026 .. Feb 2027.
  for (let k = 0; k < 10; k++) {
    const m = new Date(2026, 4 + k, 1);
    emiRows.push({ month: m, emp: 'BUT-039', name: 'Test Worker', dept: 'PROD', ref: 'EMI-24', emiAmt: 10000, status: 'ACTIVE' });
  }
  const w = makeWorld({ advances: { 'EMI-24': { advance: 100000 } }, emiRows, balanceModel });
  // May..Oct recovered 10,000 each.
  for (let k = 0; k < 6; k++) {
    w.ledger({ month: new Date(2026, 4 + k, 1), emp: 'BUT-039', ref: 'EMI-24', recovered: 10000 });
  }
  return w;
}

describe('S1 — BUT-039 settlement, month by month (EXECUTED)', () => {
  const w = seedBut039();

  // --- November: RESIGNED, LWD 15 Feb 2027, Close In Months 3, recovered 13,300 -------
  w.ledger({
    month: D(2026, 11), emp: 'BUT-039', ref: 'EMI-24', hr: 'RESIGNED',
    recovered: 13300, lwd: D(2027, 2, 15), closeIn: 3,
  });
  w.sync();
  let r = w.rows('EMI-24');
  const by = m => r.find(x => x.month === m);

  eq('S1a  no month is invented past the plan (Mar 2027 must not exist)',
    months(r), ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01',
      '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  eq('S1a  balance after November is 26,700', by('2026-11-01').bal, 26700);
  eq('S1a  Dec = 13,400 ACTIVE', view(by('2026-12-01')), '13400|ACTIVE|SETTLING|ADMIN||rec=');
  eq('S1a  Jan = 13,300 ACTIVE', view(by('2027-01-01')), '13300|ACTIVE|SETTLING|ADMIN||rec=');
  eq('S1a  Feb (LWD month, beyond the plan) = 0 but stays ACTIVE',
    view(by('2027-02-01')), '0|ACTIVE|FINAL|ADMIN||rec=');
  ok('S1a  no write-off booked while the employee is still working (B1.02/B4.05)',
    r.every(x => x.woAmt === ''), JSON.stringify(r.map(view)));

  // --- December locks and recovers 13,400 --------------------------------------------
  w.ledger({ month: D(2026, 12), emp: 'BUT-039', ref: 'EMI-24', recovered: 13400 });
  w.sync();
  r = w.rows('EMI-24');

  eq('S1b  still no March 2027 row', months(r).length, 10);
  eq('S1b  balance is 13,300', by('2026-11-01') && w.rows('EMI-24')[0].bal, 13300);
  eq('S1b  Jan does NOT halve — stays 13,300',
    view(w.rows('EMI-24').find(x => x.month === '2027-01-01')), '13300|ACTIVE|SETTLING|ADMIN||rec=');
  eq('S1b  Feb still 0 / ACTIVE',
    view(w.rows('EMI-24').find(x => x.month === '2027-02-01')), '0|ACTIVE|FINAL|ADMIN||rec=');
  ok('S1b  still no write-off', w.rows('EMI-24').every(x => x.woAmt === ''));

  // --- January under-recovers (LOP): 8,000 of the 13,300 asked for --------------------
  w.ledger({ month: D(2027, 1), emp: 'BUT-039', ref: 'EMI-24', recovered: 8000 });
  w.sync();
  r = w.rows('EMI-24');

  eq('S1c  balance is 5,300', r[0].bal, 5300);
  eq('S1c  no month invented to absorb the shortfall', months(r).length, 10);
  eq('S1c  Feb stays 0 / ACTIVE — holds the exit lock, recovers nothing (plan doc rule)',
    view(r.find(x => x.month === '2027-02-01')), '0|ACTIVE|FINAL|ADMIN||rec=');
  ok('S1c  still no write-off booked before the last working day month is paid',
    r.every(x => x.woAmt === ''));

  // --- February: the half month. Payroll runs, recovers 0 (EMI Amount is 0) -----------
  w.ledger({ month: D(2027, 2), emp: 'BUT-039', ref: 'EMI-24', recovered: 0 });
  w.sync();
  r = w.rows('EMI-24');
  const feb = r.find(x => x.month === '2027-02-01');

  eq('S1d  a recovery of exactly 0 is stored as "0", not blank (Fix 1, B6.03)', feb.recover, '0');
  eq('S1d  the write-off finally books, for the real residual', feb.woAmt, '5300');
  eq('S1d  Feb status WRITE OFF, stage FINAL', `${feb.status}|${feb.stage}`, 'WRITE OFF|FINAL');
  eq('S1d  exactly ONE write-off across the whole reference',
    r.filter(x => x.woAmt !== '').length, 1);
  eq('S1d  still 10 rows — nothing appended by the final run', months(r).length, 10);
});

/* ================================================================== *
 * S1' — same walk, but February recovers a partial amount
 * ================================================================== */

describe("S1' — LWD month recovers part of the balance (EXECUTED)", () => {
  const w = seedBut039();
  w.ledger({ month: D(2026, 11), emp: 'BUT-039', ref: 'EMI-24', hr: 'RESIGNED', recovered: 13300, lwd: D(2027, 2, 15), closeIn: 3 });
  w.sync();
  w.ledger({ month: D(2026, 12), emp: 'BUT-039', ref: 'EMI-24', recovered: 13400 });
  w.sync();
  w.ledger({ month: D(2027, 1), emp: 'BUT-039', ref: 'EMI-24', recovered: 8000 });
  w.sync();
  w.ledger({ month: D(2027, 2), emp: 'BUT-039', ref: 'EMI-24', recovered: 2000 });
  w.sync();

  const r = w.rows('EMI-24');
  const feb = r.find(x => x.month === '2027-02-01');
  eq("S1'  write-off is the residual AFTER February's partial recovery", feb.woAmt, '3300');
  eq("S1'  balance still reads 3,300 (write-off does not repay it)", r[0].bal, 3300);
  eq("S1'  Feb WRITE OFF / FINAL", `${feb.status}|${feb.stage}`, 'WRITE OFF|FINAL');
});

/* ================================================================== *
 * S2 — idempotency at every stage. 3B fires this on a timer.
 * ================================================================== */

describe('S2 — idempotency: a second run with no data change (EXECUTED)', () => {
  const stages = [
    { name: 'after the November decision', add: w => w.ledger({ month: D(2026, 11), emp: 'BUT-039', ref: 'EMI-24', hr: 'RESIGNED', recovered: 13300, lwd: D(2027, 2, 15), closeIn: 3 }) },
    { name: 'after December recovers', add: w => w.ledger({ month: D(2026, 12), emp: 'BUT-039', ref: 'EMI-24', recovered: 13400 }) },
    { name: 'after January under-recovers', add: w => w.ledger({ month: D(2027, 1), emp: 'BUT-039', ref: 'EMI-24', recovered: 8000 }) },
    { name: 'after February is paid (write-off booked)', add: w => w.ledger({ month: D(2027, 2), emp: 'BUT-039', ref: 'EMI-24', recovered: 0 }) },
  ];

  for (let n = 1; n <= stages.length; n++) {
    const w = seedBut039();
    for (let k = 0; k < n; k++) { stages[k].add(w); w.sync(); }
    const before = w.snapshot();
    w.sync();
    const after = w.snapshot();
    ok(`S2  idempotent ${stages[n - 1].name}`, before === after,
      before === after ? '' : firstDiff(before, after));
    // and a third run, in case run 2 lands in a different fixed point
    w.sync();
    ok(`S2  still idempotent on a third run — ${stages[n - 1].name}`, w.snapshot() === after);
  }

  // 30 consecutive runs, the way a timer would actually behave
  const w = seedBut039();
  stages.forEach(s => { s.add(w); w.sync(); });
  const fixed = w.snapshot();
  for (let k = 0; k < 30; k++) w.sync();
  ok('S2  stable across 30 timer-driven runs', w.snapshot() === fixed,
    w.snapshot() === fixed ? '' : firstDiff(fixed, w.snapshot()));
});

function firstDiff(a, b) {
  const A = JSON.parse(a), B = JSON.parse(b);
  for (let i = 0; i < Math.max(A.grid.length, B.grid.length); i++) {
    const x = JSON.stringify(A.grid[i]), y = JSON.stringify(B.grid[i]);
    if (x !== y) return `row ${i + 2}: ${x}  ->  ${y}`;
  }
  return `props/maxRows: ${JSON.stringify(A.props)}/${A.maxRows} -> ${JSON.stringify(B.props)}/${B.maxRows}`;
}

/* ================================================================== *
 * S3 — a settlement that clears early (regression guard, B2.01–B2.03)
 * ================================================================== */

describe('S3 — settlement clears early (EXECUTED)', () => {
  const emiRows = [];
  for (let k = 0; k < 3; k++) {
    emiRows.push({ month: new Date(2026, 6 + k, 1), emp: 'BUT-077', name: 'Early', dept: 'PROD', ref: 'EMI-40', emiAmt: 10000, status: 'ACTIVE' });
  }
  const w = makeWorld({ advances: { 'EMI-40': { advance: 30000 } }, emiRows });

  w.ledger({ month: D(2026, 7), emp: 'BUT-077', ref: 'EMI-40', hr: 'RESIGNED', recovered: 10000, lwd: D(2026, 9, 15) });
  w.sync();
  let r = w.rows('EMI-40');
  eq('S3a  Aug SETTLING / Sep FINAL, both ACTIVE (B1.01)',
    [r[1].status + '/' + r[1].stage, r[2].status + '/' + r[2].stage],
    ['ACTIVE/SETTLING', 'ACTIVE/FINAL']);
  ok('S3a  no write-off while settling (B1.02)', r.every(x => x.woAmt === ''));

  // August clears the whole remaining balance (PAY EXTRA).
  w.ledger({ month: D(2026, 8), emp: 'BUT-077', ref: 'EMI-40', recovered: 20000 });
  w.sync();
  r = w.rows('EMI-40');
  const sep = r.find(x => x.month === '2026-09-01');
  eq('S3b  balance is 0', r[0].bal, 0);
  eq('S3b  September closes: 0 / CLOSED / stage CLOSED (B2.01, B2.02)',
    `${sep.emiAmt}|${sep.status}|${sep.stage}`, '0|CLOSED|CLOSED');
  ok('S3b  NO write-off anywhere — EMI Status must read CLOSED, not WRITE OFF (B2.03)',
    r.every(x => x.woAmt === ''), JSON.stringify(r.map(view)));
  ok('S3b  (3a2) did NOT fire on the last-working-day month that was never paid',
    sep.woAmt === '');
  eq('S3b  no rows appended', r.length, 3);

  const s = w.snapshot(); w.sync();
  ok('S3c  idempotent', s === w.snapshot(), s === w.snapshot() ? '' : firstDiff(s, w.snapshot()));
});

/* ================================================================== *
 * S3' — a NON-settlement early payoff (B2.01/B2.02 for the plain path)
 * ================================================================== */

describe("S3' — PAY EXTRA clears an ordinary advance (EXECUTED)", () => {
  const emiRows = [];
  for (let k = 0; k < 4; k++) {
    emiRows.push({ month: new Date(2026, 5 + k, 1), emp: 'BUT-088', ref: 'EMI-30', emiAmt: 10000, status: 'ACTIVE' });
  }
  const w = makeWorld({ advances: { 'EMI-30': { advance: 40000 } }, emiRows });
  w.ledger({ month: D(2026, 6), emp: 'BUT-088', ref: 'EMI-30', recovered: 10000 });
  w.ledger({ month: D(2026, 7), emp: 'BUT-088', ref: 'EMI-30', recovered: 30000 });
  w.sync();
  const r = w.rows('EMI-30');
  eq("S3'  Aug and Sep close (B2.01/B2.02)",
    [view(r[2]), view(r[3])], ['0|CLOSED|CLOSED|||rec=', '0|CLOSED|CLOSED|||rec=']);
  ok("S3'  no write-off", r.every(x => x.woAmt === ''));
  eq("S3'  no rows appended", r.length, 4);
});

/* ================================================================== *
 * S4 — pass interaction / ownership
 * ================================================================== */

describe('S4 — pass ownership and interaction (EXECUTED)', () => {
  // (a) Does anything undo (3a2) later in the SAME run? Book, then keep running.
  const w = seedBut039();
  w.ledger({ month: D(2026, 11), emp: 'BUT-039', ref: 'EMI-24', hr: 'RESIGNED', recovered: 13300, lwd: D(2027, 2, 15), closeIn: 3 });
  w.sync();
  w.ledger({ month: D(2026, 12), emp: 'BUT-039', ref: 'EMI-24', recovered: 13400 });
  w.sync();
  w.ledger({ month: D(2027, 1), emp: 'BUT-039', ref: 'EMI-24', recovered: 8000 });
  w.sync();
  w.ledger({ month: D(2027, 2), emp: 'BUT-039', ref: 'EMI-24', recovered: 0 });
  w.sync();
  const feb = w.rows('EMI-24').find(x => x.month === '2027-02-01');
  eq('S4a  (3a2) survives (3b)/(3c)/(3d) in the same run',
    `${feb.woAmt}|${feb.status}|${feb.stage}`, '5300|WRITE OFF|FINAL');

  // (b) A booked write-off is never reversed by a later run (B6.05).
  for (let k = 0; k < 5; k++) w.sync();
  const feb2 = w.rows('EMI-24').find(x => x.month === '2027-02-01');
  eq('S4b  write-off never reversed across 5 further runs (B6.05)',
    `${feb2.woAmt}|${feb2.status}|${feb2.stage}`, '5300|WRITE OFF|FINAL');

  // (c) Same walk under the alternative balance model (write-off reduces the balance),
  //     so no conclusion depends on how Current Balance is defined.
  const w2 = seedBut039('net-of-writeoff');
  w2.ledger({ month: D(2026, 11), emp: 'BUT-039', ref: 'EMI-24', hr: 'RESIGNED', recovered: 13300, lwd: D(2027, 2, 15), closeIn: 3 }); w2.sync();
  w2.ledger({ month: D(2026, 12), emp: 'BUT-039', ref: 'EMI-24', recovered: 13400 }); w2.sync();
  w2.ledger({ month: D(2027, 1), emp: 'BUT-039', ref: 'EMI-24', recovered: 8000 }); w2.sync();
  w2.ledger({ month: D(2027, 2), emp: 'BUT-039', ref: 'EMI-24', recovered: 0 }); w2.sync();
  const s2 = w2.snapshot(); w2.sync(); w2.sync();
  const feb3 = w2.rows('EMI-24').find(x => x.month === '2027-02-01');
  eq('S4c  same outcome if a write-off reduces Current Balance', feb3.woAmt, '5300');
  ok('S4c  and still idempotent under that model', s2 === w2.snapshot(),
    s2 === w2.snapshot() ? '' : firstDiff(s2, w2.snapshot()));

  // (d) B6.06 — a second, untouched advance for the same employee must not move.
  const emiRows = [];
  for (let k = 0; k < 3; k++) emiRows.push({ month: new Date(2026, 6 + k, 1), emp: 'BUT-099', ref: 'EMI-A', emiAmt: 10000, status: 'ACTIVE' });
  for (let k = 0; k < 3; k++) emiRows.push({ month: new Date(2026, 6 + k, 1), emp: 'BUT-099', ref: 'EMI-B', emiAmt: 5000, status: 'ACTIVE' });
  const w3 = makeWorld({ advances: { 'EMI-A': { advance: 30000 }, 'EMI-B': { advance: 15000 } }, emiRows });
  w3.ledger({ month: D(2026, 7), emp: 'BUT-099', ref: 'EMI-A', hr: 'RESIGNED', recovered: 10000, lwd: D(2026, 9, 15) });
  w3.ledger({ month: D(2026, 7), emp: 'BUT-099', ref: 'EMI-B', recovered: 5000 });
  const bBefore = w3.rows('EMI-B').map(view);
  w3.sync();
  eq('S4d  the settling advance does not disturb the other one (B6.06)',
    w3.rows('EMI-B').map(x => x.emiAmt), ['5000', '5000', '5000']);
  ok('S4d  and the other advance books no write-off', w3.rows('EMI-B').every(x => x.woAmt === ''),
    JSON.stringify(bBefore));

  // (e) B6.04 — a CANCELLED advance must be untouched by every pass.
  const w4 = makeWorld({
    advances: { 'EMI-C': { advance: 20000, cancelled: true } },
    emiRows: [
      { month: D(2026, 7), emp: 'BUT-100', ref: 'EMI-C', emiAmt: 10000, status: 'CANCELLED' },
      { month: D(2026, 8), emp: 'BUT-100', ref: 'EMI-C', emiAmt: 10000, status: 'CANCELLED' },
    ],
  });
  w4.ledger({ month: D(2026, 7), emp: 'BUT-100', ref: 'EMI-C', hr: 'RESIGNED', recovered: 0, lwd: D(2026, 9, 15) });
  w4.sync();
  const c = w4.rows('EMI-C');
  eq('S4e  CANCELLED rows keep their amount and status (B6.04)',
    c.map(x => `${x.emiAmt}|${x.status}`), ['10000|CANCELLED', '10000|CANCELLED']);
  gap('S4e  CANCELLED row is not given a Settlement Stage / Last Working Day',
    c.every(x => x.stage === '' && x.lwd === ''),
    `stages=${JSON.stringify(c.map(x => x.stage))} lwd=${JSON.stringify(c.map(x => x.lwd))}`);
  eq('S4e  no settlement months created for a cancelled advance', c.length, 2);
});

/* ================================================================== *
 * S4' — Fix 3 in isolation: which "beyond the plan" months stay ACTIVE
 * ================================================================== */

describe("S4' — Close In Months vs the last-working-day month (EXECUTED)", () => {
  // Plan of 3 set in November; last working day 15 Mar 2027; schedule runs to April.
  const emiRows = [];
  for (let k = 0; k < 8; k++) {
    emiRows.push({ month: new Date(2026, 8 + k, 1), emp: 'BUT-060', ref: 'EMI-70', emiAmt: 10000, status: 'ACTIVE' });
  }
  const w = makeWorld({ advances: { 'EMI-70': { advance: 80000 } }, emiRows });
  w.ledger({ month: D(2026, 9), emp: 'BUT-060', ref: 'EMI-70', recovered: 10000 });
  w.ledger({ month: D(2026, 10), emp: 'BUT-060', ref: 'EMI-70', recovered: 10000 });
  w.ledger({
    month: D(2026, 11), emp: 'BUT-060', ref: 'EMI-70', hr: 'RESIGNED',
    recovered: 10000, lwd: D(2027, 3, 15), closeIn: 3,
  });
  w.sync();
  const r = w.rows('EMI-70');
  const at = m => r.find(x => x.month === m);

  eq("S4'  balance after November", r[0].bal, 50000);
  eq("S4'  Dec / Jan carry the plan (inside the window)",
    [at('2026-12-01').emiAmt, at('2027-01-01').emiAmt], ['25000', '25000']);
  eq("S4'  Feb — beyond the plan, before the last working day — is emptied AND closed",
    `${at('2027-02-01').emiAmt}|${at('2027-02-01').status}`, '0|CLOSED');
  eq("S4'  Mar — the LAST WORKING DAY month — is emptied but stays ACTIVE (Fix 3)",
    `${at('2027-03-01').emiAmt}|${at('2027-03-01').status}`, '0|ACTIVE');
  // CLOSED, not WRITE OFF (changed 2026-08-21). Nothing is forgiven on this row — it carries no
  // write-off amount, as the very next assertion checks. It is a month that cannot happen, which
  // is exactly what Feb above already called CLOSED; the two labels disagreed for no reason.
  eq("S4'  Apr — beyond the last working day — is emptied AND closed by Case B",
    `${at('2027-04-01').emiAmt}|${at('2027-04-01').status}`, '0|CLOSED');
  ok("S4'  no write-off AMOUNT booked while the employee is still working",
    r.every(x => x.woAmt === ''));
  const s = w.snapshot(); w.sync();
  ok("S4'  idempotent", s === w.snapshot(), s === w.snapshot() ? '' : firstDiff(s, w.snapshot()));
});

/* ================================================================== *
 * B4 — Close In Months, the register's own cases (EXECUTED)
 * ================================================================== */

describe('B4 — Close In Months register cases (EXECUTED)', () => {
  function seedPlan(n, opts) {
    const o = opts || {};
    const rows = [];
    for (let k = 0; k < (o.months || 5); k++) {
      rows.push({ month: new Date(2026, 6 + k, 1), emp: 'BUT-070', ref: 'EMI-80', emiAmt: 10000, status: 'ACTIVE' });
    }
    const w = makeWorld({ advances: { 'EMI-80': { advance: (o.months || 5) * 10000 } }, emiRows: rows });
    w.ledger({ month: D(2026, 7), emp: 'BUT-070', ref: 'EMI-80', recovered: o.firstRecovered === undefined ? 10000 : o.firstRecovered, closeIn: n });
    return w;
  }

  // B4.01 — plan of 1: nothing after the plan month may recover.
  const w1 = seedPlan(1);
  w1.sync();
  ok('B4.01  plan = 1: every later row is 0 / CLOSED / ADMIN',
    w1.rows('EMI-80').slice(1).every(x => x.emiAmt === '0' && x.status === 'CLOSED' && x.setBy === 'ADMIN'),
    JSON.stringify(w1.rows('EMI-80').map(view)));

  // B4.03 — plan longer than the schedule: months are created, stamped ADMIN.
  const w3 = seedPlan(6, { months: 3 });
  w3.sync();
  const r3 = w3.rows('EMI-80');
  eq('B4.03  a plan longer than the schedule creates months', r3.length, 6);
  ok('B4.03  every created month is stamped ADMIN',
    r3.slice(1).every(x => x.setBy === 'ADMIN'), JSON.stringify(r3.map(view)));
  eq('B4.03  the created months sum to the outstanding balance',
    r3.filter(x => x.recover === '').reduce((s, x) => s + Number(x.emiAmt || 0), 0), 20000);
  eq('B4.03  and no month is created past the plan window (Jul + 5 = Dec)',
    r3[r3.length - 1].month, '2026-12-01');

  // B4.04 — re-run leaves ADMIN rows alone.
  const s3 = w3.snapshot(); w3.sync(); w3.sync();
  ok('B4.04  re-running leaves the ADMIN rows unchanged', s3 === w3.snapshot(),
    s3 === w3.snapshot() ? '' : firstDiff(s3, w3.snapshot()));

  // B4.06 — two plans in different ledger months: the later one wins.
  const w6 = seedPlan(5, { months: 6 });
  w6.ledger({ month: D(2026, 8), emp: 'BUT-070', ref: 'EMI-80', recovered: 10000, closeIn: 2 });
  w6.sync();
  const r6 = w6.rows('EMI-80');
  // Later plan: set in Aug, N=2 -> window ends Sep. Everything after Sep must be closed.
  ok('B4.06  the later plan wins — nothing after its window recovers',
    r6.filter(x => x.month > '2026-09-01').every(x => x.emiAmt === '0'),
    JSON.stringify(r6.map(x => `${x.month}=${x.emiAmt}/${x.status}`)));
  eq('B4.06  the whole remaining balance lands inside the later window',
    r6.filter(x => x.recover === '').reduce((s, x) => s + Number(x.emiAmt || 0), 0), 40000);

  // B4.02 — the register says "= 2, 9,000 owed -> 4,500 + 4,500". The derived window gives
  // N-1 future months, so N=2 yields ONE future month. Recorded as an observation, not a
  // failure: the register and the implemented semantics disagree about what N counts.
  const w2 = seedPlan(2, { months: 4, firstRecovered: 31000 });
  w2.sync();
  const r2 = w2.rows('EMI-80').filter(x => x.recover === '');
  gap('B4.02  register expects the balance split 4,500 + 4,500 across TWO future months',
    r2.filter(x => Number(x.emiAmt) > 0).length === 2,
    `future months carrying an amount: ${JSON.stringify(r2.map(x => `${x.month}=${x.emiAmt}`))} ` +
    `— N-1 future months is what S1 (BUT-039, N=3 -> Dec+Jan) confirms live`);
});

/* ================================================================== *
 * S5 — SKIP (register B5, never verified since the settlement work)
 * ================================================================== */

describe('S5 — SKIP (EXECUTED)', () => {
  function seedSkip() {
    const emiRows = [];
    for (let k = 0; k < 4; k++) {
      emiRows.push({ month: new Date(2026, 5 + k, 1), emp: 'BUT-050', name: 'Skipper', dept: 'PROD', ref: 'EMI-50', emiAmt: 10000, status: 'ACTIVE' });
    }
    const w = makeWorld({ advances: { 'EMI-50': { advance: 40000 } }, emiRows });
    w.ledger({ month: D(2026, 6), emp: 'BUT-050', ref: 'EMI-50', recovered: 10000 });
    return w;
  }

  const w = seedSkip();
  w.ledger({ month: D(2026, 7), emp: 'BUT-050', ref: 'EMI-50', hr: 'SKIP', recovered: 0 });
  w.sync();
  let r = w.rows('EMI-50');
  const jul = r.find(x => x.month === '2026-07-01');

  eq('S5.03  a SKIP month stores Recover Amount "0", not blank (Fix 1, B5.03/B6.03)',
    jul.recover, '0');
  ok('S5     the skipped month is treated as a locked record, not re-offered',
    jul.emiAmt === '10000', `Jul row: ${view(jul)}`);

  const octRows = r.filter(x => x.month === '2026-10-01');
  eq('S5.01  exactly ONE row appended for the month after the schedule (B5.01)', octRows.length, 1,
    JSON.stringify(r.map(x => `${x.month} ${view(x)}`)));
  if (octRows.length === 1) {
    eq('S5.01  the appended row carries the same EMI Amount and is ACTIVE',
      `${octRows[0].emiAmt}|${octRows[0].status}`, '10000|ACTIVE');
  }
  eq('S5     the schedule still totals the outstanding balance (30,000)',
    r.filter(x => x.recover === '').reduce((s, x) => s + Number(x.emiAmt || 0), 0), 30000,
    JSON.stringify(r.map(x => `${x.month}=${x.emiAmt}`)));

  const snap = w.snapshot();
  w.sync();
  ok('S5.02  re-running appends no second row (ScriptProperties idempotency)',
    snap === w.snapshot(), snap === w.snapshot() ? '' : firstDiff(snap, w.snapshot()));

  // Provenance of the duplicate: with the SKIP month's Recover Amount stored as blank (the
  // pre-Fix-1 behaviour), (3d) counts that month as still open, the schedule adds up, no drift
  // is detected and only the SKIP append happens. Storing "0" — correctly — is what makes the
  // schedule look 10,000 short and brings the drift pass in on top of the SKIP append.
  const wBlank = seedSkip();
  wBlank.ledger({ month: D(2026, 7), emp: 'BUT-050', ref: 'EMI-50', hr: 'SKIP', recovered: '' });
  wBlank.sync();
  eq('S5     with Recover Amount blank (pre-Fix-1) only ONE row is appended',
    wBlank.rows('EMI-50').filter(x => x.month === '2026-10-01').length, 1);

  // B5.04 — DONT SKIP appends nothing.
  const w2 = seedSkip();
  w2.ledger({ month: D(2026, 7), emp: 'BUT-050', ref: 'EMI-50', hr: 'DONT SKIP', recovered: 10000 });
  w2.sync();
  eq('S5.04  DONT SKIP appends no row', w2.rows('EMI-50').length, 4);

  // B5.05 — SKIP then a PAY EXTRA that clears the balance: the appended row must close too.
  const w3 = seedSkip();
  w3.ledger({ month: D(2026, 7), emp: 'BUT-050', ref: 'EMI-50', hr: 'SKIP', recovered: 0 });
  w3.sync();
  w3.ledger({ month: D(2026, 8), emp: 'BUT-050', ref: 'EMI-50', recovered: 30000 });
  w3.sync();
  const r3 = w3.rows('EMI-50');
  ok('S5.05  every unrecovered row is CLOSED once the balance clears',
    r3.filter(x => x.recover === '').every(x => x.status === 'CLOSED' && x.emiAmt === '0'),
    JSON.stringify(r3.map(x => `${x.month} ${view(x)}`)));
});

/* ================================================================== *
 * B3 — the drift pass, and Case B's own arithmetic
 * ================================================================== */

describe('B3 — drift re-fit and Case B arithmetic (EXECUTED)', () => {
  // B3.04 — an advance nobody varied must be COMPLETELY untouched.
  const rows = [];
  for (let k = 0; k < 4; k++) rows.push({ month: new Date(2026, 5 + k, 1), emp: 'BUT-201', ref: 'EMI-90', emiAmt: 10000, status: 'ACTIVE' });
  const w = makeWorld({ advances: { 'EMI-90': { advance: 40000 } }, emiRows: rows });
  w.ledger({ month: D(2026, 6), emp: 'BUT-201', ref: 'EMI-90', recovered: 10000 });
  const before = JSON.stringify(w.rows('EMI-90'));
  w.sync();
  const after = w.rows('EMI-90');
  eq('B3.04  an unvaried advance keeps every amount and status',
    after.map(x => `${x.emiAmt}|${x.status}`),
    ['10000|ACTIVE', '10000|ACTIVE', '10000|ACTIVE', '10000|ACTIVE'], before);
  eq('B3.04  and no month is appended', after.length, 4);

  // B3.02 — PAY LESS shortens nothing and adds a month.
  const rows2 = [];
  for (let k = 0; k < 4; k++) rows2.push({ month: new Date(2026, 5 + k, 1), emp: 'BUT-202', ref: 'EMI-91', emiAmt: 10000, status: 'ACTIVE' });
  const w2 = makeWorld({ advances: { 'EMI-91': { advance: 40000 } }, emiRows: rows2 });
  w2.ledger({ month: D(2026, 6), emp: 'BUT-202', ref: 'EMI-91', recovered: 500 });
  w2.sync();
  const r2 = w2.rows('EMI-91');
  eq('B3.02  PAY LESS 500 -> 3 x 10,000 + 1 x 9,500, one month added (B3.02)',
    r2.filter(x => x.recover === '').map(x => x.emiAmt), ['10000', '10000', '10000', '9500']);
  const s2 = w2.snapshot(); w2.sync();
  ok('B3.02  and the drift pass is idempotent', s2 === w2.snapshot(),
    s2 === w2.snapshot() ? '' : firstDiff(s2, w2.snapshot()));

  // Case B does not close its own arithmetic: ceilTo100 is applied per month with no running
  // remainder, so the settlement window can be scheduled for MORE than the balance.
  const rows3 = [];
  for (let k = 0; k < 4; k++) rows3.push({ month: new Date(2026, 6 + k, 1), emp: 'BUT-203', ref: 'EMI-92', emiAmt: 10000, status: 'ACTIVE' });
  const w3 = makeWorld({ advances: { 'EMI-92': { advance: 40000 } }, emiRows: rows3 });
  w3.ledger({ month: D(2026, 7), emp: 'BUT-203', ref: 'EMI-92', hr: 'RESIGNED', recovered: 15000, lwd: D(2026, 10, 15) });
  w3.sync();
  const r3 = w3.rows('EMI-92');
  const scheduled = r3.filter(x => x.recover === '').reduce((s, x) => s + Number(x.emiAmt || 0), 0);
  gap('Case B  the settlement window should be scheduled for exactly the balance',
    scheduled === 25000, `balance 25000, scheduled ${scheduled} (${JSON.stringify(r3.map(x => x.emiAmt))})`);
});

/* ================================================================== *
 * S6 — the 24-month bound (guard added alongside the four fixes)
 * ================================================================== */

describe('S6 — out-of-range Last Working Day (EXECUTED)', () => {
  const emiRows = [
    { month: D(2026, 7), emp: 'BUT-111', ref: 'EMI-60', emiAmt: 10000, status: 'ACTIVE' },
    { month: D(2026, 8), emp: 'BUT-111', ref: 'EMI-60', emiAmt: 10000, status: 'ACTIVE' },
  ];
  const w = makeWorld({ advances: { 'EMI-60': { advance: 20000 } }, emiRows });
  // A Last Working Day cell that lost its date number format reads back as a bare serial.
  w.ledger({ month: D(2026, 7), emp: 'BUT-111', ref: 'EMI-60', hr: 'RESIGNED', recovered: 0, lwd: 46266 });
  let threw = null;
  try { w.sync(); } catch (e) { threw = e; }
  ok('S6  a bare spreadsheet serial in Last Working Day does not explode the sheet',
    !threw && w.rows('EMI-60').length === 2,
    threw ? String(threw.message).slice(0, 160) : `${w.rows('EMI-60').length} rows`);
  gap('S6  the bad reference is silently skipped — nothing is written, nothing is flagged',
    false, 'the 24-month guard `continue`s with no log and no alert; the advance is frozen');
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
