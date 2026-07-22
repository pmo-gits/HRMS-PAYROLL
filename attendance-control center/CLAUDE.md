# attendance-control center/

Controller spreadsheet that spawns each month's `Attendance_<Month>_<Year>` file from a template. This is the entry point that precedes everything in [attendance/](../attendance/CLAUDE.md). See root [CLAUDE.md](../CLAUDE.md) for cross-cutting principles.

## Files

- `Attendance Control Center` — main script (no `.gs` extension). Bound to a control spreadsheet whose name must match the `CONTROL_FILE_NAME` config key (script refuses to run otherwise).
- `Protectionremove.gs` — `removeAllProtections()`. Emergency/admin-only utility, not wired to any menu. Iterates and removes **every** RANGE and SHEET protection on the active spreadsheet (not just ones this module manages) — run manually from the script editor when protections get stuck.

## Entry points

- `onOpen()` → menu "Attendance Control" → "Generate Attendance File" → `generateAttendanceFile()`.
- `generateAttendanceFile()` — if caller is `ACC_OWNER_EMAIL` (`pmo@butlerleather.com`), runs `generateAttendanceFileServer_` directly; otherwise POSTs to `ACC_WEBAPP_URL` so it executes under the deployed Web App identity.
- `doPost(e)` — Web App entry point, parses JSON, calls `generateAttendanceFileServer_`, returns JSON.
- `generateAttendanceFileServer_(payload)` — core logic, wrapped in a 30s `LockService` script lock:
  1. Validates control filename matches config.
  2. Finds the next pending row (`accFindNextAttendanceInputRow_`).
  3. Validates sequential entry order (`accValidateSequentialEntryDiscipline_`) and month continuity (`accValidateMonthContinuity_`) — you cannot skip or go out of order.
  4. Checks duplicates both in the control sheet (`accCheckDuplicateInAttendanceControl_`) and in the target Drive folder by exact filename (`accFolderHasExactFileName_`).
  5. Copies the Drive template into the target folder, writes back `PAYROLL_MONTH_KEY`/`FILE_NAME`/`CREATED_ON`/`CREATED_BY`/hyperlinked `FILE_ID`.
  6. Updates `META_DATA` in the new file (`accUpdateOptionalMetaDataKeys_`).
  7. Locks the completed row (`accRestoreManagedProtections_`).

## Config / sheets

- Sheets: `ATTENDANCE_CONTROL` (data), `CONFIG` (key/value map, keys `TEMPLATE_ATTENDANCE_FILE_ID`, `MONTHLY_ATTENDANCE_FOLDER_ID`, `CONTROL_FILE_NAME`), `META_DATA` (written into the copied file).
- `ATTENDANCE_CONTROL` headers: `PAYROLL_MONTH_KEY, MONTH, YEAR, MONTHLY_ATTENDANCE_FILE_NAME, MONTHLY_ATTENDANCE_FILE_ID, CREATED_ON, CREATED_BY, REMARKS`. Data starts row 2.
- Naming convention: `payrollMonthKey = MONTH_YEAR`, generated file name = `Attendance_MONTH_YEAR`.
- Protection: completed rows get columns 1–7 locked, description prefix `ACC_MANAGED_PROTECTION`, restricted to the effective user with domain-edit disabled.

## Dependencies

No direct code coupling to leave-master or payroll — the only linkage is Drive-level: the template attendance file (by ID) is copied into the Monthly Attendance folder (by ID), and downstream modules ([attendance/](../attendance/CLAUDE.md), [payroll-generator/](../payroll-generator/CLAUDE.md)) locate the resulting file purely by its `Attendance_MONTH_YEAR` naming convention.
