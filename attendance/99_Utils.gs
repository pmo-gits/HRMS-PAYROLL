/************************************************
 * 99_Utils.gs
 ************************************************/

function parseMonthYear_(input) {
  const s = String(input || "").trim();

  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const year = Number(m[1]);
    const mon = Number(m[2]);
    if (mon >= 1 && mon <= 12) return { year, monthIndex0: mon - 1 };
    return null;
  }

  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const year = Number(m[2]);
    const monName = m[1].toLowerCase();
    const monthIndex0 = monthIndexFromName_(monName);
    if (monthIndex0 >= 0) return { year, monthIndex0 };
  }

  return null;
}

function parseHeaderDate_(mmddyyyy) {
  const s = String(mmddyyyy || "").trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[3]);
  if (month < 1 || month > 12) return null;
  return { year, monthIndex0: month - 1 };
}

function monthIndexFromName_(monNameLower) {
  const months = [
    "january","february","march","april","may","june",
    "july","august","september","october","november","december"
  ];
  return months.indexOf(monNameLower);
}

function monthName_(monthIndex0) {
  const months = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December"
  ];
  return months[monthIndex0] || "";
}

function getExpectedAttendanceFileName_(monthIndex0, year) {
  return `Attendance_${monthName_(monthIndex0)}_${year}`;
}

function attendanceFileExistsInFolder_(folderId, fileName, currentFileId) {
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    const f = files.next();
    if (f.getId() !== currentFileId) return true;
  }
  return false;
}

function updateDateHeadersAndVisibility_(sheet, year, monthIndex0, daysInMonth) {
  const labels = [];
  for (let d = 1; d <= 31; d++) {
    if (d <= daysInMonth) {
      const mm = String(monthIndex0 + 1).padStart(2, "0");
      const dd = String(d).padStart(2, "0");
      labels.push(`${mm}-${dd}-${year}`);
    } else {
      labels.push("");
    }
  }

  sheet.getRange(1, DATE_START_COL, 1, 31).setValues([labels]);

  for (let d = 1; d <= 31; d++) {
    const col = DATE_START_COL + (d - 1);
    if (d <= daysInMonth) sheet.showColumns(col);
    else sheet.hideColumns(col);
  }
}

function clearApprovedLeaveColumns_(sheet, empCount) {
  if (empCount <= 0) return;

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(h => String(h || "").trim().toUpperCase());

  APPROVED_HEADERS_TO_CLEAR.forEach(target => {
    const idx = headers.indexOf(String(target).trim().toUpperCase());
    if (idx === -1) return;
    const col = idx + 1;
    sheet.getRange(2, col, empCount, 1).clearContent();
  });
}

function applyAttendanceDropdownValidation_(sheet, startRow, numRows, year, monthIndex0, daysInMonth) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["P", "A", "HD", "LO"], true)
    .setAllowInvalid(false)
    .build();

  // Sundays are excluded — those columns get "WO" via
  // applySundayWOFormattingAndProtection_ and are protected right after,
  // so they must not carry the P/A/HD/LO-only rule.
  for (let day = 1; day <= daysInMonth; day++) {
    const dt = new Date(year, monthIndex0, day);
    if (dt.getDay() === 0) continue;
    const col = DATE_START_COL + (day - 1);
    sheet.getRange(startRow, col, numRows, 1).setDataValidation(rule);
  }
}

function fillWOSundaysForRows_(sheet, year, monthIndex0, daysInMonth, startRow, numRows) {
  if (numRows <= 0) return;

  const matrix = Array.from({ length: numRows }, () => new Array(31).fill(""));

  for (let day = 1; day <= daysInMonth; day++) {
    const dt = new Date(year, monthIndex0, day);
    if (dt.getDay() !== 0) continue;
    const idx = day - 1;
    for (let r = 0; r < numRows; r++) matrix[r][idx] = "WO";
  }

  sheet.getRange(startRow, DATE_START_COL, numRows, 31).setValues(matrix);
}

