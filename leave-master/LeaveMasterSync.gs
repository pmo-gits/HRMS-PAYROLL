/***********************
 * LeaveMasterSync.gs  (FULL UPDATED)
 * - Manual menu button + silent callable function
 * - Uses HEADER NAMES only (no col numbers for data fields)
 * - Sync target: LEAVE_MASTER
 *   ✅ Keep ONLY ACTIVE + STAFF employees
 *   ✅ Append new ACTIVE STAFF
 *   ✅ Delete INACTIVE / non-staff / missing rows completely (full row delete)
 *   ✅ Update ID/Name/Category/DOJ for existing ACTIVE STAFF (balances preserved)
 *
 * FIXES INCLUDED:
 * 1) Prevent "range outside sheet dimensions" by auto-expanding rows/columns.
 * 2) Append happens immediately after the LAST REAL DATA ROW based on ID.NO column,
 *    not using getLastRow() (which can be affected by stray content far below).
 * 3) STATUS accepts "ACTIVE", "ACTIVE.", "ACTIVE " etc. via startsWith("ACTIVE").
 *
 * ACCESS CONTROL:
 * - PMO runs core directly (menu click)
 * - hrassist@butlerleather.com routes via Web App (runs as PMO)
 * - All others: blocked at client gate
 * - HashWatcher calls runLeaveMasterSyncSilent_() directly — unaffected
 *
 * IMPORTANT:
 * - Do NOT redeclare EMPLOYEE_MASTER_SPREADSHEET_ID / EMPLOYEE_MASTER_GID here
 *   if they already exist in your HashWatcher file. If you see
 *   "Identifier ... has already been declared", remove duplicates from one file.
 *
 * REQUIRED:
 * - Enable Advanced Google Service: Google Sheets API
 ***********************/

// --- TARGET SHEET ---
const LEAVE_MASTER_SHEET_NAME = "LEAVE_MASTER";

// --- ACCESS CONTROL ---
const LM_PMO_EMAIL    = "pmo@butlerleather.com";
const LM_ALLOWED_USER = "hrassist@butlerleather.com";
const LM_WEBAPP_URL   = "https://script.google.com/macros/s/AKfycbzDSkLs-XXHgVakilwLWzLxR_gXSoWOGEBIReUPX1thXn50ztO-Tv9ZdSEflvYdQ0ME/exec";

// --- LEAVE MASTER SPREADSHEET ID ---
const LEAVE_MASTER_SPREADSHEET_ID = "1kVV5Vu8dPGdgGSAu7rZCz9I9L0XlJiQBE-Opv7izDfk";

// Employee Master headers (source of truth)
const EM_HEADERS = {
  ID: "ID.NO",
  NAME: "NAME",
  CATEGORY: "CATEGORY",
  DOJ: "D.O.J",
  STATUS: "STATUS",
};

// Leave Master headers (target sheet)
const LM_HEADERS = {
  ID: "ID.NO",
  NAME: "NAME",
  CATEGORY: "CATEGORY",
  DOJ: "D.O.J",
  EL: "EL BALANCE",
  CL: "CL BALANCE",
  SL: "SL BALANCE",
};

// ---------- MENU ----------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Leave Master")
    .addItem("Sync ACTIVE STAFF (Add/Remove)", "syncLeaveMasterActiveStaffManual")
    .addToUi();
}

/**
 * Manual run: confirmation + summary
 * - PMO        → runs core directly
 * - hrassist   → routes via Web App (runs as PMO)
 * - Others     → blocked
 */
