/************************************************
 * 4_SalaryMasterSync.gs
 * Bind this script to SALARY ADVANCE MASTER spreadsheet
 *
 * Mirrors the CURRENTLY ACTIVE salary of every employee out of
 * Salary Revision History's REVISION_HISTORY tab into a local
 * "SALARY master" tab, so the advance-eligibility gate in
 * 1_Advance_EMIScheduler.gs — and the Eligible Amount / Eligibility
 * Status formulas on Advance Ledger — have a local, formula-readable
 * source of salary. IMPORTRANGE is deliberately not used: a financial
 * gate must not depend on a volatile cross-file link.
 *
 * ✅ Web App pattern (same as 2_EmpMasterSync.gs):
 *    - syncSalaryMaster_FromRevisionHistory() → user gate wrapper
 *      pmo@     runs syncSalaryMaster_Core_(ss) directly
 *      nazneen@ calls Web App → syncSalaryMasterServer_() in 0_WebApp.gs
 *    - syncSalaryMaster_Core_(ss) is UI-free.
 *
 * WHY THIS IS A REBUILD, NOT AN UPSERT (unlike 2_EmpMasterSync.gs):
 *   REVISION_HISTORY keeps every revision an employee has ever had and
 *   marks exactly one of them ACTIVE_FOR_PAYROLL = ACTIVE. An upsert
 *   that never deletes would leave a stale salary behind for anyone
 *   whose active row disappears (code inactivated, revision withdrawn),
 *   and a stale salary here silently RAISES someone's advance ceiling.
 *   The body is therefore cleared and rewritten every run.
 *
 * WHAT IS NEVER TOUCHED:
 *   Only columns A:N are cleared and written. Column O (NET SALARY) is
 *   an ARRAYFORMULA anchored at O2 — writing or clearing anything in its
 *   spill range would break the column, the same trap documented in
 *   3A_Master_SharedEMILockSync.gs's append logic.
 *
 * Sheets expected (exact names):
 * - SALARY master   (local, this spreadsheet)
 * - REVISION_HISTORY (remote, Salary Revision History)
 *
 * Menu: Master → Refresh Salary Master (SALARY master)
 ************************************************/

// ---- SOURCE (Salary Revision History) ----
const SALARY_REV_SRC_SPREADSHEET_ID =
  "1XsyWVct4LOVMvZMDq4EThD6mgoAoumN-_RNQiwy67KM";

const SALARY_REV_SRC_SHEET_NAME = "REVISION_HISTORY";

// ---- TARGET (this spreadsheet) ----
const SALARY_MASTER_SHEET_NAME  = "SALARY master";

/**
 * Columns copied verbatim from REVISION_HISTORY into SALARY master.
 * Both tabs carry these headers in this order (A:N), but every lookup
 * below is still by header NAME on both sides — per this codebase's
 * header-name-based rule, a reorder on either side must stay harmless.
 */
const SALARY_MASTER_COPY_HEADERS = [
  "ID.NO", "NAME", "CATEGORY", "DEPARTMENT", "DESIGNATION",
  "BASIC", "DA", "TOTAL", "HRA", "CONV.ALL", "SPL.ALL",
  "GROSS", "CHANGE OF VALUE", "EFFECTIVE_FROM",
];

/* ================================================
 * MENU WRAPPER — user gate lives here.
 * UI calls (alert) live here only.
 * ================================================ */

/**
 * syncSalaryMaster_FromRevisionHistory
 * Menu / Button entry point.
 *
 * pmo@butlerleather.com     → runs syncSalaryMaster_Core_(ss) directly
 * nazneen@butlerleather.com → routes to Web App
 * anyone else               → access denied
 */
function syncSalaryMaster_FromRevisionHistory() {
  const ui   = SpreadsheetApp.getUi();
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const user = Session.getEffectiveUser().getEmail().toLowerCase();

  if (user !== EMI_PMO_USER_ && user !== EMI_ALLOWED_USER_) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  const resp = ui.alert(
    "Refresh Salary Master",
    'This rebuilds "SALARY master" from Salary Revision History.\n' +
    "• Only rows with ACTIVE_FOR_PAYROLL = ACTIVE are copied\n" +
    "• Columns A:N are replaced; NET SALARY (column O) is untouched\n\nProceed?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  if (user === EMI_PMO_USER_) {
    try {
      const result = syncSalaryMaster_Core_(ss);
      ui.alert(result.message);
    } catch (err) {
      ui.alert("Error: " + err.message);
    }
    return;
  }

  // nazneen@: route via Web App
  try {
    const result = callEmiWebApp_("syncSalaryMaster", ss);
    ui.alert(result.success
      ? (result.message || "Salary Master refreshed ✅")
      : ("Error: " + (result.message || "Unknown error from Web App."))
    );
  } catch (err) {
    ui.alert("Web App call failed: " + err.message);
  }
}

/* ================================================
 * CORE FUNCTION — UI-free
 * ================================================ */

/**
 * syncSalaryMaster_Core_(ss)
 *
 * Rebuilds SALARY master!A:N from REVISION_HISTORY rows where
 * ACTIVE_FOR_PAYROLL = "ACTIVE". Never touches column O.
 *
 * Duplicate ACTIVE rows for one ID.NO are a data error in Revision
 * History (its own approval flow flips the previous row to IN-ACTIVE).
 * They are NOT silently resolved here: the first occurrence wins — which
 * is what VLOOKUP would pick anyway — and every duplicated ID.NO is
 * named in the returned message so somebody fixes the source.
 *
 * Returns { success, message, written, duplicates }
 */
