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
 *    - RESIGNED / ABSCOND: settlement-aware (v5)
 *        Case A - Last Working Day falls in or before the decision month (or is blank):
 *          there is no month left to recover from, so settle now.
 *          Decision row: Write off Amount -> the REAL outstanding balance (once, only if
 *          blank), Write off Time stamp -> timestamp, Settlement Stage -> FINAL.
 *          Rows strictly after the decision month: EMI Amount -> 0, Status -> WRITE OFF.
 *        Case B - Last Working Day is in a later month:
 *          keep the months up to and including the last-working-day month OPEN (Status
 *          ACTIVE), stamped Settlement Stage = SETTLING, or FINAL for the last-working-day
 *          month itself. Missing months in that window are created. Rows beyond the
 *          last-working-day month are written off. NOTHING is booked into Write off Amount
 *          while settling - booking it is what releases the Employee Master exit lock.
 *        The last-working-day month later re-enters through Case A on its own run, which is
 *        what books the final write-off. One rule covers both.
 *
 * Notes:
 * - Header maps are cached once per sheet (re-read only if we add missing headers)
 * - No split triggers (single entry function)
 * - Idempotent for SKIP via ScriptProperties; settlement rows are idempotent by existence
 *   check (a missing month is created, an existing one is never duplicated)
 ************************************************/

var _M_SHEET_SHARED = "Shared EMI Summary";
var _M_SHEET_RECOVERED = "Recovered Amount Ledger";
var _M_SHEET_EMI_SCHEDULE = "EMI_SCHEDULE";

// Idempotency for SKIP extension (avoid adding multiple rows for same decision)
var _PROP_SKIP_PREFIX = "SKIP_EXTENDED_V4::"; // <REF>::<MONTHKEY>::<EMP>

