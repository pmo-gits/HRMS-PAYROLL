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

const EMI_PMO_USER_       = "pmo@butlerleather.com";
const EMI_ALLOWED_USER_   = "nazneen@butlerleather.com";
const EMI_HR_ASSIST_USER_ = "hrassist@butlerleather.com";

/**
 * Who may call which action, keyed by action name.
 *
 * Authorisation used to be a single check — "are you nazneen@?" — applied to
 * every action alike. hrassist@ needs TWO of them (removeRequestRows, so HR can
 * withdraw their own un-scheduled requests past the sheet protection, and
 * syncEmpMaster, so they can refresh the mirror themselves) and must NOT gain
 * scheduleEMI or cancelEMI along the way. A flat second allowed-user constant
 * would have handed over all five.
 *
 * Note what hrassist@ deliberately does NOT get: syncSalaryMaster. Refreshing
 * SALARY master moves the ceiling the eligibility gate enforces, so it stays
 * with pmo@/nazneen@ — the people who own the limit, not the people who request
 * against it.
 *
 * FAIL-CLOSED: an action absent from this map is denied. Adding a new action to
 * the switch below therefore denies everyone until it is listed here too, which
 * is the right way round — a forgotten entry blocks work, it does not expose it.
 * pmo@ never appears here: the owner never reaches the Web App, running Core
 * directly from the menu instead.
 */
