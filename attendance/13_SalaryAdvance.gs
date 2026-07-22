/************************************************
 * 13_SalaryAdvance.gs  (Attendance file)
 *
 * Functions:
 * 1) Get Salary Advance EMI  -> getSalaryAdvanceEMI_Button()
 *    - Requires Attendance LOCKED (LOCKED STATUS contains "LOCKED")
 *    - Loads snapshot from Master "Shared EMI Summary" by Attendance File Name
 *    - If snapshot not present: fetch from Master "EMI_SCHEDULE" where Status = ACTIVE
 *      then append snapshot into Master "Shared EMI Summary"
 *    - Writes into Attendance "Salary Advance deductions"
 *    - Clears ONLY these columns before paste:
 *      Month, Employee Code, Name, Department, EMI Reference Number, EMI Amount, Current Balance, HR Decision
 *      (Does NOT clear Planned EMI, Payroll Status)
 *
 * 2) Refresh Salary Advance EMI -> refreshSalaryAdvanceEMI_Button()
 *    - Requires Attendance LOCKED
 *    - Also blocks if Payroll is locked (based on Salary Advance deductions → "Payroll Status" not empty)
 *    - Fetches ACTIVE rows from Master EMI_SCHEDULE for the month
 *    - Appends missing rows into Master Shared EMI Summary (dedupe)
 *    - Loads the snapshot (Master Shared EMI Summary) into Attendance deductions
 *    - Clears ONLY these columns before paste:
 *      Month, Employee Code, Name, Department, EMI Reference Number, EMI Amount, Current Balance, HR Decision
 *      (Does NOT clear Planned EMI, Payroll Status)
 *
 * ✅ ADDITIONAL GUARD:
 * - Both buttons run ONLY when active sheet is "Salary Advance deductions"
 *
 * ✅ SA Run Timestamp:
 * - writeToDeductions_() always writes timestamp in row 2 of "SA Run Timestamp" column
 * - Written even when no EMI rows found (button was clicked = SA was run)
 * - Header written in row 1 if not already present
 * - Row 2 cleared by clearSalaryAdvanceDeductionsInputsByHeader_() on month refresh
 *   (SA RUN TIMESTAMP in targets list in 99_Utils.gs)
 ************************************************/

/** ✅ GET Salary Advance EMI */
function getSalaryAdvanceEMI_Button() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // ✅ Must run from Salary Advance deductions tab only
  const activeSheet = ss.getActiveSheet();
  if (!activeSheet || activeSheet.getName() !== SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME) {
    ui.alert("Stop", `Please run this button from "${SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME}" sheet only.`, ui.ButtonSet.OK);
    return;
  }

  // 1) Must be Attendance LOCKED
  if (!isAttendanceLockedForSalaryAdvance_(ss)) {
    ui.alert("Stop", "Attendance entry is not LOCKED. Please lock the file first.", ui.ButtonSet.OK);
    return;
  }

  const attendanceFileName = String(ss.getName() || "").trim();
  const monthKey = monthKeyFromAttendanceFileName_(attendanceFileName);
  if (!monthKey) {
    ui.alert("Stop", `Invalid file name "${attendanceFileName}". Expected like Attendance_January_2026`, ui.ButtonSet.OK);
    return;
  }

  const deductions = ss.getSheetByName(SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME);
  if (!deductions) {
    ui.alert("Stop", `Sheet not found: ${SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME}`, ui.ButtonSet.OK);
    return;
  }

  // 2) Payroll lock stop (based on deductions sheet "Payroll Status")
  if (isPayrollLockedInDeductions_(deductions)) {
    ui.alert("Stop", "Payroll is LOCKED (Payroll Status is filled). Get EMI is not allowed.", ui.ButtonSet.OK);
    return;
  }

  // 3) Open Master
  const master = SpreadsheetApp.openById(SALARY_ADVANCE_MASTER_SPREADSHEET_ID);

  // 4) Snapshot first: Master Shared EMI Summary
  const masterShared = getOrCreateSheet_(master, MASTER_SHARED_EMI_SUMMARY_SHEET_NAME);
  ensureHeaders_(masterShared, [
    "Attendance File Name",
    "Month",
    "Employee Code",
    "Name",
    "Department",
    "EMI Reference Number",
    "EMI Amount",
    "Current Balance",
    "Payroll Status",
  ]);

  let rows7 = readMasterSharedRows_(masterShared, attendanceFileName, monthKey);

  // 5) If snapshot missing -> fetch ACTIVE from EMI_SCHEDULE and append snapshot
  if (!rows7.length) {
    const rowsFromSchedule7 = fetchActiveRowsFromMasterSchedule_(master, monthKey);

    if (!rowsFromSchedule7.length) {
      // ✅ No EMI rows found — still write timestamp then inform user
      writeToDeductions_(deductions, [], /*clearBefore*/ false);
      ui.alert("Info", `No ACTIVE EMI rows found in master EMI_SCHEDULE for ${monthKey}.`, ui.ButtonSet.OK);
      return;
    }

    appendToMasterShared_(masterShared, attendanceFileName, rowsFromSchedule7);
    rows7 = rowsFromSchedule7;
  }

  // 6) Write to Salary Advance deductions
  // Clears ONLY: Month..Current Balance + HR Decision
  // Does NOT clear Planned EMI / Payroll Status
  const out8 = rows7.map(r7 => [...r7, ""]); // add HR Decision blank
  writeToDeductions_(deductions, out8, /*clearBefore*/ true);

  ui.alert("Done", `Loaded ${out8.length} EMI rows for ${monthKey}.`, ui.ButtonSet.OK);
}

