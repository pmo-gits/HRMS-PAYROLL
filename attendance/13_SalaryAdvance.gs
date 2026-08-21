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
 * ✅ Settlement carry-forward (2d):
 * - Settlement Stage + Last Working Day are read from Master EMI_SCHEDULE and written by
 *   applySettlementColumns_(), as a SEPARATE write from the 7-field snapshot pipeline
 * - Settlement Stage is always protected (system-written)
 * - Last Working Day is protected only on rows already carrying a Settlement Stage; on all
 *   other rows it stays open so HR can record a departure
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
      applySettlementColumns_(deductions, [], new Map());
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

  // Captured BEFORE the write — writeToDeductions_ reshuffles rows (see helper note)
  const priorLwd = captureTypedLastWorkingDay_(deductions);
  writeToDeductions_(deductions, out8, /*clearBefore*/ true);

  // ✅ Settlement carry-forward — written separately, NOT folded into rows7 (see helper note)
  applySettlementColumns_(
    deductions, out8, fetchSettlementMapFromMasterSchedule_(master, monthKey), priorLwd
  );

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

  // Captured BEFORE the write — writeToDeductions_ reshuffles rows (see helper note)
  const priorLwd = captureTypedLastWorkingDay_(deductions);
  writeToDeductions_(deductions, out8, /*clearBefore*/ true);

  // ✅ Settlement carry-forward — written separately, NOT folded into rows7 (see helper note)
  applySettlementColumns_(
    deductions, out8, fetchSettlementMapFromMasterSchedule_(master, monthKey), priorLwd
  );

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

/**
 * Settlement Stage + Last Working Day for this month, keyed "EMPCODE||EMIREF".
 *
 * Deliberately a SEPARATE read from fetchActiveRowsFromMasterSchedule_(): that function's
 * 7-field tuple feeds appendToMasterShared_() and the 9-column "Shared EMI Summary" contract,
 * and widening it would force schema changes through four functions and that master tab.
 * Settlement data is read straight from EMI_SCHEDULE instead, and never travels via the snapshot.
 *
 * Not filtered by Status — a row whose settlement has just concluded still needs its stage
 * shown, and the deduction rows themselves are already the ACTIVE set.
 */
function fetchSettlementMapFromMasterSchedule_(masterSpreadsheet, monthKey) {
  const sh = masterSpreadsheet.getSheetByName(MASTER_EMI_SCHEDULE_SHEET_NAME);
  if (!sh) throw new Error(`Master tab not found: ${MASTER_EMI_SCHEDULE_SHEET_NAME}`);

  const values = sh.getDataRange().getValues();
  const map = new Map();
  if (values.length < 2) return map;

  const headers = values[0].map(h => String(h || "").trim());
  const idx = headerIndexMapCaseSensitive_(headers);

  const required = ["Month", "Employee Code", "EMI Reference Number", "Settlement Stage", "Last Working Day"];
  const missing = required.filter(h => idx[h] == null);
  if (missing.length) {
    throw new Error(`Missing headers in Master ${MASTER_EMI_SCHEDULE_SHEET_NAME}: ${missing.join(", ")}`);
  }

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (normalizeMonthToKey_(row[idx["Month"]]) !== monthKey) continue;

    const emp = String(row[idx["Employee Code"]] || "").trim().toUpperCase();
    const ref = String(row[idx["EMI Reference Number"]] || "").trim().toUpperCase();
    if (!emp || !ref) continue;

    map.set(`${emp}||${ref}`, {
      stage: String(row[idx["Settlement Stage"]] || "").trim(),
      lwd: row[idx["Last Working Day"]],
    });
  }

  return map;
}

/**
 * Writes Settlement Stage + Last Working Day alongside the rows just written by
 * writeToDeductions_(), then re-applies protection.
 *
 * Protection rules:
 *  - Settlement Stage is system-written, never typed. Protected across the whole used range.
 *  - Last Working Day is HR's input in the DECISION month, but is carried forward by the system
 *    in every settlement month after it. So it is protected ONLY on rows that already carry a
 *    Settlement Stage — rows without one stay open for HR to record a departure.
 *
 * Protections are removed BEFORE the writes: these buttons can run directly as a delegate, not
 * only as the owner, and a live protection would make the clear/write fail.
 */
