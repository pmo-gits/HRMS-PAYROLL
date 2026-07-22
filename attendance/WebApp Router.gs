/************************************************
 * WebApp Router.gs
 * Butler Leather — Attendance Apps Script
 *
 * Single doPost entry point for all Web App actions.
 * Owner (pmo@butlerleather.com) runs all functions directly.
 * hrassist@butlerleather.com routes through this Web App.
 * All other users are blocked at each individual script's user gate.
 *
 * ATTENDANCE_WEBAPP_URL is defined ONCE here.
 * All other scripts reference this constant directly.
 ************************************************/

const ATTENDANCE_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbzP2ob-QEwc6Jc5mIPATltoI7_vt_cROwEL4kV33nmqt6owXnnz_SDHGHLlQdgmvjf7/exec";

const WEBAPP_ALLOWED_USER_ = "hrassist@butlerleather.com";

/**
 * forceEmailScope_
 * Never called in production.
 * Exists solely so Apps Script includes userinfo.email scope
 * during authorization. Run this ONCE manually after deploying
 * to trigger the authorization dialog.
 */
function forceEmailScope_() {
  Session.getEffectiveUser().getEmail();
}

/* ================================================
 * doPost — Web App entry point
 * Routes action strings to their server handlers.
 * Only WEBAPP_ALLOWED_USER_ is permitted.
 * All other callers receive an access denied response.
 * ================================================ */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const caller  = String(payload.caller || "").trim();

    if (caller !== WEBAPP_ALLOWED_USER_) {
      return jsonResponse_("error", "Access denied. You are not authorised to call this Web App.");
    }

    const action = String(payload.action || "").trim();

    switch (action) {

      case "refreshAttendanceMonth":
        return refreshAttendanceMonthServer_(payload);

      case "syncNewEmployees":
        return syncNewEmployeesServer_(payload);

      case "getLeaveBalances":
        return getLeaveBalancesServer_(payload);

      case "recalcLateEntryPenalty":
        return recalcLateEntryPenaltyServer_(payload);

      case "removeInactiveEmployee":
        return removeInactiveEmployeeServer_(payload);

      default:
        return jsonResponse_("error", `Unknown action: "${action}"`);
    }

  } catch (err) {
    return jsonResponse_("error", "Router error: " + err.message);
  }
}

/* ================================================
 * Server Handlers
 * Thin wrappers — all core logic lives in the
 * individual script runners. No logic duplicated here.
 * ================================================ */

/**
 * refreshAttendanceMonth
 * Requires: year, monthIndex0, spreadsheetId in payload.
 * Sets active spreadsheet to the correct generated file before calling runner.
 * Calls: refreshAttendanceMonth_WithParsed_() in 02_Attendance_Refresh.gs
 */
function refreshAttendanceMonthServer_(payload) {
  try {
    const year        = Number(payload.year);
    const monthIndex0 = Number(payload.monthIndex0);
    const ssId        = String(payload.spreadsheetId || "").trim();

    if (isNaN(year) || isNaN(monthIndex0) || monthIndex0 < 0 || monthIndex0 > 11) {
      return jsonResponse_("error", "Invalid year or monthIndex0 in payload.");
    }
    if (!ssId) {
      return jsonResponse_("error", "Missing spreadsheetId in payload.");
    }

    const ss = SpreadsheetApp.openById(ssId);
    SpreadsheetApp.setActiveSpreadsheet(ss);
    refreshAttendanceMonth_WithParsed_(year, monthIndex0);

    return jsonResponse_(
      "success",
      `Attendance refreshed for ${monthName_(monthIndex0)} ${year}.`
    );

  } catch (err) {
    return jsonResponse_("error", "refreshAttendanceMonth failed: " + err.message);
  }
}

/**
 * syncNewEmployees
 * Requires: spreadsheetId in payload.
 * Sets active spreadsheet to the correct generated file before detecting state.
 * Calls: syncNewEmployeesAppendOnly_Runner_() in 03_Attendance_SyncNew.gs
 */