/** ✅ REFRESH Salary Advance EMI */
function refreshSalaryAdvanceEMI_Button() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // ✅ Must run from Salary Advance deductions tab only
  const activeSheet = ss.getActiveSheet();
  if (!activeSheet || activeSheet.getName() !== SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME) {
    ui.alert("Stop", `Please run this button from "${SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME}" sheet only.`, ui.ButtonSet.OK);
    return;
  }

  // 1) Must be Attendance LOCKED
  if (!isAttendanceLockedForSalaryAdvance_(ss)) {
    ui.alert("Stop", "Attendance entry is not LOCKED. Please lock the file first.", ui.ButtonSet.OK);
    return;
  }

  const attendanceFileName = String(ss.getName() || "").trim();
  const monthKey = monthKeyFromAttendanceFileName_(attendanceFileName);
  if (!monthKey) {
    ui.alert("Stop", `Invalid file name "${attendanceFileName}". Expected like Attendance_January_2026`, ui.ButtonSet.OK);
    return;
  }

  const deductions = ss.getSheetByName(SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME);
  if (!deductions) {
    ui.alert("Stop", `Sheet not found: ${SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME}`, ui.ButtonSet.OK);
    return;
  }

  // 2) Payroll lock stop (based on deductions sheet "Payroll Status")
  if (isPayrollLockedInDeductions_(deductions)) {
    ui.alert("Stop", "Payroll is LOCKED (Payroll Status is filled). Refresh is not allowed.", ui.ButtonSet.OK);
    return;
  }

  // 3) Open Master
  const master = SpreadsheetApp.openById(SALARY_ADVANCE_MASTER_SPREADSHEET_ID);

  const masterShared = getOrCreateSheet_(master, MASTER_SHARED_EMI_SUMMARY_SHEET_NAME);
  ensureHeaders_(masterShared, [
    "Attendance File Name",
    "Month",
    "Employee Code",
    "Name",
    "Department",
    "EMI Reference Number",
    "EMI Amount",
    "Current Balance",
    "Payroll Status",
  ]);

  // 4) Fetch ACTIVE rows from Master EMI_SCHEDULE for that month
  const activeRows7 = fetchActiveRowsFromMasterSchedule_(master, monthKey);
  if (activeRows7.length) {
    // 5) Append missing rows into Master Shared EMI Summary (dedupe)
    appendToMasterShared_(masterShared, attendanceFileName, activeRows7);
  }

  // 6) Load snapshot from Master Shared EMI Summary
  const snapshotRows7 = readMasterSharedRows_(masterShared, attendanceFileName, monthKey);

  // 7) Write to deductions:
  // - Clear ONLY columns: Month..HR Decision (A:H by header mapping)
  // - Paste fresh list (Month..Current Balance + HR Decision blank)
  const out8 = snapshotRows7.map(r7 => [...r7, ""]); // add HR Decision blank
  writeToDeductions_(deductions, out8, /*clearBefore*/ true);

  ui.alert("Done", `Refreshed EMI rows for ${monthKey}. Rows loaded: ${out8.length}`, ui.ButtonSet.OK);
}

/* =========================================================
 * Helpers (inside this file only)
 * ========================================================= */