function applySettlementColumns_(deductionsSheet, rows8, settlementMap, priorLwd) {
  const prevLwd = priorLwd instanceof Map ? priorLwd : new Map();
  const headers = getHeaderRow_(deductionsSheet);
  const stageCol = indexOfHeader_(headers, "SETTLEMENT STAGE") + 1;
  const lwdCol = indexOfHeader_(headers, "LAST WORKING DAY") + 1;

  if (stageCol <= 0 || lwdCol <= 0) {
    const missing = [];
    if (stageCol <= 0) missing.push("Settlement Stage");
    if (lwdCol <= 0) missing.push("Last Working Day");
    throw new Error(
      `Missing header(s) in "${SALARY_ADVANCE_DEDUCTIONS_SHEET_NAME}": ${missing.join(", ")}`
    );
  }

  // 1) Drop our own previous protections so the clear/write below cannot be blocked.
  deductionsSheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => {
    const desc = p.getDescription() || "";
    if (desc.startsWith(SETTLEMENT_PROTECTION_PREFIX)) {
      try { p.remove(); } catch (e) {}
    }
  });

  // 2) Clear both columns — row order changes between refreshes, so stale values would misalign.
  const maxRows = deductionsSheet.getMaxRows();
  const clearRows = Math.max(maxRows - 1, 0);
  if (clearRows > 0) {
    deductionsSheet.getRange(2, stageCol, clearRows, 1).clearContent();
    deductionsSheet.getRange(2, lwdCol, clearRows, 1).clearContent();
  }

  if (!rows8 || !rows8.length) return;

  // 3) Align to the rows just written. rows8 field order comes from writeToDeductions_'s
  //    writeOrder: [Month, Employee Code, Name, Department, EMI Reference Number, ...]
  const stageVals = [];
  const lwdVals = [];
  const settledOffsets = [];

  rows8.forEach((r, i) => {
    const emp = String(r[1] || "").trim().toUpperCase();
    const ref = String(r[4] || "").trim().toUpperCase();
    const key = `${emp}||${ref}`;
    const hit = settlementMap.get(key);

    const stage = hit ? String(hit.stage || "").trim() : "";
    const carried = hit && hit.lwd !== "" && hit.lwd != null ? hit.lwd : "";

    stageVals.push([stage]);

    // The master wins when it has a date to carry down; otherwise restore whatever HR had
    // typed before the clear. Only genuinely new rows end up blank.
    if (carried !== "") lwdVals.push([carried]);
    else if (prevLwd.has(key)) lwdVals.push([prevLwd.get(key)]);
    else lwdVals.push([""]);

    if (stage) settledOffsets.push(i);
  });

  deductionsSheet.getRange(2, stageCol, stageVals.length, 1).setValues(stageVals);
  deductionsSheet.getRange(2, lwdCol, lwdVals.length, 1).setValues(lwdVals);

  // 4) Re-protect.
  protectSettlementRange_(
    deductionsSheet,
    deductionsSheet.getRange(2, stageCol, rows8.length, 1),
    `${SETTLEMENT_PROTECTION_PREFIX}STAGE`
  );

  buildContinuousRowBlocks_(settledOffsets).forEach((blk, n) => {
    protectSettlementRange_(
      deductionsSheet,
      deductionsSheet.getRange(2 + blk.start, lwdCol, blk.count, 1),
      `${SETTLEMENT_PROTECTION_PREFIX}LWD_${n}`
    );
  });
}

/**
 * Snapshot of any HR-typed Last Working Day, keyed "EMPCODE||EMIREF".
 *
 * MUST be called BEFORE writeToDeductions_(): that function reshuffles the rows, so reading
 * the date column afterwards would pair old dates with whichever employee now sits in that row.
 */
