/************************************************
 * 3A_Master_SharedEMILockSync.gs  (Salary Advance Master) - SPEED OPTIMIZED
 *
 * Single trigger entry:
 * 1) Locks Shared EMI Summary -> Payroll Status (only if blank)
 * 2) Syncs Recovered Amount Ledger -> EMI_SCHEDULE
 *    - HR Decision -> HR Decision
 *    - Recovered Amount -> Recover Amount   ✅ UPDATED (was Planned EMI)
 * 3) Post-actions in EMI_SCHEDULE based on HR Decision:
 *    - SKIP:
 *        Create 1 new row for the same EMI Ref and APPEND at FIRST EMPTY ROW (by Month col)
 *        New Month = (last row month for that EMI Ref) + 1 month
 *        Month written as Date + number format "MMMM_yyyy"
 *    - RESIGNED / ABSCOND:
 *        For future rows strictly after decision month (same ref):
 *          EMI Amount -> 0
 *          Status -> WRITE OFF
 *          Write off Amount -> previous EMI Amount (only if blank)
 *          Write off Time stamp -> timestamp (only if blank)
 *
 * Notes:
 * - Header maps are cached once per sheet (re-read only if we add missing headers)
 * - No split triggers (single entry function)
 * - Idempotent for SKIP via ScriptProperties
 ************************************************/

var _M_SHEET_SHARED = "Shared EMI Summary";
var _M_SHEET_RECOVERED = "Recovered Amount Ledger";
var _M_SHEET_EMI_SCHEDULE = "EMI_SCHEDULE";

// Idempotency for SKIP extension (avoid adding multiple rows for same decision)
var _PROP_SKIP_PREFIX = "SKIP_EXTENDED_V4::"; // <REF>::<MONTHKEY>::<EMP>