function isAttendanceLockedForSalaryAdvance_(ss) {
  const sh = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sh) throw new Error(`Sheet not found: ${ATTENDANCE_SHEET_NAME}`);

  const headers = getHeaderRow_(sh);
  const idx = indexOfHeader_(headers, "LOCKED STATUS");
  if (idx === -1) throw new Error(`Header "LOCKED STATUS" not found in ${ATTENDANCE_SHEET_NAME}`);

  const raw = String(sh.getRange(2, idx + 1).getValue() || "").trim().toUpperCase();
  return raw.includes("LOCKED");
}

function isPayrollLockedInDeductions_(deductionsSheet) {
  const headers = getHeaderRow_(deductionsSheet);
  const idx = indexOfHeader_(headers, "PAYROLL STATUS");
  if (idx === -1) return false;

  const maxRows = deductionsSheet.getMaxRows();
  if (maxRows < 2) return false;

  const vals = deductionsSheet.getRange(2, idx + 1, maxRows - 1, 1).getDisplayValues();
  return vals.some(r => String(r[0] || "").trim() !== "");
}

function monthKeyFromAttendanceFileName_(fileName) {
  const m = String(fileName || "").trim().match(/^Attendance[_\-\s]+([A-Za-z]+)[_\-\s]+(\d{4})$/i);
  if (!m) return null;

  const monName = String(m[1] || "").trim().toLowerCase();
  const year = String(m[2] || "").trim();

  const mi = monthIndexFromName_(monName);
  if (mi < 0) return null;

  return `${monthName_(mi)} ${year}`; // "January 2026"
}

function normalizeMonthToKey_(val) {
  if (val == null || val === "") return null;

  if (Object.prototype.toString.call(val) === "[object Date]" && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "MMMM yyyy");
  }

  const s = String(val).trim();
  if (!s) return null;

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "MMMM yyyy");
  }

  const parts = s.replace(/\s+/g, " ").split(" ");
  if (parts.length >= 2) {
    const mi = monthIndexFromName_(String(parts[0]).toLowerCase());
    const year = (s.match(/\b\d{4}\b/) || [null])[0];
    if (mi >= 0 && year) return `${monthName_(mi)} ${year}`;
  }

  return s;
}

function monthIndexFromName_(monNameLower) {
  const months = [
    "january","february","march","april","may","june",
    "july","august","september","october","november","december"
  ];
  return months.indexOf(String(monNameLower || "").trim());
}

function monthName_(monthIndex0) {
  const months = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December"
  ];
  return months[monthIndex0] || "";
}

function getOrCreateSheet_(spreadsheet, name) {
  let sh = spreadsheet.getSheetByName(name);
  if (!sh) sh = spreadsheet.insertSheet(name);
  return sh;
}

function ensureHeaders_(sheet, headers) {
  const lastCol = Math.max(sheet.getLastColumn(), headers.length);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  const ok = headers.every((h, i) => existing[i] === h);
  if (!ok) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function getHeaderRow_(sheet) {
  const lastCol = sheet.getLastColumn();
  return sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(h => String(h || "").trim());
}

function indexOfHeader_(headers, target) {
  const t = String(target || "").trim().toUpperCase();
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] || "").trim().toUpperCase() === t) return i;
  }
  return -1;
}

function headerIndexMapCaseSensitive_(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h || "").trim();
    if (key) map[key] = i;
  });
  return map;
}

function readMasterSharedRows_(masterSharedSheet, attendanceFileName, monthKey) {
  const data = masterSharedSheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const out = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const file = String(row[0] || "").trim();
    if (file !== attendanceFileName) continue;

    const mk = normalizeMonthToKey_(row[1]);
    if (mk && mk !== monthKey) continue;

    out.push([
      row[1], // Month
      row[2], // Employee Code
      row[3], // Name
      row[4], // Department
      row[5], // EMI Reference Number
      row[6], // EMI Amount
      row[7], // Current Balance
    ]);
  }
  return out;
}

