# salary-advance-master/

Manages employee salary-advance EMI (installment) lifecycles: schedule creation, a local Employee Master mirror, and reconciliation of HR recovery/write-off decisions against the EMI schedule. See root [CLAUDE.md](../CLAUDE.md) for cross-cutting principles — **this module is where the `|| ""` falsy-zero bug the root file warns about actually lives** (see below).

## Files

- `0_WebApp.gs` — `doPost` router, the user constants and `callEmiWebApp_()`. This is the module's shared-infrastructure file; anything referenced "from nowhere" in the others is almost certainly declared here.
- `1_Advance_EMIScheduler.gs` — creates/cancels EMI schedules from the Advance Ledger. `cancelEMI_Core_` gained blocking guardrails (v5); `scheduleEMI_Core_` gained the eligibility gate (v6) — see below.
- `2_EmpMasterSync.gs` — mirrors Employee Master into a local `EMP master` tab. Also builds the whole `Master` menu, including the item handled by file 4.
- `3A_Master_SharedEMILockSync.gs` — reconciles HR decisions (recover/write-off) from the Recovered Ledger into the EMI schedule and locks payroll status.
- `3B_RecoveredLedgerWatcher.gs` — polling watcher that triggers 3A only when the Recovered Ledger actually changed.
- `4_SalaryMasterSync.gs` — mirrors the **active** salary out of Salary Revision History into a local `SALARY master` tab.
- `5_AdvanceEligibility.gs` — the advance-eligibility gate (net salary + one year of service) and the HTML result dialog.
- `6_RemoveRequestRows.gs` — lets HR/Finance delete their own un-scheduled requests past the sheet protection.

> **In the sandbox only:** `7_SalaryMasterWatcher.gs` (a hash watcher that rebuilds `SALARY master` when Salary Revision History changes) and a shared `withEmiLock_` script lock around the three Cores. Neither has been brought here — see the verification table at the end. In production, `SALARY master` is refreshed by hand from the `Master` menu.

### Cross-file dependencies worth knowing

Apps Script gives every file in a project one shared global scope, so these are invisible until something moves:

- Files **5 and 6** call `findLastDataRowByColumn_` and `ensureTargetHasRows_`, which are declared in **`2_EmpMasterSync.gs`** — a file about Employee Master. Nothing to do with either caller.
- Files **4, 5 and 6** call `str_`, `num_`, `req_`, `opt_`, `getHeaderMap_` and `stamp_` from **`1_Advance_EMIScheduler.gs`**.
- `req_` and `addMonths_` are each declared **twice** — in files 1 and 3A. The two definitions are semantically identical, so whichever loads last wins harmlessly. Pre-existing; left alone deliberately, but don't let them drift apart.

## EMI scheduling (`1_Advance_EMIScheduler.gs`)

- `scheduleEMI_FromAdvanceLedger()` / `cancelEMI_ByReference()` — dual-actor gated menu entries.
- `scheduleEMI_Core_(ss, allowExceptions)` — **two-phase, all-or-nothing for field validation**: Phase 1 validates every eligible Advance Ledger row (Status=ACTIVE, Advance Amount>0, Tenure>0, EMI Start Month, Advance Paid Month, no existing ref) before any writes; Phase 2 builds and appends EMI rows. As of `v4` (below), a *conflicting* employee is skipped rather than aborting the whole batch — the all-or-nothing guarantee now applies only to field-validation failures, not to active-EMI conflicts.
- EMI amount = ledger value if present, else `ceilingTo_(advanceAmount/tenure, 100)` (rounded up to nearest 100). Generates `tenure` monthly rows, decrementing a running balance, capping each installment at the remaining balance, and forcing the final installment to whatever balance is left so the total exactly equals the advance amount.
- `cancelEMI_Core_(ss, emiRef)` — sets status to `CANCELLED` or `CANCELLED & GOT PAID` based on Recovered Amount; deletes matching Shared EMI Summary rows only if Payroll Status is blank. Correctly guards zero with `recoveredAmtForRef && recoveredAmtForRef > 0` — contrast with the bug in 3A below.
- `refreshEmiScheduleProtection_()` — single named-range protection `EMI_SCHEDULE_PROTECTION` on Advance Ledger `A2:L{lastRow}`, PMO-only.

### Duplicate-active-EMI handling — v3 → v4

> **Note:** the text below describes v4 as TEST-only. It is not, and has not been since
> commit `72c3178 feat(salary-advance): skip conflicting employees instead of aborting EMI
> run` — this file has carried v4 ever since. The sandbox's notes said otherwise for months;
> caught by reading `git log` here during the v6 migration. A reminder that these documents
> are orientation, not ground truth.

