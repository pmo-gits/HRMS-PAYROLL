# attendance/

Monthly attendance file scripts, bound to each `Attendance_<Month>_<Year>` spreadsheet (spawned from a template by [attendance-control center/](../attendance-control%20center/CLAUDE.md)). See root [CLAUDE.md](../CLAUDE.md) for cross-cutting principles before reading this.

## File order and responsibilities

- `00_Config` — all constants: external spreadsheet IDs/GIDs, local sheet-name constants, header lists.
- `01_Menu.gs` — `onOpen()` builds Attendance / Leave / Salary Advance menus.
- `02_Attendance_Refresh.gs` — `refreshAttendanceMonth_FullSheet()` (menu) → `refreshAttendanceMonth_WithParsed_(year, monthIndex0)` (UI-free, also called from Web App). Rewrites roster + date headers, cascades into Late Entry and Carry Forwarded refresh.
- `03_Attendance_SyncNew.gs` — `syncNewEmployeesAppendOnly()` appends newly-ACTIVE employees only (never removes), mirrors into Late Entry.
- `04_Leave_GetBalances.gs` — `getLeaveBalances_Button()` is the one-time action that pulls balances from Leave Master, writes them, then **locks the file**. This is the point of no return for the month.
- `05_Lock.gs` — `isAttendanceLocked_` / `setAttendanceLocked_` / `autoUnlockAttendance_`.
- `06_LeaveMaster_Readers.gs` — reads/writes the external Leave Master spreadsheet (LEAVE_MASTER + SHARED_SUMMARY tabs).
- `07_EmployeeMaster_Fetch.gs` — `fetchActiveEmployees_()`, `fetchEmployeeStatus_()` pull from Employee Master via Sheets Advanced Service.
- `08_RemoveInactiveEmployee.gs` — `removeInactiveEmployee()`. Never deletes row 2 directly (array formulas anchor there) — shifts row 3 up instead via `safeRemoveEmployeeRow_`.
- `10_LateEntry.gs` / `11_LateEntry_PenaltyCalc.gs` — Late Entry sheet sync + `recalcLateEntryLeavePenaltyCount()` (must run from the "Late Entry" sheet).
- `12_CarryForwarded.gs` — clears header-named columns only, no roster rewrite.
- `13_SalaryAdvance.gs` — syncs EMI data from Salary Advance Master. Requires Attendance to be **locked** first; blocked if Payroll is already locked.
- `99_Utils.gs` — shared helpers (see below).
- `WebApp Router.gs` — `doPost(e)`, the sole Web App entry point.

## Shared utilities worth knowing (`99_Utils.gs`)

- `parseMonthYear_`, `parseHeaderDate_`, `monthName_`, `getExpectedAttendanceFileName_` — filename/date parsing, format `Attendance_<Month>_<Year>`.
- `updateDateHeadersAndVisibility_` — writes date labels to `I1:AM1`, hides unused day columns.
- `applySundayWOFormattingAndProtection_` — marks/protects Sunday columns as "WO", protection description prefix `SUNDAY_PROTECTION_PREFIX`.
- `getSheetTitleByIdCached_` — resolves tab title from numeric sheetId, **cached 6h** in ScriptCache. A tab rename within that window returns a stale title.
- `clearMonthlySheets_` — the centralized month-refresh routine; touches Attendance entry, Leave Balances, Late Entry, OT Entry, Other Payments, Other Deductions, Salary Advance deductions, all via header-name lookups.

## Non-obvious patterns

- **Dual-actor dispatch, repeated in every 0x file**: caller email checked against `PMO = "pmo@butlerleather.com"` (runs in-sheet directly) vs `hrassist@butlerleather.com` (routed through `ATTENDANCE_WEBAPP_URL` via `UrlFetchApp`, re-validated server-side in `doPost`). Everyone else is blocked.
- **Locking is both logical and physical**: `LOCK_COL = 60` stores `"LOCKED - <timestamp>"` on row 2 only (`isAttendanceLocked_` checks row 2), *and* actual Sheets range protections (prefix `AUTO_LOCK_COL_PROTECT_`) are applied. Triggered once per month by Get Leave Balances; gates Sync New Employees, Refresh, Remove Inactive Employee, and (inversely) Salary Advance sync, which requires the lock to already be set.
- **Fixed-position vs header-based columns coexist.** The roster/date grid (`STATIC_COLS_COUNT=8`, `DATE_START_COL=9`..`DATE_END_COL=39` for I:AM) is positional. Everything else (Late Entry summary, OT Entry, Other Payments/Deductions, Salary Advance deductions, Carry Forwarded) is header-name driven — see root principle on header-based lookups.
- **Late penalty rules** (`11_LateEntry_PenaltyCalc.gs`): STAFF get 2 permission slots/month, WORKER get 1. Grace of up to 3 uses for 6–10 min lateness. `P60`/`P120` codes consume a slot or count as 60/120 min late. Penalty = 0.5 for >5min (post-grace), 1.0 if >270min.
- **Salary Advance month key** derived from filename regex (`monthKeyFromAttendanceFileName_`) and normalized via `normalizeMonthToKey_`; snapshot dedupe key is `[attendanceFileName, monthKey, empCode, EMI_Reference].join("|")`.

## External spreadsheet dependencies

- **Employee Master**: `1yqQ-edwQzZd0pAlaXCAAZt88MbsHfCf4hCcxti4ojCw`, tab GID `1874110664`. Headers: S.NO, ID.NO, NAME, GENDER, CATEGORY, DEPARTMENT, DESIGNATION, D.O.J, STATUS.
- **Leave Master**: `1kVV5Vu8dPGdgGSAu7rZCz9I9L0XlJiQBE-Opv7izDfk`, tabs GID `0` (LEAVE_MASTER), `1577916656` (APPROVED_LEAVE_LEDGER, referenced not read here), `1839786889` (SHARED_SUMMARY).
- **Salary Advance Master**: `172uLkW5v1Dr_fYO8rZ3GaAwYEyYyRc_n0PaVYjHDwUg`, tabs `EMI_SCHEDULE`, `Shared EMI Summary`.
- Produces the locked monthly file that [payroll-generator/](../payroll-generator/CLAUDE.md) consumes (Validate Attendance stage reads this file's lock status and tabs directly).