function captureTypedLastWorkingDay_(deductionsSheet) {
  const map = new Map();
  const headers = getHeaderRow_(deductionsSheet);

  const empCol = indexOfHeader_(headers, "EMPLOYEE CODE") + 1;
  const refCol = indexOfHeader_(headers, "EMI REFERENCE NUMBER") + 1;
  const lwdCol = indexOfHeader_(headers, "LAST WORKING DAY") + 1;
  if (empCol <= 0 || refCol <= 0 || lwdCol <= 0) return map;

  const lastRow = deductionsSheet.getLastRow();
  if (lastRow < 2) return map;

  const n = lastRow - 1;
  const emps = deductionsSheet.getRange(2, empCol, n, 1).getDisplayValues();
  const refs = deductionsSheet.getRange(2, refCol, n, 1).getDisplayValues();
  const lwds = deductionsSheet.getRange(2, lwdCol, n, 1).getValues();

  for (let i = 0; i < n; i++) {
    const e = String(emps[i][0] || "").trim().toUpperCase();
    const f = String(refs[i][0] || "").trim().toUpperCase();
    if (!e || !f) continue;
    if (lwds[i][0] !== "" && lwds[i][0] != null) map.set(`${e}||${f}`, lwds[i][0]);
  }

  return map;
}

function protectSettlementRange_(sheet, range, description) {
  const protection = range.protect();
  protection.setDescription(description);
  protection.setWarningOnly(false);
  try {
    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
  } catch (e) {}
}

/** [0,1,2,5,6] -> [{start:0,count:3},{start:5,count:2}] — one protection per run, not per row. */
function buildContinuousRowBlocks_(offsets) {
  if (!offsets || !offsets.length) return [];

  const sorted = offsets.slice().sort((a, b) => a - b);
  const blocks = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) { prev = sorted[i]; continue; }
    blocks.push({ start, count: prev - start + 1 });
    start = sorted[i];
    prev = sorted[i];
  }
  blocks.push({ start, count: prev - start + 1 });

  return blocks;
}

function appendToMasterShared_(masterSharedSheet, attendanceFileName, rows7) {
  if (!rows7.length) return;

  const existing = masterSharedSheet.getDataRange().getValues();
  const seen = new Set();
  const rowByKey = new Map(); // key -> 1-based sheet row, for the open-month refresh below

  for (let r = 1; r < existing.length; r++) {
    const file = String(existing[r][0] || "").trim();
    const mk = normalizeMonthToKey_(existing[r][1]);
    const emp = String(existing[r][2] || "").trim();
    const ref = String(existing[r][5] || "").trim();
    if (file && mk && emp && ref) {
      const k = [file, mk, emp, ref].join("|");
      seen.add(k);
      // col 9 (index 8) = Payroll Status. Blank means the month is not locked yet.
      if (String(existing[r][8] || "").trim() === "") rowByKey.set(k, r + 1);
    }
  }

  const toAppend = [];
  const toRefresh = []; // [sheetRow, EMI Amount, Current Balance]

  for (const r7 of rows7) {
    const mk = normalizeMonthToKey_(r7[0]);
    const emp = String(r7[1] || "").trim();
    const ref = String(r7[4] || "").trim();
    const key = [attendanceFileName, mk, emp, ref].join("|");

    if (!seen.has(key)) {
      toAppend.push([attendanceFileName, ...r7, ""]);
      seen.add(key);
      continue;
    }

    // Already snapshotted. Dedupe still applies - no second row is ever added - but for a
    // month that is NOT yet locked the two numeric columns are refreshed from EMI_SCHEDULE.
    // Without this a settlement rebalance (14000 -> 12900) could never reach the attendance
    // file, because both buttons read this snapshot rather than EMI_SCHEDULE. A locked month
    // is left untouched: it is an audit record.
    const sheetRow = rowByKey.get(key);
    if (sheetRow) toRefresh.push([sheetRow, r7[5], r7[6]]);
  }

  toRefresh.forEach(([sheetRow, emiAmt, curBal]) => {
    masterSharedSheet.getRange(sheetRow, 7, 1, 2).setValues([[emiAmt, curBal]]);
  });

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

  // ✅ Month arrives from EMI_SCHEDULE as a real Date, and Validate Attendance compares it with
  // getDisplayValues() — so the DISPLAY FORMAT decides whether the month matches. Without this
  // the same Date renders as "8/1/2026" in a freshly copied file and "August_2026" in one that
  // happened to be formatted by hand, and validation fails on the new file.
  const monthCol = colIndex("MONTH");
  if (monthCol > 0) {
    deductionsSheet.getRange(startRow, monthCol, numRows, 1).setNumberFormat("MMMM_yyyy");
  }
}
