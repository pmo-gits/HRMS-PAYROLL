/************************************************
 * 08_RemoveInactiveEmployee.gs
 * Butler Leather — Attendance Apps Script
 *
 * Removes a single INACTIVE employee row from:
 *   - Attendance entry sheet
 *   - Late Entry sheet
 *
 * Rules:
 *   - Attendance must NOT be locked
 *   - Employee must exist in Attendance entry (Column B)
 *   - Employee STATUS must be INACTIVE in Employee Master
 *   - One employee at a time
 *   - PMO runs directly; hrassist routes through Web App
 *   - All other users are blocked
 ************************************************/

function removeInactiveEmployee() {
  const ui   = SpreadsheetApp.getUi();
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const user = Session.getEffectiveUser().getEmail();

  const PMO     = "pmo@butlerleather.com";
  const ALLOWED = "hrassist@butlerleather.com";

  // ── 1. Access control ──────────────────────────────────────────────────────
  if (user !== PMO && user !== ALLOWED) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  // ── 2. Attendance sheet existence ──────────────────────────────────────────
  const sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sheet) {
    ui.alert(`Sheet "${ATTENDANCE_SHEET_NAME}" not found.`);
    return;
  }

  // ── 3. Lock check ──────────────────────────────────────────────────────────
  if (isAttendanceLocked_()) {
    ui.alert(
      "Attendance Locked",
      "This attendance file is LOCKED.\nRemoving an employee is not allowed.",
      ui.ButtonSet.OK
    );
    return;
  }

  // ── 4. Warning confirmation ────────────────────────────────────────────────
  const warn = ui.alert(
    "Remove Inactive Employee — Confirm",
    "Removing an employee will permanently delete all their attendance records for this month.\n\n" +
    "This action cannot be undone. Their payroll will not be processed for this month.\n\n" +
    "Do you want to continue?",
    ui.ButtonSet.YES_NO
  );
  if (warn !== ui.Button.YES) return;

  // ── 5. Employee code prompt ────────────────────────────────────────────────
  const promptResult = ui.prompt(
    "Remove Inactive Employee",
    "Enter the Employee Code to remove:",
    ui.ButtonSet.OK_CANCEL
  );
  if (promptResult.getSelectedButton() !== ui.Button.OK) return;

  const empCode = String(promptResult.getResponseText() || "").trim();
  if (!empCode) {
    ui.alert("No employee code entered. Action cancelled.");
    return;
  }

  // ── 6. Dispatch ────────────────────────────────────────────────────────────
  if (user === PMO) {
    try {
      removeInactiveEmployee_Runner_(sheet, ss, empCode);
      ui.alert(
        "Done",
        `Employee "${empCode}" has been removed from Attendance entry and Late Entry.`,
        ui.ButtonSet.OK
      );
    } catch (e) {
      ui.alert("Error", e.message, ui.ButtonSet.OK);
    }

  } else {
    // hrassist → Web App (UI already done above; pass empCode in payload)
    try {
      const payload = {
        action         : "removeInactiveEmployee",
        caller         : user,
        spreadsheetId  : ss.getId(),
        empCode        : empCode
      };
      const response = UrlFetchApp.fetch(ATTENDANCE_WEBAPP_URL, {
        method         : "post",
        contentType    : "application/json",
        payload        : JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const result = JSON.parse(response.getContentText());
      if (result.status === "success") {
        ui.alert(result.message || "Employee removed successfully.");
      } else {
        ui.alert("Error: " + (result.message || "Unknown error from Web App."));
      }
    } catch (e) {
      ui.alert("Web App call failed: " + e.message);
    }
  }
}


/**
 * removeInactiveEmployee_Runner_
 * UI-free core logic.
 * Called by:
 *   - PMO direct path (above)
 *   - Web App server handler (removeInactiveEmployeeServer_ in WebApp_Router.gs)
 *
 * Throws on any validation failure — caller handles messaging.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} attendanceSheet  Attendance entry sheet object
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss         Active spreadsheet
 * @param {string} empCode                                       Employee code to remove
 */
function removeInactiveEmployee_Runner_(attendanceSheet, ss, empCode) {

  // ── Step 1. Confirm employee is INACTIVE in Employee Master ─────────────────
  const status = fetchEmployeeStatus_(empCode);

  if (status === null) {
    throw new Error(
      `Employee code "${empCode}" was not found in Employee Master.\n` +
      "Please check the code and try again."
    );
  }
  if (status === "ACTIVE") {
    throw new Error(
      `Employee "${empCode}" is still marked as ACTIVE in Employee Master.\n` +
      "Please change their status to INACTIVE first, then try again."
    );
  }
  // Any value other than ACTIVE (e.g. INACTIVE, RESIGNED, etc.) proceeds.

  // ── Step 2. Remove from Attendance entry ────────────────────────────────────
  const attendanceRowNum = findEmployeeRow_(attendanceSheet, empCode);
  if (attendanceRowNum === -1) {
    throw new Error(
      `Employee code "${empCode}" was not found in the Attendance entry sheet.\n` +
      "They may have already been removed."
    );
  }
  safeRemoveEmployeeRow_(attendanceSheet, attendanceRowNum);

  // ── Step 3. Remove from Late Entry (silent skip if not found) ───────────────
  const lateSheet = ss.getSheetByName(LATE_ENTRY_SHEET_NAME);
  if (lateSheet) {
    const lateRowNum = findEmployeeRow_(lateSheet, empCode);
    if (lateRowNum !== -1) {
      safeRemoveEmployeeRow_(lateSheet, lateRowNum);
    }
  }
}


/**
 * safeRemoveEmployeeRow_
 * Removes an employee row without touching the array formulas anchored in row 2.
 *
 * Rule:
 *   - If targetRow === 2 (array formula row):
 *       Copy row 3 data (A:H + date columns I:AM) up into row 2,
 *       then delete row 3.
 *       This keeps row 2 physically intact so array formulas are never lost.
 *   - If targetRow > 2:
 *       Direct deleteRow() — no formula risk.
 *
 * Used identically for both Attendance entry and Late Entry sheets,
 * since both have array formulas anchored at row 2.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} targetRow  1-based row number of the employee to remove
 */
function safeRemoveEmployeeRow_(sheet, targetRow) {
  const lastRow = sheet.getLastRow();

  if (targetRow > 2) {
    // ── Safe path: direct delete, no formula impact ──────────────────────────
    sheet.deleteRow(targetRow);
    return;
  }

  // ── Row 2 path: shift row 3 up into row 2, then delete row 3 ────────────────
  // Only possible if a row 3 exists (i.e. at least 2 employee rows).
  // If row 2 is the only employee row, just clear A:H + date columns —
  // deleting it would remove the array formula anchor entirely.
  if (lastRow < 3) {
    // Only one employee row exists — clear content only, preserve row 2 structure.
    const totalCols = STATIC_COLS_COUNT + 31; // A:H + I:AM
    sheet.getRange(2, 1, 1, totalCols).clearContent();
    return;
  }

  // Copy row 3 static data (A:H) up to row 2
  const staticSrc  = sheet.getRange(3, 1, 1, STATIC_COLS_COUNT);
  const staticDest = sheet.getRange(2, 1, 1, STATIC_COLS_COUNT);
  staticSrc.copyTo(staticDest, SpreadsheetApp.CopyPasteType.PASTE_VALUES, false);

  // Copy row 3 date data (I:AM — 31 columns) up to row 2
  const dateSrc  = sheet.getRange(3, DATE_START_COL, 1, 31);
  const dateDest = sheet.getRange(2, DATE_START_COL, 1, 31);
  dateSrc.copyTo(dateDest, SpreadsheetApp.CopyPasteType.PASTE_VALUES, false);

  // Now delete row 3 (the duplicate that was shifted up)
  sheet.deleteRow(3);
}


/**
 * fetchEmployeeStatus_
 * Fetches the raw STATUS value for a given employee code from Employee Master
 * (regardless of whether ACTIVE or INACTIVE — unlike fetchActiveEmployees_
 * which filters ACTIVE only).
 *
 * Returns:
 *   - "ACTIVE" / "INACTIVE" / other status string  → employee found
 *   - null                                          → employee code not found
 *
 * @param {string} empCode
 * @returns {string|null}
 */
function fetchEmployeeStatus_(empCode) {
  const cache        = CacheService.getScriptCache();
  const titleCacheKey = `EMP_SHEET_TITLE_${EMP_MASTER_SPREADSHEET_ID}_${EMP_MASTER_SHEET_ID}`;
  let sheetTitle      = cache.get(titleCacheKey);

  if (!sheetTitle) {
    const meta  = Sheets.Spreadsheets.get(EMP_MASTER_SPREADSHEET_ID, {
      fields: "sheets(properties(sheetId,title))"
    });
    const found = (meta.sheets || []).find(
      s => s.properties && s.properties.sheetId === EMP_MASTER_SHEET_ID
    );
    if (!found) throw new Error("Employee Master sheet not found. Check EMP_MASTER_SHEET_ID.");
    sheetTitle = found.properties.title;
    cache.put(titleCacheKey, sheetTitle, 21600);
  }

  const range  = `${sheetTitle}!A1:AR`;
  const res    = Sheets.Spreadsheets.Values.get(EMP_MASTER_SPREADSHEET_ID, range);
  const values = res.values || [];
  if (values.length < 2) return null;

  const headers = (values[0] || []).map(h => String(h).trim().toUpperCase());
  const iId     = headers.indexOf("ID.NO");
  const iStatus = headers.indexOf("STATUS");

  if (iId === -1 || iStatus === -1) {
    throw new Error(
      "Employee Master is missing required headers (ID.NO, STATUS)."
    );
  }

  const target = String(empCode).trim().toUpperCase();

  for (let r = 1; r < values.length; r++) {
    const row       = values[r] || [];
    const rowCode   = String(row[iId]     || "").trim().toUpperCase();
    const rowStatus = String(row[iStatus] || "").trim().toUpperCase();
    if (rowCode === target) return rowStatus; // return raw status (could be "INACTIVE", "RESIGNED", etc.)
  }

  return null; // not found
}


/**
 * findEmployeeRow_
 * Scans Column B of the given sheet for a matching employee code.
 * Returns the 1-based sheet row number, or -1 if not found.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} empCode
 * @returns {number}
 */
function findEmployeeRow_(sheet, empCode) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const colB  = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const target = String(empCode).trim().toUpperCase();

  for (let i = 0; i < colB.length; i++) {
    const val = String(colB[i][0] || "").trim().toUpperCase();
    if (val === target) return i + 2; // +1 for 0-index, +1 for header row
  }
  return -1;
}