function syncNewEmployeesServer_(payload) {
  try {
    const ssId = String(payload.spreadsheetId || "").trim();
    if (!ssId) {
      return jsonResponse_("error", "Missing spreadsheetId in payload.");
    }

    const ss = SpreadsheetApp.openById(ssId);
    SpreadsheetApp.setActiveSpreadsheet(ss);
    const sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);

    if (!sheet) {
      return jsonResponse_("error", `Sheet "${ATTENDANCE_SHEET_NAME}" not found.`);
    }

    if (isAttendanceLocked_()) {
      return jsonResponse_("error", "Attendance is LOCKED. Sync New Employees is not allowed.");
    }

    const firstHeader = sheet.getRange(1, DATE_START_COL).getDisplayValue();
    const parsed      = parseHeaderDate_(firstHeader);

    if (!parsed) {
      return jsonResponse_("error", 'Cannot detect month/year from header. Run "Refresh the attendance month" first.');
    }

    const { year, monthIndex0 } = parsed;
    const daysInMonth = new Date(year, monthIndex0 + 1, 0).getDate();

    const empRows = fetchActiveEmployees_();
    if (empRows.length === 0) {
      return jsonResponse_("error", "No ACTIVE employees found in Employee Master.");
    }

    const lastRow = sheet.getLastRow();
    const existing = new Set();
    if (lastRow >= 2) {
      sheet.getRange(2, 2, lastRow - 1, 1).getValues()
        .forEach(r => {
          const v = String(r[0] || "").trim();
          if (v) existing.add(v);
        });
    }

    const newRows = empRows.filter(r => {
      const empCode = String(r[1] || "").trim();
      return empCode && !existing.has(empCode);
    });

    if (newRows.length === 0) {
      return jsonResponse_("success", "No new ACTIVE employees to append.");
    }

    syncNewEmployeesAppendOnly_Runner_(sheet, newRows, year, monthIndex0, daysInMonth);

    return jsonResponse_("success", `New employees appended: ${newRows.length}`);

  } catch (err) {
    return jsonResponse_("error", "syncNewEmployees failed: " + err.message);
  }
}

/**
 * getLeaveBalances
 * Requires: spreadsheetId in payload.
 * Sets active spreadsheet to the correct generated file before detecting state.
 * On success: locks Attendance + protects Leave Balances tab (pmo only).
 * Calls: computeLeaveBalancesRows_(), writeLeaveBalancesToAttendance_(),
 *        setAttendanceLocked_(), protectLeaveBalancesTab_()
 *        in 04_Leave_GetBalances.gs / 05_Lock.gs
 */
function getLeaveBalancesServer_(payload) {
  try {
    const ssId = String(payload.spreadsheetId || "").trim();
    if (!ssId) {
      return jsonResponse_("error", "Missing spreadsheetId in payload.");
    }

    const ss = SpreadsheetApp.openById(ssId);
    SpreadsheetApp.setActiveSpreadsheet(ss);

    if (isAttendanceLocked_()) {
      return jsonResponse_("error", "Attendance is LOCKED. No changes allowed.");
    }

    const attendanceFileName = ss.getName().trim();
    const rows = computeLeaveBalancesRows_(attendanceFileName);

    if (rows.length === 0) {
      return jsonResponse_("error", "No leave balances found.");
    }

    writeLeaveBalancesToAttendance_(rows);
    setAttendanceLocked_();
    protectLeaveBalancesTab_();

    return jsonResponse_(
      "success",
      `LOCKED ✅ Leave balances updated successfully. Rows: ${rows.length}`
    );

  } catch (err) {
    return jsonResponse_("error", "getLeaveBalances failed: " + err.message);
  }
}

/**
 * recalcLateEntryPenalty
 * Requires: spreadsheetId in payload.
 * Sets active spreadsheet to the correct generated file before detecting state.
 * On success: locks LATE PENALTY COUNT column (pmo only) via runner.
 * Calls: recalcLateEntryPenalty_Runner_() in 11_LateEntry_PenaltyCalc.gs
 */