function syncLeaveMasterActiveStaffManual() {
  const ui = SpreadsheetApp.getUi();
  const caller = Session.getActiveUser().getEmail();

  if (caller !== LM_PMO_EMAIL && caller !== LM_ALLOWED_USER) {
    ui.alert("Not authorised to run this sync.");
    return;
  }

  const resp = ui.alert(
    "Sync Leave Master (ACTIVE STAFF only)",
    "This will:\n• Add new ACTIVE STAFF employees\n• Remove anyone who is not ACTIVE STAFF (delete full rows)\n• Update ID/Name/Category/DOJ for existing ACTIVE STAFF (balances preserved)\n\nProceed?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  // PMO runs directly
  if (caller === LM_PMO_EMAIL) {
    const result = syncLeaveMasterActiveStaffCore_();
    ui.alert(`Sync complete.\nAdded: ${result.added}\nRemoved: ${result.removed}\nUpdated: ${result.updated}`);
    return;
  }

  // hrassist routes via Web App
  _callLeaveMasterSyncWebApp_(caller, ui);
}

/**
 * Web App caller — used by hrassist only
 */
function _callLeaveMasterSyncWebApp_(caller, ui) {
  const payload = {
    action: "syncLeaveMaster",
    spreadsheetId: LEAVE_MASTER_SPREADSHEET_ID,
    requestedBy: caller,
  };

  const response = UrlFetchApp.fetch(LM_WEBAPP_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const result = JSON.parse(response.getContentText());

  if (result.success) {
    ui.alert(`Sync complete.\nAdded: ${result.added}\nRemoved: ${result.removed}\nUpdated: ${result.updated}`);
  } else {
    ui.alert(`Sync failed: ${result.message}`);
  }
}

/**
 * Web App entry point
 * - Server gate: validates requestedBy === LM_ALLOWED_USER
 * - Runs core as PMO (Web App deployed as PMO)
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    if (payload.action === "syncLeaveMaster") {
      if (payload.requestedBy !== LM_ALLOWED_USER) {
        return ContentService.createTextOutput(
          JSON.stringify({ success: false, message: "Access denied." })
        ).setMimeType(ContentService.MimeType.JSON);
      }

      const result = syncLeaveMasterActiveStaffCore_();
      return ContentService.createTextOutput(
        JSON.stringify({ success: true, ...result })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ success: false, message: "Unknown action." })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ success: false, message: err.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Called by hash watcher (silent) — unaffected by Web App changes
 */
function runLeaveMasterSyncSilent_() {
  syncLeaveMasterActiveStaffCore_();
}

/**
 * Core logic (no UI)
 * - Called directly by PMO (menu) and HashWatcher (trigger)
 * - Called via Web App when hrassist triggers
 */
function syncLeaveMasterActiveStaffCore_() {
  const ss = SpreadsheetApp.openById(LEAVE_MASTER_SPREADSHEET_ID);
  const lmSheet = ss.getSheetByName(LEAVE_MASTER_SHEET_NAME);
  if (!lmSheet) throw new Error(`Sheet not found: ${LEAVE_MASTER_SHEET_NAME}`);

  // Validate Leave Master headers exist
  const lmHeaderMap = getHeaderIndexMap_(lmSheet, 1);
  validateHeaders_(lmHeaderMap, Object.values(LM_HEADERS), "LEAVE_MASTER");

  // Fetch ACTIVE STAFF employees (header-based)
  const activeStaffMap = fetchActiveStaffFromEmployeeMasterByHeaders_(); // id -> {id,name,category,doj}
  const activeStaffIds = Object.keys(activeStaffMap);

  // Read existing Leave Master data
  const lastRow = lmSheet.getLastRow();
  const dataRowCount = Math.max(0, lastRow - 1);

  if (dataRowCount === 0) {
    appendNewEmployeesByHeaders_(lmSheet, lmHeaderMap, activeStaffIds.map(id => activeStaffMap[id]));
    return { added: activeStaffIds.length, removed: 0, updated: 0 };
  }

  const lastCol = lmSheet.getLastColumn();
  const values = lmSheet.getRange(2, 1, dataRowCount, lastCol).getValues();

  const idCol  = lmHeaderMap[normalizeKey_(LM_HEADERS.ID)];
  const nameCol = lmHeaderMap[normalizeKey_(LM_HEADERS.NAME)];
  const catCol  = lmHeaderMap[normalizeKey_(LM_HEADERS.CATEGORY)];
  const dojCol  = lmHeaderMap[normalizeKey_(LM_HEADERS.DOJ)];

  // Build map of first occurrence by ID + collect duplicates for deletion
  const firstById = new Map();
  const rowsToDelete = [];
  const seen = new Set();

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const id = normalizeCell_(row[idCol]);
    if (!id) continue;

    const sheetRow = i + 2;

    if (seen.has(id)) {
      rowsToDelete.push(sheetRow); // duplicate row
      continue;
    }
    seen.add(id);

    firstById.set(id, { sheetRow, row });
  }

  // Delete any row whose ID is not in ACTIVE STAFF map
  for (const [id, info] of firstById.entries()) {
    if (!activeStaffMap[id]) rowsToDelete.push(info.sheetRow);
  }

  // Delete full rows bottom-up
  const uniqueDelete = Array.from(new Set(rowsToDelete)).sort((a, b) => b - a);
  uniqueDelete.forEach(r => lmSheet.deleteRow(r));

  // Re-read after deletions
  const newLastRow   = lmSheet.getLastRow();
  const newDataCount = Math.max(0, newLastRow - 1);
  const newLastCol   = lmSheet.getLastColumn();
  const newValues    = newDataCount
    ? lmSheet.getRange(2, 1, newDataCount, newLastCol).getValues()
    : [];

  // Build existing map again
  const existingById = new Map();
  for (let i = 0; i < newValues.length; i++) {
    const row = newValues[i];
    const id = normalizeCell_(row[idCol]);
    if (!id) continue;
    existingById.set(id, { sheetRow: i + 2, row });
  }

  // Add new ACTIVE STAFF not present
  const toAdd = [];
  for (const id of activeStaffIds) {
    if (!existingById.has(id)) toAdd.push(activeStaffMap[id]);
  }

  // Update ID/Name/Category/DOJ for existing ACTIVE STAFF (preserve balances)
  let updated = 0;
  for (const id of activeStaffIds) {
    const ex = existingById.get(id);
    if (!ex) continue;

    const master = activeStaffMap[id];
    const cur = ex.row;

    const curId  = normalizeCell_(cur[idCol]);
    const curName = normalizeCell_(cur[nameCol]);
    const curCat  = normalizeCell_(cur[catCol]).toUpperCase();
    const curDoj  = normalizeDateComparable_(cur[dojCol]);

    const mId     = normalizeCell_(master.id);
    const mName   = normalizeCell_(master.name);
    const mCat    = normalizeCell_(master.category).toUpperCase();
    const mDojComp = normalizeDateComparable_(master.doj);

    if (curId !== mId || curName !== mName || curCat !== mCat || curDoj !== mDojComp) {
      const rowNum = ex.sheetRow;
      lmSheet.getRange(rowNum, idCol  + 1).setValue(master.id);
      lmSheet.getRange(rowNum, nameCol + 1).setValue(master.name);
      lmSheet.getRange(rowNum, catCol  + 1).setValue(master.category);
      lmSheet.getRange(rowNum, dojCol  + 1).setValue(master.doj);
      updated++;
    }
  }

  if (toAdd.length) appendNewEmployeesByHeaders_(lmSheet, lmHeaderMap, toAdd);

  return { added: toAdd.length, removed: uniqueDelete.length, updated };
}

/**
 * Fetch ONLY ACTIVE + STAFF employees from Employee Master using header lookup.
 * STATUS accepts ACTIVE, ACTIVE., ACTIVE , etc.
 */
function fetchActiveStaffFromEmployeeMasterByHeaders_() {
  const emSS    = SpreadsheetApp.openById(EMPLOYEE_MASTER_SPREADSHEET_ID);
  const emSheet = getSheetByGid_(emSS, EMPLOYEE_MASTER_GID);
  if (!emSheet) throw new Error("Employee Master sheet not found by given GID.");

  const sheetName = emSheet.getName();

  const resp = Sheets.Spreadsheets.Values.get(
    EMPLOYEE_MASTER_SPREADSHEET_ID,
    `${sheetName}!A1:Z`
  );

  const rows = resp.values || [];
  if (rows.length < 2) return {};

  const header = (rows[0] || []).map(h => normalizeCell_(h));
  const idx = (h) => header.indexOf(normalizeCell_(h));

  const idIdx     = idx(EM_HEADERS.ID);
  const nameIdx   = idx(EM_HEADERS.NAME);
  const catIdx    = idx(EM_HEADERS.CATEGORY);
  const dojIdx    = idx(EM_HEADERS.DOJ);
  const statusIdx = idx(EM_HEADERS.STATUS);

  if ([idIdx, nameIdx, catIdx, dojIdx, statusIdx].some(i => i < 0)) {
    throw new Error(`Employee Master headers missing. Required: ${Object.values(EM_HEADERS).join(", ")}`);
  }

  const map = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const id  = normalizeCell_(row[idIdx]);
    if (!id) continue;

    const statusRaw = normalizeCell_(row[statusIdx]).toUpperCase();
    const category  = normalizeCell_(row[catIdx]).toUpperCase();

    const isActive = statusRaw.startsWith("ACTIVE");
    if (!isActive) continue;
    if (category !== "STAFF") continue;

    map[id] = {
      id,
      name:     normalizeCell_(row[nameIdx]),
      category: "STAFF",
      doj:      row[dojIdx] || "",
    };
  }

  return map;
}

