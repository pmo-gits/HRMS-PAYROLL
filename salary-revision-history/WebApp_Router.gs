/************************************************
 * WebApp Router.gs
 * Salary Revision — Spreadsheet-bound Apps Script
 *
 * Holds all Web App related constants and routing:
 *   - SALARY_REVISION_WEBAPP_URL
 *   - User email constants (referenced by Submit_Approval.gs & Revision_Approval.gs)
 *   - _callWebApp_() helper (referenced by Submit_Approval.gs & Revision_Approval.gs)
 *   - doPost() — routes actions to server handlers
 *
 * Owner (pmo@butlerleather.com)     → runs functions directly
 * hrassist@butlerleather.com        → submitForApproval routes via Web App
 * nazneen@butlerleather.com         → revisionApproval routes via Web App
 * All others                        → blocked with toast
 ************************************************/

const SALARY_REVISION_WEBAPP_URL =
  'https://script.google.com/macros/s/AKfycbxMked-K5eh3V1C8nBf2IggBCM8m9R_6m1ztMrm_L2RFYtdR0MjKGluOUds5iUkugFLnQ/exec';

const OWNER_EMAIL_     = 'pmo@butlerleather.com';
const HR_ASSIST_EMAIL_ = 'hrassist@butlerleather.com';
const NAZNEEN_EMAIL_   = 'nazneen@butlerleather.com';

/* ================================================
 * _callWebApp_()
 * Shared UrlFetchApp caller used by entry points
 * in Submit_Approval.gs and Revision_Approval.gs.
 * Sends { action, spreadsheetId, requestedBy } to doPost.
 * ================================================ */
function _callWebApp_(action, ss) {
  try {
    const payload = JSON.stringify({
      action        : action,
      spreadsheetId : ss.getId(),
      requestedBy   : Session.getActiveUser().getEmail(),
    });

    const response = UrlFetchApp.fetch(SALARY_REVISION_WEBAPP_URL, {
      method             : 'post',
      contentType        : 'application/json',
      payload            : payload,
      muteHttpExceptions : true,
    });

    const result = JSON.parse(response.getContentText());
    const ui     = SpreadsheetApp.getUi();

    if (result.success) {
      ui.alert(action, result.message || 'Done.', ui.ButtonSet.OK);
    } else {
      ui.alert(action, `Error: ${result.message || 'Unknown error.'}`, ui.ButtonSet.OK);
    }

  } catch (err) {
    SpreadsheetApp.getUi().alert(
      action,
      `Web App call failed: ${err && err.message ? err.message : err}`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  }
}

/* ================================================
 * doPost — Web App entry point
 * Validates caller, enforces action-to-user mapping,
 * routes to the correct server handler.
 * ================================================ */
function doPost(e) {
  try {
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    const action  = String(payload.action || '').trim();
    const caller  = String(payload.requestedBy || '').toLowerCase().trim();

    let result;

    switch (action) {
      case 'submitForApproval':
        if (caller !== HR_ASSIST_EMAIL_) {
          return jsonResponse_('error', `User "${caller}" is not authorised for action: ${action}`);
        }
        result = submitForApprovalServer_(payload);
        break;

      case 'revisionApproval':
        if (caller !== NAZNEEN_EMAIL_) {
          return jsonResponse_('error', `User "${caller}" is not authorised for action: ${action}`);
        }
        result = revisionApprovalServer_(payload);
        break;

      default:
        result = { success: false, message: `Unknown action: "${action}".` };
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({
        success: false,
        message: `Router error: ${err && err.message ? err.message : err}`,
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* ================================================
 * jsonResponse_ — helper for early error returns
 * ================================================ */
function jsonResponse_(status, message) {
  return ContentService
    .createTextOutput(
      JSON.stringify({ success: status === 'success', message })
    )
    .setMimeType(ContentService.MimeType.JSON);
}
