# Salary advance — test case register

Every scenario for the salary-advance settlement feature, across all three layers.

**This file is the specification, not a description of the code.** Test cases are written from
here and from [_docs/salary-advance-settlement-plan.md](../../_docs/salary-advance-settlement-plan.md)
— never by reading the implementation. A test derived from the code only confirms what the code
already does, including where it is wrong. Several of the bugs below were found precisely because
a human expected something the code did not do.

Readable by any executor: the Node harness, a Claude Code agent, or Antigravity's browser agent.

---

## The three layers

| Layer | What it tests | Needs a payroll cycle? | Cost each |
|---|---|---|---|
| **A — Formulas** | The approval tab's rules | No | seconds |
| **B — Engine (3A)** | Settlement, rebalance, closing | No | minutes |
| **C — Full chain** | The plumbing between files | Yes, and it is one-way | ~1 hour |

**Layer B needs no payroll.** 3A reads the Recovered Amount Ledger and writes `EMI_SCHEDULE`; it
neither knows nor cares whether a payroll ever ran. Write a ledger row by hand, run the sync, read
the result. That is where most of the logic — and nearly every bug found so far — lives.

## Status key

| | |
|---|---|
| ✅ | walked manually, passed |
| 🐛 | found a real bug (now fixed) — **keep as a regression case** |
| ⬜ | never tested |

## Rules for every scenario

- **Sandbox only.** `TEST_SANDBOX_Salary Advance Master`. Seeding wipes `EMI_SCHEDULE`.
- **Reset from `_BASELINE` between scenarios.** Otherwise case 3 inherits case 2's mess and a
  failure tells you nothing.
- **Read values from the CSV export, never from the grid.** Sheets renders cells on a `<canvas>`;
  anything scraping the DOM invents numbers.
  `…/gviz/tq?tqx=out:csv&sheet=EMI_SCHEDULE`
- **Assert on values, not screenshots.** A screenshot is evidence for a human, not a test result.

---

# Layer A — Formula scenarios

No scripts. Type the inputs into one approval-tab row and read the outputs.

Column letters as of 2026-08-17: `H` EMI Amount · `I` Current Balance · `K` Settlement Stage ·
`L` Last Working Day · `M` Months Remaining · `Q` Max Recoverable · `R` Scheduled Amount ·
`S` HR Decision · `T` Approved Decision · `V` Entry Mode · `W` Admin Entry · `X` Close In Months ·
`Y` Recovery Total · `Z` Planned EMI · `AF` Alert.

## A1 — Alert, the 19 rules

Each rule needs a firing case and a **not**-firing case. A rule that always fires is as broken as
one that never does.

| # | Scenario | Expect | |
|---|---|---|---|
| A1.01 | `Max Recoverable` blank | ERROR: Run Validate Payroll | ⬜ |
| A1.02 | Last working day `15/10/2025` on a Jul-2026 row | ERROR: before this payroll month | 🐛 |
| A1.03 | `Admin Entry` 5000 **and** `Close In Months` 2 | ERROR: not both | 🐛 |
| A1.04 | `Close In Months` = 0 | ERROR: must be 1 or more | ⬜ |
| A1.05 | `Close In Months` = 5, LWD leaves 3 months | ERROR: only 3 month(s) left | ⬜ |
| A1.06 | `Admin Entry` on the 2nd advance of an employee | ERROR: oldest advance only | ⬜ |
| A1.07 | `Close In Months` on the 2nd advance | ERROR: oldest advance only | ⬜ |
| A1.08 | `RESIGNED`, `Last Working Day` blank | ERROR: enter the last working day | ✅ |
| A1.09 | HR `SKIP`, `Approved Decision` blank | ERROR: approve it or choose DONT SKIP | 🐛 |
| A1.10 | `Entry Mode` set, no amount, no plan | ERROR: enter an amount | ⬜ |
| A1.11 | `PERCENT` mode, entry 120 | ERROR: cannot exceed 100 | ⬜ |
| A1.12 | `Admin Entry` = 0 | ERROR: must be greater than zero | ⬜ |
| A1.13 | `PAY EXTRA` 200, EMI 10000 | ERROR: must be MORE than scheduled | 🐛 |
| A1.14 | `PAY EXTRA` 10000, EMI 10000 (**equal**) | ERROR: must be MORE than scheduled | 🐛 |
| A1.15 | `PAY LESS` 15000, EMI 10000 | ERROR: must be LESS than scheduled | ⬜ |
| A1.16 | `PAY LESS` 10000, EMI 10000 (**equal**) | ERROR: must be LESS than scheduled | ⬜ |
| A1.17 | `RESIGNED`, no entry, no plan, no stage | ERROR: enter recovery amount | ✅ |
| A1.18 | `RESIGNED`, no entry, `Close In Months` **set** | **blank** — the plan is the instruction | 🐛 |
| A1.19 | Recovery 40000 against 36423 capacity | ERROR: Over by ₹3,577 | ✅ |
| A1.20 | Recovery 50000 against a 40000 balance | ERROR: more than outstanding | ⬜ |
| A1.21 | Amount typed, `Approved Decision` blank, not resigned | WARN: amount ignored | ✅ |
| A1.22 | Settlement leaving a shortfall | WARN: projected write-off | ✅ |
| A1.23 | Recovery takes take-home to 0 | WARN: employee left with ₹0 | ⬜ |
| A1.24 | **Ordinary row, nothing entered** | **blank** | ✅ |

