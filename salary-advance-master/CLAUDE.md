# salary-advance-master/

Manages employee salary-advance EMI (installment) lifecycles: schedule creation, a local Employee Master mirror, and reconciliation of HR recovery/write-off decisions against the EMI schedule. See root [CLAUDE.md](../CLAUDE.md) for cross-cutting principles — **this module is where the `|| ""` falsy-zero bug the root file warns about actually lives** (see below).

## Files

- `1_Advance_EMIScheduler.gs` — creates/cancels EMI schedules from the Advance Ledger.
- `2_EmpMasterSync.gs` — mirrors Employee Master into a local `EMP master` tab.
- `3A_Master_SharedEMILockSync.gs` — reconciles HR decisions (recover/write-off) from the Recovered Ledger into the EMI schedule and locks payroll status.
- `3B_RecoveredLedgerWatcher.gs` — polling watcher that triggers 3A only when the Recovered Ledger actually changed.
- **Note**: `EMI_PMO_USER_`, `EMI_ALLOWED_USER_`, `callEmiWebApp_()`, and `SALARY_ADVANCE_MASTER_SPREADSHEET_ID` are referenced throughout but declared in a `0_WebApp.gs` file not present in this listing at research time — check for it before assuming those permission gates are self-contained here.

## EMI scheduling (`1_Advance_EMIScheduler.gs`)

- `scheduleEMI_FromAdvanceLedger()` / `cancelEMI_ByReference()` — dual-actor gated menu entries.
- `scheduleEMI_Core_(ss)` — **two-phase, all-or-nothing**: Phase 1 validates every eligible Advance Ledger row (Status=ACTIVE, Advance Amount>0, Tenure>0, EMI Start Month, Advance Paid Month, no existing ref) before any writes; Phase 2 builds and appends EMI rows.
- EMI amount = ledger value if present, else `ceilingTo_(advanceAmount/tenure, 100)` (rounded up to nearest 100). Generates `tenure` monthly rows, decrementing a running balance, capping each installment at the remaining balance, and forcing the final installment to whatever balance is left so the total exactly equals the advance amount.
- `cancelEMI_Core_(ss, emiRef)` — sets status to `CANCELLED` or `CANCELLED & GOT PAID` based on Recovered Amount; deletes matching Shared EMI Summary rows only if Payroll Status is blank. Correctly guards zero with `recoveredAmtForRef && recoveredAmtForRef > 0` — contrast with the bug in 3A below.
- `refreshEmiScheduleProtection_()` — single named-range protection `EMI_SCHEDULE_PROTECTION` on Advance Ledger `A2:L{lastRow}`, PMO-only.

## Employee Master sync (`2_EmpMasterSync.gs`)

`syncEmpMaster_Core_()` pulls `A:AB` from the external Employee Master (by GID), upserts into local `EMP master` by Employee Code (col B). Update-or-append only — never deletes.

## Shared lock sync (`3A_Master_SharedEMILockSync.gs`)

`syncSharedEmiPayrollStatusFromRecoveredLedger()` — three phases:
1. Lock `Shared EMI Summary` "Payroll Status" cells (only if currently blank) when a matching Recovered Ledger row exists.
2. Sync `HR Decision`/`Recover Amount` from Recovered Ledger into `EMI_SCHEDULE`.
3. Apply HR Decision post-actions: `SKIP` appends one new EMI row next month, idempotent via ScriptProperties key `SKIP_EXTENDED_V4::<ref>::<month>::<emp>`; `RESIGNED`/`ABSCOND` zero out and mark `WRITE OFF` all future rows after the decision month.

**Known bug, not yet fixed**: line ~286, `newRow[E.emiAmt] = String(emiVals[i][E.emiAmt] || "").trim();` — `emiVals` comes from `getValues()` as raw numbers, so a legitimately-zero EMI Amount evaluates `0 || ""` → `""`, silently blanking the amount instead of writing `"0"`. Same pattern at ~line 240 (though that field appears unused downstream). If touching this file, replace numeric `|| ""` fallbacks with explicit `(val === "" || val == null) ? "" : String(val)` or `parseFloat(val) > 0` checks.

## Watcher (`3B_RecoveredLedgerWatcher.gs`)

`watchRecoveredLedgerAndSyncLocks()` hashes (MD5+base64) the full used-range of Recovered Amount Ledger, compares to `ScriptProperties` key `RECOVERED_LEDGER_HASH_V1`, and only calls 3A's sync when changed. `seedRecoveredLedgerHash()` is a manual one-time seed to avoid a spurious first run.

## Config

- Sheets: `Advance Ledger`, `EMI_SCHEDULE`, `Shared EMI Summary`, `EMP master`, `Recovered Amount Ledger`.
- `EMP_SRC_SPREADSHEET_ID = "1yqQ-edwQzZd0pAlaXCAAZt88MbsHfCf4hCcxti4ojCw"`, GID `1874110664`.
- ScriptProperties keys: `SKIP_EXTENDED_V4::` prefix, `RECOVERED_LEDGER_HASH_V1`.
- Month format convention throughout: `"MMMM_yyyy"`; `normMonthKey_()` also strips an `"ATTENDANCE_"` prefix, implying some month-key values originate from the Attendance module's naming convention.

## Dependencies

- Employee Master (external, hardcoded ID/GID) — mirrored, not live-read, into `EMP master`.
- No direct code reference to [payroll-generator/](../payroll-generator/CLAUDE.md) or [attendance/](../attendance/CLAUDE.md) in these four files, but `payroll-generator`'s Generate Locked Payroll stage pushes into this module's Recovered Amount Ledger (`glpPushRecoveredLedgerSnapshot_`), which is what 3B/3A react to.
