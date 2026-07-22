/************************************************
 * 03_Attendance_SyncNew.gs
 ************************************************/
function syncNewEmployeesAppendOnly() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const user = Session.getEffectiveUser().getEmail();
  const PMO = "pmo@butlerleather.com";
  const ALLOWED = "hrassist@butlerleather.com";

  // User gate
  if (user !== PMO && user !== ALLOWED) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  const sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sheet) {
    ui.alert(`Sheet "${ATTENDANCE_SHEET_NAME}" not found. Please update ATTENDANCE_SHEET_NAME in script.`);
    return;
  }

  // Block if locked
  if (isAttendanceLocked_()) {
    ui.alert("This attendance file is LOCKED.\nSync New Employees is not allowed.");
    return;
  }

  // Detect month/year from header I1
  const firstHeader = sheet.getRange(1, DATE_START_COL).getDisplayValue();
  const parsedHeader = parseHeaderDate_(firstHeader);
  if (!parsedHeader) {
    ui.alert('Cannot detect month/year from header I1. Please run "Refresh the attendance month - full sheet" once first.');
    return;
  }

  const { year, monthIndex0 } = parsedHeader;
  const daysInMonth = new Date(year, monthIndex0 + 1, 0).getDate();

  // Fetch ACTIVE employees
  const empRows = fetchActiveEmployees_();
  if (empRows.length === 0) {
    ui.alert("No ACTIVE employees found in Employee Master.");
    return;
  }

  // Existing employee codes (Column B)
  const lastRow = sheet.getLastRow();
  const existing = new Set();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    ids.forEach(r => {
      const v = String(r[0] || "").trim();
      if (v) existing.add(v);
    });
  }

  // New employees not present in Attendance entry
  const newRows = empRows.filter(r => {
    const empCode = String(r[1] || "").trim();
    return empCode && !existing.has(empCode);
  });

  if (newRows.length === 0) {
    ui.alert("No new ACTIVE employees to append.");
    return;
  }

  // Dispatch
  if (user === PMO) {
    syncNewEmployeesAppendOnly_Runner_(sheet, newRows, year, monthIndex0, daysInMonth);
  } else {
    // tally -> Web App
    try {
      const payload = { action: "syncNewEmployees", caller: user, spreadsheetId: ss.getId() };
      const response = UrlFetchApp.fetch(ATTENDANCE_WEBAPP_URL, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const result = JSON.parse(response.getContentText());
      if (result.status === "success") {
        ui.alert(result.message || "New employees synced successfully.");
      } else {
        ui.alert("Error: " + (result.message || "Unknown error from Web App."));
      }
    } catch (e) {
      ui.alert("Web App call failed: " + e.message);
    }
  }
}

/**
 * Sync New Employees (Internal Runner)
 * UI-free: called by both pmo direct path and Web App server handler.
 * Errors thrown — caller handles messaging.
 */
function syncNewEmployeesAppendOnly_Runner_(sheet, newRows, year, monthIndex0, daysInMonth) {
  // Find last actual employee row by scanning column B (not getLastRow)
  // — avoids appending below validation-only rows
  const maxRows = sheet.getMaxRows();
  const colBValues = sheet.getRange(2, 2, maxRows - 1, 1).getValues();
  let lastEmpRow = 1;
  for (let i = colBValues.length - 1; i >= 0; i--) {
    if (String(colBValues[i][0] || "").trim() !== "") {
      lastEmpRow = i + 2; // +1 for 0-index, +1 for header row
      break;
    }
  }
  const appendStartRow = lastEmpRow + 1;

  // Ensure enough rows
  const needed = appendStartRow + newRows.length - 1;
  if (sheet.getMaxRows() < needed) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  }

  // Append A:H in Attendance entry
  sheet.getRange(appendStartRow, 1, newRows.length, STATIC_COLS_COUNT).setValues(newRows);

  // Apply dropdowns for appended rows (I:AM)
  applyAttendanceDropdownValidation_(sheet, appendStartRow, newRows.length);

  // Fill WO in Sundays for appended rows only
  fillWOSundaysForRows_(sheet, year, monthIndex0, daysInMonth, appendStartRow, newRows.length);

  // Rebuild protections to include new rows
  // Use lastEmpRow + newRows.length to get accurate total — avoids getLastRow() counting validation rows
  const totalEmpCount = lastEmpRow + newRows.length - 1;
  applySundayWOFormattingAndProtection_(sheet, year, monthIndex0, daysInMonth, totalEmpCount);

  // Append same employees into Late Entry
  appendNewEmployeesToLateEntry_(newRows, year, monthIndex0, daysInMonth);
}