**v3** (found live in the TEST project, 2026-07-26, with **no trace in this git repo at all** until this session): a pre-scan built a Set of employee codes already carrying `EMI Status = ACTIVE` in the ledger; any newly-eligible row (Employee Code present, no ref yet) matching that Set caused the **entire run to abort** with a named blocker list, before Phase 1 field-validation even began.

**v4** (this session, requirement changed, **TEST environment only** — production's copy of this file is untouched and still needs this decision made separately):

- Conflicts are now **skipped, not aborted**. Every other eligible employee in the same run still gets scheduled.
- `scheduleEMI_FromAdvanceLedger()` calls a new read-only function, `scheduleEMI_FindActiveEmiConflicts_(ss)`, **before** routing to Core or the Web App. This runs client-side for **both** pmo@ and nazneen@ — this wrapper always has a real `ui`, since it's invoked directly from the open spreadsheet's menu regardless of who clicked it. (The actual privileged *write* still goes through the Web App for nazneen@, unchanged — only the read-only pre-check runs directly.)
- If conflicts exist, **one combined `ui.alert` (Yes/No)** lists every conflicting employee together with their existing active EMI Reference Number, and asks whether to schedule new EMIs for them anyway.
- Yes → all conflicting employees are passed through as an `allowExceptions` list (array of Employee Codes). No → the list stays empty and those employees are skipped.
- `scheduleEMI_Core_(ss, allowExceptions)` stays **UI-free**, per its original design comment — the dialog only ever lives in the menu wrapper. Any employee still conflicting and not in `allowExceptions` is skipped in both Phase 1 and Phase 2; the result message names who was skipped and why.
- `scheduleEMI_BuildActiveEmiConflicts_(ledVals, ledDisp, L, emiStatusIdx0)` is a new **shared, pure helper** — used by both the pre-check and Core, so the two can never disagree on what counts as a conflict.
- `0_WebApp.gs`'s `scheduleEMIServer_` now reads `payload.allowExceptions` and passes it straight through to Core — it stays a thin relay, no UI, no new logic.
- **Not yet tested against real ledger data** — pushed live via clasp, `envSelfTest()` confirms the project runs, but the Yes/No flow itself hasn't been exercised with an actual conflicting employee.

## Employee Master sync (`2_EmpMasterSync.gs`)

`syncEmpMaster_Core_()` pulls `A:AB` from the external Employee Master (by GID), upserts into local `EMP master` by Employee Code (col B). Update-or-append only — never deletes.

## Shared lock sync (`3A_Master_SharedEMILockSync.gs`) — the settlement cycle

**Substantially rewritten 2026-08-17.** This is now the largest file in the module and the place
where the salary-advance settlement actually happens. Full design and rationale in
[_docs/salary-advance-settlement-plan.md](../_docs/salary-advance-settlement-plan.md) — read it
before changing anything here.

`syncSharedEmiPayrollStatusFromRecoveredLedger()`, in order — **6 passes as of 2026-08-18**, up
from 4:

1. **Lock** `Shared EMI Summary` → `Payroll Status` (only where blank) when a matching Recovered
   Ledger row exists.
2. **Sync** `HR Decision`, `Recover Amount`, `Settlement Stage`, `Last Working Day` and
   `Close In Months` from the ledger into `EMI_SCHEDULE`, then `flush()` so `Current Balance` (an
   ARRAYFORMULA over Advance Ledger) recalculates before it is read back as the residual.
3. **HR Decision post-actions.** `SKIP` appends one row next month (idempotent via
   `SKIP_EXTENDED_V4::<ref>::<month>::<emp>`). `RESIGNED`/`ABSCOND` run the settlement logic below.
   A reference already marked `CANCELLED` is skipped entirely before this branches — see Cancel
   EMI, below.
4. **(3a2) Book the write-off** once the last-working-day month has itself been paid. **New
   2026-08-18** — see "The write-off that never ran," below.
5. **(3b) Close leftover months** once an advance is fully repaid — for *every* reference, not only
   settlements, because `PAY EXTRA` or a compressed schedule can clear a balance early.
6. **(3c) Apply `Close In Months`**, then **(3d) re-fit a non-settlement schedule** that has
   drifted from `PAY EXTRA`/`PAY LESS`. Both new 2026-08-18 — see below.

### The settlement rule

One rule, two branches, keyed on `Last Working Day`:

- **No month left** (LWD in or before the decision month, or blank) → settle now. **One**
  write-off, booked once, for the real outstanding balance — not a per-row sum of scheduled
  instalments. Stage `FINAL`, status `WRITE OFF` or `CLOSED`.
- **Months remain** → hold the window `(decision month → LWD month]` open as `ACTIVE`, stamped
  `SETTLING` / `FINAL`, creating any missing months. **Nothing is booked into `WRITE OFF AMOUNT`.**
  The LWD month later re-enters the first branch on its own run and books the final write-off.

**Booking a write-off is what releases the Employee Master exit lock** — `Advance Ledger!EMI
Status` keys off `SUMIF(EMI_SCHEDULE!K:K)`, the write-off *amount*, not off `HR Decision`. So
nothing may book one while an employee is still working. This is the whole point of the feature;
the original bug was that recording a resignation closed the advance on paper, which unlocked the
record, which let HR set D.O.L, which deleted their notice-period wages.

### The write-off that never ran (fixed 2026-08-18)

Case A only fires on a row carrying an HR Decision, and only the *decision* month ever has one —
every settlement month is deliberately left blank so HR never re-declares a departure. So 3A kept
comparing the last working day against the decision month forever, always concluded "months
remain," and took Case B again — **the write-off that ends a settlement had never executed at
all.** Went unnoticed because both cases walked in testing (Kareem, Bhavani) cleared their balance
early and were tidied by (3b) instead; the path only matters when someone leaves still owing money,
which is the case this feature exists for.

**(3a2)** now detects it per row instead of per decision: a row whose own month **is** the
last-working-day month, whose payroll has already run (`Recover Amount` non-blank — which is why
storing a recovery of exactly `0` as `"0"` rather than blank was a prerequisite, not a tidy-up),
and which still leaves a balance. Booked once; a row already carrying a write-off is skipped, so
the timer-driven re-runs are harmless.

### `Last Working Day` may only move EARLIER (2026-08-21)

One reference carries **one** date — the **earliest** ever recorded for it (`lwdByRef`, built
from the ledger). Pass (2) no longer writes it row by row from each row's own ledger entry; it
normalises the whole column per reference afterwards.

- **Brought forward** (he leaves sooner than declared) → **applied**, and the window compresses.
  Refusing this was a real bug: months past the true departure stayed `ACTIVE` waiting for a
  payroll that never runs, so nothing recovered, no write-off booked — and since booking the
  write-off releases the Employee Master exit lock, **the advance could never close.**
- **Pushed back** (notice extended) → **refused**, and `console.error`'d naming both dates.
  Owner's decision: extending after a settlement opens re-spreads the balance over more months
  and cuts each instalment on nothing but the employee's word; if they then abscond the shortfall
  is unrecoverable.

Before this, **both** directions were silently ignored — the forward correction because pass (2)
only wrote into a blank cell and Case B had already stamped the whole window, and the backward one
by the same accident rather than by any rule. Nobody was told either way.

Editing `EMI_SCHEDULE` directly is not a supported route: the column is re-normalised from the
ledger on every run. A correction must arrive on a later month's ledger row.

### One write-off per reference, ever (2026-08-21)

`writtenOffRefs` is built from `WRITE OFF AMOUNT` before the decision loop. Case A used to check
only the row it was standing on, so a second decision row arriving later booked a **second**
write-off for the same balance while the first was still on the sheet — the balance forgiven
twice, and the exit lock released off the earlier one. (3a2) now shares the same set.

### `CLOSED`, not `WRITE OFF`, for months that cannot happen (2026-08-21)

Rows beyond the last working day (Case A and Case B) are emptied to 0 and marked **`CLOSED`**.
They carry no write-off amount — nothing is forgiven on them. Labelling them `WRITE OFF` made a
compressed window read as a repeated forgiveness. (3c)'s `statusFor` already used `CLOSED` for the
identical situation, so the two disagreed for no reason. Nothing keys off `Status` for the exit
lock — `Advance Ledger!EMI Status` sums the write-off *amount* column — and (3d) skips settlement
references, so a `CLOSED` row here cannot be reused by the drift re-fit.

### `Amount Set By` — AUTO / ADMIN

New `EMI_SCHEDULE` column, script-written only (no dropdown; the admin never edits that sheet).
An `ADMIN` row's amount is taken off the top and only `AUTO` rows share out what remains, so a
month the admin pinned via `Close In Months` survives every later rebalance. Rows the settlement
cycle and the (3d) drift re-fit create are stamped `AUTO`; rows a `Close In Months` plan creates
are stamped `ADMIN`.

### `Close In Months` is a fixed window, not a slot count (fixed 2026-08-18)

The window is derived — `planEnd = addMonths_(plan.monthDate, plan.n - 1)` — **not** counted as
`slots = plan.n - 1` against however many months happen to still be open. The counted version was
not idempotent: the ledger row carrying the plan never expires, 3B fires this on a timer, and each
run found one fewer open month than the plan wanted (the previous month had just recovered) and
**invented a new one**. A 3-month plan set in November produced a March row, then April, then May
— each further past the actual last working day, halving the instalment each time. Confirmed live
on BUT-039 before the fix.

The last-working-day month is a special case inside this pass: **emptied to 0 but never closed**
while a balance is still owed, because it is the row (3a2) needs to book the write-off in. Closing
it (the original bug) stranded the employee — no month left to recover from, no month left to write
off, exit lock held forever.

### Case B and (3c) both round the balance across the window evenly

For N slots, `perMonth = ceilTo100_(spread / slots)`, running months first and the **last** month
absorbing whatever is left — the same convention the EMI scheduler already uses when it first
creates an advance. Before 2026-08-18, Case B gave every month the rounded-up figure (25,000 over 3
months scheduled 25,200) — no overcharge, since `Planned EMI` caps at the balance, but the sheet
did not add up.

### (3d) — re-fitting a schedule that drifted from PAY EXTRA / PAY LESS (added 2026-08-18)

`PAY EXTRA`/`PAY LESS` change what was recovered without changing what is still scheduled — Case B
only rebalances **departures**, so a continuing employee's future rows stayed at the original
figure and stopped adding up to the balance. (3d) keeps the instalment and changes the **number of
months**: paid extra closes surplus months, paid less appends one, mirroring how a part-payment
against a normal loan works. Runs *only* where the scheduled total and the balance actually
disagree — a no-op on every advance nobody has varied.

Two bugs found live before this stabilised, both now fixed:

- **A month (3d) had zeroed and `CLOSED` on an earlier run couldn't be reused** — the pass
  originally skipped any row not blank/`ACTIVE`, so a later `PAY LESS` appended a brand-new month
  *past* the closed one instead of reopening it, leaving a hole (Dec, Jan, *nothing*, Mar, Apr).
  `CLOSED` is not terminal when this pass is what set it; only `CANCELLED`/`WRITE OFF` are.
- **SKIP and (3d) could append the same month in one run.** (3d) reads the in-memory arrays, which
  do not contain the row SKIP has just queued — so the schedule looked one instalment short and
  (3d) appended it again. Two `ACTIVE` rows, one reference, one month; `13_SalaryAdvance.gs` has no
  dedupe by ref, so **double** the instalment would have been deducted. Only became reachable once
  a recovery of `0` was stored as `"0"` rather than blank — see the falsy-zero note below. A
  `skipRefs` guard, same shape as the existing `settlementRefs`/`closeInByRef` exclusions, fixed it.

### Cancel EMI guardrails — v5 (2026-08-18)

`cancelEMI_Core_` (in `1_Advance_EMIScheduler.gs`) previously stamped **every** `EMI_SCHEDULE` row
for a reference `CANCELLED` unconditionally, with no check on what had already happened to the
advance. Now:

- **Refuses outright, before writing anything**, if any row for the reference already carries
  `HR Decision = RESIGNED`/`ABSCOND` (employee marked as leaving), `HR Decision = PAY EXTRA`/
  `PAY LESS`/`SKIP` (a decision already approved once), or `Amount Set By = ADMIN` (a
  `Close In Months` plan active). **Permanent** — once true for a reference, cancel refuses
  forever, not only while the condition is current.
- **When it does proceed, only untouched rows are stamped.** A row already carrying a
  `Recover Amount` or a `Write Off Amount` is a locked record and keeps its Status — cancel no
  longer rewrites history.
- The matching other half lives in *this* file: the decision loop skips any reference already
  `CANCELLED` before touching it (a `cancelledRefs` set), so a stale ledger entry can never flip a
  cancelled reference's rows back to `WRITE OFF`/`CLOSED` on a later run.

### Non-obvious things in this file

- **`Close In Months` arrives via the ledger, not from the workings file.** It was first built into
  `5A.Update Salary Advance` writing straight into `EMI_SCHEDULE` — wrong twice: it inverts
  ownership of the master, and 5A writes at *Update*, before the lock, so an abandoned month left
  `ADMIN` rows behind for a decision never committed. Behind the lock that window does not exist.
- **Appends are written column by column**, unlike the older SKIP append which writes a full-width
  row. `Current Balance` is an ARRAYFORMULA anchored at row 2; writing a blank into its spill range
  would break the column. (The SKIP append still does this — see Known risks.)
- **A booked write-off is never reversed.** Case B skips any row with `WRITE OFF AMOUNT > 0`,
  which is what stops an earlier decision row, processed later in the loop, re-opening a month that
  was already concluded.
- **`Last Working Day` is kept as a real `Date`**, read with `getValues()` not
  `getDisplayValues()`. The self-heal check asks whether the cell **is** a Date, not whether it
  holds the right day — raw JS date text parses to the correct date, so a value comparison would
  call it correct and leave it there forever.
- **The falsy-zero trap has bitten this file four times now.** Most recently the ledger read of
  `Recover Amount`: `String(row[R.recoveredAmt] || "").trim()` turned a genuine `SKIP` recovery of
  `0` into blank, and four passes read a blank `Recover Amount` as "not recovered yet, still
  available" — which is also what let SKIP and (3d) append the same month (above). Use
  `numOrZero_` / `strOrBlank_`; never `|| ""` on a numeric read, ever, in this file.
- **An out-of-range `Last Working Day` is frozen, loudly, not silently.** A bare spreadsheet serial
  parses as `new Date("46266")` → the year 46266; any reference whose LWD is more than 4 months
  past its decision month is skipped entirely and a `console.error` names the reference. A genuine
  notice period longer than 4 months would also be frozen here — that threshold is a judgment call,
  not a hard rule; revisit if a real one ever comes up.

## Advance eligibility gate — v6 (2026-08-24)

Schedule EMI refuses an advance the employee cannot repay. Logic lives in
`5_AdvanceEligibility.gs`; `1_Advance_EMIScheduler.gs` only calls it and reports.

**Two rules, deliberately with different politics.**

| | Rule | Overridable? |
|---|---|---|
| **AMOUNT** | Advance Amount + the employee's existing **ACTIVE** advance balances ≤ his **NET SALARY** | **No.** No parameter, payload field or dialog answer anywhere in the module can schedule one |
| **TENURE** | D.O.J + 1 year reached **as of today** | **Yes**, via one combined Yes/No dialog, and the override is stamped onto the ledger row |

- The ceiling is **floored to a multiple of 500** (`ADV_ELIG_ROUND_TO`) — an advance is paid
  as cash, so 34,999 is not a real figure. Rounding **down** is the safe direction: it can
  only refuse money the unrounded rule would allow. Residual headroom under 500 floors to 0
  and blocks outright.
- **This must match `Advance Ledger!I2`'s `FLOOR(..., 500)`.** Two independent
  implementations of one rule; change both or neither. If they disagree, HR is shown one
  ceiling and refused at another, which reads as the gate malfunctioning.
- **The gate never reads columns I/J.** Those formula columns exist so HR sees the ceiling
  while typing. A formula cell can be stale, pasted over, or on `#REF!`, and none of that may
  decide whether money is released — everything is recomputed from `SALARY master`,
  `EMP master` and the ledger's own balance columns.
- **Multiple new advances in one run are judged together.** A candidate row has no EMI
  Reference, so its own `EMI Status` is blank and it is never counted as an existing ACTIVE
  balance — correct for one row, but two would each pass alone while together exceeding
  salary. Approved amounts accumulate into `pendingByEmp` and are charged against every later
  candidate row for the same employee.
- **A row failing BOTH rules is reported as un-overridable and never offered in the tenure
  dialog.** Approving that override would change nothing — the amount branch skips him
  regardless — so asking would invite an approval that silently does nothing. This was a real
  bug caught by the test suite before it ever ran.
- **Missing ≠ zero.** An employee absent from `SALARY master` is blocked as "no salary on
  record". A recorded net salary of `0` is a genuine ceiling of zero. `num_()` cannot express
  that difference, which is why the raw cell is inspected before conversion.
- **A bare spreadsheet serial is refused as a D.O.J** — `new Date("46266")` yields the year
  46266, the same trap 3A guards against on Last Working Day. An absurd year would make a new
  joiner look like a veteran, so anything outside 1950–2200 is treated as *no* D.O.J, which
  blocks rather than passes.
- Result is shown in an **HTML modal**, not `ui.alert` — that API renders plain text in a
  proportional font and can neither emphasise a heading nor hold the Requested/Eligible/Over
  by figures in a column. Falls back to `ui.alert` if the modal cannot open.

### Two hardcoded Advance Ledger ranges fixed at the same time

Neither auto-adjusts when a column is inserted, because neither is a live formula in a cell:

- `EMI_SCHEDULE_CURRENT_BALANCE_FORMULA` read `'Advance Ledger'!N:P`. That was **already
  wrong** against the live sheet's `O:Q` before any of this — dormant only because it fires
  solely when `EMI_SCHEDULE` has zero data rows. Now `Q:S` for the post-insert layout.
- `refreshEmiScheduleProtection_` protected 12 columns (`A:L`). The insert pushed the same
  logical span to `A:N`, so it is now 14.

**Both are correct only for the post-insert sheet.** Re-check them on any future column change.

## `SALARY master` (`4_SalaryMasterSync.gs`)

Mirrors `REVISION_HISTORY` rows with `ACTIVE_FOR_PAYROLL = ACTIVE` into a local tab, columns
A:N verbatim — the two tabs carry identical headers in identical order, though every lookup is
still by header name on both sides.

- **A rebuild, not an upsert** — deliberately unlike `2_EmpMasterSync.gs`. An employee whose
  ACTIVE row disappears must not keep a stale salary, because a stale salary silently *raises*
  his advance ceiling.
- **Column O (`NET SALARY`) is never touched** — it is an ARRAYFORMULA anchored at O2, and the
  sync throws if any copied column is not strictly left of it.
- `NET SALARY` = Gross − PF − ESI − PT, replicating `PAY_ROLL`'s own formulas: PF for everyone
  (`(Basic+DA) ≥ 15000 ? 1800 : 12%`), ESI for **workers only**, PT off the slab table. No TDS,
  no LWF. **These duplicate the payroll sheet's statutory formulas** — a rate change has to be
  made in both places.
- Duplicate ACTIVE rows for one `ID.NO` are a source data error. First wins (matching what
  `VLOOKUP` would return) and every duplicate is **named in the result message**.
- Row count is taken off `ID.NO`, never `getLastRow()` — `REVISION_HISTORY!AADHAAR NO` is a
  whole-column `MAP()` spill that stamps `""` down the column and inflates it.

## Remove Request Rows (`6_RemoveRequestRows.gs`)

Menu: `Advance → Remove Request Rows (selected)`. Exists because `Advance Ledger!A2:N` is
protected with pmo@ as sole editor, so HR cannot clear their own un-scheduled requests by hand.

- **A row carrying an EMI Reference Number is never removable.** `EMI_SCHEDULE` rows and
  recovery history point at it; use Cancel EMI instead.
- **All-or-nothing.** One bad row in the selection deletes nothing — deletion is irreversible
  and a Web App run has no undo, so a wrong selection must be corrected by the person.
- Selection is read **client-side** (`getActiveRangeList()` does not exist in a Web App
  request) and travels as row numbers, which Core treats as a *suggestion*: it re-reads and
  re-validates every one from the sheet. Minutes can pass between the dialog and the run, and
  somebody may have scheduled one of them meanwhile.
- ⚠️ **Row 2 is the ARRAYFORMULA anchor for thirteen columns.** `safeRemoveAdvanceRow_`
  mirrors `attendance/08_RemoveInactiveEmployee.gs`'s `safeRemoveEmployeeRow_` — delete
  directly below row 2; for row 2 copy row 3 up then delete row 3; if row 2 is the only data
  row, clear it and leave it standing. **It may NOT be copied verbatim from there**: that
  sheet's `A:H` are plain values so its block `copyTo` is safe, whereas here a block copy would
  write row 3's spilled values over B, C, D, E, F, I, J, O, R, S, T, U and V — replacing every
  Name, Eligible Amount, Balance Amount and EMI Status on the sheet with static text. This
  copies **input columns only, one at a time, by header name**.
- Every removal is recorded in a **`Removed Requests`** tab, created on first use. If it is
  created by hand instead, the headers must match exactly — the append writes by position.
- **Never run against a real sheet in either environment.** Unit-tested only.

## Web App authorisation — per action

`EMI_ACTION_ALLOWED_` in `0_WebApp.gs` maps action → allowed callers. It replaced a single flat
"are you nazneen@?" check, because hrassist@ needed exactly two actions and a second flat
constant would have handed over all five.

| Action | nazneen@ | hrassist@ |
|---|---|---|
| `scheduleEMI` | ✅ | ✗ |
| `cancelEMI` | ✅ | ✗ |
| `syncEmpMaster` | ✅ | ✅ |
| `syncSalaryMaster` | ✅ | ✗ |
| `removeRequestRows` | ✅ | ✅ |

**Fails closed**: an action absent from the map is denied, so adding a new `case` to the switch
blocks everyone until it is listed. pmo@ never appears — the owner runs Core directly.

`syncSalaryMaster` is withheld from hrassist@ deliberately: refreshing `SALARY master` moves the
ceiling the gate enforces, so it stays with the people who own the limit rather than the people
requesting against it. **Consequence:** if a revision is approved and nobody refreshes, HR is
held to a stale ceiling and cannot fix it themselves — somebody with access has to run
`Master → Refresh Salary Master`. The sandbox answers this with an hourly hash watcher that
has not been brought here yet.

**Every menu wrapper has a matching client-side check.** That one is convenience — it stops the
menu erroring for an unauthorised user. The map is the gate.

## Known risks

- **The SKIP append still writes a full-width row**, including a blank into `Current Balance`'s
  ARRAYFORMULA spill range. Verified intact in the live sheet as of 2026-08-17, so it has not bitten
  — but if column G ever goes `#REF!`, that is where to look.
- **The `SKIP` path has still not been re-verified end to end** in the live sandbox since the
  settlement work, despite several indirect changes to it since. It has been executed against the
  Node engine harness (`_tests/run-engine.js`, scenario S5) and passed there — see Testing, below —
  but never walked through Sheets with real formulas and real timing.
- **A genuine notice period longer than 4 months would be silently frozen** by the LWD guard above
  (loudly logged, but nothing in the UI surfaces it to an admin). Revisit if this becomes real.

## Watcher (`3B_RecoveredLedgerWatcher.gs`)

`watchRecoveredLedgerAndSyncLocks()` hashes (MD5+base64) the full used-range of Recovered Amount Ledger, compares to `ScriptProperties` key `RECOVERED_LEDGER_HASH_V1`, and only calls 3A's sync when changed. `seedRecoveredLedgerHash()` is a manual one-time seed to avoid a spurious first run.

## Config

- Sheets: `Advance Ledger`, `EMI_SCHEDULE`, `Shared EMI Summary`, `EMP master`, `Recovered Amount Ledger`, **`SALARY master`**, **`Removed Requests`**.
- **`Advance Ledger` gained four columns (2026-08-24)** and every letter from I rightward moved:

  | | Before | After |
  |---|---|---|
  | I, J | Advance Amount, Tenure | **Eligible Amount, Eligibility Status** (formulas) |
  | Advance Amount | I | K |
  | EMI Reference Number | O | **Q** |
  | Balance Amount | Q | **S** |
  | EMI Status | S | U |
  | — | — | **Y, Z: Eligibility Override By / On** (script-written) |

  Sheets auto-adjusted the live cross-sheet formulas on insert; the two **hardcoded** ranges in
  code did not, and were fixed by hand (above). `EMI_SCHEDULE!Current Balance` is
  `VLOOKUP(…,'Advance Ledger'!Q:S,3,FALSE)` — **check it on any future column change.**
- **`SALARY master` is A:O**: `ID.NO · NAME · CATEGORY · DEPARTMENT · DESIGNATION · BASIC · DA ·
  TOTAL · HRA · CONV.ALL · SPL.ALL · GROSS · CHANGE OF VALUE · EFFECTIVE_FROM · NET SALARY`.
  A:N script-written, O a formula.
- **`Removed Requests` is 12 columns**, written by position, not by header name — if the tab is
  created by hand the order must match exactly (see file 6).
- **`EMI_SCHEDULE` columns (2026-08-17)**: Month · Employee Code · Name · Department · EMI Reference Number · EMI Amount · Current Balance *(formula)* · Status · HR Decision · Recover Amount · WRITE OFF AMOUNT · WRITE OFF TIME STAMP · Settlement Stage · Last Working Day · **Amount Set By**.
- **`Recovered Amount Ledger` is 13 columns**, ending `… HR Decision | Recovered Amount | Settlement Stage | Last Working Day | Close In Months`. Written by `payroll-generator/8.RecoveredLedgerPush`, which resolves every destination by header name — reorder freely, but a missing header throws.
- **`Shared EMI Summary` stays at 9 columns** and must not be widened. It is a snapshot/dedup cache, and four functions plus both attendance buttons share its fixed tuple. Settlement data is read from `EMI_SCHEDULE` directly instead.
- **`Status` values in play**: `ACTIVE` (the only one `attendance/13_SalaryAdvance.gs` will pull), `CLOSED`, `WRITE OFF`, `CANCELLED`, `CANCELLED & GOT PAID`.
- **`Settlement Stage` values**: `SETTLING`, `FINAL`, `CLOSED`.
- `EMP_SRC_SPREADSHEET_ID = "1yqQ-edwQzZd0pAlaXCAAZt88MbsHfCf4hCcxti4ojCw"`, GID `1874110664`.
- ScriptProperties keys: `SKIP_EXTENDED_V4::` prefix, `SETTLEMENT_OPENED_V1::` prefix (traceability only — settlement rows are idempotent by existence check, so a deleted month is legitimately recreated), `RECOVERED_LEDGER_HASH_V1`.
- Month format convention throughout: `"MMMM_yyyy"`; `normMonthKey_()` also strips an `"ATTENDANCE_"` prefix, implying some month-key values originate from the Attendance module's naming convention.

## Dependencies

- Employee Master (external, hardcoded ID/GID) — mirrored, not live-read, into `EMP master`.
- No direct code reference to [payroll-generator/](../payroll-generator/CLAUDE.md) or [attendance/](../attendance/CLAUDE.md) in these four files, but `payroll-generator`'s Generate Locked Payroll stage pushes into this module's Recovered Amount Ledger (`glpPushRecoveredLedgerSnapshot_`), which is what 3B/3A react to.

## Testing (added 2026-08-18)

A Node test harness lives at repo root under `_tests/` — not part of this module, but this module
is almost everything it covers. `_tests/cases/salary-advance.md` is the scenario register (read it
before assuming a behaviour is proven); `_tests/RESULTS.md` is the latest run's output.

- `_tests/run.js` — loads `3A_Master_SharedEMILockSync.gs` into a `vm` sandbox and executes its
  genuinely pure helpers (`numOrZero_`, `ceilTo100_`, `toRealDate_`, etc.) directly. 74 assertions.
- `_tests/run-engine.js` — a real in-memory emulation of the Sheets *platform* (no business rules
  of its own) so `syncSharedEmiPayrollStatusFromRecoveredLedger` runs **unmodified** against plain
  arrays. This is what actually caught the `Close In Months` idempotency bug, the SKIP/(3d)
  duplicate month, and confirmed the write-off fix — as concrete failing assertions, not by
  reading the code and reasoning about it. 81 assertions as of the last run.
- `_tests/run-eligibility.js` — the v6 gate (60 assertions). Its readers and clock are replaced
  with fixtures; the arithmetic, the ACTIVE filter, the accumulation and the overridable /
  un-overridable classification are the real code.
- `_tests/run-remove-rows.js` — Remove Request Rows (46). `sheets.js` was taught `deleteRow`,
  `copyTo` and `clearContent`, and now **models the loss of ARRAYFORMULA anchors when row 2 is
  deleted** — without that, a naive `deleteRow(2)` passed.
- All run in seconds with `node _tests/<file>.js`. No npm install, no framework — plain Node,
  plain assertions. **261 assertions across four suites** as of 2026-08-24. (The sandbox has a fifth, for the watcher and the lock.)
- **Every new suite is mutation-checked**: the rule is deliberately broken and the suite must go
  red. A suite that passes against broken code is decoration. Results are in the commit
  messages; re-run them after any change here.
- **Rule for writing new cases**: derive the expected result from the register/plan doc, never
  from what the code currently does. A test written from the implementation only confirms the
  implementation, including where it is wrong — which is exactly how the `Close In Months` bug
  would have been enshrined instead of caught.
- Still gaps: Layer C (the full payroll lock chain) has no harness and still needs a real monthly
  cycle. `SKIP` is executed in the engine harness but not yet walked live end to end.

## What is actually verified, and where (2026-08-24)

Read this before trusting anything above as "working".

| | Status in production |
|---|---|
| Eligibility gate (v6) | pushed via clasp, **not yet run against real data here** |
| `SALARY master` + sync | pushed, not yet run |
| Remove Request Rows | pushed, **never run in either environment** |
| Watcher / shared lock | **absent** — sandbox only, by design |

- **The Web App has NOT been redeployed.** `clasp push` saves script content; it does not
  redeploy. Until someone does it by hand, nazneen@ and hrassist@ hit the old deployment — no
  eligibility gate on their Schedule EMI, and `removeRequestRows` answers "Unknown action".
  pmo@'s menu path is unaffected and always runs the latest saved code.
- Sheet prerequisites are applied: `SALARY master`, the two inserted columns with their
  formulas, the override columns, `Removed Requests`.
- The v6 gate was exercised against real ledger data **in the sandbox**, not here. The first
  production run is still the first production run.
