/*******************************************************
 * PAYSLIP EMAIL — WEB APP ENTRY POINT
 *
 * Standalone script project, bound to the Template Payslip file.
 * Deployed ONCE from here as its own Web App — makeCopy() into
 * each monthly Payslip_<Month> file carries over this code, but
 * NOT a live deployment, so every month's file calls back to this
 * SAME deployed URL, passing its own spreadsheetId. No redeploy
 * needed month to month.
 *
 * Deliberately SEPARATE from PAYROLL_GEN_6 / PAYROLL_GEN_10's
 * shared doPost — this is its own project with its own webapp
 * URL, per PMO's direction (the existing Locked Payroll doPost is
 * already large).
 *
 * Access: pmo@ runs directly, hrassist@ via this Web App (runs as
 * owner), everyone else blocked.
 *******************************************************/

const EMAIL_WEBAPP_URL    = 'https://script.google.com/a/macros/butlerleather.com/s/AKfycbyXPmAXu3HC75S0bXHYHy6WWoyNSK33qI9oyh4625zvAjj_SY32QO1JLxqApLxg59gm-w/exec'; // fill in after first deployment
const EMAIL_OWNER_EMAIL   = 'pmo@butlerleather.com';
const EMAIL_ALLOWED_EMAIL = 'hrassist@butlerleather.com';

/* =========================================================
   ENTRY POINT (menu-triggered — see PAYSLIP_EMAIL_Menu.gs)
========================================================= */

function sendStaffPayslipEmails() {
  const ui = SpreadsheetApp.getUi();

  try {
    const currentUser = String(
      (Session.getEffectiveUser() && Session.getEffectiveUser().getEmail()) || ''
    ).trim().toLowerCase();

    if (currentUser === EMAIL_OWNER_EMAIL.toLowerCase()) {
      const result = sendStaffPayslipEmailsServer_({
        spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
        requestedBy: currentUser,
        runMode: 'direct',
      });
      ui.alert('Send Staff Payslip Emails', result.message || 'No response received.', ui.ButtonSet.OK);
      return;
    }

    if (currentUser === EMAIL_ALLOWED_EMAIL.toLowerCase()) {
      if (!EMAIL_WEBAPP_URL || EMAIL_WEBAPP_URL === 'PASTE_YOUR_WEBAPP_URL_HERE') {
        ui.alert('Send Staff Payslip Emails', 'Web App URL is not configured.', ui.ButtonSet.OK);
        return;
      }

      const response = UrlFetchApp.fetch(EMAIL_WEBAPP_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          action: 'sendStaffPayslipEmails',
          spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
          requestedBy: currentUser,
        }),
        muteHttpExceptions: true,
      });

      const result = JSON.parse(response.getContentText() || '{}');
      ui.alert('Send Staff Payslip Emails', result.message || 'No response received from Web App.', ui.ButtonSet.OK);
      return;
    }

    ui.alert('Send Staff Payslip Emails', 'You are not authorized to run this function.', ui.ButtonSet.OK);

  } catch (err) {
    ui.alert('Send Staff Payslip Emails', `Error: ${err && err.message ? err.message : err}`, ui.ButtonSet.OK);
  }
}

/* =========================================================
   WEB APP doPost — this project's OWN doPost (completely
   separate from PAYROLL_GEN_6's).
========================================================= */

function doPost(e) {
  try {
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    const action  = String(payload.action || '').trim();

    let result;

    if (action === 'sendStaffPayslipEmails') {
      result = sendStaffPayslipEmailsServer_(payload);
    } else if (action === 'getStaffEmails') {
      result = getStaffEmailsServer_(payload);
    } else {
      result = { success: false, message: `Unknown action: "${action}".` };
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({
        success: false,
        message: `Error: ${err && err.message ? err.message : err}`,
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