function applySundayWOFormattingAndProtection_(sheet, year, monthIndex0, daysInMonth, empCount) {
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  protections.forEach(p => {
    const desc = p.getDescription() || "";
    if (desc.startsWith(SUNDAY_PROTECTION_PREFIX)) {
      try { p.remove(); } catch (e) {}
    }
  });

  sheet.getRange(1, DATE_START_COL, 1, 31).setBackground(null);

  for (let day = 1; day <= daysInMonth; day++) {
    const dt = new Date(year, monthIndex0, day);
    if (dt.getDay() !== 0) continue;

    const col = DATE_START_COL + (day - 1);

    sheet.getRange(1, col).setBackground("#ff0000");

    if (empCount > 0) {
      const sundayRange = sheet.getRange(2, col, empCount, 1);
      sundayRange.setDataValidation(null); // Sunday cells are never P/A/HD/LO — clear any stray rule before writing WO
      sundayRange.setValue("WO");
    }

    const protectRange = sheet.getRange(2, col, Math.max(empCount, 1), 1);
    const protection = protectRange.protect();
    protection.setDescription(
      `${SUNDAY_PROTECTION_PREFIX}${year}-${String(monthIndex0 + 1).padStart(2, "0")}-D${String(day).padStart(2, "0")}`
    );
    protection.setWarningOnly(false);

    try {
      protection.removeEditors(protection.getEditors());
      if (protection.canDomainEdit()) protection.setDomainEdit(false);
    } catch (e) {}
  }
}

function getSheetTitleByIdCached_(spreadsheetId, sheetId) {
  const cache = CacheService.getScriptCache();
  const key = `${spreadsheetId}_${sheetId}`;
  let title = cache.get(key);
  if (title) return title;

  const meta = Sheets.Spreadsheets.get(spreadsheetId, { fields: "sheets(properties(sheetId,title))" });
  const found = (meta.sheets || []).find(s => s.properties && s.properties.sheetId === sheetId);
  if (!found) throw new Error(`SheetId ${sheetId} not found in spreadsheet ${spreadsheetId}`);

  title = found.properties.title;
  cache.put(key, title, 21600);
  return title;
}

/************************************************
 * ✅ CENTRALIZED CLEARING RULE (MONTH REFRESH)
 *
 * Clears:
 * - Attendance entry A:H + I2:AM1000 + Approved leave columns
 * - Leave Balances A2:G
 * - Late Entry A:H + I:AM (rows 2..maxRows) + summary columns (till sheet end)
 *   NOTE: TOTAL LATE DURATION is NOT cleared (as requested)
 * - OT Entry inputs only by HEADER NAME (Date, Employee Code, OT Start, OT End, OT Purpose)
 *   rows 2..1000 (keeps other formulas/headers safely even if columns shift)
 * - Other Payments inputs by HEADER NAME (Employee Code, Payment Type, Amount, Month Applicable [MM/DD/YY], Remarks, Approved By)
 *   rows 2..maxRows (keeps formula-driven columns intact)
 * - Other Deductions inputs by HEADER NAME (Employee Code, Deduction Type, Amount, Month Applicable [MM/DD/YY], Remarks)
 *   rows 2..maxRows (keeps formula-driven columns intact)
 * - Salary Advance deductions inputs by HEADER NAME (rows 2..maxRows)
 *   includes SA Run Timestamp (row 2 cleared on refresh)
 ************************************************/