**A1.24 is the one that matters most.** A rule that fires on a clean row blocks the whole payroll —
one bad row stops the month for everyone.

## A2 — Recovery Total, every branch

`Total Outstanding` 40,000 · `Max Recoverable` 30,000 · `EMI Amount` 10,000 unless stated.

| # | Input | Expect | |
|---|---|---|---|
| A2.01 | `Close In Months` = 1 | 30,000 (capped at capacity) | ⬜ |
| A2.02 | `Close In Months` = 4 | 10,000 | ⬜ |
| A2.03 | `SKIP` approved | 0 | ⬜ |
| A2.04 | `PAY EXTRA` 15,000 | 15,000 | ✅ |
| A2.05 | `PAY LESS` 500 | 500 | ✅ |
| A2.06 | `ABSCOND` | 30,000 (clamped) | ⬜ |
| A2.07 | `RESIGNED`, entry 16,000 | 16,000 | ✅ |
| A2.08 | `RESIGNED`, **no entry** | = `Scheduled Amount` | 🐛 |
| A2.09 | Stage `SETTLING`, no decision | = `Scheduled Amount` | ✅ |
| A2.10 | Nothing set | blank → `Planned EMI` = EMI Amount | ✅ |
| A2.11 | `PERCENT` mode, 100 | exactly `Max Recoverable`, unrounded | 🐛 |

**A2.08 and A2.09 both route through `Scheduled Amount`, and settlement is checked LAST.** It used
to be checked first, which silently discarded `Admin Entry` in every settlement month — the
"8,200 mystery". If A2.04 ever regresses to returning `Scheduled Amount`, branch order has been
reversed again.

## A3 — Scheduled Amount

| # | Input | Expect | |
|---|---|---|---|
| A3.01 | Ordinary month, EMI 2,000, balance 20,000 | 2,000 | 🐛 |
| A3.02 | Balance 1,500, EMI 2,000 | 1,500 (capped at balance) | ⬜ |
| A3.03 | Settlement, future capacity covers it comfortably | **the regular EMI, not 0** | 🐛 |
| A3.04 | Final month, needed 25,700, capacity 34,999 | 25,700 | ✅ |
| A3.05 | Needed exceeds capacity | exactly `Max Recoverable`, unrounded | ✅ |
| A3.06 | Last working day mid-month | Sundays excluded from payable days | ✅ |

**A3.03 was a silent money bug.** Returning 0 whenever future capacity looked sufficient meant a
settlement collected nothing for two months, then needed the whole balance in a partial final
month at half capacity — manufacturing the write-off it existed to prevent.

## A4 — Planned EMI and the multi-advance cascade

| # | Scenario | Expect | |
|---|---|---|---|
| A4.01 | Single advance, ordinary row | min(EMI Amount, balance) | ⬜ |
| A4.02 | `DONT SKIP` chosen | same as ordinary | ⬜ |
| A4.03 | Two advances, entry 16,000, older owes 2,000 | 2,000 then 14,000 | ✅ |
| A4.04 | Two advances, entry exceeds both balances | each capped at its own balance | ⬜ |
| A4.05 | Balance 5,000, EMI 10,000, ordinary row | **5,000, not 10,000** | ⬜ |

