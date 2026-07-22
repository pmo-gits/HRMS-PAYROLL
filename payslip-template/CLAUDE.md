# payslip-template/

Payslip **email delivery** step — a standalone Apps Script project bound to the "Template Payslip" file, separate from `PAYROLL_GEN_10` (which lives in [payroll-generator/](../payroll-generator/CLAUDE.md) and does the actual PDF/layout generation). `makeCopy()` of this template carries the same code into every monthly `Payslip_<Month>` file; every monthly copy calls back to the one Web App URL deployed from this template project. See root [CLAUDE.md](../CLAUDE.md) for cross-cutting principles — note the **template-is-source-of-truth** principle applies to `PAYROLL_GEN_10`'s layout work, not to this email module.

## Files

- `Payslip email menu` — `onOpen()` → menu "Payslip Email": "Get Staff Emails" → `getStaffEmails()`, "Send Staff Payslip Emails" → `sendStaffPayslipEmails()`.
- `PAYSLIP_EMAIL_GetEmails` — `getStaffEmails()` → `getStaffEmailsServer_(payload)`. Looks up each row's Employee Code against Employee Master's `PERSONAL EMAIL ID` column (`gseBuildEmployeeMasterEmailMap_`), writes into `Staff Email Master`. **Never overwrites a non-blank Email cell.** On completion stamps `_GENERATED_LOG!F1` (`gseStampGeneratedLog_`) — this timestamp gates sending.
- `PAYSLIP_EMAIL_SendMails.gs` — `sendStaffPayslipEmailsServer_(payload)`. Blocks entirely if `_GENERATED_LOG!F1` is blank. Sends only rows where `PDF File ID` is non-blank, `Email Sent On` is blank, `Email` is non-blank. Fetches the PDF directly by Drive file ID (no folder/filename search), sends via `MailApp.sendEmail` (subject `Payslip - <Name> - <MonthLabel>`, CC'd to `zafar@butlerleather.com`), and **marks `Email Sent On` immediately after each send** — so a mid-run failure only leaves unmarked (unsent) rows pending, safe to re-run.
- `PAYSLIP_EMAIL_WebApp.gs` — dual-actor dispatch (`EMAIL_OWNER_EMAIL` = pmo direct, `EMAIL_ALLOWED_EMAIL` = hrassist via `EMAIL_WEBAPP_URL`), plus this project's own `doPost(e)` — deliberately separate from PAYROLL_GEN_6's/GEN_3's `doPost`.

## Non-obvious patterns

- **Send is gated on a written timestamp, not a live check** — `_GENERATED_LOG!F1` must have been stamped by Get Staff Emails first. This is a hard dependency ordering enforced in code.
- Both server functions take a 30s `LockService` script lock to prevent concurrent runs.
- Header lookups are dynamic by name (`pesBuildHeaderIndex_`/`pesRequireHeader_`), not fixed columns.
- `PDF File ID` is stored as a `HYPERLINK` formula but read via `getDisplayValues()` to extract the raw file ID text.
- Month label is parsed from the spreadsheet filename (`pesParseMonthLabel_`, expects prefix `Payslip_`) — must match `PSG.FILE_PREFIX` in `PAYROLL_GEN_10`.
- No A5 layout, print-area, or PDF-generation logic lives here — that's entirely in `PAYROLL_GEN_10` (see [payroll-generator/CLAUDE.md](../payroll-generator/CLAUDE.md)).

## Dependencies

- **Employee Master** (`1yqQ-edwQzZd0pAlaXCAAZt88MbsHfCf4hCcxti4ojCw`, tab by GID `1874110664`) for `ID.NO` / `PERSONAL EMAIL ID`.
- **PAYROLL_GEN_10** (`psgMarkStaffPdfFileId_`) writes the `PDF File ID` column this module reads, and its `Payslip_<Month>` naming convention (`PSG.FILE_PREFIX`) is mirrored here as `PES_FILE_PREFIX`.