function clearMonthlySheets_(attendanceSheet, empCount, year, monthIndex0, daysInMonth) {
  const ATTENDANCE_MARKS_CLEAR_LAST_ROW = 1000;

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Attendance I2:AM1000 sizing
  const startRow = 2;
  const numRowsAttendance = Math.max(ATTENDANCE_MARKS_CLEAR_LAST_ROW - startRow + 1, 0);

  // 1) Attendance entry: Clear A:H below header
  const lastRow = attendanceSheet.getLastRow();
  if (lastRow >= 2) {
    attendanceSheet.getRange(2, 1, lastRow - 1, STATIC_COLS_COUNT).clearContent();
  }

  // 2) Attendance entry: Clear I:AM1000 (values only; keep validation)
  if (numRowsAttendance > 0) {
    attendanceSheet
      .getRange(startRow, DATE_START_COL, numRowsAttendance, (DATE_END_COL - DATE_START_COL + 1))
      .clearContent();
  }

  // 3) Attendance entry: Clear Approved leave columns
  clearApprovedLeaveColumns_(attendanceSheet, empCount);

  // 4) Leave Balances: Clear A2:G
  const lb = ss.getSheetByName(LEAVE_BALANCES_SHEET_NAME);
  if (lb) {
    const lbLast = lb.getLastRow();
    if (lbLast >= 2) {
      lb.getRange(2, 1, lbLast - 1, 7).clearContent();
    }
  }

  // 5) Late Entry: Clear A:H + I:AM (rows 2..maxRows) + summary columns (till sheet end)
  const late = ss.getSheetByName(LATE_ENTRY_SHEET_NAME);
  if (late) {
    const lateLast = late.getLastRow();
    if (lateLast >= 2) {
      late.getRange(2, 1, lateLast - 1, STATIC_COLS_COUNT).clearContent();
    }

    // ✅ Clear Late minutes entries I:AM for FULL PAGE rows (2..maxRows)
    const lateMaxRows = late.getMaxRows();
    if (lateMaxRows >= 2) {
      late.getRange(2, DATE_START_COL, lateMaxRows - 1, (DATE_END_COL - DATE_START_COL + 1)).clearContent();
    }

    // ✅ Clear calculated summary columns till sheet end (but NOT Total Late Duration)
    clearLateEntrySummaryColumns_(late, 2, late.getMaxRows());
  }

  // 6) OT Entry: Clear inputs only by HEADER NAME (safe if columns shift)
  const ot = ss.getSheetByName(OT_ENTRY_SHEET_NAME);
  if (ot) {
    clearOTEntryInputsByHeader_(ot, 2, 1000);
  }

  // 7) Other Payments: Clear selected inputs only by HEADER NAME (rows 2..maxRows)
  const op = ss.getSheetByName(OTHER_PAYMENTS_SHEET_NAME);
  if (op) {
    clearOtherPaymentsInputsByHeader_(op, 2, op.getMaxRows());
  }

  // 8) Other Deductions: Clear selected inputs only by HEADER NAME (rows 2..maxRows)
  const od = ss.getSheetByName(OTHER_DEDUCTIONS_SHEET_NAME);
  if (od) {
    clearOtherDeductionsInputsByHeader_(od, 2, od.getMaxRows());
  }

  // 9) Salary Advance deductions: Clear selected inputs only by HEADER NAME (rows 2..maxRows)
  const sad = ss.getSheetByName(SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME);
  if (sad) {
    clearSalaryAdvanceDeductionsInputsByHeader_(sad, 2, sad.getMaxRows());
  }
}

/**
 * Clears Late Entry calculated summary columns by header name
 * - Clears rows startRow..endRow (endRow = sheet.getMaxRows() as requested)
 * - DOES NOT clear "TOTAL LATE DURATION"
 */
function clearLateEntrySummaryColumns_(sh, startRow, endRow) {
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(h => String(h || "").trim().toUpperCase());

  const targets = [
    "LEAVE PENALTY COUNT",
    "TOTAL LOP DAYS"
  ];

  const numRows = Math.max(endRow - startRow + 1, 0);
  if (numRows <= 0) return;

  targets.forEach(t => {
    const idx = headers.indexOf(t);
    if (idx === -1) return;
    sh.getRange(startRow, idx + 1, numRows, 1).clearContent();
  });
}

/**
 * ✅ OT Entry: Clear selected input columns by HEADER NAME
 * Clears values only for rows startRow..endRow
 * Targets:
 * - DATE
 * - EMPLOYEE CODE
 * - OT START
 * - OT END
 * - OT PURPOSE
 *
 * This prevents issues when inserting columns in OT Entry sheet.
 */
function clearOTEntryInputsByHeader_(sh, startRow, endRow) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(h => String(h || "").trim().toUpperCase());

  const targets = [
    "DATE",
    "EMPLOYEE CODE",
    "OT START",
    "OT END",
    "OT PURPOSE"
  ];

  const numRows = Math.max(endRow - startRow + 1, 0);
  if (numRows <= 0) return;

  targets.forEach(t => {
    const idx = headers.indexOf(t);
    if (idx === -1) return; // safe skip
    sh.getRange(startRow, idx + 1, numRows, 1).clearContent();
  });
}

