# leave-master/

Keeps the LEAVE_MASTER spreadsheet in sync with the ACTIVE + STAFF subset of Employee Master. Feeds [attendance/](../attendance/CLAUDE.md)'s "Get Leave Balances" step, which is a file-locking, irreversible action — so this sync must be correct before that runs. See root [CLAUDE.md](../CLAUDE.md) for cross-cutting principles.

## Files

- `01_HashWatcher.gs` — change-detection layer, meant to run on a time trigger.
- `LeaveMasterSync.gs` — the actual sync logic (add/remove/update).
- `HRMS_Process_MindMap.html` — visual process overview of the full HRMS monthly cycle (reference only, not code).

## Hash watcher pattern (`01_HashWatcher.gs`)

`watchEmployeeMasterHashAndSync()` is the trigger entry point. It computes a SHA-256 hash (`computeEmployeeMasterHashByHeaders_`) over a canonical `ID|NAME|STAFF|DOJ|ACTIVE` string built from every ACTIVE+STAFF row in Employee Master (sorted, joined), compares it against the last stored hash in Document Properties (`EMP_MASTER_HASH_ACTIVE_STAFF`), and only calls `runLeaveMasterSyncSilent_()` when it differs. This exists purely to debounce — avoid rewriting LEAVE_MASTER on every trigger fire when nothing relevant changed.

## Sync logic (`LeaveMasterSync.gs`)

- `onOpen()` — menu "Leave Master" → "Sync ACTIVE STAFF (Add/Remove)".
- `syncLeaveMasterActiveStaffManual()` — UI entry, dual-actor dispatch: `LM_PMO_EMAIL` runs core directly, `LM_ALLOWED_USER` (hrassist) routes through `LM_WEBAPP_URL` (`_callLeaveMasterSyncWebApp_`), which executes as PMO on the far side.
- `doPost(e)` — Web App entry, re-validates `requestedBy === LM_ALLOWED_USER` server-side before calling core.
- `runLeaveMasterSyncSilent_()` — thin no-UI wrapper called by the hash watcher.
- `syncLeaveMasterActiveStaffCore_()` — the real work: deletes duplicate/inactive/removed rows (bottom-up full-row delete), updates ID/Name/Category/DOJ on existing rows **while preserving EL/CL/SL balance columns**, appends new active-staff employees with blank balances. Returns `{added, removed, updated}`.
- `fetchActiveStaffFromEmployeeMasterByHeaders_()` — status match uses `startsWith("ACTIVE")`, tolerant of variants like `"ACTIVE."` or `"ACTIVE "`.
- `appendNewEmployeesByHeaders_()` — finds the true last data row via the ID.NO column, **not** `getLastRow()` (avoids stopping short on trailing formatting/formula rows).

## Config

- `EMPLOYEE_MASTER_SPREADSHEET_ID = "1yqQ-edwQzZd0pAlaXCAAZt88MbsHfCf4hCcxti4ojCw"`, GID `1874110664`.
- `LEAVE_MASTER_SPREADSHEET_ID = "1kVV5Vu8dPGdgGSAu7rZCz9I9L0XlJiQBE-Opv7izDfk"`, target sheet `LEAVE_MASTER`.
- Document Properties: `EMP_MASTER_HASH_ACTIVE_STAFF`, `EMP_MASTER_LAST_SYNC_ACTIVE_STAFF`.
- Requires the "Google Sheets API" Advanced Service enabled (used for `Sheets.Spreadsheets.Values.get`).
- All lookups are header-name based (ID.NO, NAME, CATEGORY, D.O.J, STATUS, EL/CL/SL BALANCE), resilient to column reordering — see root principle.

## Dependencies

- Upstream: **Employee Master** (read-only source of truth).
- Downstream: **LEAVE_MASTER** is read by [attendance/](../attendance/CLAUDE.md)'s Get Leave Balances step, and balances here are later updated by [payroll-generator/](../payroll-generator/CLAUDE.md)'s Leave Ledger Push stage (Dec year-end reset, Mar carry-forward expiry) — no direct code coupling in this module's files, only shared spreadsheet state.