function fetchActiveRowsFromMasterSchedule_(masterSpreadsheet, monthKey) {
  const sh = masterSpreadsheet.getSheetByName(MASTER_EMI_SCHEDULE_SHEET_NAME);
  if (!sh) throw new Error(`Master tab not found: ${MASTER_EMI_SCHEDULE_SHEET_NAME}`);

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => String(h || "").trim());
  const idx = headerIndexMapCaseSensitive_(headers);

  const required = ["Month", "Employee Code", "Name", "Department", "EMI Reference Number", "EMI Amount", "Current Balance", "Status"];
  const missing = required.filter(h => idx[h] == null);
  if (missing.length) throw new Error(`Missing headers in Master EMI_SCHEDULE: ${missing.join(", ")}`);

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];

    const rowMonthKey = normalizeMonthToKey_(row[idx["Month"]]);
    if (rowMonthKey !== monthKey) continue;

    const status = String(row[idx["Status"]] || "").trim().toUpperCase();
    if (status !== "ACTIVE") continue;

    out.push([
      row[idx["Month"]],
      row[idx["Employee Code"]],
      row[idx["Name"]],
      row[idx["Department"]],
      row[idx["EMI Reference Number"]],
      row[idx["EMI Amount"]],
      row[idx["Current Balance"]],
    ]);
  }

  return out;
}

function appendToMasterShared_(masterSharedSheet, attendanceFileName, rows7) {
  if (!rows7.length) return;

  const existing = masterSharedSheet.getDataRange().getValues();
  const seen = new Set();

  for (let r = 1; r < existing.length; r++) {
    const file = String(existing[r][0] || "").trim();
    const mk = normalizeMonthToKey_(existing[r][1]);
    const emp = String(existing[r][2] || "").trim();
    const ref = String(existing[r][5] || "").trim();
    if (file && mk && emp && ref) seen.add([file, mk, emp, ref].join("|"));
  }

  const toAppend = [];
  for (const r7 of rows7) {
    const mk = normalizeMonthToKey_(r7[0]);
    const emp = String(r7[1] || "").trim();
    const ref = String(r7[4] || "").trim();
    const key = [attendanceFileName, mk, emp, ref].join("|");

    if (!seen.has(key)) {
      toAppend.push([attendanceFileName, ...r7, ""]);
      seen.add(key);
    }
  }

  if (toAppend.length) {
    masterSharedSheet
      .getRange(masterSharedSheet.getLastRow() + 1, 1, toAppend.length, 9)
      .setValues(toAppend);
  }
}

function writeToDeductions_(deductionsSheet, rows, clearBefore) {
  const headers = getHeaderRow_(deductionsSheet);
  const mapU = headers.map(h => String(h || "").trim().toUpperCase());

  const colIndex = (nameUpper) => mapU.indexOf(String(nameUpper).trim().toUpperCase()) + 1; // 1-based, 0 if not found

  const colsToClear = [
    "MONTH",
    "EMPLOYEE CODE",
    "NAME",
    "DEPARTMENT",
    "EMI REFERENCE NUMBER",
    "EMI AMOUNT",
    "CURRENT BALANCE",
    "HR DECISION",
  ];

  if (clearBefore) {
    const maxRows = deductionsSheet.getMaxRows();
    const numRows = Math.max(maxRows - 1, 0);
    if (numRows > 0) {
      colsToClear.forEach(h => {
        const c = colIndex(h);
        if (c > 0) deductionsSheet.getRange(2, c, numRows, 1).clearContent();
      });
    }
  }

  // ✅ Stamp SA Run Timestamp in row 2 always — even if no EMI rows
  // Header written in row 1 if not already present
  // Row 2 cleared by clearSalaryAdvanceDeductionsInputsByHeader_() on month refresh
  const SA_TIMESTAMP_HEADER = "SA Run Timestamp";
  let tsCol = colIndex(SA_TIMESTAMP_HEADER);

  if (tsCol <= 0) {
    const nextCol = deductionsSheet.getLastColumn() + 1;
    deductionsSheet.getRange(1, nextCol).setValue(SA_TIMESTAMP_HEADER);
    tsCol = nextCol;
  }

  const stamp = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    "'Loaded — 'd MMM yyyy HH:mm"
  );
  deductionsSheet.getRange(2, tsCol).setValue(stamp);

  // Early return after stamp — no data rows to write
  if (!rows || rows.length === 0) return;

  const writeOrder = [
    "MONTH",
    "EMPLOYEE CODE",
    "NAME",
    "DEPARTMENT",
    "EMI REFERENCE NUMBER",
    "EMI AMOUNT",
    "CURRENT BALANCE",
    "HR DECISION",
    "PLANNED EMI",
  ];

  const width = rows[0].length;
  const startRow = 2;
  const numRows = rows.length;

  for (let i = 0; i < width; i++) {
    const hdr = writeOrder[i];
    const c = colIndex(hdr);
    if (c <= 0) continue;
    const colVals = rows.map(r => [r[i]]);
    deductionsSheet.getRange(startRow, c, numRows, 1).setValues(colVals);
  }
}