/**
 * Append new employees by Leave Master headers.
 * ✅ Auto-expands rows/columns to prevent dimension errors.
 * ✅ Appends immediately after the last REAL row based on ID.NO column (not getLastRow()).
 */
function appendNewEmployeesByHeaders_(lmSheet, lmHeaderMap, employees) {
  if (!employees.length) return;

  const idCol0   = lmHeaderMap[normalizeKey_(LM_HEADERS.ID)];
  const nameCol0 = lmHeaderMap[normalizeKey_(LM_HEADERS.NAME)];
  const catCol0  = lmHeaderMap[normalizeKey_(LM_HEADERS.CATEGORY)];
  const dojCol0  = lmHeaderMap[normalizeKey_(LM_HEADERS.DOJ)];
  const elCol0   = lmHeaderMap[normalizeKey_(LM_HEADERS.EL)];
  const clCol0   = lmHeaderMap[normalizeKey_(LM_HEADERS.CL)];
  const slCol0   = lmHeaderMap[normalizeKey_(LM_HEADERS.SL)];

  const requiredLastColIndex = Math.max(idCol0, nameCol0, catCol0, dojCol0, elCol0, clCol0, slCol0);
  const requiredCols = requiredLastColIndex + 1;

  // ✅ Ensure enough columns exist
  const maxCols = lmSheet.getMaxColumns();
  if (maxCols < requiredCols) {
    lmSheet.insertColumnsAfter(maxCols, requiredCols - maxCols);
  }

  // ✅ Find last real data row using ID.NO column only
  const idCol1     = idCol0 + 1;
  const lastDataRow = findLastDataRowByColumn_(lmSheet, idCol1);
  const startRow    = Math.max(2, lastDataRow + 1);
  const neededLastRow = startRow + employees.length - 1;

  // ✅ Ensure enough rows exist
  const maxRows = lmSheet.getMaxRows();
  if (maxRows < neededLastRow) {
    lmSheet.insertRowsAfter(maxRows, neededLastRow - maxRows);
  }

  const width = lmSheet.getMaxColumns();

  const out = employees.map(e => {
    const row = new Array(width).fill("");
    row[idCol0]   = e.id;
    row[nameCol0] = e.name;
    row[catCol0]  = e.category;
    row[dojCol0]  = e.doj;
    row[elCol0]   = "";
    row[clCol0]   = "";
    row[slCol0]   = "";
    return row;
  });

  lmSheet.getRange(startRow, 1, out.length, width).setValues(out);
}

