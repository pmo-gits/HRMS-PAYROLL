/************************************************
 * 0_WebApp.gs  (Salary Advance Master)
 *
 * ✅ SALARY_ADVANCE_MASTER_SPREADSHEET_ID declared HERE
 *    (loads before 3A_Master_SharedEMILockSync.gs which references it)
 *
 * Deploy as: Execute as → Me (owner), Who has access → Anyone
 *
 * Allowed Web App caller: nazneen@butlerleather.com
 * Owner (direct run):     pmo@butlerleather.com
 *
 * Actions routed via doPost:
 *   scheduleEMI   → scheduleEMIServer_(payload)
 *   cancelEMI     → cancelEMIServer_(payload)
 *   syncEmpMaster → syncEmpMasterServer_(payload)
 ************************************************/

const SALARY_ADVANCE_MASTER_SPREADSHEET_ID =
  "172uLkW5v1Dr_fYO8rZ3GaAwYEyYyRc_n0PaVYjHDwUg";

const EMI_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbxopXmcqaaDy3AhLCHoC8RU6OfuzOJ70fwv6LjFrd5YqkZzAZ6lroz_-XoIESLMt0Ehxg/exec";

const EMI_PMO_USER_     = "pmo@butlerleather.com";
const EMI_ALLOWED_USER_ = "nazneen@butlerleather.com";

/**
 * forceEmailScope_EMI_
 * Never called in production.
 * Run ONCE manually after deploying to trigger the
 * authorization dialog — ensures userinfo.email scope is included.
 */
function forceEmailScope_EMI_() {
  Session.getEffectiveUser().getEmail();
}

/* ================================================
 * doPost — single Web App entry point
 * Parses action + requestedBy from payload.
 * Only EMI_ALLOWED_USER_ is permitted.
 * ================================================ */
function doPost(e) {
  try {
    const payload     = JSON.parse(e.postData.contents);
    const requestedBy = String(payload.requestedBy || "").trim().toLowerCase();

    if (requestedBy !== EMI_ALLOWED_USER_) {
      return emiJsonResponse_(false, "Access denied. You are not authorised to call this Web App.");
    }

    const action = String(payload.action || "").trim();

    switch (action) {
      case "scheduleEMI":
        return scheduleEMIServer_(payload);
      case "cancelEMI":
        return cancelEMIServer_(payload);
      case "syncEmpMaster":
        return syncEmpMasterServer_(payload);
      default:
        return emiJsonResponse_(false, `Unknown action: "${action}"`);
    }

  } catch (err) {
    return emiJsonResponse_(false, "Router error: " + err.message);
  }
}

/* ================================================
 * Server Handlers
 * Thin wrappers — all core logic lives in the
 * individual script files. No logic duplicated here.
 * ================================================ */

/**
 * scheduleEMI server handler
 * Requires: spreadsheetId, requestedBy in payload.
 * Opens ss by ID, passes to scheduleEMI_Core_().
 * Three Web App gotchas handled inside Core:
 *   - ss passed in (no getActiveSpreadsheet)
 *   - bypassTabGuard not needed here (no sheet-level guard)
 *   - requestedBy available if stamping is ever needed
 */
function scheduleEMIServer_(payload) {
  try {
    const ssId = String(payload.spreadsheetId || "").trim();
    if (!ssId) return emiJsonResponse_(false, "Missing spreadsheetId.");

    const ss     = SpreadsheetApp.openById(ssId);
    const result = scheduleEMI_Core_(ss);

    return emiJsonResponse_(result.success, result.message, {
      refsCreated: result.refsCreated || 0,
      rowsAdded:   result.rowsAdded   || 0,
    });

  } catch (err) {
    return emiJsonResponse_(false, "scheduleEMI failed: " + err.message);
  }
}

/**
 * cancelEMI server handler
 * Requires: spreadsheetId, requestedBy, emiRef in payload.
 * emiRef is collected by ui.prompt() on the CLIENT side
 * and passed here — this handler never calls any UI method.
 */
function cancelEMIServer_(payload) {
  try {
    const ssId   = String(payload.spreadsheetId || "").trim();
    const emiRef = String(payload.emiRef        || "").trim().toUpperCase();

    if (!ssId)   return emiJsonResponse_(false, "Missing spreadsheetId.");
    if (!emiRef) return emiJsonResponse_(false, "Missing emiRef. Enter an EMI Reference Number.");

    const ss     = SpreadsheetApp.openById(ssId);
    const result = cancelEMI_Core_(ss, emiRef);

    return emiJsonResponse_(result.success, result.message, {
      emiRef,
      ledgerHits:        result.ledgerHits        || 0,
      recoveredAmtForRef: result.recoveredAmtForRef || 0,
      scheduleHits:      result.scheduleHits      || 0,
      statusLabel:       result.statusLabel        || "",
      sharedRowsDeleted: result.sharedRowsDeleted  || 0,
    });

  } catch (err) {
    return emiJsonResponse_(false, "cancelEMI failed: " + err.message);
  }
}

/**
 * syncEmpMaster server handler
 * Requires: requestedBy in payload.
 * Core logic is already UI-free in 2_EmpMasterSync.gs —
 * syncEmpMaster_Core_() called directly, no ss needed
 * (it uses getActiveSpreadsheet() internally, which is fine
 *  because it's bound to Salary Advance Master).
 */
function syncEmpMasterServer_(payload) {
  try {
    const result = syncEmpMaster_Core_();
    return emiJsonResponse_(true,
      `Employee Master refreshed ✅  Updated: ${result.updated}, Added: ${result.added}, Source rows: ${result.sourceRows}`
    );
  } catch (err) {
    return emiJsonResponse_(false, "syncEmpMaster failed: " + err.message);
  }
}

/* ================================================
 * Shared Utilities
 * ================================================ */

/**
 * emiJsonResponse_
 * Builds a JSON ContentService response.
 * @param {boolean} success
 * @param {string}  message
 * @param {object}  [extra]   additional fields merged into response
 */
function emiJsonResponse_(success, message, extra) {
  const body = Object.assign({ success, message }, extra || {});
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * callEmiWebApp_
 * Used by menu wrapper functions in other files to POST to this Web App.
 * Merges base payload (action, spreadsheetId, requestedBy) with any extras.
 * Returns the parsed JSON result object.
 *
 * @param {string} action       doPost action string
 * @param {Spreadsheet} ss      active spreadsheet (for getId())
 * @param {object} [extra]      additional payload fields (e.g. { emiRef })
 */
function callEmiWebApp_(action, ss, extra) {
  const payload = Object.assign(
    {
      action,
      spreadsheetId: ss.getId(),
      requestedBy:   Session.getEffectiveUser().getEmail(),
    },
    extra || {}
  );

  const response = UrlFetchApp.fetch(EMI_WEBAPP_URL, {
    method:             "post",
    contentType:        "application/json",
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  return JSON.parse(response.getContentText());
}