/**
 * ✅ Other Payments: Clear selected input columns by HEADER NAME
 * Clears values only for rows startRow..endRow
 * Targets (as confirmed):
 * - EMPLOYEE CODE
 * - PAYMENT TYPE
 * - AMOUNT
 * - MONTH APPLICABLE [MM/DD/YY]
 * - REMARKS
 * - APPROVED BY
 *
 * Keeps formula-driven columns intact (Name/Department/Designation/Payment Nature/Consider Under).
 */
function clearOtherPaymentsInputsByHeader_(sh, startRow, endRow) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(h => String(h || "").trim().toUpperCase());

  const targets = [
    "EMPLOYEE CODE",
    "PAYMENT TYPE",
    "AMOUNT",
    "MONTH APPLICABLE [MM/DD/YY]",
    "REMARKS",
    "APPROVED BY"
  ];

  const numRows = Math.max(endRow - startRow + 1, 0);
  if (numRows <= 0) return;

  targets.forEach(t => {
    const idx = headers.indexOf(t);
    if (idx === -1) return; // safe skip
    sh.getRange(startRow, idx + 1, numRows, 1).clearContent();
  });
}

/**
 * ✅ Other Deductions: Clear selected input columns by HEADER NAME
 * Clears values only for rows startRow..endRow
 * Targets (as confirmed):
 * - EMPLOYEE CODE
 * - DEDUCTION TYPE   (preferred)
 * - AMOUNT
 * - MONTH APPLICABLE [MM/DD/YY]
 * - REMARKS
 *
 * Note:
 * - If your sheet uses "PAYMENT TYPE" instead of "DEDUCTION TYPE", it will also be cleared.
 * Keeps formula-driven columns intact (Name/Department/Designation/Consider Under).
 */
function clearOtherDeductionsInputsByHeader_(sh, startRow, endRow) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(h => String(h || "").trim().toUpperCase());

  const targets = [
    "EMPLOYEE CODE",
    "DEDUCTION TYPE",
    "PAYMENT TYPE", // backward-compatible if header not renamed yet
    "AMOUNT",
    "MONTH APPLICABLE [MM/DD/YY]",
    "REMARKS"
  ];

  const numRows = Math.max(endRow - startRow + 1, 0);
  if (numRows <= 0) return;

  targets.forEach(t => {
    const idx = headers.indexOf(t);
    if (idx === -1) return; // safe skip
    sh.getRange(startRow, idx + 1, numRows, 1).clearContent();
  });
}

/**
 * ✅ Salary Advance deductions: Clear selected input columns by HEADER NAME
 * Clears values only for rows startRow..endRow
 * Targets (as confirmed):
 * - MONTH
 * - EMPLOYEE CODE
 * - NAME
 * - DEPARTMENT
 * - EMI REFERENCE NUMBER
 * - EMI AMOUNT
 * - CURRENT BALANCE
 * - HR DECISION
 * - PAYROLL STATUS
 * - RECOVERED AMOUNT
 * - SA RUN TIMESTAMP (row 2 cleared on month refresh — header in row 1 preserved)
 *
 * Keeps any non-target columns intact.
 */
function clearSalaryAdvanceDeductionsInputsByHeader_(sh, startRow, endRow) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(h => String(h || '').trim().toUpperCase());

  const targets = [
    'MONTH',
    'EMPLOYEE CODE',
    'NAME',
    'DEPARTMENT',
    'EMI REFERENCE NUMBER',
    'EMI AMOUNT',
    'CURRENT BALANCE',
    'HR DECISION',
    'PAYROLL STATUS',
    'RECOVERED AMOUNT',
    'SA RUN TIMESTAMP', // ✅ clears row 2 on month refresh; header in row 1 preserved
  ];

  const numRows = Math.max(endRow - startRow + 1, 0);
  if (numRows <= 0) return;

  targets.forEach(t => {
    const idx = headers.indexOf(t);
    if (idx === -1) return; // safe skip
    sh.getRange(startRow, idx + 1, numRows, 1).clearContent();
  });
}