**A4.05 is currently unguarded.** The ordinary branch returns `EMI Amount` raw. That was safe while
the scheduler guaranteed the final instalment equalled the balance — `PAY EXTRA` breaks that
guarantee, and the row can then ask for more than is owed.

---

# Layer B — Engine scenarios (3A)

Seed `EMI_SCHEDULE` and the Recovered Amount Ledger, run
`syncSharedEmiPayrollStatusFromRecoveredLedger`, assert the end state. **No payroll cycle needed.**

## B1 — Settlement window

| # | Scenario | Expect | |
|---|---|---|---|
| B1.01 | `RESIGNED` Jul, LWD 15 Sep | Aug `SETTLING`, Sep `FINAL`, both ACTIVE, **no write-off** | ✅ |
| B1.02 | Same, `Advance Ledger!EMI Status` | stays **ACTIVE** — the exit lock holds | ✅ |
| B1.03 | `RESIGNED` Jul, LWD 20 Jul (same month) | write off now, **one** amount, status WRITE OFF | ⬜ |
| B1.04 | `RESIGNED`, LWD **blank** | treated as same-month — no worse than before | ⬜ |
| B1.05 | `ABSCOND`, no LWD | clamped to capacity, immediate write-off | ⬜ |
| B1.06 | Window months missing from the schedule | created, stamped `AUTO` | ✅ |
| B1.07 | Rows beyond the LWD month | zeroed, WRITE OFF | ⬜ |
| B1.08 | Settlement month under-recovers | remainder absorbed by the months left | ⬜ |
| B1.09 | Re-run the sync twice | **identical result** — no duplicate rows | ⬜ |

**B1.02 is the single most important assertion in this file.** If `EMI Status` reads `WRITE OFF`
while the employee is still working, the exit lock has released, they can be marked inactive, and
their remaining wages disappear. That is the original bug this whole feature exists to prevent.

**B1.09 matters because 3B fires 3A on a timer** — it will run repeatedly against the same data.

## B2 — Early closure

| # | Scenario | Expect | |
|---|---|---|---|
| B2.01 | `PAY EXTRA` clears the balance | later rows `0` / `CLOSED` | ✅ |
| B2.02 | Same, `Settlement Stage` on those rows | `CLOSED`, **not** `FINAL` | 🐛 |
| B2.03 | Same, `Advance Ledger!EMI Status` | `CLOSED`, **not** `WRITE OFF` — nothing was lost | ✅ |
| B2.04 | Ordinary advance repaid on schedule | nothing left open | ⬜ |
| B2.05 | Balance zero, a row already carries a `Recover Amount` | left untouched — a locked record | ⬜ |

## B3 — Drift re-fit (non-settlement)

| # | Scenario | Expect | |
|---|---|---|---|
| B3.01 | `PAY EXTRA` 20,000 on a 10,000 EMI, 40,000 owed | 2 months at 10,000, surplus closed | ✅ |
| B3.02 | `PAY LESS` 500, 39,500 owed | 3×10,000 + 1×9,500, one month added | 🐛 |
| B3.03 | **`PAY EXTRA` then `PAY LESS` on the same advance** | **no gap** — no closed month mid-schedule | 🐛 |
| B3.04 | Advance never varied | **completely untouched** | ⬜ |
| B3.05 | An `ADMIN` row inside the schedule | amount preserved, others re-spread around it | ⬜ |
| B3.06 | Advance in settlement | drift pass does **not** touch it — Case B owns it | ⬜ |

**B3.04 is the regression guard for the whole pass.** It runs against every advance in the sheet;
if an untouched one moves, the drift comparison is wrong and it is rewriting schedules nobody
changed.

**B3.03 is the February bug.** A `PAY EXTRA` closed February, then a later `PAY LESS` appended
March and April *past* it — Dec, Jan, nothing, Mar, Apr. Totals correct, schedule with a hole.

## B4 — Close In Months

| # | Scenario | Expect | |
|---|---|---|---|
| B4.01 | `= 1` | every future row `0` / `CLOSED` / `ADMIN` | ✅ |
| B4.02 | `= 2`, 9,000 owed | 4,500 + 4,500, rest closed, stamped `ADMIN` | ✅ |
| B4.03 | Longer than the schedule | extra months created, stamped `ADMIN` | ⬜ |
| B4.04 | Re-run the sync | `ADMIN` rows **unchanged** — the rebalance leaves them alone | ⬜ |
| B4.05 | Plan set, balance still owing, LWD later | **no write-off booked early** | ⬜ |
| B4.06 | Two plans in different ledger months | the **later** one wins | ⬜ |

