/************************************************
 * 14_FixAuth.gs — FIX PERMISSIONS
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
 * 1. Blocked on the template file. This project is bound to the
 *    attendance template, which holds the ONE deployed Web App
 *    that every monthly copy POSTs back to (ATTENDANCE_WEBAPP_URL
 *    in WebApp Router.gs — "defined ONCE here"). That deployment
 *    runs as the owner, so resetting the owner's authorization
 *    there can stop hrassist@ until the owner re-authorizes.
 *    Monthly Attendance_<Month>_<Year> copies carry no deployment
 *    and no installable trigger, so nothing in them can break.
 *
 * 2. Nothing is read before the reset that the reset might need.
 *    If the missing scope is the Sheets one, SpreadsheetApp itself
 *    throws — so every SpreadsheetApp call here is wrapped, and an
 *    unreadable file name is treated as "broken monthly file",
 *    not as a template. Only the owner opens the template, and the
 *    owner always holds full scopes, so a real template is always
 *    identified correctly.
 ************************************************/

// Monthly files are named "Attendance_<Month>_<Year>" — see
// getExpectedAttendanceFileName_ / parseMonthYear_ in 99_Utils.gs.
// The payroll validator locates them by this exact name.
const FIXAUTH_MONTHLY_NAME = /^Attendance_/i;

function resetMyAttendanceAuthorization() {

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
      'Open the monthly Attendance file and run it there.';
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