function syncSalaryMaster_Core_(ss) {
  // ✅ Serialised: this function CLEARS SALARY master!A2:N before rewriting it,
  // so anything reading the tab mid-run would see an empty salary table. The
  // lock is taken here rather than in each caller, so the menu, the Web App and
  // the hash watcher are all covered by the one guard. See withEmiLock_.
  return withEmiLock_("Refresh Salary Master", () => syncSalaryMaster_CoreLocked_(ss));
}

function syncSalaryMaster_CoreLocked_(ss) {
  const target = ss.getSheetByName(SALARY_MASTER_SHEET_NAME);
  if (!target) throw new Error(`Sheet not found: ${SALARY_MASTER_SHEET_NAME}`);

  // ---- Read source ----
  const srcSS = SpreadsheetApp.openById(SALARY_REV_SRC_SPREADSHEET_ID);
  const srcSh = srcSS.getSheetByName(SALARY_REV_SRC_SHEET_NAME);
  if (!srcSh) throw new Error(`Source sheet not found: ${SALARY_REV_SRC_SHEET_NAME}`);

  const srcMap = getHeaderMap_(srcSh);
  const activeIdx0 = req_(srcMap, "ACTIVE_FOR_PAYROLL");
  const srcIdIdx0  = req_(srcMap, "ID.NO");

  // Source index for each header we copy — by NAME, not by position.
  const srcIdxByHeader = SALARY_MASTER_COPY_HEADERS.map(h => req_(srcMap, h));

  // REVISION_HISTORY!AADHAAR NO is a whole-column MAP() spill that stamps ""
  // into every row to the end of the reference, which inflates getLastRow().
  // Count rows off ID.NO instead — same precaution revisionApprovalCore_ takes.
  const srcLast = findLastDataRowByColumn_(srcSh, srcIdIdx0 + 1);
  if (srcLast < 2) {
    return { success: false, message: "REVISION_HISTORY has no data rows.", written: 0, duplicates: [] };
  }

  const srcVals = srcSh.getRange(2, 1, srcLast - 1, srcSh.getLastColumn()).getValues();

  // ---- Build one row per ACTIVE employee ----
  const seen       = new Set();
  const duplicates = [];
  const outRows    = [];

  for (let i = 0; i < srcVals.length; i++) {
    const row = srcVals[i];

    const empCode = str_(row[srcIdIdx0]);
    if (!empCode) continue;

    if (str_(row[activeIdx0]).toUpperCase() !== "ACTIVE") continue;

    const key = empCode.toUpperCase();
    if (seen.has(key)) {
      if (duplicates.indexOf(empCode) === -1) duplicates.push(empCode);
      continue; // first ACTIVE row wins — matches what VLOOKUP would return
    }
    seen.add(key);

    outRows.push(srcIdxByHeader.map(idx0 => row[idx0]));
  }

  // ---- Target header order is read from the target itself ----
  // Written values are ordered to match SALARY master's own headers, so a
  // reordered target tab still receives the right value in the right column.
  const tgtMap   = getHeaderMap_(target);
  const tgtOrder = SALARY_MASTER_COPY_HEADERS.map(h => req_(tgtMap, h));
  const nCols    = SALARY_MASTER_COPY_HEADERS.length;

  // Guard the ARRAYFORMULA column: everything we write must sit left of it.
  const netIdx0 = req_(tgtMap, "NET SALARY");
  const maxTgtIdx0 = Math.max.apply(null, tgtOrder);
  if (maxTgtIdx0 >= netIdx0) {
    throw new Error(
      `"NET SALARY" must be to the RIGHT of every copied column in ${SALARY_MASTER_SHEET_NAME} — ` +
      `it is an ARRAYFORMULA and this sync would overwrite its spill range.`
    );
  }
  if (maxTgtIdx0 !== nCols - 1) {
    throw new Error(
      `${SALARY_MASTER_SHEET_NAME} headers are not contiguous from column A — ` +
      `expected the ${nCols} copied columns to occupy A:${columnLetter_(nCols)}.`
    );
  }

  const ordered = outRows.map(vals => {
    const out = new Array(nCols).fill("");
    tgtOrder.forEach((tIdx0, k) => { out[tIdx0] = vals[k]; });
    return out;
  });

  // ---- Rebuild the body: clear A2:N only, then write ----
  const maxRows = target.getMaxRows();
  if (maxRows >= 2) {
    target.getRange(2, 1, maxRows - 1, nCols).clearContent();
  }

  if (ordered.length) {
    ensureTargetHasRows_(target, ordered.length + 1);
    target.getRange(2, 1, ordered.length, nCols).setValues(ordered);
  }

  let message = `Salary Master rebuilt ✅\nActive salaries written: ${ordered.length}`;
  if (duplicates.length) {
    message +=
      `\n\n⚠️ ${duplicates.length} employee(s) have MORE THAN ONE row marked ` +
      `ACTIVE_FOR_PAYROLL = ACTIVE in REVISION_HISTORY. The first was used; ` +
      `fix the source:\n  ${duplicates.join(", ")}`;
  }

  return { success: true, message, written: ordered.length, duplicates };
}

/* ================================================
 * Helpers
 * ================================================ */

/** 1-based column index → column letter (1 → "A", 27 → "AA"). Error text only. */
function columnLetter_(n) {
  let s = "";
  let i = n;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}