**B4.05 is the rule that is easiest to get wrong.** `Close In Months` controls when recovery stops,
never when the write-off is booked. Booking it early releases the exit lock on someone still
working.

## B5 — SKIP

**Never re-verified since the settlement work**, despite two indirect changes — the `HR Decision`
write-back in file 6, and the close-leftovers pass.

| # | Scenario | Expect | |
|---|---|---|---|
| B5.01 | `SKIP` approved | one row appended next month, same EMI Amount | ⬜ |
| B5.02 | Re-run the sync | **no second row** — ScriptProperties idempotency | ⬜ |
| B5.03 | `SKIP` on an EMI Amount of exactly 0 | writes `0`, not blank | ⬜ |
| B5.04 | `DONT SKIP` chosen | **no row appended**, normal EMI recovered | ⬜ |
| B5.05 | `SKIP` then `PAY EXTRA` clearing the balance | the appended row closes too | ⬜ |

## B6 — Data integrity

| # | Scenario | Expect | |
|---|---|---|---|
| B6.01 | `Last Working Day` from the ledger | stored as a **real Date**, not text | 🐛 |
| B6.02 | A row holding raw JS date text | self-healed to a Date | 🐛 |
| B6.03 | Balance exactly 0 | reaches the closing pass | 🐛 |
| B6.04 | `CANCELLED` advance | untouched by every pass | ⬜ |
| B6.05 | A booked write-off | never reversed by a later run | ⬜ |
| B6.06 | Two advances, one settling | the other is unaffected | ⬜ |

**B6.03 is the falsy-zero trap.** `0 || ""` is `""`, so a fully repaid advance was the one case that
could never reach the pass whose entire job is handling a fully repaid advance. That trap has now
caught this file three times.

---

# Layer C — Full chain

Expensive and **one-way** — the lock creates Drive copies, stamps `LOCK_STATUS`, and refuses a
second attempt. Each run needs a fresh month or fresh copies. Run before promoting to production,
and once naturally each real month.

| # | Scenario | Expect | |
|---|---|---|---|
| C1.01 | Clean month, no departures | identical to pre-settlement behaviour | ⬜ |
| C1.02 | Decision month, end to end | ledger gets 13 columns incl. stage, LWD, plan | ✅ |
| C1.03 | Settlement month carry-forward | attendance shows stage + LWD, both locked | ✅ |
| C1.04 | HR edits a protected `Last Working Day` | refused | ⬜ |
| C1.05 | HR types an LWD, then clicks Refresh | **the date survives** | 🐛 |
| C1.06 | Lock without running Update first | refused | ⬜ |
| C1.07 | Validate Payroll after Update, no fresh Get Payroll Data | refused | ✅ |
| C1.08 | `PAY EXTRA` through the lock | validation cleared, value written | 🐛 |
| C1.09 | Two-advance employee with `PAY EXTRA` | lock **not** blocked by the consistency precheck | ⬜ |
| C1.10 | Fresh attendance file from the template | Month reads `August_2026`, not `8/1/2026` | 🐛 |
| C1.11 | Same attendance file locked twice | refused | ⬜ |
| C1.12 | Ledger push for a file already pushed | skipped, no duplicates | ✅ |

---

# Coverage gaps worth naming

**Never tested at all:**

- The entire `SKIP` path since the settlement work (B5)
- A withdrawn resignation — no scenario, and no code path either. The workaround is cancel and
  reschedule; that has never been walked.
- `PAY EXTRA` on a multi-advance employee (C1.09). The consistency precheck and `Alert` used to
  contradict each other here; the fix is committed but unproven.
- Idempotency generally (B1.09, B4.04, B5.02) — 3B fires 3A on a timer, so every path runs
  repeatedly against the same data. Anything not idempotent will duplicate silently.

**Tested once, by accident:**

Most of the 🐛 rows. They were found by a human noticing something looked wrong, not by design.
Each one is now a permanent regression case — that is the point of writing them down.

**Deliberately out of scope**, raised and set aside: full & final settlement, the 50% statutory
deduction ceiling, and perquisite tax on interest-free advances.
