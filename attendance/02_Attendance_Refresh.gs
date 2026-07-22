/************************************************
 * 02_Attendance_Refresh.gs
 ************************************************/

/**
 * Refresh Attendance Month (Wrapper)
 */
function refreshAttendanceMonth_FullSheet() {
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

  const resp = ui.prompt(
    "Refresh Attendance Month",
    'Enter month & year (examples:"2025-12")',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const parsed = parseMonthYear_(resp.getResponseText());
  if (!parsed) {
    ui.alert('Invalid format. Use "2025-12".');
    return;
  }

  const { year, monthIndex0 } = parsed;
  const expectedName = getExpectedAttendanceFileName_(monthIndex0, year);

  const actualName = ss.getName().trim();
  if (actualName !== expectedName) {
    ui.alert(
      `File name mismatch!\n\nSelected month: ${monthName_(monthIndex0)} ${year}\nExpected file name: ${expectedName}\nCurrent file name: ${actualName}\n\nPlease rename the file correctly and try again.`
    );
    return;
  }

  const duplicateExists = attendanceFileExistsInFolder_(MONTHLY_ATTENDANCE_FOLDER_ID, expectedName, ss.getId());
  if (duplicateExists) {
    ui.alert(
      `Duplicate attendance file detected in Monthly Attendance folder.\n\nA file named "${expectedName}" already exists.\n\nStop to avoid multiple attendance files for the same month.`
    );
    return;
  }

  // LOCK RULE
  if (isAttendanceLocked_()) {
    const sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
    if (!sheet) {
      ui.alert(`Sheet "${ATTENDANCE_SHEET_NAME}" not found. Please update ATTENDANCE_SHEET_NAME in script.`);
      return;
    }

    const firstHeader = sheet.getRange(1, DATE_START_COL).getDisplayValue();
    const headerParsed = parseHeaderDate_(firstHeader);

    if (headerParsed && headerParsed.year === year && headerParsed.monthIndex0 === monthIndex0) {
      ui.alert("This attendance file is LOCKED for this month.\nRefresh is not allowed.");
      return;
    }

    // Different month detected -> auto unlock
    autoUnlockAttendance_();
  }

  // Dispatch
  if (user === PMO) {
    refreshAttendanceMonth_WithParsed_(year, monthIndex0);
    ui.alert(`Attendance refreshed for ${monthName_(monthIndex0)} ${year}.`);
  } else {
    // tally -> Web App
    try {
      const payload = { action: "refreshAttendanceMonth", year, monthIndex0, caller: user, spreadsheetId: ss.getId() };
      const response = UrlFetchApp.fetch(ATTENDANCE_WEBAPP_URL, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const result = JSON.parse(response.getContentText());
      if (result.status === "success") {
        ui.alert(result.message || "Attendance refreshed successfully.");
      } else {
        ui.alert("Error: " + (result.message || "Unknown error from Web App."));
      }
    } catch (e) {
      ui.alert("Web App call failed: " + e.message);
    }
  }
}

/**
 * Refresh Attendance Month (Internal Runner)
 * UI-free: called by both pmo direct path and Web App server handler.
 * Errors thrown — caller handles messaging.
 */
function refreshAttendanceMonth_WithParsed_(year, monthIndex0) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sheet) {
    throw new Error(`Sheet "${ATTENDANCE_SHEET_NAME}" not found.`);
  }

  const daysInMonth = new Date(year, monthIndex0 + 1, 0).getDate();

  // Fetch ACTIVE employees
  const empRows = fetchActiveEmployees_();
  if (empRows.length === 0) {
    throw new Error("No ACTIVE employees found in Employee Master.");
  }

  // Centralized clearing (Attendance entry + Leave Balances + Late Entry + OT Entry inputs)
  clearMonthlySheets_(sheet, empRows.length, year, monthIndex0, daysInMonth);

  // Ensure enough rows exist
  const neededRows = empRows.length + 1; // header + employees
  if (sheet.getMaxRows() < neededRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
  }

  // Write A:H
  sheet.getRange(2, 1, empRows.length, STATIC_COLS_COUNT).setValues(empRows);

  // Update date headers I:AM + hide extra date columns
  updateDateHeadersAndVisibility_(sheet, year, monthIndex0, daysInMonth);

  // Sundays: red + WO + protect
  applySundayWOFormattingAndProtection_(sheet, year, monthIndex0, daysInMonth, empRows.length);

  // Late Entry refresh (same behavior as Attendance)
  refreshLateEntrySheet_(year, monthIndex0, empRows);

  // Carry Forwarded refresh (clear specific headers only; no empRows)
  refreshCarryForwardedSheet_();
}
