/*******************************************************
 * PAYSLIP EMAIL — FIX PERMISSIONS
 *
 * Google's consent screen allows PARTIAL grants: if the user
 * clicks Continue without ticking "Select all", the script is
 * authorized with only some of its scopes. It then never
 * re-prompts, and every run fails with a raw error —
 * "You do not have permission to call SpreadsheetApp..." or
 * "ENV_REGISTRY: could not read Drive metadata ... drive.files.get".
 *
 * ScriptApp.invalidateAuth() clears THIS user's authorization for
 * THIS script project only, so the consent screen comes back.
 *
 * TWO DELIBERATE DESIGN POINTS:
 *
 * 1. Blocked on the Template file. This project is bound to the
 *    Template Payslip, which holds the ONE deployed Web App that
 *    every monthly copy POSTs back to (see PAYSLIP_EMAIL_WebApp.gs).
 *    That deployment runs as the owner, so resetting the owner's
 *    authorization here can stop hrassist@ until the owner
 *    re-authorizes. Monthly copies carry no deployment and no
 *    trigger, so there is nothing to break in them.
 *
 * 2. Nothing is read before the reset that the reset might need.
 *    If the missing scope is the Sheets one, SpreadsheetApp itself
 *    throws — so every SpreadsheetApp call here is wrapped, and an
 *    unreadable file name is treated as "broken monthly file",
 *    not as a template. Only the owner opens templates, and the
 *    owner always holds full scopes, so a real template is always
 *    identified correctly.
 *******************************************************/

// Monthly copies are named "Payslip_<MONTH>_<YEAR>" —
// PSG.FILE_PREFIX in payroll-generator/10.generate payslips,
// mirrored as PES_FILE_PREFIX in PAYSLIP_EMAIL_SendMails.gs.
const FIXAUTH_MONTHLY_NAME = /^Payslip_/i;

function resetMyPayslipAuthorization() {

  let ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }

  /* ---- Template guard: monthly files only ---- */
  let fileName = '';
  try {
    fileName = String(SpreadsheetApp.getActiveSpreadsheet().getName() || '');
  } catch (e) {
    fileName = ''; // unreadable = a permission is already missing
  }

  if (fileName && !FIXAUTH_MONTHLY_NAME.test(fileName)) {
    const blocked =
      'This is a TEMPLATE file:\n"' + fileName + '"\n\n' +
      'Fix Permissions does not run here.\n\n' +
      'Open the monthly Payslip file and run it there.';
    if (ui) { try { ui.alert('Fix Permissions', blocked, ui.ButtonSet.OK); } catch (e2) {} }
    return blocked;
  }

  /* ---- Confirm (skipped if the UI itself is broken) ---- */
  if (ui) {
    try {
      const answer = ui.alert(
        'Fix Permissions',
        'This resets YOUR permissions for this file only.\n\n' +
        'After it runs: close and reopen this file, click the menu ' +
        'item again, and tick "Select all" on the Google permission ' +
        'screen.\n\nContinue?',
        ui.ButtonSet.YES_NO
      );
      if (answer !== ui.Button.YES) return;
    } catch (e) { /* no UI available — carry on with the reset */ }
  }

  /* ---- Reset ---- */
  let message;
  try {
    ScriptApp.invalidateAuth();
    message =
      'Permissions reset.\n\n' +
      '1. Close this file and reopen it.\n' +
      '2. Click the menu item again.\n' +
      '3. Tick "Select all", then Continue.\n\n' +
      'If you skip "Select all", the same error comes back.';
  } catch (err) {
    // Thrown when there is no authorization to invalidate.
    message =
      'Nothing to reset — no stored permission was found.\n\n' +
      'Just run the menu item and tick "Select all".';
  }

  if (ui) { try { ui.alert('Fix Permissions', message, ui.ButtonSet.OK); } catch (e) {} }
  return message; // visible in the execution log if the dialog failed
}

/* =========================================================
   Turns a raw partial-consent error into a plain instruction.
   Anything unrecognised passes through untouched, so genuine
   errors are never masked.

   Not wired into the entry points' catch blocks — swap
   `${err && err.message ? err.message : err}` for
   `pesAuthErrorHint_(err)` in PAYSLIP_EMAIL_WebApp.gs and
   PAYSLIP_EMAIL_GetEmails if that is wanted.
========================================================= */

function pesAuthErrorHint_(err) {
  const raw = String((err && err.message) ? err.message : err);

  const isAuthError =
    /do not have permission to call/i.test(raw) ||
    /Required permissions:/i.test(raw) ||
    /PERMISSION_DENIED/i.test(raw) ||
    /could not read Drive metadata/i.test(raw);

  if (!isAuthError) return `Error: ${raw}`;

  return 'Authorization incomplete — not all permissions were granted.\n\n' +
         'Fix: menu "Payslip Email" > "Fix Permissions (Re-authorize)",\n' +
         'then tick "Select all" on the Google permission screen.\n\n' +
         `Original error: ${raw}`;
}