function syncSharedEmiPayrollStatusFromRecoveredLedger() {
  const ss = SpreadsheetApp.openById(SALARY_ADVANCE_MASTER_SPREADSHEET_ID);
  const tz = Session.getScriptTimeZone();
  const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");

  const shShared = ss.getSheetByName(_M_SHEET_SHARED);
  const shRec = ss.getSheetByName(_M_SHEET_RECOVERED);
  const shEmi = ss.getSheetByName(_M_SHEET_EMI_SCHEDULE);

  if (!shShared) throw new Error(`Sheet not found: ${_M_SHEET_SHARED}`);
  if (!shRec) throw new Error(`Sheet not found: ${_M_SHEET_RECOVERED}`);
  if (!shEmi) throw new Error(`Sheet not found: ${_M_SHEET_EMI_SCHEDULE}`);

  // =========================================================
  // Build Recovered Ledger lookup: key(MonthKey+Emp+Ref) -> {hr, recoveredAmt}
  // =========================================================
  const recMap = getHeaderMapUpper_(shRec);
  const R = {
    month: req_(recMap, "MONTH"),
    emp: req_(recMap, "EMPLOYEE CODE"),
    ref: req_(recMap, "EMI REFERENCE NUMBER"),
    hr: req_(recMap, "HR DECISION"),
    recoveredAmt: req_(recMap, "RECOVERED AMOUNT"), // ✅ CHANGED (was PLANNED EMI)
  };

  const recLastRow = shRec.getLastRow();
  if (recLastRow < 2) return;

  const recVals = shRec.getRange(2, 1, recLastRow - 1, shRec.getLastColumn()).getValues();

  const recoveredByKey = new Map();
  for (let i = 0; i < recVals.length; i++) {
    const row = recVals[i];
    const monthKey = normMonthKey_(row[R.month]);
    const emp = norm_(row[R.emp]);
    const ref = norm_(row[R.ref]);
    if (!monthKey || !emp || !ref) continue;

    const key = [monthKey, emp, ref].join("||");
    recoveredByKey.set(key, {
      hr: String(row[R.hr] || "").trim(),
      recoveredAmt: String(row[R.recoveredAmt] || "").trim(), // ✅ CHANGED
    });
  }
  if (recoveredByKey.size === 0) return;

  // =========================================================
  // (1) Lock Shared EMI Summary Payroll Status (only if blank)
  // =========================================================
  let shMap = getHeaderMapUpper_(shShared);

  let payrollIdx0 = shMap["PAYROLL STATUS"];
  if (payrollIdx0 == null) {
    shShared.getRange(1, shShared.getLastColumn() + 1).setValue("Payroll Status");
    shMap = getHeaderMapUpper_(shShared); // refresh after header mutation
    payrollIdx0 = shMap["PAYROLL STATUS"];
  }

  const S = {
    month: req_(shMap, "MONTH"),
    emp: req_(shMap, "EMPLOYEE CODE"),
    ref: req_(shMap, "EMI REFERENCE NUMBER"),
  };

  const shLast = shShared.getLastRow();
  if (shLast >= 2) {
    const shNumRows = shLast - 1;
    const shLastCol = shShared.getLastColumn();

    const sharedVals = shShared.getRange(2, 1, shNumRows, shLastCol).getValues();
    const payrollRange = shShared.getRange(2, payrollIdx0 + 1, shNumRows, 1);
    const payrollCol = payrollRange.getDisplayValues();

    const lockText = `LOCKED - ${stamp}`;
    let changed = false;

    for (let i = sharedVals.length - 1; i >= 0; i--) {
      if (String(payrollCol[i][0] || "").trim() !== "") continue;

      const monthKey = normMonthKey_(sharedVals[i][S.month]);
      const emp = norm_(sharedVals[i][S.emp]);
      const ref = norm_(sharedVals[i][S.ref]);
      if (!monthKey || !emp || !ref) continue;

      const key = [monthKey, emp, ref].join("||");
      if (!recoveredByKey.has(key)) continue;

      payrollCol[i][0] = lockText;
      changed = true;
    }

    if (changed) payrollRange.setValues(payrollCol);
  }

  // =========================================================
  // (2) Sync into EMI_SCHEDULE: HR Decision + Recover Amount
  // =========================================================
  let emiMap = getHeaderMapUpper_(shEmi);

  // Ensure write-off columns exist (refresh header map only if we add)
  const beforeCols = shEmi.getLastColumn();
  emiMap = ensureHeader_(shEmi, emiMap, "WRITE OFF AMOUNT");
  emiMap = ensureHeader_(shEmi, emiMap, "WRITE OFF TIME STAMP");
  if (shEmi.getLastColumn() !== beforeCols) {
    emiMap = getHeaderMapUpper_(shEmi);
  }

  const E = {
    month: req_(emiMap, "MONTH"),
    emp: req_(emiMap, "EMPLOYEE CODE"),
    name: req_(emiMap, "NAME"),
    dept: req_(emiMap, "DEPARTMENT"),
    ref: req_(emiMap, "EMI REFERENCE NUMBER"),
    emiAmt: req_(emiMap, "EMI AMOUNT"),
    status: req_(emiMap, "STATUS"),
    hr: req_(emiMap, "HR DECISION"),
    recover: req_(emiMap, "RECOVER AMOUNT"),
    woAmt: req_(emiMap, "WRITE OFF AMOUNT"),
    woTs: req_(emiMap, "WRITE OFF TIME STAMP"),
  };

  const emiLast = shEmi.getLastRow();
  if (emiLast < 2) return;

  const emiNumRows = emiLast - 1;
  const emiLastCol = shEmi.getLastColumn();

  // getValues(): month is Date
  const emiVals = shEmi.getRange(2, 1, emiNumRows, emiLastCol).getValues();

  // Columns we write (batch)
  const hrRange = shEmi.getRange(2, E.hr + 1, emiNumRows, 1);
  const recRange = shEmi.getRange(2, E.recover + 1, emiNumRows, 1);
  const emiAmtRange = shEmi.getRange(2, E.emiAmt + 1, emiNumRows, 1);
  const statusRange = shEmi.getRange(2, E.status + 1, emiNumRows, 1);
  const woAmtRange = shEmi.getRange(2, E.woAmt + 1, emiNumRows, 1);
  const woTsRange = shEmi.getRange(2, E.woTs + 1, emiNumRows, 1);

  const hrCol = hrRange.getDisplayValues();
  const recCol = recRange.getDisplayValues();
  const emiAmtCol = emiAmtRange.getDisplayValues();
  const statusCol = statusRange.getDisplayValues();
  const woAmtCol = woAmtRange.getDisplayValues();
  const woTsCol = woTsRange.getDisplayValues();

  // Apply ledger sync (HR + Recover)
  let changedSync = false;
  for (let i = 0; i < emiVals.length; i++) {
    const monthKey = normMonthKey_(emiVals[i][E.month]);
    const emp = norm_(emiVals[i][E.emp]);
    const ref = norm_(emiVals[i][E.ref]);
    if (!monthKey || !emp || !ref) continue;

    const key = [monthKey, emp, ref].join("||");
    const src = recoveredByKey.get(key);
    if (!src) continue;

    const newHr = String(src.hr || "").trim();
    const newRecover = String(src.recoveredAmt || "").trim(); // ✅ CHANGED (was src.planned)

    if (String(hrCol[i][0] || "").trim() !== newHr) {
      hrCol[i][0] = newHr;
      changedSync = true;
    }
    if (String(recCol[i][0] || "").trim() !== newRecover) {
      recCol[i][0] = newRecover;
      changedSync = true;
    }
  }
  if (changedSync) {
    hrRange.setValues(hrCol);
    recRange.setValues(recCol);
  }

  // =========================================================
  // (3) Post-actions based on HR Decision (speed optimized)
  // =========================================================

  const refInfo = new Map();    // ref -> {lastSheetRow, lastRowMonthDate, emp, name, dept, emiAmt}
  const refRowList = new Map(); // ref -> [{idx0, monthDate}]

  for (let i = 0; i < emiVals.length; i++) {
    const ref = norm_(emiVals[i][E.ref]);
    if (!ref) continue;

    const monthDate = toFirstOfMonthDate_(emiVals[i][E.month]);
    const sheetRow = i + 2;

    if (!refRowList.has(ref)) refRowList.set(ref, []);
    refRowList.get(ref).push({ idx0: i, monthDate });

    const prev = refInfo.get(ref) || {
      lastSheetRow: 0,
      lastRowMonthDate: null,
      emp: "",
      name: "",
      dept: "",
      emiAmt: "",
    };

    if (sheetRow > prev.lastSheetRow) {
      prev.lastSheetRow = sheetRow;
      prev.lastRowMonthDate = monthDate;
      prev.emp = String(emiVals[i][E.emp] || "").trim();
      prev.name = String(emiVals[i][E.name] || "").trim();
      prev.dept = String(emiVals[i][E.dept] || "").trim();
      prev.emiAmt = String(emiVals[i][E.emiAmt] || "").trim();
      refInfo.set(ref, prev);
    } else {
      refInfo.set(ref, prev);
    }
  }

  const props = PropertiesService.getScriptProperties();

  // Decision indices
  const decisionIdx = [];
  for (let i = 0; i < hrCol.length; i++) {
    const d = String(hrCol[i][0] || "").trim();
    if (d) decisionIdx.push(i);
  }

  // Prepare SKIP rows to append
  const skipAppendRows = []; // each row is full width array for setValues
  const lastColCount = shEmi.getLastColumn();
  let changedWO = false;

  for (const i of decisionIdx) {
    const decisionUC = String(hrCol[i][0] || "").trim().toUpperCase();
    const ref = norm_(emiVals[i][E.ref]);
    const emp = norm_(emiVals[i][E.emp]);
    const decisionMonthKey = normMonthKey_(emiVals[i][E.month]);
    const decisionMonthDate = toFirstOfMonthDate_(emiVals[i][E.month]);

    if (!ref || !emp || !decisionMonthKey) continue;

    // SKIP: append one row at first empty row (batch)
    if (decisionUC === "SKIP") {
      const propKey = _PROP_SKIP_PREFIX + ref + "::" + decisionMonthKey + "::" + emp;
      if (props.getProperty(propKey) === "1") continue;

      const info = refInfo.get(ref);
      if (!info || !info.lastRowMonthDate) continue;

      const nextMonth = addMonths_(info.lastRowMonthDate, 1);

      const newRow = new Array(lastColCount).fill("");
      newRow[E.month] = nextMonth; // Date
      newRow[E.emp] = info.emp || emp;
      newRow[E.name] = info.name;
      newRow[E.dept] = info.dept;
      newRow[E.ref] = ref;
      newRow[E.emiAmt] = String(emiVals[i][E.emiAmt] || "").trim(); // ✅ FIXED: use skipped row's own EMI Amount (not last row's)
      newRow[E.status] = "ACTIVE";

      skipAppendRows.push(newRow);
      props.setProperty(propKey, "1");
      continue;
    }

    // RESIGNED / ABSCOND: write-off future rows strictly after decision month
    if (decisionUC === "RESIGNED" || decisionUC === "ABSCOND") {
      if (!decisionMonthDate) continue;

      const rows = refRowList.get(ref) || [];
      for (const rr of rows) {
        if (!rr.monthDate) continue;
        if (rr.monthDate <= decisionMonthDate) continue;

        const j = rr.idx0;

        if (String(woAmtCol[j][0] || "").trim() === "") {
          woAmtCol[j][0] = String(emiAmtCol[j][0] || "").trim();
          changedWO = true;
        }
        if (String(woTsCol[j][0] || "").trim() === "") {
          woTsCol[j][0] = stamp;
          changedWO = true;
        }
        if (String(emiAmtCol[j][0] || "").trim() !== "0") {
          emiAmtCol[j][0] = "0";
          changedWO = true;
        }
        if (String(statusCol[j][0] || "").trim().toUpperCase() !== "WRITE OFF") {
          statusCol[j][0] = "WRITE OFF";
          changedWO = true;
        }
      }
    }
  }

  if (changedWO) {
    emiAmtRange.setValues(emiAmtCol);
    statusRange.setValues(statusCol);
    woAmtRange.setValues(woAmtCol);
    woTsRange.setValues(woTsCol);
  }

  // =========================================================
  // APPEND SKIP rows at FIRST EMPTY ROW (by Month column)
  // =========================================================
  if (skipAppendRows.length) {
    const startRow = getNextEmptyRowByColumn_(shEmi, E.month + 1); // 1-based col
    ensureRows_(shEmi, startRow + skipAppendRows.length - 1);

    const writeRange = shEmi.getRange(startRow, 1, skipAppendRows.length, lastColCount);
    writeRange.setValues(skipAppendRows);

    const monthRange = shEmi.getRange(startRow, E.month + 1, skipAppendRows.length, 1);
    monthRange.setNumberFormat("MMMM_yyyy"); // your custom display
  }
}

