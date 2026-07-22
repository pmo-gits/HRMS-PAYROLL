function glpPushLeaveLedgerSnapshotAndUpdateBalances_(attendanceSS) {
  const attendanceFileName = String(attendanceSS.getName() || "").trim();

  const ym = yearMonthFromAttendanceFileName_(attendanceFileName);
  if (!ym) return;

  const year = ym.year;
  const month = ym.month;

  const shEntry = attendanceSS.getSheetByName("Attendance entry");
  if (!shEntry) throw new Error("Sheet not found in Attendance file: Attendance entry");

  const entryLastRow = shEntry.getLastRow();
  const entryLastCol = shEntry.getLastColumn();
  if (entryLastRow < 2 || entryLastCol < 1) return;

  const entryMap = getHeaderMapUpper_(shEntry);

  function req(map, header) {
    const key = String(header || "").trim().toUpperCase();
    if (!(key in map)) throw new Error(`Missing required header: ${header}`);
    return map[key];
  }

  const A = {
    empCode: req(entryMap, "EMPLOYEE CODE"),
    name: req(entryMap, "NAME"),
    elEarn: req(entryMap, "EL EARNED"),
    clEarn: req(entryMap, "CL EARNED"),
    slEarn: req(entryMap, "SL EARNED"),
    elBal: req(entryMap, "EL BALANCE"),
    clBal: req(entryMap, "CL BALANCE"),
    slBal: req(entryMap, "SL BALANCE"),
    apEl: req(entryMap, "APPROVED EL DAYS"),
    apCl: req(entryMap, "APPROVED CL DAYS"),
    apSl: req(entryMap, "APPROVED SL DAYS"),
    newEl: req(entryMap, "NEW EL BALANCE"),
    newCl: req(entryMap, "NEW CL BALANCE"),
    newSl: req(entryMap, "NEW SL BALANCE"),
  };

  const entryVals = shEntry
    .getRange(2, 1, entryLastRow - 1, entryLastCol)
    .getDisplayValues();

  const leaveSS = SpreadsheetApp.openById(GLP_LEAVE_MASTER_SPREADSHEET_ID);

  const shLedger = leaveSS.getSheetById(GLP_APPROVED_LEAVE_LEDGER_SHEET_ID);
  if (!shLedger) throw new Error(`Leave ledger sheet not found by ID: ${GLP_APPROVED_LEAVE_LEDGER_SHEET_ID}`);

  const shMaster = leaveSS.getSheetById(GLP_LEAVE_MASTER_SHEET_ID);
  if (!shMaster) throw new Error(`Leave master sheet not found by ID: ${GLP_LEAVE_MASTER_SHEET_ID}`);

  if (ledgerHasYearMonth_(shLedger, year, month)) return;

  const mLastRow = shMaster.getLastRow();
  const mLastCol = shMaster.getLastColumn();
  if (mLastRow < 2 || mLastCol < 1) return;

  const mMap = getHeaderMapUpper_(shMaster);

  const M = {
    id: req(mMap, "ID.NO"),
    category: req(mMap, "CATEGORY"),
    elBal: req(mMap, "EL BALANCE"),
    clBal: req(mMap, "CL BALANCE"),
    slBal: req(mMap, "SL BALANCE"),
    cfRem: req(mMap, "EL_CF_REMAINING"),
    cfYear: req(mMap, "EL_CF_YEAR"),
    janDone: req(mMap, "EL_JAN_RESET_DONE_YEAR"),
    marDone: req(mMap, "EL_MAR_EXPIRY_DONE_YEAR"),
  };

  const masterVals = shMaster
    .getRange(2, 1, mLastRow - 1, mLastCol)
    .getDisplayValues();

  const masterById = new Map();

  for (let i = 0; i < masterVals.length; i++) {
    const id = String(masterVals[i][M.id] || "").trim();
    if (!id) continue;

    const cat = String(masterVals[i][M.category] || "").trim().toUpperCase();
    masterById.set(id, { idx0: i, category: cat });
  }

  let ledMap = getHeaderMapUpper_(shLedger);

  const requiredHeaders = [
    "ID.NO", "NAME",
    "EL EARNED", "CL EARNED", "SL EARNED",
    "EL BALANCE", "CL BALANCE", "SL BALANCE",
    "APPROVED EL DAYS", "APPROVED CL DAYS", "APPROVED SL DAYS",
    "NEW EL BALANCE", "NEW CL BALANCE", "NEW SL BALANCE",
    "YEAR", "MONTH",
    "EL_CF_USED", "EL_CY_USED"
  ];

  let mutated = false;

  requiredHeaders.forEach(h => {
    if (ledMap[h] == null) {
      shLedger.getRange(1, shLedger.getLastColumn() + 1).setValue(h);
      mutated = true;
    }
  });

  if (mutated) ledMap = getHeaderMapUpper_(shLedger);

  const isDec = String(month || "").toUpperCase() === "DEC";
  const isMar = String(month || "").toUpperCase() === "MAR";
  const monthIdx = monthIndexFromAbbr_(month);
  const yNum = toInt_(year);
  const nextYear = String(isNaN(yNum) ? "" : yNum + 1);
  const prevYear = String(isNaN(yNum) ? "" : yNum - 1);

  const outAligned = [];
  const updates = [];

  for (let i = 0; i < entryVals.length; i++) {
    const r = entryVals[i];

    const idKey = String(r[A.empCode] || "").trim();
    if (!idKey) continue;

    const info = masterById.get(idKey);
    if (!info || info.category !== "STAFF") continue;

    const idx0 = info.idx0;
    const mRow = masterVals[idx0];

    const apElStr = r[A.apEl] || "";
    const newElStr = r[A.newEl] || "";
    const newClStr = r[A.newCl] || "";
    const newSlStr = r[A.newSl] || "";

    const cfRemBefore = toNumber_(mRow[M.cfRem]);
    const cfYearVal = String(mRow[M.cfYear] || "").trim();
    const apElNum = toNumber_(apElStr);

    const cfApplies =
      cfYearVal &&
      cfYearVal === prevYear &&
      monthIdx >= 0 &&
      monthIdx <= 2;

    const cfUsed = cfApplies
      ? Math.min(Math.max(cfRemBefore, 0), Math.max(apElNum, 0))
      : 0;

    const cyUsed = Math.max(apElNum, 0) - cfUsed;

    const row = new Array(shLedger.getLastColumn()).fill("");

    setIfCol_(row, ledMap, "ID.NO", idKey);
    setIfCol_(row, ledMap, "NAME", r[A.name] || "");
    setIfCol_(row, ledMap, "EL EARNED", r[A.elEarn] || "");
    setIfCol_(row, ledMap, "CL EARNED", r[A.clEarn] || "");
    setIfCol_(row, ledMap, "SL EARNED", r[A.slEarn] || "");
    setIfCol_(row, ledMap, "EL BALANCE", r[A.elBal] || "");
    setIfCol_(row, ledMap, "CL BALANCE", r[A.clBal] || "");
    setIfCol_(row, ledMap, "SL BALANCE", r[A.slBal] || "");
    setIfCol_(row, ledMap, "APPROVED EL DAYS", apElStr);
    setIfCol_(row, ledMap, "APPROVED CL DAYS", r[A.apCl] || "");
    setIfCol_(row, ledMap, "APPROVED SL DAYS", r[A.apSl] || "");
    setIfCol_(row, ledMap, "NEW EL BALANCE", newElStr);
    setIfCol_(row, ledMap, "NEW CL BALANCE", newClStr);
    setIfCol_(row, ledMap, "NEW SL BALANCE", newSlStr);
    setIfCol_(row, ledMap, "YEAR", year);
    setIfCol_(row, ledMap, "MONTH", month);
    setIfCol_(row, ledMap, "EL_CF_USED", numberToCell_(cfUsed));
    setIfCol_(row, ledMap, "EL_CY_USED", numberToCell_(cyUsed));

    outAligned.push(row);

    updates.push({
      idx0,
      newEl: newElStr,
      newCl: newClStr,
      newSl: newSlStr,
      cfRemBefore,
      cfYearVal,
      cfApplies,
      cfUsed,
    });
  }

  if (!outAligned.length) return;

  const startRow = nextEmptyRowByColA_(shLedger);
  ensureRows_(shLedger, startRow + outAligned.length - 1);

  shLedger
    .getRange(startRow, 1, outAligned.length, outAligned[0].length)
    .setValues(outAligned);

  const elRange = shMaster.getRange(2, M.elBal + 1, masterVals.length, 1);
  const clRange = shMaster.getRange(2, M.clBal + 1, masterVals.length, 1);
  const slRange = shMaster.getRange(2, M.slBal + 1, masterVals.length, 1);

  const cfRange = shMaster.getRange(2, M.cfRem + 1, masterVals.length, 1);
  const cfYearRange = shMaster.getRange(2, M.cfYear + 1, masterVals.length, 1);
  const janDoneRange = shMaster.getRange(2, M.janDone + 1, masterVals.length, 1);
  const marDoneRange = shMaster.getRange(2, M.marDone + 1, masterVals.length, 1);

  const elCol = elRange.getDisplayValues();
  const clCol = clRange.getDisplayValues();
  const slCol = slRange.getDisplayValues();

  const cfCol = cfRange.getDisplayValues();
  const cfYearCol = cfYearRange.getDisplayValues();
  const janDoneCol = janDoneRange.getDisplayValues();
  const marDoneCol = marDoneRange.getDisplayValues();

  let changed = false;

  for (const u of updates) {
    const j = u.idx0;
    if (j == null || j < 0 || j >= masterVals.length) continue;

    if (String(elCol[j][0] || "") !== String(u.newEl || "")) {
      elCol[j][0] = u.newEl;
      changed = true;
    }

    if (String(clCol[j][0] || "") !== String(u.newCl || "")) {
      clCol[j][0] = u.newCl;
      changed = true;
    }

    if (String(slCol[j][0] || "") !== String(u.newSl || "")) {
      slCol[j][0] = u.newSl;
      changed = true;
    }

    if (u.cfApplies) {
      const cfAfter = Math.max(0, (u.cfRemBefore || 0) - (u.cfUsed || 0));
      if (String(cfCol[j][0] || "") !== String(numberToCell_(cfAfter))) {
        cfCol[j][0] = numberToCell_(cfAfter);
        changed = true;
      }
    }

    if (isDec && nextYear && String(janDoneCol[j][0] || "").trim() !== nextYear) {
      if (String(clCol[j][0] || "") !== "0") {
        clCol[j][0] = "0";
        changed = true;
      }

      if (String(slCol[j][0] || "") !== "0") {
        slCol[j][0] = "0";
        changed = true;
      }

      const decClosingEl = toNumber_(elCol[j][0]);

      if (String(cfCol[j][0] || "") !== String(numberToCell_(decClosingEl))) {
        cfCol[j][0] = numberToCell_(decClosingEl);
        changed = true;
      }

      if (String(cfYearCol[j][0] || "").trim() !== String(year)) {
        cfYearCol[j][0] = String(year);
        changed = true;
      }

      janDoneCol[j][0] = nextYear;
      changed = true;
    }

    if (isMar && String(marDoneCol[j][0] || "").trim() !== String(year)) {
      const cfYearVal = String(cfYearCol[j][0] || "").trim();
      const cfNow = toNumber_(cfCol[j][0]);
      const elNow = toNumber_(elCol[j][0]);

      const shouldExpire = cfYearVal && cfYearVal === prevYear;

      if (shouldExpire && cfNow > 0) {
        elCol[j][0] = numberToCell_(elNow - cfNow);
        cfCol[j][0] = "0";
        changed = true;
      }

      marDoneCol[j][0] = String(year);
      changed = true;
    }
  }

  if (changed) {
    elRange.setValues(elCol);
    clRange.setValues(clCol);
    slRange.setValues(slCol);

    cfRange.setValues(cfCol);
    cfYearRange.setValues(cfYearCol);
    janDoneRange.setValues(janDoneCol);
    marDoneRange.setValues(marDoneCol);
  }

  function getHeaderMapUpper_(sh) {
    const lastCol = sh.getLastColumn();
    if (lastCol < 1) return {};
    const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
      .map(h => String(h || "").trim().toUpperCase());

    const map = {};
    headers.forEach((h, i) => {
      if (h) map[h] = i;
    });
    return map;
  }

  function ledgerHasYearMonth_(shLedger, year, month) {
    const map = getHeaderMapUpper_(shLedger);
    const yIdx0 = map["YEAR"];
    const mIdx0 = map["MONTH"];
    if (yIdx0 == null || mIdx0 == null) return false;

    const lastRow = shLedger.getLastRow();
    if (lastRow < 2) return false;

    const yVals = shLedger.getRange(2, yIdx0 + 1, lastRow - 1, 1).getDisplayValues();
    const mVals = shLedger.getRange(2, mIdx0 + 1, lastRow - 1, 1).getDisplayValues();

    const yT = String(year || "").trim();
    const mT = String(month || "").trim().toUpperCase();

    for (let i = yVals.length - 1; i >= 0; i--) {
      const y = String(yVals[i][0] || "").trim();
      const m = String(mVals[i][0] || "").trim().toUpperCase();
      if (!y && !m) continue;
      if (y === yT && m === mT) return true;
    }

    return false;
  }

  function yearMonthFromAttendanceFileName_(fileName) {
    const m = String(fileName || "")
      .trim()
      .match(/^Attendance[_\-\s]+([A-Za-z]+)[_\-\s]+(\d{4})$/i);

    if (!m) return null;

    const mon = String(m[1] || "").trim().toLowerCase();
    const year = String(m[2] || "").trim();

    const idx = monthIndexFromName_(mon);
    if (idx < 0) return null;

    const abbr = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][idx];

    return { year, month: abbr };
  }

  function monthIndexFromName_(monLower) {
    const months = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december"
    ];

    return months.indexOf(String(monLower || "").trim());
  }

  function monthIndexFromAbbr_(monAbbr) {
    const abbrs = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    return abbrs.indexOf(String(monAbbr || "").trim().toUpperCase());
  }

  function setIfCol_(rowArr, map, header, value) {
    const idx0 = map[String(header || "").trim().toUpperCase()];
    if (idx0 != null) rowArr[idx0] = value;
  }

  function nextEmptyRowByColA_(sh) {
    const maxRows = sh.getMaxRows();
    if (maxRows < 2) return 2;

    const colA = sh.getRange(1, 1, maxRows, 1).getDisplayValues();

    for (let i = colA.length - 1; i >= 0; i--) {
      if (String(colA[i][0] || "").trim() !== "") return i + 2;
    }

    return 2;
  }

  function ensureRows_(sh, neededLastRow) {
    const cur = sh.getMaxRows();
    if (cur < neededLastRow) {
      sh.insertRowsAfter(cur, neededLastRow - cur);
    }
  }

  function toNumber_(v) {
    const s = String(v == null ? "" : v).replace(/,/g, "").trim();
    if (!s) return 0;

    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function toInt_(v) {
    const s = String(v == null ? "" : v).trim();
    const n = parseInt(s, 10);
    return isNaN(n) ? NaN : n;
  }

  function numberToCell_(n) {
    if (n == null || isNaN(n)) return "0";

    const x = Math.round(n * 1000000) / 1000000;
    return String(x);
  }
}
