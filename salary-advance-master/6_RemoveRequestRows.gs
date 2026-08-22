/************************************************
 * 6_RemoveRequestRows.gs
 * Bind this script to SALARY ADVANCE MASTER spreadsheet
 *
 * Lets HR / Finance delete their own un-scheduled advance requests from
 * Advance Ledger. They cannot do it by hand because A2:N is protected with
 * pmo@ as the sole editor (see refreshEmiScheduleProtection_), so the delete
 * has to run as the owner — directly for pmo@, via the Web App for everyone
 * else, exactly like every other privileged write in this module.
 *
 * Menu: Advance → Remove Request Rows (selected)
 *
 * THE ONE RULE: a row carrying an EMI Reference Number is NOT removable.
 * By then EMI_SCHEDULE rows exist against that reference, Shared EMI Summary
 * may hold a snapshot of it, and the Recovered Amount Ledger may already have
 * recovery history pointing at it. Deleting the ledger row orphans all of it
 * and there is no route back. Use Cancel EMI for a scheduled advance.
 *
 * ALL-OR-NOTHING: if any selected row fails validation, NOTHING is deleted.
 * Deletion is irreversible and a Web App run has no undo, so a wrong selection
 * must be corrected by the person, never silently partially honoured.
 *
 * ROW 2 IS SPECIAL — see safeRemoveAdvanceRow_ below. This mirrors
 * attendance/08_RemoveInactiveEmployee.gs's safeRemoveEmployeeRow_, but it may
 * NOT be copied from it verbatim: that sheet's A:H are plain script-written
 * values, whereas Advance Ledger's B, C, D, E, F, I, J, O, R, S, T, U and V are
 * ARRAYFORMULA / MAP formulas anchored in row 2. A blanket block copy would
 * overwrite those anchors with static text — the same loss as deleting the row.
 ************************************************/

const ADV_REMOVE_LOG_SHEET = "Removed Requests";

/**
 * Advance Ledger columns that hold real INPUT (typed by HR, or stamped by this
 * module's own scripts). Everything not listed here is formula-driven and must
 * never be written to. Resolved by header NAME, so inserting a column cannot
 * silently shift this onto the wrong cells.
 */
const ADV_ROW_INPUT_HEADERS = [
  "EMPLOYEE CODE",
  "ADVANCE REASON CATEGORY",
  "REASON DETAILS",
  "ADVANCE AMOUNT",
  "TENURE",
  "ADVANCE PAID MONTH [MM/DD/YY]",
  "EMI START MONTH [MM/DD/YY]",
  "EMI SCHEDULED STATUS",
  "EMI REFERENCE NUMBER",
  ADV_ELIG_OVERRIDE_BY_HEADER,
  ADV_ELIG_OVERRIDE_ON_HEADER,
];

/** Columns captured into the removal log, in order. */
const ADV_REMOVE_LOG_HEADERS = [
  "Removed On", "Removed By", "Employee Code", "Name", "Department",
  "Advance Reason Category", "Reason Details", "Advance Amount", "Tenure",
  "Advance Paid Month", "EMI Start Month", "Source Row",
];

/* ================================================
 * MENU WRAPPER — selection + UI live here only
 * ================================================ */

/**
 * removeRequestRows_FromSelection
 * Menu entry point.
 *
 * The SELECTION IS READ HERE and travels onward as plain row numbers. It has
 * to: getActiveRangeList() is a property of the caller's open spreadsheet
 * session and does not exist inside a Web App request. Same reason
 * cancelEMI_ByReference collects its emiRef client-side.
 *
 * pmo@      → runs removeRequestRows_Core_ directly
 * nazneen@  → routes to Web App
 * hrassist@ → routes to Web App (this action only — see EMI_ACTION_ALLOWED_)
 */