function recalcLateEntryPenaltyServer_(payload) {
  try {
    const ssId = String(payload.spreadsheetId || "").trim();
    if (!ssId) {
      return jsonResponse_("error", "Missing spreadsheetId in payload.");
    }

    const ss = SpreadsheetApp.openById(ssId);
    SpreadsheetApp.setActiveSpreadsheet(ss);
    const sh = ss.getSheetByName(LATE_ENTRY_SHEET_NAME);

    if (!sh) {
      return jsonResponse_("error", `Sheet "${LATE_ENTRY_SHEET_NAME}" not found.`);
    }

    const lastCol = sh.getLastColumn();
    if (lastCol < 1) {
      return jsonResponse_("error", "Late Entry sheet is empty.");
    }

    const header = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
      .map(h => String(h || "").trim());

    const idx = (name) => header.findIndex(h => h.toUpperCase() === String(name).toUpperCase());

    const iEmpCode   = idx("EMPLOYEE CODE");
    const iCategory  = idx("CATEGORY");
    const iPenalty   = idx("LATE PENALTY COUNT");
    const iDOJ       = idx("DOJ");
    const iTotalLate = idx("TOTAL LATE DURATION");

    if (iEmpCode   === -1) return jsonResponse_("error", 'Late Entry: "Employee Code" not found.');
    if (iCategory  === -1) return jsonResponse_("error", 'Late Entry: "Category" not found.');
    if (iPenalty   === -1) return jsonResponse_("error", 'Late Entry: "Late Penalty Count" not found.');
    if (iDOJ       === -1) return jsonResponse_("error", 'Late Entry: "DOJ" not found.');
    if (iTotalLate === -1) return jsonResponse_("error", 'Late Entry: "Total Late Duration" not found.');

    const dateStartCol1 = iDOJ + 2;
    const dateEndCol1   = iTotalLate;

    if (dateEndCol1 < dateStartCol1) {
      return jsonResponse_("error", "Late Entry: Date columns not detected.");
    }

    const maxRows = sh.getLastRow();
    if (maxRows < 2) {
      return jsonResponse_("error", "No employee rows found in Late Entry.");
    }

    const empCodes = sh.getRange(2, iEmpCode + 1, maxRows - 1, 1).getValues();
    let lastEmpIndex0 = -1;
    for (let i = empCodes.length - 1; i >= 0; i--) {
      if (String(empCodes[i][0] || "").trim() !== "") {
        lastEmpIndex0 = i;
        break;
      }
    }

    if (lastEmpIndex0 === -1) {
      return jsonResponse_("error", "No Employee Code values found in Late Entry.");
    }

    recalcLateEntryPenalty_Runner_(
      sh, iPenalty, iEmpCode, iCategory,
      dateStartCol1, dateEndCol1, lastEmpIndex0, lastCol
    );

    return jsonResponse_(
      "success",
      `Late penalty calculated ✅ Employees processed: ${lastEmpIndex0 + 1}`
    );

  } catch (err) {
    return jsonResponse_("error", "recalcLateEntryPenalty failed: " + err.message);
  }
}

/**
 * removeInactiveEmployee
 * Requires: spreadsheetId, empCode in payload.
 * Sets active spreadsheet to the correct generated file before detecting state.
 * Validates lock, then calls removeInactiveEmployee_Runner_()
 * in 08_RemoveInactiveEmployee.gs.
 * All UI (warning + prompt) already done on hrassist's side before this call.
 */
function removeInactiveEmployeeServer_(payload) {
  try {
    const ssId    = String(payload.spreadsheetId || "").trim();
    const empCode = String(payload.empCode        || "").trim();

    if (!ssId) {
      return jsonResponse_("error", "Missing spreadsheetId in payload.");
    }
    if (!empCode) {
      return jsonResponse_("error", "Missing empCode in payload.");
    }

    const ss = SpreadsheetApp.openById(ssId);
    SpreadsheetApp.setActiveSpreadsheet(ss);

    const sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
    if (!sheet) {
      return jsonResponse_("error", `Sheet "${ATTENDANCE_SHEET_NAME}" not found.`);
    }

    if (isAttendanceLocked_()) {
      return jsonResponse_("error", "Attendance is LOCKED. Removing an employee is not allowed.");
    }

    removeInactiveEmployee_Runner_(sheet, ss, empCode);

    return jsonResponse_(
      "success",
      `Employee "${empCode}" has been removed from Attendance entry and Late Entry.`
    );

  } catch (err) {
    return jsonResponse_("error", "removeInactiveEmployee failed: " + err.message);
  }
}

/* ================================================
 * Utility
 * ================================================ */

/**
 * Builds a JSON ContentService response.
 * @param {"success"|"error"} status
 * @param {string} message
 */
function jsonResponse_(status, message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status, message }))
    .setMimeType(ContentService.MimeType.JSON);
}
