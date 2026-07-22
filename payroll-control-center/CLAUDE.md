# payroll-control-center/

Control-plane / gatekeeper for the monthly payroll cycle. Spawns each month's "Payroll Workings" file from a template, analogous to how [attendance-control center/](../attendance-control%20center/CLAUDE.md) spawns Attendance files. See root [CLAUDE.md](../CLAUDE.md) for cross-cutting principles.

## Files

- `Payroll Control Center` — main script (no `.gs` extension), 631 lines. Bound to the "Payroll Control" spreadsheet; refuses to run unless the active spreadsheet name matches `CONTROL_FILE_NAME`.
- `Protectionremove.gs` — `removeAllProtections()`, emergency/admin-only, not menu-wired. Strips **all** range/sheet protections on the active spreadsheet, not just ones this module manages.

## Entry points

- `onOpen()` → menu "Payroll Control" → "Generate Payroll Workings" → `generatePayrollWorkings()`.
- `generatePayrollWorkings()` — dual-actor dispatch: `PCC_OWNER_EMAIL` (`pmo@butlerleather.com`) runs `generatePayrollWorkingsServer_` directly; others POST to `PCC_WEBAPP_URL`.
- `doPost(e)` — Web App entry point, dispatches to `generatePayrollWorkingsServer_`.
- `generatePayrollWorkingsServer_(payload)` — core logic under `LockService`:
  1. Validates control filename and headers.
  2. Finds the next unlocked row (`findFirstUnlockedRow_`).
  3. Validates month/year, **checks the matching Attendance file actually exists** (`validateAttendance_`) in the Monthly Attendance Drive folder.
  4. Validates sequential entry discipline and month continuity (`validateSequentialEntryDiscipline_`, `validateMonthContinuity_`).
  5. Checks duplicates (`checkDuplicateInControl_`, `folderHasExactFileName_`).
  6. Copies the payroll-generator template into the Workings folder, sets `META_DATA` on the copy (`updateMetaDataKeys_`), writes the control row, refreshes protection (`refreshControlSheetProtection_`).

## Config / sheets

- Sheets: `PAYROLL_CONTROL` (data), `CONFIG` (key/value in cols A/B), `META_DATA` (written into the copied Workings file).
- `CONFIG_KEYS`: `TEMPLATE_PAYROLL_GENERATOR_FILE_ID`, `MONTHLY_PAYROLL_WORKINGS_FOLDER_ID`, `LOCKED_PAYROLL_FILES_FOLDER_ID`, `BANK_TRANSFER_FILES_FOLDER_ID`, `MONTHLY_ATTENDANCE_FOLDER_ID`, `CONTROL_FILE_NAME`.
- Control row headers: `PAYROLL_MONTH_KEY, MONTH, YEAR, PAYROLL_WORKINGS_FILE_NAME, PAYROLL_WORKINGS_FILE_ID, LOCK_STATUS, CREATED_ON, CREATED_BY`. Data starts row 2.
- File naming: workings file `Payroll-Workings_{Month}_{Year}`; expected attendance file `Attendance_{Month}_{Year}`.
- `PCC_WEBAPP_URL` / `PCC_OWNER_EMAIL` are top-level constants, not part of the frozen `PCC` config object.
- **Bulk protection pattern**: a single protection range `A2:G{lastRow}` tagged `PCC_MANAGED_PROTECTION`, owner-only, domain-edit disabled — the code comments note this replaced an older row-by-row protection approach. If touching protection logic, prefer this bulk-range style, not per-row.

## Dependencies

No direct code coupling to [payroll-generator/](../payroll-generator/CLAUDE.md), [attendance/](../attendance/CLAUDE.md), [salary-advance-master/](../salary-advance-master/CLAUDE.md), or [salary-revision-history/](../salary-revision-history/CLAUDE.md) — only indirect linkage via Drive folder IDs in `CONFIG` (validating the attendance file exists, spawning payroll-generator copies into the Workings folder).
