/************************************************
 * 2_EmpMasterSync.gs  (UPDATED - Web App)
 * Salary Advance Master
 *
 * ✅ Web App pattern implemented:
 *    - syncEmpMaster_FromEmployeeMaster() → user gate wrapper
 *      pmo@ runs syncEmpMaster_Core_() directly
 *      nazneen@ calls Web App → syncEmpMasterServer_() in 0_WebApp.gs
 *
 * ✅ Core function syncEmpMaster_Core_() — UNCHANGED
 *    Already UI-free. No modifications made.
 *
 * ✅ Constants EMI_PMO_USER_, EMI_ALLOWED_USER_, callEmiWebApp_()
 *    declared in 0_WebApp.gs — referenced here directly.
 *
 * Rules (unchanged):
 * - Source: Employee Master spreadsheetId + gid
 * - Read A:AB
 * - Only rows where Column B (Employee Code) is NOT blank
 * - Match/update by Employee Code (Column B)
 * - Append new employees at bottom (after last real row by Column B)
 * - NO DELETION
 ************************************************/

// ---- SOURCE (Employee Master) ----
const EMP_SRC_SPREADSHEET_ID = "1yqQ-edwQzZd0pAlaXCAAZt88MbsHfCf4hCcxti4ojCw";
const EMP_SRC_GID             = 1874110664; // Employee Master tab gid

// ---- TARGET (Salary Advance Master) ----
const EMP_TARGET_SHEET_NAME = "EMP master";

// ---- Range settings ----
const SRC_START_ROW  = 1;
const SRC_START_COL  = 1;  // A
const SRC_NUM_COLS   = 28; // A..AB
const KEY_COL_INDEX0 = 1;  // Column B (0-based)

/* ================================================
 * MENU BUILDER
 * Called from the SINGLE onOpen() in 1_Advance_EMIScheduler.gs
 * ================================================ */
function addEmpMasterSyncMenu_() {
  SpreadsheetApp.getUi()
    .createMenu("Master")
    .addItem("Refresh Employee Master (EMP master)", "syncEmpMaster_FromEmployeeMaster")
    // ✅ Handler lives in 7_SalaryMasterWatcher.gs. Rebuilds SALARY master only
    // if Salary Revision History actually changed since the last check, and
    // reports either way — the same check the hourly trigger runs on its own.
    //
    // "Refresh Salary Master" (syncSalaryMaster_FromRevisionHistory, in
    // 4_SalaryMasterSync.gs) is DELIBERATELY NOT on this menu — an unconditional
    // rebuild button sitting next to a conditional one confused users, since both
    // produce the same visible result whenever there IS a change. The function
    // itself is untouched and still callable from the Apps Script editor's Run
    // dropdown (it doesn't end in "_") — kept as an escape hatch: any genuine
    // salary change WILL be caught by the hash check above, but a forced rebuild
    // can still be run by hand if the watcher itself needs debugging, or if
    // someone simply wants SALARY master rewritten regardless of whether
    // anything tracked has changed.
    .addItem("Check Salary Revisions Now", "checkSalaryRevisionsNow")
    .addToUi();
}

/* ================================================
 * MENU WRAPPER — user gate lives here
 * UI calls (alert) live here only.
 * Core logic is UI-free and lives in syncEmpMaster_Core_() below.
 * ================================================ */

/**
 * syncEmpMaster_FromEmployeeMaster
 * Menu / Button entry point.
 *
 * pmo@butlerleather.com    → runs syncEmpMaster_Core_() directly
 * nazneen@butlerleather.com → routes to Web App
 * anyone else               → access denied
 */
function syncEmpMaster_FromEmployeeMaster() {
  const ui   = SpreadsheetApp.getUi();
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const user = Session.getEffectiveUser().getEmail().toLowerCase();

  // hrassist@ added alongside nazneen@: this only re-reads Employee Master into
  // the local mirror — it moves no money and changes no limit. The matching
  // server-side permission lives in EMI_ACTION_ALLOWED_ in 0_WebApp.gs; this
  // check is convenience only, that one is the gate.
  if (user !== EMI_PMO_USER_ && user !== EMI_ALLOWED_USER_ && user !== EMI_HR_ASSIST_USER_) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  // Confirmation prompt — same for both paths
  const resp = ui.alert(
    "Refresh Employee Master",
    "This will update and append employees from Employee Master (A:AB).\n" +
    "• Matching by Employee Code\n" +
    "• No deletions\n\nProceed?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  if (user === EMI_PMO_USER_) {
    // Owner: run core directly
    try {
      const result = syncEmpMaster_Core_();
      ui.alert(
        `Employee Master refreshed ✅\n\n` +
        `Updated: ${result.updated}\n` +
        `Added: ${result.added}\n` +
        `Source rows read: ${result.sourceRows}`
      );
    } catch (err) {
      ui.alert("Error: " + err.message);
    }
    return;
  }

  // nazneen@: route via Web App
  try {
    const result = callEmiWebApp_("syncEmpMaster", ss);
    ui.alert(result.success
      ? (result.message || "Employee Master refreshed ✅")
      : ("Error: " + (result.message || "Unknown error from Web App."))
    );
  } catch (err) {
    ui.alert("Web App call failed: " + err.message);
  }
}