const EMI_ACTION_ALLOWED_ = {
  scheduleEMI:       [EMI_ALLOWED_USER_],
  cancelEMI:         [EMI_ALLOWED_USER_],
  syncEmpMaster:     [EMI_ALLOWED_USER_, EMI_HR_ASSIST_USER_],
  syncSalaryMaster:  [EMI_ALLOWED_USER_],
  removeRequestRows: [EMI_ALLOWED_USER_, EMI_HR_ASSIST_USER_],
};

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
    const action      = String(payload.action || "").trim();

    // Authorisation is now PER ACTION — see EMI_ACTION_ALLOWED_ above. The
    // action is resolved first so the check can be specific to it; an unknown
    // action has no entry, so it is denied here before ever reaching the
    // switch. Denials stay deliberately vague about which of the two reasons
    // applied.
    const allowed = Object.prototype.hasOwnProperty.call(EMI_ACTION_ALLOWED_, action)
      ? EMI_ACTION_ALLOWED_[action]
      : [];

    if (allowed.indexOf(requestedBy) === -1) {
      return emiJsonResponse_(false, "Access denied. You are not authorised to call this Web App.");
    }

    switch (action) {
      case "scheduleEMI":
        return scheduleEMIServer_(payload);
      case "cancelEMI":
        return cancelEMIServer_(payload);
      case "syncEmpMaster":
        return syncEmpMasterServer_(payload);
      case "syncSalaryMaster":
        return syncSalaryMasterServer_(payload);
      case "removeRequestRows":
        return removeRequestRowsServer_(payload);
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
 *
 * ✅ NEW (v4): payload.allowExceptions (array of Employee Codes) is passed
 * through unchanged to scheduleEMI_Core_(). The Yes/No decision behind
 * this list was already made client-side in the menu wrapper — this
 * handler stays UI-free, it only relays the decision.
 */
function scheduleEMIServer_(payload) {
  try {
    const ssId = String(payload.spreadsheetId || "").trim();
    if (!ssId) return emiJsonResponse_(false, "Missing spreadsheetId.");

    const ss              = SpreadsheetApp.openById(ssId);
    const allowExceptions = Array.isArray(payload.allowExceptions) ? payload.allowExceptions : [];

    // ✅ NEW (v6) — tenure-override list, relayed exactly like allowExceptions.
    // There is intentionally NO payload field for amount failures: those are
    // not overridable, so no request can ask for one.
    const allowTenureExceptions = Array.isArray(payload.allowTenureExceptions)
      ? payload.allowTenureExceptions : [];

    // requestedBy has already been validated against EMI_ALLOWED_USER_ in
    // doPost. It is forwarded so the override stamp names the person who
    // actually clicked — this Web App executes as the owner, so reading the
    // effective user inside Core would stamp pmo@ for every delegate override.
    const result = scheduleEMI_Core_(
      ss, allowExceptions, allowTenureExceptions, String(payload.requestedBy || "").trim()
    );

    return emiJsonResponse_(result.success, result.message, {
      refsCreated:       result.refsCreated       || 0,
      rowsAdded:         result.rowsAdded         || 0,
      skippedIneligible: result.skippedIneligible || 0,
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

/**
 * syncSalaryMaster server handler
 * Requires: spreadsheetId, requestedBy in payload.
 * Core logic is UI-free in 4_SalaryMasterSync.gs. Unlike syncEmpMaster_Core_,
 * it takes ss explicitly rather than calling getActiveSpreadsheet() — there is
 * no active spreadsheet in a Web App request, and relying on the binding would
 * make the function untestable from anywhere else.
 */
function syncSalaryMasterServer_(payload) {
  try {
    const ssId = String(payload.spreadsheetId || "").trim();
    if (!ssId) return emiJsonResponse_(false, "Missing spreadsheetId.");

    const result = syncSalaryMaster_Core_(SpreadsheetApp.openById(ssId));
    return emiJsonResponse_(result.success, result.message, {
      written:    result.written || 0,
      duplicates: (result.duplicates || []).length,
    });
  } catch (err) {
    return emiJsonResponse_(false, "syncSalaryMaster failed: " + err.message);
  }
}

/**
 * removeRequestRows server handler
 * Requires: spreadsheetId, requestedBy, rowNumbers in payload.
 *
 * The selection was resolved to row numbers CLIENT-side (getActiveRangeList
 * does not exist in a Web App request). Those numbers are treated as a
 * suggestion, not an instruction: removeRequestRows_Core_ re-reads every one of
 * them from the sheet and re-applies the full validation before deleting
 * anything, so a stale or hand-edited payload cannot remove a scheduled row.
 *
 * requestedBy is forwarded for the removal log — this Web App executes as the
 * owner, so reading the effective user inside Core would record pmo@ for every
 * delegate deletion.
 */
function removeRequestRowsServer_(payload) {
  try {
    const ssId = String(payload.spreadsheetId || "").trim();
    if (!ssId) return emiJsonResponse_(false, "Missing spreadsheetId.");

    const rowNumbers = Array.isArray(payload.rowNumbers) ? payload.rowNumbers : [];
    if (rowNumbers.length === 0) return emiJsonResponse_(false, "No rows were selected.");

    const ss     = SpreadsheetApp.openById(ssId);
    const result = removeRequestRows_Core_(
      ss, rowNumbers, String(payload.requestedBy || "").trim()
    );

    return emiJsonResponse_(result.success, result.message, { removed: result.removed || 0 });
  } catch (err) {
    return emiJsonResponse_(false, "removeRequestRows failed: " + err.message);
  }
}

/* ================================================
 * Shared Utilities
 * ================================================ */

/** How long a caller waits for the module lock before giving up. */
const EMI_LOCK_TIMEOUT_MS_ = 30000;

/**
 * withEmiLock_(label, fn)
 *
 * Runs fn under ONE script-wide lock shared by every operation in this module
 * that reads or writes the advance tables. A single lock rather than one per
 * function, deliberately — the races that matter are BETWEEN different
 * operations, not between two runs of the same one:
 *
 *   - syncSalaryMaster_Core_ clears SALARY master!A2:N and rewrites it. A
 *     scheduleEMI_Core_ reading during that window sees no salaries and refuses
 *     every advance as "no salary on record" — a wrong refusal caused purely by
 *     timing, and a baffling one to debug after the fact.
 *
 *   - removeRequestRows_Core_ resolves its target rows, then deletes them. A
 *     second removal landing in between shifts the sheet underneath those
 *     numbers, and the WRONG row is deleted. This is the destructive one.
 *
 * NOT REENTRANT — never call a locked Core from inside another locked Core.
 * The watcher in 7_SalaryMasterWatcher.gs therefore takes no lock of its own;
 * it delegates to syncSalaryMaster_Core_, which takes it.
 *
 * FAILS CLOSED: if the lock cannot be acquired it throws rather than proceeding
 * on data that may be mid-rewrite. Callers surface the message and the person
 * runs it again — the alternative is a silent wrong answer.
 */
function withEmiLock_(label, fn) {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(EMI_LOCK_TIMEOUT_MS_)) {
    throw new Error(
      `${label} could not start: another salary-advance action is running ` +
      `(waited ${Math.round(EMI_LOCK_TIMEOUT_MS_ / 1000)}s). Nothing was changed — ` +
      `wait for it to finish and run this again.`
    );
  }

  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

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