function removeRequestRows_FromSelection() {
  const ui   = SpreadsheetApp.getUi();
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const user = Session.getEffectiveUser().getEmail().toLowerCase();

  if (user !== EMI_PMO_USER_ && user !== EMI_ALLOWED_USER_ && user !== EMI_HR_ASSIST_USER_) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  const sheet = ss.getActiveSheet();
  if (sheet.getName() !== ADV_LEDGER_SHEET) {
    ui.alert(
      "Wrong sheet",
      `Select the request row(s) on the "${ADV_LEDGER_SHEET}" tab, then run this again.`,
      ui.ButtonSet.OK
    );
    return;
  }

  const rowNumbers = removeRequestRows_SelectedRowNumbers_(ss);
  if (rowNumbers.length === 0) {
    ui.alert("Nothing selected", "Select the row(s) you want to remove first.", ui.ButtonSet.OK);
    return;
  }

  // Read-only validation so the person sees the refusal BEFORE confirming
  // anything. Core validates again from the sheet regardless — this pre-check
  // exists for the message, never as the gate.
  let preview;
  try {
    preview = removeRequestRows_Validate_(ss, rowNumbers);
  } catch (err) {
    ui.alert("Error: " + err.message);
    return;
  }

  if (preview.blockers.length > 0) {
    advElig_ShowResultDialog_(ui,
      "Nothing removed.\n\n" +
      `${preview.blockers.length} selected row(s) cannot be removed:\n\n` +
      preview.blockers.map(b => `Row ${b.row}\n   ${b.reason}`).join("\n\n") +
      "\n\nNothing was deleted. Correct the selection and run again."
    );
    return;
  }

  const list = preview.targets
    .map(t => `  • Row ${t.row}: ${t.empCode} – ${t.name}` +
              (t.advAmt ? ` (${advElig_Money_(t.advAmt)})` : ""))
    .join("\n");

  const resp = ui.alert(
    "Remove request row(s)?",
    `The following ${preview.targets.length} request(s) will be permanently ` +
    `removed from the Advance Ledger:\n\n${list}\n\n` +
    `This cannot be undone. A record is kept in "${ADV_REMOVE_LOG_SHEET}".\n\nProceed?`,
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  const requestedBy = Session.getEffectiveUser().getEmail();

  if (user === EMI_PMO_USER_) {
    try {
      const result = removeRequestRows_Core_(ss, rowNumbers, requestedBy);
      advElig_ShowResultDialog_(ui, result.message);
    } catch (err) {
      ui.alert("Error: " + err.message);
    }
    return;
  }

  try {
    const result = callEmiWebApp_("removeRequestRows", ss, { rowNumbers });
    advElig_ShowResultDialog_(ui, result.success
      ? (result.message || "Request row(s) removed ✅")
      : ("Error\n" + (result.message || "Unknown error from Web App."))
    );
  } catch (err) {
    ui.alert("Web App call failed: " + err.message);
  }
}

/**
 * Every row number covered by the current selection, de-duplicated and sorted.
 * getActiveRangeList() rather than getActiveRange() so a ctrl-click selection
 * of several separate rows is honoured, not just the last block.
 */
function removeRequestRows_SelectedRowNumbers_(ss) {
  const rows = new Set();
  const list = ss.getActiveRangeList();
  if (!list) return [];

  list.getRanges().forEach(rng => {
    const start = rng.getRow();
    for (let r = start; r < start + rng.getNumRows(); r++) rows.add(r);
  });

  return Array.from(rows).sort((a, b) => a - b);
}

/* ================================================
 * VALIDATION — shared by the pre-check and Core
 * ================================================ */

/**
 * removeRequestRows_Validate_(ss, rowNumbers)
 *
 * Resolves each selected row to its identity AND checks it may be removed.
 *
 * Identity is captured here, before any deletion, because removing row 2 shifts
 * row 3 up into it — so row numbers stop meaning what they meant the moment the
 * first delete lands. Core deletes using the resolved targets, never by
 * replaying the caller's numbers against a sheet that has moved underneath.
 *
 * Returns { targets: [...], blockers: [{row, reason}] }.
 */
function removeRequestRows_Validate_(ss, rowNumbers) {
  const ledger = ss.getSheetByName(ADV_LEDGER_SHEET);
  if (!ledger) throw new Error(`Sheet not found: ${ADV_LEDGER_SHEET}`);

  const ledMap = getHeaderMap_(ledger);
  const C = {
    emp:     req_(ledMap, "EMPLOYEE CODE"),
    name:    req_(ledMap, "NAME"),
    dept:    req_(ledMap, "DEPARTMENT"),
    ref:     req_(ledMap, "EMI REFERENCE NUMBER"),
    advAmt:  req_(ledMap, "ADVANCE AMOUNT"),
    tenure:  req_(ledMap, "TENURE"),
    advPaid: req_(ledMap, "ADVANCE PAID MONTH [MM/DD/YY]"),
    start:   req_(ledMap, "EMI START MONTH [MM/DD/YY]"),
    reason:  opt_(ledMap, "ADVANCE REASON CATEGORY"),
    detail:  opt_(ledMap, "REASON DETAILS"),
  };

  const lastRow = ledger.getLastRow();
  const vals = lastRow >= 2
    ? ledger.getRange(2, 1, lastRow - 1, ledger.getLastColumn()).getValues()
    : [];
  const disp = lastRow >= 2
    ? ledger.getRange(2, 1, lastRow - 1, ledger.getLastColumn()).getDisplayValues()
    : [];

  const targets  = [];
  const blockers = [];

  (rowNumbers || []).forEach(rowRaw => {
    const row = Math.floor(Number(rowRaw));

    if (!isFinite(row) || row < 2) {
      blockers.push({ row: rowRaw, reason: "Row 1 is the header and cannot be removed." });
      return;
    }
    if (row > lastRow) {
      blockers.push({ row, reason: "Empty row — nothing to remove." });
      return;
    }

    const i = row - 2;
    const empCode = str_(vals[i][C.emp]);
    if (!empCode) {
      blockers.push({ row, reason: "No Employee Code — this row holds no request." });
      return;
    }

    const ref = str_(vals[i][C.ref]);
    if (ref) {
      blockers.push({
        row,
        reason: `${empCode} is already scheduled as ${ref}. A scheduled advance ` +
                `cannot be removed here — use Cancel EMI instead.`,
      });
      return;
    }

    targets.push({
      row,
      empCode,
      name:    str_(disp[i][C.name]) || empCode,
      dept:    str_(disp[i][C.dept]),
      advAmt:  num_(vals[i][C.advAmt]),
      tenure:  vals[i][C.tenure],
      advPaid: disp[i][C.advPaid],
      start:   disp[i][C.start],
      reason:  C.reason === -1 ? "" : str_(disp[i][C.reason]),
      detail:  C.detail === -1 ? "" : str_(disp[i][C.detail]),
    });
  });

  return { targets, blockers };
}

/* ================================================
 * CORE — UI-free
 * ================================================ */

/**
 * removeRequestRows_Core_(ss, rowNumbers, requestedBy)
 *
 * Re-validates from the sheet and, only if EVERY row passes, removes them.
 *
 * Re-validation is not paranoia about the caller: minutes can pass between the
 * confirmation dialog and this running, and in that window somebody else may
 * have scheduled one of the selected requests. The reference check has to be
 * made against the sheet as it is now, not as it was when the dialog opened.
 *
 * Deletion runs BOTTOM-UP so earlier deletions cannot shift later targets, with
 * row 2 handled last and specially (see safeRemoveAdvanceRow_).
 *
 * Returns { success, message, removed }
 */
function removeRequestRows_Core_(ss, rowNumbers, requestedBy) {
  const ledger = ss.getSheetByName(ADV_LEDGER_SHEET);
  if (!ledger) throw new Error(`Sheet not found: ${ADV_LEDGER_SHEET}`);

  const { targets, blockers } = removeRequestRows_Validate_(ss, rowNumbers);

  if (blockers.length > 0) {
    return {
      success: false,
      message: "Nothing removed.\n\n" +
        `${blockers.length} selected row(s) cannot be removed:\n\n` +
        blockers.map(b => `Row ${b.row}\n   ${b.reason}`).join("\n\n") +
        "\n\nNothing was deleted. Correct the selection and run again.",
      removed: 0,
    };
  }

  if (targets.length === 0) {
    return { success: false, message: "Nothing removed.\n\nNo request rows were selected.", removed: 0 };
  }

  const removedBy = str_(requestedBy) || Session.getEffectiveUser().getEmail();
  const stampNow  = stamp_();
  const done      = [];

  // The log is written in a finally block from whatever actually got deleted,
  // so a failure part-way through still leaves an accurate record rather than
  // either an over-count (logging up front) or none at all (logging after).
  try {
    targets
      .slice()
      .sort((a, b) => b.row - a.row) // bottom-up; row 2 therefore comes last
      .forEach(t => {
        safeRemoveAdvanceRow_(ledger, t.row);
        done.push(t);
      });
  } finally {
    if (done.length) {
      try {
        removeRequestRows_AppendLog_(ss, done, removedBy, stampNow);
      } catch (logErr) {
        // A failed log must not mask the deletion result, and must not look
        // like the deletion failed — it did not.
        console.error("Removed Requests log write failed: " + logErr.message);
      }
    }
  }

  const list = done
    .sort((a, b) => a.row - b.row)
    .map(t => `${t.empCode} – ${t.name}` + (t.advAmt ? `   ${advElig_Money_(t.advAmt)}` : ""))
    .join("\n");

  return {
    success: true,
    message: `${done.length} request row(s) removed.\n\n${list}\n\n` +
             `Recorded in "${ADV_REMOVE_LOG_SHEET}" against ${removedBy}.`,
    removed: done.length,
  };
}

/* ================================================
 * Row-2-safe removal
 * ================================================ */

/**
 * safeRemoveAdvanceRow_(ledger, targetRow)
 *
 * Removes one Advance Ledger row without destroying the array formulas
 * anchored in row 2. Mirrors safeRemoveEmployeeRow_ in
 * attendance/08_RemoveInactiveEmployee.gs:
 *
 *   targetRow > 2                  → deleteRow(), no formula risk
 *   targetRow = 2, rows below      → copy row 3's INPUTS up into row 2,
 *                                    then deleteRow(3)
 *   targetRow = 2, only data row   → clear row 2's INPUTS, keep the row
 *
 * ⚠️ THE DIFFERENCE FROM THE ATTENDANCE VERSION, and the reason this could not
 * simply be reused: that sheet copies a contiguous A:H block with PASTE_VALUES,
 * which is safe there because A:H are plain values. Advance Ledger's B, C, D,
 * E, F, I, J, O, R, S, T, U and V are ARRAYFORMULA / MAP formulas living in
 * row 2. Writing row 3's spilled *values* into them would replace the formula
 * with static text for the whole column — every Name, Eligible Amount, Balance
 * Amount and EMI Status on the sheet, silently. So this copies ONLY the input
 * columns, one at a time, resolved by header name.
 */
function safeRemoveAdvanceRow_(ledger, targetRow) {
  if (targetRow > 2) {
    ledger.deleteRow(targetRow);
    return;
  }

  const ledMap = getHeaderMap_(ledger);
  const inputCols1 = ADV_ROW_INPUT_HEADERS
    .map(h => opt_(ledMap, h))
    .filter(idx0 => idx0 !== -1)
    .map(idx0 => idx0 + 1);

  const lastRow = ledger.getLastRow();

  if (lastRow < 3) {
    // Row 2 is the only data row. Deleting it would take the formula anchors
    // with it, so clear the inputs and leave the row standing. Every gate in
    // this module already skips a row with no Employee Code, so an empty row 2
    // is inert and the next request simply reuses it.
    inputCols1.forEach(c => ledger.getRange(2, c).clearContent());
    return;
  }

  // Shift row 3's inputs up into row 2, column by column — never a block copy.
  inputCols1.forEach(c => {
    ledger.getRange(3, c).copyTo(
      ledger.getRange(2, c),
      SpreadsheetApp.CopyPasteType.PASTE_VALUES,
      false
    );
  });

  ledger.deleteRow(3);
}

/* ================================================
 * Removal log
 * ================================================ */

/**
 * removeRequestRows_AppendLog_(ss, rows, removedBy, stampNow)
 * Appends one row per removal, creating the tab on first use.
 * Plain values only — no formulas, so nothing here needs row-2 protection.
 */
function removeRequestRows_AppendLog_(ss, rows, removedBy, stampNow) {
  let sh = ss.getSheetByName(ADV_REMOVE_LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(ADV_REMOVE_LOG_SHEET);
    sh.getRange(1, 1, 1, ADV_REMOVE_LOG_HEADERS.length).setValues([ADV_REMOVE_LOG_HEADERS]);
    sh.setFrozenRows(1);
  }

  const out = rows.map(t => [
    stampNow, removedBy, t.empCode, t.name, t.dept,
    t.reason, t.detail, t.advAmt, t.tenure,
    t.advPaid, t.start, t.row,
  ]);

  const startRow = Math.max(2, findLastDataRowByColumn_(sh, 1) + 1);
  ensureTargetHasRows_(sh, startRow + out.length - 1);
  sh.getRange(startRow, 1, out.length, ADV_REMOVE_LOG_HEADERS.length).setValues(out);
}