// Traceability marker for an opened settlement window (not the guard - see header note)
var _PROP_SETTLE_PREFIX = "SETTLEMENT_OPENED_V1::"; // <REF>::<LWDMONTHKEY>::<EMP>

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
    stage: req_(recMap, "SETTLEMENT STAGE"),
    lwd: req_(recMap, "LAST WORKING DAY"),
    closeIn: req_(recMap, "CLOSE IN MONTHS"),
  };

  const recLastRow = shRec.getLastRow();
  if (recLastRow < 2) return;

  const recVals = shRec.getRange(2, 1, recLastRow - 1, shRec.getLastColumn()).getValues();

  const recoveredByKey = new Map();

  // Close In Months, per EMI reference, from the LATEST ledger month that carries one.
  // A later month's plan supersedes an earlier one — the admin has changed their mind.
  const closeInByRef = new Map();

  // Last Working Day, per EMI reference: the EARLIEST date ever recorded for it.
  //
  // ONE REFERENCE CARRIES ONE DATE, AND IT MAY ONLY MOVE FORWARD IN TIME TOWARDS TODAY.
  //
  //   Brought FORWARD (he leaves sooner than declared) -> APPLIED. There are now fewer months
  //   to recover in, so the window must compress. Refusing this was a real bug: the months
  //   past the true departure stayed ACTIVE waiting for a payroll that never runs, nothing
  //   recovered, no write-off booked - and since booking the write-off is what releases the
  //   Employee Master exit lock, the advance could never close and the employee could never
  //   be released.
  //
  //   Pushed BACK (notice extended) -> REFUSED, and logged. Extending after a settlement has
  //   opened re-spreads the balance over more months and CUTS each instalment, on nothing but
  //   the employee's word that they will stay. If they then abscond the shortfall is
  //   unrecoverable. Owner's decision, 2026-08-21: the date is fixed once, downward only.
  //
  // Before this, BOTH directions were silently ignored - the forward correction because
  // pass (2) only wrote into a blank cell and Case B had already stamped the whole window,
  // and the backward one by the same accident rather than by any rule. Nobody was told.
  const lwdByRef = new Map();
  const lwdRefusedByRef = new Map();

  for (let i = 0; i < recVals.length; i++) {
    const row = recVals[i];
    const monthKey = normMonthKey_(row[R.month]);
    const emp = norm_(row[R.emp]);
    const ref = norm_(row[R.ref]);
    if (!monthKey || !emp || !ref) continue;

    const rowLwd = toRealDate_(row[R.lwd]);
    if (rowLwd) {
      const prevLwd = lwdByRef.get(ref);
      if (!prevLwd || rowLwd.getTime() < prevLwd.getTime()) {
        lwdByRef.set(ref, rowLwd);
      } else if (rowLwd.getTime() > prevLwd.getTime()) {
        lwdRefusedByRef.set(ref, { attempted: rowLwd, kept: prevLwd, emp: emp });
      }
    }

    const planN = Math.round(numOrZero_(row[R.closeIn]));
    if (planN >= 1) {
      const planMonth = toFirstOfMonthDate_(row[R.month]);
      const prev = closeInByRef.get(ref);
      if (planMonth && (!prev || planMonth.getTime() > prev.monthDate.getTime())) {
        closeInByRef.set(ref, { n: planN, monthDate: planMonth, emp: emp });
      }
    }

    const key = [monthKey, emp, ref].join("||");
    recoveredByKey.set(key, {
      hr: String(row[R.hr] || "").trim(),
      // NOT `|| ""` — this comes from getValues(), so a recovered amount of exactly 0 is the
      // NUMBER 0, and `0 || ""` is "". Four passes read a blank Recover Amount as "this month
      // has not recovered yet, it is still available", so a skipped month would be handed out
      // again. SKIP produces a recovery of 0 by design.
      recoveredAmt: strOrBlank_(row[R.recoveredAmt]),
      stage: String(row[R.stage] == null ? "" : row[R.stage]).trim(),
      lwd: row[R.lwd],
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
    curBal: req_(emiMap, "CURRENT BALANCE"),
    status: req_(emiMap, "STATUS"),
    hr: req_(emiMap, "HR DECISION"),
    recover: req_(emiMap, "RECOVER AMOUNT"),
    woAmt: req_(emiMap, "WRITE OFF AMOUNT"),
    woTs: req_(emiMap, "WRITE OFF TIME STAMP"),
    stage: req_(emiMap, "SETTLEMENT STAGE"),
    lwd: req_(emiMap, "LAST WORKING DAY"),
    setBy: req_(emiMap, "AMOUNT SET BY"),
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
  const stageRange = shEmi.getRange(2, E.stage + 1, emiNumRows, 1);
  const lwdRange = shEmi.getRange(2, E.lwd + 1, emiNumRows, 1);
  const setByRange = shEmi.getRange(2, E.setBy + 1, emiNumRows, 1);
  const setByCol = setByRange.getDisplayValues();

  const hrCol = hrRange.getDisplayValues();
  const recCol = recRange.getDisplayValues();
  const emiAmtCol = emiAmtRange.getDisplayValues();
  const statusCol = statusRange.getDisplayValues();
  const woAmtCol = woAmtRange.getDisplayValues();
  const woTsCol = woTsRange.getDisplayValues();
  const stageCol = stageRange.getDisplayValues();
  // RAW values, not display: Last Working Day must stay a real Date. Reading it as a display
  // string and writing it back stores raw JS date text ("Tue Sep 15 2026 00:00:00 GMT+0530"),
  // which then travels into the attendance file's date-validated column.
  const lwdCol = lwdRange.getValues();

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

    // Settlement Stage: ledger value is authoritative for the row's own month.
    const newStage = String(src.stage || "").trim();
    if (newStage && String(stageCol[i][0] || "").trim().toUpperCase() !== newStage.toUpperCase()) {
      stageCol[i][0] = newStage;
      changedSync = true;
    }

    // Last Working Day is NOT written here - see the per-reference pass immediately below.
    // Writing it row by row from each row's own ledger entry is what let one reference end up
    // carrying two different dates at once.
  }

  // Last Working Day, normalised per reference.
  //
  // Every row of a reference that carries a date carries THE SAME date - the earliest ever
  // recorded (see lwdByRef above). A row with no date keeps none: rows before the departure
  // was declared are not part of the settlement and must stay blank.
  //
  // This deliberately overwrites. The old write-once guard meant a correction had nowhere to
  // land, because Case B stamps the whole settlement window the moment the settlement opens.
  for (let i = 0; i < emiVals.length; i++) {
    const ref = norm_(emiVals[i][E.ref]);
    if (!ref) continue;

    const effLwd = lwdByRef.get(ref);
    if (!effLwd) continue;

    const cur = lwdCol[i][0];
    const curIsDate = Object.prototype.toString.call(cur) === "[object Date]";
    const curDate = toRealDate_(cur);
    const rowHasLedgerDate = (() => {
      const monthKey = normMonthKey_(emiVals[i][E.month]);
      const emp = norm_(emiVals[i][E.emp]);
      if (!monthKey || !emp) return false;
      const src = recoveredByKey.get([monthKey, emp, ref].join("||"));
      return !!(src && toRealDate_(src.lwd));
    })();

    // Nothing there and no ledger row claiming one: leave it blank.
    if (!curDate && !rowHasLedgerDate) continue;

    // Also rewrites a cell holding raw JS date text - it parses to the right day, so a value
    // comparison alone would call it correct and leave it wrong forever.
    if (!curIsDate || !curDate || curDate.getTime() !== effLwd.getTime()) {
      lwdCol[i][0] = effLwd;
      changedSync = true;
    }
  }

  // Tell somebody. A refused extension used to vanish without trace.
  for (const [ref, r] of lwdRefusedByRef) {
    console.error(
      `3A: REFUSED a later Last Working Day for ${ref} (${r.emp}) — ` +
      `${Utilities.formatDate(r.attempted, tz, "dd-MMM-yyyy")} was entered but ` +
      `${Utilities.formatDate(r.kept, tz, "dd-MMM-yyyy")} is kept. A departure date may only ` +
      `be brought forward, never extended, once a settlement has opened.`
    );
  }
  if (changedSync) {
    hrRange.setValues(hrCol);
    recRange.setValues(recCol);
    stageRange.setValues(stageCol);
    lwdRange.setValues(lwdCol);
    lwdRange.setNumberFormat("M/d/yyyy");
    // Force Current Balance (an ARRAYFORMULA over the Advance Ledger) to recalculate so the
    // residual read below is ground truth, not a pre-sync figure.
    SpreadsheetApp.flush();
  }

  // Real outstanding balance per EMI Reference, AFTER this run's recovery has been synced.
  const balColVals = shEmi.getRange(2, E.curBal + 1, emiNumRows, 1).getValues();
  const residualByRef = new Map();
  for (let i = 0; i < emiVals.length; i++) {
    const ref = norm_(emiVals[i][E.ref]);
    if (!ref || residualByRef.has(ref)) continue;

    // Skip ONLY a genuinely blank cell — Current Balance returns "" for a cancelled advance
    // or before the formula has resolved. A balance of 0 is a real, meaningful figure and
    // must be recorded: it is exactly the case that means "fully repaid, close what is left".
    // Testing it with `|| ""` treated 0 as absent, so a settled advance never reached the
    // closing pass below.
    const raw = balColVals[i][0];
    if (raw === "" || raw == null) continue;

    residualByRef.set(ref, numOrZero_(raw));
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
      prev.emiAmt = strOrBlank_(emiVals[i][E.emiAmt]); // not `|| ""` - a real 0 must survive
      refInfo.set(ref, prev);
    } else {
      refInfo.set(ref, prev);
    }
  }

  const props = PropertiesService.getScriptProperties();

  // Refs where ANY row is already CANCELLED (or CANCELLED & GOT PAID) — Cancel EMI stamps this
  // deliberately, and the decision loop below must never touch a reference in that state. Without
  // this, a stale HR Decision still sitting in the ledger for a cancelled reference could flip
  // its rows straight back to WRITE OFF/CLOSED on the next scheduled run, silently undoing an
  // admin's cancel. (3a2), (3b), (3c) and (3d) are already safe — a cancelled reference has no
  // Current Balance, so `residualByRef` carries no entry for it and each of those passes skips it
  // on that basis. This loop is the one place that had no such check.
  const cancelledRefs = new Set();
  for (let i = 0; i < emiVals.length; i++) {
    const ref = norm_(emiVals[i][E.ref]);
    if (ref && norm_(statusCol[i][0]).startsWith("CANCELLED")) cancelledRefs.add(ref);
  }

  // Decision indices
  const decisionIdx = [];
  for (let i = 0; i < hrCol.length; i++) {
    const d = String(hrCol[i][0] || "").trim();
    if (d) decisionIdx.push(i);
  }

  // Prepare SKIP rows to append
  const skipAppendRows = []; // each row is full width array for setValues
  const settlementAppendRows = []; // field objects - written column by column, see below
  // A reference gets ONE write-off, ever. Case A used to check only the row it was standing on,
  // so a second decision row arriving later (a correction, a re-declared departure) booked a
  // SECOND write-off for the same balance while the first was still on the sheet - the balance
  // forgiven twice, and the Employee Master exit lock released off the earlier one.
  const writtenOffRefs = new Set();
  for (let i = 0; i < emiVals.length; i++) {
    const woRef = norm_(emiVals[i][E.ref]);
    if (woRef && numOrZero_(woAmtCol[i][0]) > 0) writtenOffRefs.add(woRef);
  }

  const settlementRefs = new Set();      // refs Case A/B own, so (3d) leaves their schedules alone
  const settlementLwdByRef = new Map();  // ref -> last-working-day month, for (3c)'s protection
  const skipRefs = new Set();            // refs SKIP extended this run — (3d) must not extend them too
  const lastColCount = shEmi.getLastColumn();
  let changedWO = false;
  let changedStage = false;
  let changedSetBy = false;

  for (const i of decisionIdx) {
    const decisionUC = String(hrCol[i][0] || "").trim().toUpperCase();
    const ref = norm_(emiVals[i][E.ref]);
    const emp = norm_(emiVals[i][E.emp]);
    const decisionMonthKey = normMonthKey_(emiVals[i][E.month]);
    const decisionMonthDate = toFirstOfMonthDate_(emiVals[i][E.month]);

    if (!ref || !emp || !decisionMonthKey) continue;
    if (cancelledRefs.has(ref)) continue; // Cancel EMI owns this reference now — hands off

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
      newRow[E.emiAmt] = strOrBlank_(emiVals[i][E.emiAmt]); // skipped row's own EMI Amount (not last row's); `|| ""` blanked a real 0
      newRow[E.status] = "ACTIVE";

      skipAppendRows.push(newRow);
      skipRefs.add(ref);
      props.setProperty(propKey, "1");
      continue;
    }

    // RESIGNED / ABSCOND: settlement-aware (v5)
    if (decisionUC === "RESIGNED" || decisionUC === "ABSCOND") {
      if (!decisionMonthDate) continue;

      settlementRefs.add(ref);

      const rows = refRowList.get(ref) || [];
      const residual = residualByRef.has(ref) ? residualByRef.get(ref) : 0;

      // Last Working Day, month granularity. Blank -> treated as Case A, which is exactly
      // the pre-v5 behaviour, so missing data can never be worse than the old system.
      const lwdMonth = toFirstOfMonthDate_(lwdCol[i][0]);

      // A last working day more than four months out is treated as bad data rather than a
      // notice period. The likeliest cause is a bare spreadsheet serial reaching this column,
      // because `new Date("46266")` parses it as the YEAR 46266 — and the window loop below
      // has no upper bound, so it would try to create a quarter of a million rows.
      //
      // The reference is skipped entirely: no settlement opens, no rebalance, nothing is
      // written. That is deliberately conservative, but it must not be SILENT — an advance
      // that quietly stops being managed is the hardest kind of failure to notice. Logged so
      // it is visible in the Apps Script execution log.
      //
      // NOTE: a genuine notice period longer than four months would also be frozen here.
      if (lwdMonth && lwdMonth.getTime() > addMonths_(decisionMonthDate, 4).getTime()) {
        console.error(
          `3A: skipped ${ref} (${emp}) — Last Working Day ` +
          `${Utilities.formatDate(lwdMonth, tz, "MMMM_yyyy")} is more than 4 months after the ` +
          `decision month ${decisionMonthKey}. Check the date; this advance is NOT being settled.`
        );
        continue;
      }

      if (lwdMonth) settlementLwdByRef.set(ref, lwdMonth);

      // ---------------------------------------------------------------
      // Case A - no month left to recover from. Settle now.
      // ---------------------------------------------------------------
      if (!lwdMonth || lwdMonth.getTime() <= decisionMonthDate.getTime()) {
        // ONE write-off, booked once, for the real outstanding balance - once per REFERENCE,
        // not once per row. See writtenOffRefs above.
        const bookHere = residual > 0 && !writtenOffRefs.has(ref);
        if (bookHere) {
          woAmtCol[i][0] = String(residual);
          changedWO = true;
          if (String(woTsCol[i][0] || "").trim() === "") {
            woTsCol[i][0] = stamp;
            changedWO = true;
          }
          writtenOffRefs.add(ref);
        }
        if (String(stageCol[i][0] || "").trim() === "") {
          stageCol[i][0] = "FINAL";
          changedStage = true;
        }
        // This row is done. Leaving it ACTIVE would let next month's attendance pull it again.
        const closedStatus = numOrZero_(woAmtCol[i][0]) > 0 ? "WRITE OFF" : "CLOSED";
        if (norm_(statusCol[i][0]) !== closedStatus) {
          statusCol[i][0] = closedStatus;
          changedWO = true;
        }

        // Everything after the decision month carries no money and must not be pulled again.
        for (const rr of rows) {
          if (!rr.monthDate) continue;
          if (rr.monthDate.getTime() <= decisionMonthDate.getTime()) continue;

          const j = rr.idx0;
          if (String(emiAmtCol[j][0] || "").trim() !== "0") {
            emiAmtCol[j][0] = "0";
            changedWO = true;
          }
          // CLOSED, not WRITE OFF. Nothing is forgiven on these rows - they carry no write-off
          // amount at all; they are months that simply cannot happen. Labelling them WRITE OFF
          // made the sheet read as though the balance had been forgiven several times over.
          if (norm_(statusCol[j][0]) !== "CLOSED") {
            statusCol[j][0] = "CLOSED";
            changedWO = true;
          }
        }
        continue;
      }

      // ---------------------------------------------------------------
      // Case B - months remain. Hold the window (decisionMonth, lwdMonth] open.
      // Nothing is booked into Write off Amount here: booking it is what flips
      // Advance Ledger!EMI Status to WRITE OFF and releases the exit lock.
      // ---------------------------------------------------------------
      const haveMonths = new Set();
      const openRows = [];  // AUTO window rows, nothing recovered yet - these get rebalanced
      let adminFixed = 0;   // months the admin has pinned; their amounts are not redistributed

      for (const rr of rows) {
        if (!rr.monthDate) continue;
        const t = rr.monthDate.getTime();
        if (t <= decisionMonthDate.getTime()) continue;

        const j = rr.idx0;

        if (t <= lwdMonth.getTime()) {
          haveMonths.add(normMonthKey_(rr.monthDate));

          // A booked write-off is final and is NEVER reversed. This covers two cases at once:
          // the last-working-day month once Case A has settled it, and any row written off by
          // the pre-v5 logic. Without this, an earlier decision row processed later in the
          // loop could re-open a month that was already concluded.
          if (numOrZero_(woAmtCol[j][0]) > 0) continue;

          const wantStage = (t === lwdMonth.getTime()) ? "FINAL" : "SETTLING";
          if (String(stageCol[j][0] || "").trim().toUpperCase() !== wantStage) {
            stageCol[j][0] = wantStage;
            changedStage = true;
          }
          // Settlement rows are system-owned, so unlike the decision row (write-once, HR's
          // fact) the master overwrites them. That also self-heals a cell holding raw JS date
          // text from before the Date fix - it parses to the right day, so a value comparison
          // alone would consider it correct and leave it there forever.
          const srcLwd = lwdCol[i][0];
          if (String(srcLwd || "").trim() !== "") {
            const cur = lwdCol[j][0];
            const curIsDate = Object.prototype.toString.call(cur) === "[object Date]";
            const a = toRealDate_(srcLwd);
            const b = toRealDate_(cur);
            const sameDay = a && b && a.getTime() === b.getTime();

            if (!curIsDate || !sameDay) {
              lwdCol[j][0] = srcLwd;
              changedStage = true;
            }
          }

          // Keep it recoverable. Only re-open a row that is blank or was flagged WRITE OFF
          // without any amount booked - never resurrect a CANCELLED or CLOSED row.
          const st = norm_(statusCol[j][0]);
          if (st === "" || st === "WRITE OFF") {
            statusCol[j][0] = "ACTIVE";
            changedWO = true;
          }

          // A month that has already recovered is finished - its EMI Amount is part of a
          // locked record and must never be rewritten. Of what remains, an ADMIN row was
          // pinned deliberately: its amount is honoured and taken off the top, and only the
          // AUTO rows share out whatever is left.
          if (String(recCol[j][0] || "").trim() === "") {
            if (norm_(setByCol[j][0]) === "ADMIN") adminFixed += numOrZero_(emiAmtCol[j][0]);
            else openRows.push({ idx0: j, monthDate: rr.monthDate });
          }
        } else {
          // Beyond the last working day there is genuinely no month. CLOSED, not WRITE OFF -
          // see the matching note in Case A. These rows carry no write-off amount; calling
          // them WRITE OFF made a compressed window look like a repeated forgiveness.
          if (String(emiAmtCol[j][0] || "").trim() !== "0") {
            emiAmtCol[j][0] = "0";
            changedWO = true;
          }
          if (norm_(statusCol[j][0]) !== "CLOSED") {
            statusCol[j][0] = "CLOSED";
            changedWO = true;
          }
        }
      }

      // Nothing left owed -> no settlement rows to open. The closing pass below tidies up.
      if (residual <= 0) continue;

      const missing = [];
      let m = addMonths_(decisionMonthDate, 1);
      while (m.getTime() <= lwdMonth.getTime()) {
        if (!haveMonths.has(normMonthKey_(m))) missing.push(new Date(m.getTime()));
        m = addMonths_(m, 1);
      }

      // Rebalance across the months that can still recover: existing AUTO rows plus any month
      // still to be created. Recomputed from the LIVE balance every run, so a month that
      // under-recovers (LOP, leave, capacity cap) is automatically absorbed by the ones left.
      const slots = openRows.length + missing.length;
      if (slots <= 0) continue;

      const info = refInfo.get(ref) || {};
      const spread = Math.max(0, residual - adminFixed);
      const perMonth = ceilTo100_(spread / slots);

      // Rounded-up instalments FIRST, remainder in the LAST month — the same convention the
      // EMI scheduler uses when it creates an advance, and the reason a schedule adds up to
      // exactly the balance. Giving every month the rounded figure scheduled 25,200 against a
      // 25,000 balance: no overcharge, because Planned EMI caps at the balance, but the sheet
      // did not add up and nobody reading it could tell whether that mattered.
      //
      // Existing rows and months still to be created are merged and sorted, so a gap in the
      // middle of the window still receives the larger instalment rather than the remainder.
      const window = openRows
        .map(o => ({ monthDate: o.monthDate, idx0: o.idx0 }))
        .concat(missing.map(md => ({ monthDate: md, idx0: null })))
        .sort((a, b) => a.monthDate.getTime() - b.monthDate.getTime());

      let left = spread;

      window.forEach(w => {
        const amount = Math.min(perMonth, left);
        left = Math.max(0, left - amount);

        if (w.idx0 != null) {
          if (String(emiAmtCol[w.idx0][0] || "").trim() !== String(amount)) {
            emiAmtCol[w.idx0][0] = String(amount);
            changedWO = true;
          }
          return;
        }

        settlementAppendRows.push({
          month: new Date(w.monthDate.getTime()),
          emp: info.emp || emp,
          name: info.name || "",
          dept: info.dept || "",
          ref: ref,
          emiAmt: amount,
          stage: (w.monthDate.getTime() === lwdMonth.getTime()) ? "FINAL" : "SETTLING",
          lwd: lwdCol[i][0],
        });
      });

      if (!missing.length) continue;

      props.setProperty(
        _PROP_SETTLE_PREFIX + ref + "::" + normMonthKey_(lwdMonth) + "::" + emp,
        "1"
      );
    }
  }

  // =========================================================
  // (3a2) Book the write-off once the LAST WORKING DAY month has been paid
  //
  // Case A only fires on a row carrying an HR Decision, and only the decision month has one —
  // every settlement month is deliberately left blank so HR never has to re-declare a
  // departure. So 3A kept comparing the last working day against the DECISION month, always
  // concluded "months remain", and took Case B again, every month, forever. The write-off that
  // ENDS a settlement therefore never ran at all. It went unnoticed because every case tested
  // cleared its balance early and was tidied by the closing pass below instead — the path only
  // matters when someone leaves still owing money, which is the case the feature exists for.
  //
  // Detected per row rather than per decision: a row whose own month IS the last-working-day
  // month, whose payroll has already run, and which still leaves a balance. "Payroll has run"
  // is a non-blank Recover Amount — which is exactly why a recovery of 0 has to be stored as
  // "0" and not blank.
  //
  // Booked once. A row already carrying a write-off is skipped, so re-running is harmless.
  // =========================================================
  for (let i = 0; i < emiVals.length; i++) {
    const ref = norm_(emiVals[i][E.ref]);
    if (!ref) continue;

    const rowMonth = toFirstOfMonthDate_(emiVals[i][E.month]);
    const lwdMonth = toFirstOfMonthDate_(lwdCol[i][0]);
    if (!rowMonth || !lwdMonth) continue;
    if (rowMonth.getTime() !== lwdMonth.getTime()) continue;

    if (String(recCol[i][0] || "").trim() === "") continue; // this month has not been paid yet
    if (writtenOffRefs.has(ref)) continue;                  // already booked, anywhere on this ref

    const residual = residualByRef.has(ref) ? residualByRef.get(ref) : 0;
    if (residual <= 0) continue; // fully repaid — the closing pass below handles it

    woAmtCol[i][0] = String(residual);
    writtenOffRefs.add(ref);
    changedWO = true;

    if (String(woTsCol[i][0] || "").trim() === "") woTsCol[i][0] = stamp;

    if (norm_(statusCol[i][0]) !== "WRITE OFF") {
      statusCol[i][0] = "WRITE OFF";
      changedWO = true;
    }
    if (norm_(stageCol[i][0]) !== "FINAL") {
      stageCol[i][0] = "FINAL";
      changedStage = true;
    }
  }

  // =========================================================
  // (3b) Close leftover months once an advance is fully repaid
  //
  // Runs for EVERY reference, not only settlements. An advance can clear early through a
  // one-shot PAY EXTRA, a compressed schedule, or simply better recovery than planned - and
  // the rows scheduled beyond that point would otherwise stay ACTIVE with a live EMI Amount,
  // so the next month would pull an instalment against a zero balance.
  //
  // A row carrying a Recover Amount is left alone: it is a locked record. So are CANCELLED
  // and WRITE OFF rows, which are already concluded by another route.
  // =========================================================
  for (const [ref, rows] of refRowList) {
    if (!residualByRef.has(ref) || residualByRef.get(ref) > 0) continue;

    for (const rr of rows) {
      const j = rr.idx0;
      if (String(recCol[j][0] || "").trim() !== "") continue;

      // CLOSED is allowed through, not skipped. A row can reach CLOSED without a stage — the
      // Close In Months pass sets Status but not Settlement Stage — and skipping it here left
      // the label reading FINAL forever, which says "the last settlement month" about a month
      // the advance never reached. CANCELLED and WRITE OFF ended by another route and are
      // left alone.
      const st = norm_(statusCol[j][0]);
      if (st !== "" && st !== "ACTIVE" && st !== "CLOSED") continue;

      if (String(emiAmtCol[j][0] || "").trim() !== "0") {
        emiAmtCol[j][0] = "0";
        changedWO = true;
      }
      if (st !== "CLOSED") {
        statusCol[j][0] = "CLOSED";
        changedWO = true;
      }

      // Say WHY the row is dead. Without this a settlement row still reads FINAL, which
      // looks like a last month that recovered nothing rather than one that never needed to.
      // Settlement Stage is system-owned, so CLOSED belongs here and not in HR Decision.
      if (norm_(stageCol[j][0]) !== "CLOSED") {
        stageCol[j][0] = "CLOSED";
        changedStage = true;
      }
    }
  }

  // =========================================================
  // (3c) Close In Months — the admin's plan for the FUTURE months
  //
  // Applied last, so it wins over the automatic rebalance computed above: an explicit
  // instruction beats a calculated default. Every row it touches is stamped ADMIN, so from
  // the next run onward the rebalance in (3) leaves those months alone by itself.
  //
  // For a plan of N months, N-1 of them fall after the plan's own month. The balance is
  // shared across those; anything beyond is emptied and closed. Where the schedule is too
  // short, months are created — which is why this belongs here and not in the payroll
  // workings file, where no row-append machinery exists.
  // =========================================================
  const closeAppendRows = [];

  for (const [ref, plan] of closeInByRef) {
    const residual = residualByRef.has(ref) ? residualByRef.get(ref) : 0;
    if (residual <= 0) continue; // repaid already — the pass above closes the leftovers

    // The plan names a FIXED WINDOW: N months counting from the month it was set in. Deriving
    // it this way is what makes the pass idempotent. The previous version used
    // `slots = plan.n - 1`, a constant, while the months it could find shrank as each one
    // recovered — so every run decided it was a month short and invented one. A 3-month plan
    // set in November produced a March row, then April and May, each further past the
    // employee's last working day. The ledger row carrying the plan never expires, and 3B
    // fires this on a timer, so it compounded unattended.
    const planEnd = addMonths_(plan.monthDate, Math.max(1, plan.n) - 1);
    const lwdMonth = settlementLwdByRef.get(ref) || null;

    const all = refRowList.get(ref) || [];

    const haveMonths = new Set();
    all.forEach(rr => { if (rr.monthDate) haveMonths.add(normMonthKey_(rr.monthDate)); });

    const open = all
      .filter(rr => rr.monthDate && rr.monthDate.getTime() > plan.monthDate.getTime())
      .filter(rr => {
        const j = rr.idx0;
        if (String(recCol[j][0] || "").trim() !== "") return false; // recovered — a locked record
        const st = norm_(statusCol[j][0]);
        return st === "" || st === "ACTIVE" || st === "CLOSED";
      })
      .sort((a, b) => a.monthDate.getTime() - b.monthDate.getTime());

    const inWindow = open.filter(rr => rr.monthDate.getTime() <= planEnd.getTime());
    const beyond   = open.filter(rr => rr.monthDate.getTime() >  planEnd.getTime());

    // Months inside the window that do not exist yet. Bounded by planEnd, so this can never
    // create a month past the plan the admin actually asked for.
    const missing = [];
    let m = addMonths_(plan.monthDate, 1);
    while (m.getTime() <= planEnd.getTime()) {
      if (!haveMonths.has(normMonthKey_(m))) missing.push(new Date(m.getTime()));
      m = addMonths_(m, 1);
    }

    /**
     * The last-working-day month is emptied but NEVER closed while a balance is owed. It is
     * the month that holds the Employee Master exit lock and books any shortfall — close it
     * and a settlement that falls even slightly short has nowhere to recover from and nowhere
     * to write off, so the employee can never be released. The admin's instruction is about
     * when RECOVERY stops; it was never about when the advance ends.
     */
    const statusFor = (rr, amount) => {
      if (amount > 0) return "ACTIVE";
      const isLwd = lwdMonth && rr.monthDate.getTime() === lwdMonth.getTime();
      return isLwd ? "ACTIVE" : "CLOSED";
    };

    const setRow = (j, amount, status) => {
      if (String(emiAmtCol[j][0] || "").trim() !== String(amount)) {
        emiAmtCol[j][0] = String(amount);
        changedWO = true;
      }
      if (norm_(statusCol[j][0]) !== status) {
        statusCol[j][0] = status;
        changedWO = true;
      }
      if (norm_(setByCol[j][0]) !== "ADMIN") {
        setByCol[j][0] = "ADMIN";
        changedSetBy = true;
      }
    };

    // Past the plan's window: recover nothing.
    beyond.forEach(rr => setRow(rr.idx0, 0, statusFor(rr, 0)));

    const slots = inWindow.length + missing.length;
    if (slots <= 0) continue;

    const perMonth = ceilTo100_(residual / slots);
    let left = residual;

    inWindow.forEach(rr => {
      const amount = Math.min(perMonth, left);
      left = Math.max(0, left - amount);
      setRow(rr.idx0, amount, statusFor(rr, amount));
    });

    const info = refInfo.get(ref) || {};
    missing.forEach(md => {
      const amount = Math.min(perMonth, left);
      left = Math.max(0, left - amount);

      closeAppendRows.push({
        month: new Date(md.getTime()),
        emp: info.emp || plan.emp,
        name: info.name || "",
        dept: info.dept || "",
        ref: ref,
        emiAmt: amount,
      });
    });
  }

  // =========================================================
  // (3d) Re-fit a NON-settlement schedule that has drifted from the balance
  //
  // PAY EXTRA and PAY LESS change what was recovered without changing what is still
  // scheduled, so the remaining rows stop adding up to what is owed. Case B only rebalances
  // departures, so a continuing employee kept the original schedule: EMI-24 sat with 30,000
  // still scheduled against a 20,000 balance.
  //
  // The instalment is kept and the NUMBER OF MONTHS changes - the same shape the EMI
  // scheduler built the advance with, and what a lender normally does with a part-payment.
  // Paid extra -> fewer months, surplus rows closed. Paid less -> a month is added.
  //
  // Runs ONLY where there is drift. An untouched advance already adds up, so this is a no-op
  // for everything except an advance an admin has actually varied.
  // =========================================================
  const driftAppendRows = [];

  for (const [ref, rows] of refRowList) {
    if (!residualByRef.has(ref)) continue;

    const residual = residualByRef.get(ref);
    if (residual <= 0) continue;               // (3b) closes these
    if (settlementRefs.has(ref)) continue;     // Case A/B own the schedule
    if (closeInByRef.has(ref)) continue;       // (3c) owns the schedule

    // SKIP has already appended next month for this reference IN THIS RUN, but that row does
    // not exist in the arrays this pass reads — so the schedule looks one instalment short and
    // (3d) appends the very same month again. Two ACTIVE rows for one reference in one month,
    // and 13_SalaryAdvance.gs has no dedupe by EMI ref: readSumByKey_ sums both and DOUBLE the
    // instalment is deducted.
    //
    // It only became reachable once a recovery of 0 was stored as "0" rather than blank. While
    // it was blank the skipped month still counted as open, the totals matched, and (3d) saw
    // no drift — correct behaviour by accident. And the timer would not repair it: 3B fires
    // only when the LEDGER hash changes, while this appends to EMI_SCHEDULE.
    if (skipRefs.has(ref)) continue;

    const open = [];
    let adminFixed = 0;

    for (const rr of rows) {
      const j = rr.idx0;
      if (!rr.monthDate) continue;
      if (String(recCol[j][0] || "").trim() !== "") continue; // recovered - a locked record

      // CLOSED counts as available, not finished. A month this pass zeroed on an earlier run
      // must be reusable, or a later PAY LESS appends new months past it and leaves a hole in
      // the schedule - Dec, Jan, nothing, Mar, Apr. Only CANCELLED and WRITE OFF are terminal.
      // Safe because (3d) runs only while a balance is still owed, and every reference owned
      // by (3b), (3c) or a settlement was excluded above.
      const st = norm_(statusCol[j][0]);
      if (st !== "" && st !== "ACTIVE" && st !== "CLOSED") continue;

      // An ADMIN row was pinned deliberately: honoured, taken off the top, never re-spread.
      if (norm_(setByCol[j][0]) === "ADMIN") {
        adminFixed += numOrZero_(emiAmtCol[j][0]);
        continue;
      }
      open.push(rr);
    }

    if (!open.length) continue;
    open.sort((a, b) => a.monthDate.getTime() - b.monthDate.getTime());

    const scheduled = open.reduce((s, rr) => s + numOrZero_(emiAmtCol[rr.idx0][0]), 0) + adminFixed;
    if (Math.abs(scheduled - residual) < 1) continue; // no drift - nothing to do

    const spread = Math.max(0, residual - adminFixed);

    // The standard instalment, taken as the LARGEST of the open rows: the final row may
    // already hold a remainder from how the advance was originally scheduled.
    let instalment = 0;
    open.forEach(rr => { instalment = Math.max(instalment, numOrZero_(emiAmtCol[rr.idx0][0])); });
    if (instalment <= 0) instalment = numOrZero_((refInfo.get(ref) || {}).emiAmt);
    if (instalment <= 0) continue;

    const needed = Math.ceil(spread / instalment);
    let left = spread;

    open.forEach((rr, idx) => {
      const j = rr.idx0;
      const amount = idx < needed ? Math.min(instalment, left) : 0;
      left = Math.max(0, left - amount);

      if (String(emiAmtCol[j][0] || "").trim() !== String(amount)) {
        emiAmtCol[j][0] = String(amount);
        changedWO = true;
      }
      const want = amount > 0 ? "ACTIVE" : "CLOSED";
      if (norm_(statusCol[j][0]) !== want) {
        statusCol[j][0] = want;
        changedWO = true;
      }
    });

    // Paid less than scheduled -> the schedule is now too short. Add months.
    if (left > 0) {
      const info = refInfo.get(ref) || {};
      let anchor = info.lastRowMonthDate || open[open.length - 1].monthDate;
      if (!anchor) continue;

      while (left > 0) {
        anchor = addMonths_(anchor, 1);
        const amount = Math.min(instalment, left);
        left = Math.max(0, left - amount);

        driftAppendRows.push({
          month: new Date(anchor.getTime()),
          emp: info.emp || "",
          name: info.name || "",
          dept: info.dept || "",
          ref: ref,
          emiAmt: amount,
        });
      }
    }
  }

  if (changedWO) {
    emiAmtRange.setValues(emiAmtCol);
    statusRange.setValues(statusCol);
    woAmtRange.setValues(woAmtCol);
    woTsRange.setValues(woTsCol);
  }

  if (changedSetBy) setByRange.setValues(setByCol);

  if (changedStage) {
    stageRange.setValues(stageCol);
    lwdRange.setValues(lwdCol);
    lwdRange.setNumberFormat("M/d/yyyy");
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

  // =========================================================
  // APPEND SETTLEMENT rows at FIRST EMPTY ROW (by Month column)
  //
  // Written COLUMN BY COLUMN, deliberately - unlike the SKIP append above, which writes a
  // full-width row. "Current Balance" is an ARRAYFORMULA anchored at row 2; writing a blank
  // into its spill range would break the whole column. Column-wise writes never touch it.
  // =========================================================
  if (settlementAppendRows.length) {
    const n = settlementAppendRows.length;
    const startRow = getNextEmptyRowByColumn_(shEmi, E.month + 1);
    ensureRows_(shEmi, startRow + n - 1);

    const col = (idx0, pick) =>
      shEmi.getRange(startRow, idx0 + 1, n, 1).setValues(settlementAppendRows.map(r => [pick(r)]));

    col(E.month, r => r.month);
    col(E.emp, r => r.emp);
    col(E.name, r => r.name);
    col(E.dept, r => r.dept);
    col(E.ref, r => r.ref);
    col(E.emiAmt, r => r.emiAmt);
    col(E.status, () => "ACTIVE");
    col(E.stage, r => r.stage);
    col(E.lwd, r => r.lwd);
    col(E.setBy, () => "AUTO"); // system-created, so the rebalance keeps ownership of it

    shEmi.getRange(startRow, E.month + 1, n, 1).setNumberFormat("MMMM_yyyy");
  }

  // =========================================================
  // APPEND rows created by a Close In Months plan longer than the schedule
  //
  // Stamped ADMIN, unlike the settlement rows above: the admin asked for these months
  // specifically, so the automatic rebalance must not redistribute them.
  // Column by column, for the same ARRAYFORMULA reason as above.
  // =========================================================
  if (closeAppendRows.length) {
    const n = closeAppendRows.length;
    const startRow = getNextEmptyRowByColumn_(shEmi, E.month + 1);
    ensureRows_(shEmi, startRow + n - 1);

    const col = (idx0, pick) =>
      shEmi.getRange(startRow, idx0 + 1, n, 1).setValues(closeAppendRows.map(r => [pick(r)]));

    col(E.month, r => r.month);
    col(E.emp, r => r.emp);
    col(E.name, r => r.name);
    col(E.dept, r => r.dept);
    col(E.ref, r => r.ref);
    col(E.emiAmt, r => r.emiAmt);
    col(E.status, () => "ACTIVE");
    col(E.setBy, () => "ADMIN");

    shEmi.getRange(startRow, E.month + 1, n, 1).setNumberFormat("MMMM_yyyy");
  }

  // =========================================================
  // APPEND rows added by the drift re-fit (a PAY LESS that shortened the schedule)
  //
  // Stamped AUTO, unlike the Close In Months rows above: nobody asked for these months
  // specifically, they exist because the balance no longer fitted, so the rebalance keeps
  // ownership of them.
  // =========================================================
  if (driftAppendRows.length) {
    const n = driftAppendRows.length;
    const startRow = getNextEmptyRowByColumn_(shEmi, E.month + 1);
    ensureRows_(shEmi, startRow + n - 1);

    const col = (idx0, pick) =>
      shEmi.getRange(startRow, idx0 + 1, n, 1).setValues(driftAppendRows.map(r => [pick(r)]));

    col(E.month, r => r.month);
    col(E.emp, r => r.emp);
    col(E.name, r => r.name);
    col(E.dept, r => r.dept);
    col(E.ref, r => r.ref);
    col(E.emiAmt, r => r.emiAmt);
    col(E.status, () => "ACTIVE");
    col(E.setBy, () => "AUTO");

    shEmi.getRange(startRow, E.month + 1, n, 1).setNumberFormat("MMMM_yyyy");
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

/**
 * Numeric coercion that does NOT use `|| ""` - a legitimate 0 must survive.
 * Strips currency symbols/commas so a display-formatted cell doesn't read as NaN.
 */
function numOrZero_(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

/** Blank-safe stringifier - unlike `x || ""`, a numeric 0 becomes "0", not "". */
function strOrBlank_(v) {
  if (v == null || v === "") return "";
  return String(v).trim();
}

/** Coerce to a real Date, or null. Keeps date columns as dates instead of raw JS date text. */
function toRealDate_(v) {
  if (v == null || v === "") return null;
  if (Object.prototype.toString.call(v) === "[object Date]") return isNaN(v.getTime()) ? null : v;
  const d = new Date(String(v).trim());
  return isNaN(d.getTime()) ? null : d;
}

/** Round up to the nearest 100, matching the EMI scheduler's installment convention. */
function ceilTo100_(v) {
  const n = numOrZero_(v);
  if (n <= 0) return 0;
  return Math.ceil(n / 100) * 100;
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