/* ========================= Helpers ========================= */

function getHeaderMapUpper_(sh) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0]
    .map(h => String(h || "").trim().toUpperCase());
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i; });
  return map;
}

function req_(map, name) {
  const key = String(name || "").trim().toUpperCase();
  if (!(key in map)) throw new Error(`Missing required header: ${name}`);
  return map[key];
}

function ensureHeader_(sh, map, headerName) {
  const key = String(headerName || "").trim().toUpperCase();
  if (map[key] != null) return map;
  sh.getRange(1, sh.getLastColumn() + 1).setValue(headerName);
  return map;
}

function norm_(v) {
  return String(v == null ? "" : v).trim().toUpperCase();
}

function normMonthKey_(v) {
  if (v == null || String(v).trim() === "") return "";

  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    const d = new Date(v.getFullYear(), v.getMonth(), 1);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "MMMM_yyyy").toUpperCase();
  }

  let s = String(v).trim();
  s = s.replace(/^ATTENDANCE[_\s]*/i, "");

  const d2 = new Date(s);
  if (!isNaN(d2.getTime())) {
    const d = new Date(d2.getFullYear(), d2.getMonth(), 1);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "MMMM_yyyy").toUpperCase();
  }

  s = s.replace(/\s+/g, "_").replace(/_+/g, "_");
  return s.toUpperCase();
}