/* ================================================
 * CORE FUNCTION — UNCHANGED
 * UI-free. Called by wrapper (direct path) AND
 * by syncEmpMasterServer_() in 0_WebApp.gs (Web App path).
 * ================================================ */

/**
 * syncEmpMaster_Core_()
 * Silent callable — no UI.
 * Returns { updated, added, sourceRows }
 */
function syncEmpMaster_Core_() {
  const targetSS = SpreadsheetApp.getActiveSpreadsheet();
  const targetSh = targetSS.getSheetByName(EMP_TARGET_SHEET_NAME);
  if (!targetSh) throw new Error(`Target sheet not found: ${EMP_TARGET_SHEET_NAME}`);

  // --- Load source ---
  const srcSS = SpreadsheetApp.openById(EMP_SRC_SPREADSHEET_ID);
  const srcSh = getSheetByGid_(srcSS, EMP_SRC_GID);
  if (!srcSh) throw new Error(`Source sheet not found by gid: ${EMP_SRC_GID}`);

  const srcLastRow = srcSh.getLastRow();
  if (srcLastRow < 1) return { updated: 0, added: 0, sourceRows: 0 };

  const srcValues = srcSh
    .getRange(SRC_START_ROW, SRC_START_COL, srcLastRow, SRC_NUM_COLS)
    .getValues();

  if (!srcValues.length) return { updated: 0, added: 0, sourceRows: 0 };

  // --- Header sync ---
  const header = srcValues[0];
  ensureTargetHasColumns_(targetSh, SRC_NUM_COLS);
  targetSh.getRange(1, 1, 1, SRC_NUM_COLS).setValues([header]);

  // --- Filter valid source rows (Employee Code not blank) ---
  const filtered = [];
  for (let i = 1; i < srcValues.length; i++) {
    const row = srcValues[i];
    const key = normalizeKey_(row[KEY_COL_INDEX0]);
    if (!key) continue;
    filtered.push(row);
  }

  // --- Build target index by Employee Code ---
  const tLastReal  = findLastDataRowByColumn_(targetSh, 2); // Column B
  const tDataCount = Math.max(0, tLastReal - 1);

  let tValues = [];
  if (tDataCount > 0) {
    tValues = targetSh.getRange(2, 1, tDataCount, SRC_NUM_COLS).getValues();
  }

  const tIndexByKey = new Map();
  for (let i = 0; i < tValues.length; i++) {
    const key = normalizeKey_(tValues[i][KEY_COL_INDEX0]);
    if (!key) continue;
    if (!tIndexByKey.has(key)) tIndexByKey.set(key, i + 2);
  }

  // --- Update existing / collect new ---
  let updated    = 0;
  const toAppend = [];

  for (const srcRow of filtered) {
    const key         = normalizeKey_(srcRow[KEY_COL_INDEX0]);
    const targetRowNo = tIndexByKey.get(key);

    if (targetRowNo) {
      targetSh.getRange(targetRowNo, 1, 1, SRC_NUM_COLS).setValues([srcRow]);
      updated++;
    } else {
      toAppend.push(srcRow);
    }
  }

  // --- Append new employees ---
  let added = 0;
  if (toAppend.length) {
    const appendStartRow = Math.max(2, findLastDataRowByColumn_(targetSh, 2) + 1);
    ensureTargetHasRows_(targetSh, appendStartRow + toAppend.length - 1);
    targetSh.getRange(appendStartRow, 1, toAppend.length, SRC_NUM_COLS).setValues(toAppend);
    added = toAppend.length;
  }

  return { updated, added, sourceRows: filtered.length };
}

/* ================================================
 * Helpers — ALL UNCHANGED from original
 * ================================================ */

function getSheetByGid_(ss, gid) {
  return ss.getSheets().find(sh => sh.getSheetId() === gid) || null;
}

function normalizeKey_(v) {
  return String(v == null ? "" : v).trim();
}

function findLastDataRowByColumn_(sheet, col1Based) {
  const vals = sheet.getRange(1, col1Based, sheet.getMaxRows(), 1).getDisplayValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0] || "").trim() !== "") return i + 1;
  }
  return 1;
}

function ensureTargetHasColumns_(sheet, neededCols) {
  const cur = sheet.getMaxColumns();
  if (cur < neededCols) sheet.insertColumnsAfter(cur, neededCols - cur);
}

function ensureTargetHasRows_(sheet, neededLastRow) {
  const cur = sheet.getMaxRows();
  if (cur < neededLastRow) sheet.insertRowsAfter(cur, neededLastRow - cur);
}