/**
 * Returns last row number (1-based) where the given column has a non-empty value.
 * Column index is 1-based.
 */
function findLastDataRowByColumn_(sheet, col1Based) {
  const maxRows = sheet.getMaxRows();
  const values  = sheet.getRange(1, col1Based, maxRows, 1).getValues();

  for (let i = values.length - 1; i >= 0; i--) {
    const v = String(values[i][0] || "").trim();
    if (v) return i + 1;
  }
  return 1;
}

// ---------- HELPERS ----------
function getHeaderIndexMap_(sheet, headerRowNum) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(headerRowNum, 1, 1, lastCol).getValues()[0] || [];
  const map = {};
  for (let c = 0; c < headers.length; c++) {
    const key = normalizeKey_(headers[c]);
    if (key) map[key] = c;
  }
  return map;
}

function validateHeaders_(map, requiredHeaders, sheetLabel) {
  const missing = [];
  requiredHeaders.forEach(h => {
    const key = normalizeKey_(h);
    if (!(key in map)) missing.push(h);
  });
  if (missing.length) throw new Error(`${sheetLabel} missing headers: ${missing.join(", ")}`);
}

function normalizeKey_(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function normalizeCell_(v) {
  return String(v || "").trim().replace(/\s+/g, " ");
}

function normalizeDateComparable_(v) {
  if (!v) return "";
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    const yyyy = v.getFullYear();
    const mm   = String(v.getMonth() + 1).padStart(2, "0");
    const dd   = String(v.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return normalizeCell_(v);
}

/**
 * If getSheetByGid_ already exists in another file, delete this one to avoid redeclare error.
 */
function getSheetByGid_(ss, gid) {
  const sheets = ss.getSheets();
  for (const sh of sheets) {
    if (sh.getSheetId() === gid) return sh;
  }
  return null;
}