function toFirstOfMonthDate_(v) {
  if (v == null || String(v).trim() === "") return null;

  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return new Date(v.getFullYear(), v.getMonth(), 1);
  }

  const s = String(v).trim();
  const d = new Date(s);
  if (!isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), 1);

  const k = normMonthKey_(s);
  const m = k.match(/^([A-Z]+)_([0-9]{4})$/);
  if (!m) return null;

  const mon = m[1];
  const year = Number(m[2]);

  const idx = {
    JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5,
    JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11,
  }[mon];

  if (idx == null) return null;
  return new Date(year, idx, 1);
}

function addMonths_(d, add) {
  return new Date(d.getFullYear(), d.getMonth() + add, 1);
}

/**
 * Find next empty row by scanning a single column (1-based).
 * Looks from bottom up and returns lastNonEmptyRow+1 (min 2).
 */
function getNextEmptyRowByColumn_(sh, col1Based) {
  const maxRows = sh.getMaxRows();
  if (maxRows < 2) return 2;

  const vals = sh.getRange(2, col1Based, maxRows - 1, 1).getDisplayValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0] || "").trim() !== "") {
      return i + 3; // i is 0-based within range starting at row2
    }
  }
  return 2;
}

/** Ensure sheet has at least neededLastRow rows */
function ensureRows_(sh, neededLastRow) {
  const cur = sh.getMaxRows();
  if (cur < neededLastRow) sh.insertRowsAfter(cur, neededLastRow - cur);
}
