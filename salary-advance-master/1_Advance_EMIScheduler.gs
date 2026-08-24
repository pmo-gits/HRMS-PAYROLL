/************************************************
 * 1_Advance_EMIScheduler.gs  (UPDATED - Web App)
 * Bind this script to SALARY ADVANCE MASTER spreadsheet
 *
 * ✅ Web App pattern implemented:
 *    - scheduleEMI_FromAdvanceLedger() → user gate wrapper
 *      pmo@ runs scheduleEMI_Core_(ss) directly
 *      nazneen@ calls Web App → scheduleEMIServer_() in 0_WebApp.gs
 *
 *    - cancelEMI_ByReference() → user gate wrapper
 *      ui.prompt() stays HERE (client side) for BOTH paths
 *      pmo@ runs cancelEMI_Core_(ss, emiRef) directly
 *      nazneen@ passes emiRef in payload to Web App → cancelEMIServer_()
 *
 * ✅ Core functions extracted (UI-free):
 *    - scheduleEMI_Core_(ss)         → called by wrapper + server handler
 *    - cancelEMI_Core_(ss, emiRef)   → called by wrapper + server handler
 *
 * ✅ All original logic UNCHANGED:
 *    - ARRAYFORMULA-safe getDisplayValues() for Name/Department
 *    - Current Balance formula seeding on first run
 *    - Selective column writing (never touches Current Balance)
 *    - STATUS = "ACTIVE" on schedule
 *    - STATUS = "CANCELLED" / "CANCELLED & GOT PAID" on cancel
 *    - Advance Paid Month validation
 *    - Advance Ledger Status = ACTIVE validation
 *    - Shared EMI Summary delete only if Payroll Status blank
 *
 * ✅ NEW (v2):
 *    - Missing field validation: alerts user instead of silent skip
 *    - All-or-nothing batch: any invalid row stops entire run
 *    - Single growing protection on EMI_SCHEDULE A2:L{lastRow}
 *      recreated fresh on every successful schedule run (never stacks)
 *
 * ✅ NEW (v3):
 *    - Duplicate active EMI guardrail in scheduleEMI_Core_():
 *      Pre-scan builds a Set of employee codes that already have
 *      EMI Status = "ACTIVE" in the ledger (formula column, read via
 *      getDisplayValues). Any new eligible row (no ref yet) whose
 *      employee code appears in that Set is collected as a blocker.
 *      If one or more blockers found → entire run is aborted with a
 *      clear, named alert before Phase 1 field-validation begins.
 *      All-or-nothing: fix the blocker(s), then re-run for all.
 *
 * ✅ NEW (v4) — TEST ENVIRONMENT ONLY, not yet applied to production:
 *    - The v3 guardrail no longer hard-aborts the run. Instead:
 *        1. scheduleEMI_FromAdvanceLedger() calls the new read-only
 *           scheduleEMI_FindActiveEmiConflicts_(ss) BEFORE routing to
 *           Core/Web App. This runs client-side for BOTH pmo@ and
 *           nazneen@ (it's just a read, no privileged write needed),
 *           because this wrapper function always has a real `ui` —
 *           it's invoked directly from the open spreadsheet's menu,
 *           regardless of which user clicked it.
 *        2. If conflicts are found, ONE combined ui.alert (Yes/No)
 *           lists every conflicting employee together with the EMI
 *           Reference Number of their existing active EMI, and asks
 *           whether to schedule new EMIs for them anyway.
 *        3. Yes → all conflicting employees are passed through as an
 *           `allowExceptions` list. No → the list stays empty.
 *        4. scheduleEMI_Core_(ss, allowExceptions) then SKIPS only the
 *           employees who are still conflicting and NOT in the allow
 *           list — every other eligible employee in the same run is
 *           still scheduled normally. This replaces the old all-abort
 *           behaviour with a per-employee skip.
 *        5. scheduleEMI_BuildActiveEmiConflicts_() is the shared,
 *           pure helper used by both the pre-check and Core, so the
 *           definition of "conflict" can never drift between them.
 *    - Core stays UI-free per the original design — the Yes/No dialog
 *      lives only in the menu wrapper, never in Core or in 0_WebApp.gs.
 *
 * ✅ NEW (v5) — cancelEMI_Core_ gained blocking prechecks and stopped overwriting history:
 *    - BLOCKING: cancel now refuses outright, before writing anything, if EMI_SCHEDULE holds
 *      any row for the reference with HR Decision = RESIGNED/ABSCOND (employee marked as
 *      leaving), HR Decision = PAY EXTRA/PAY LESS/SKIP (a recovery decision already approved
 *      and committed at least once), or Amount Set By = ADMIN (a Close In Months plan active).
 *      Permanent, not "only if unresolved" — once any of these has happened on a reference,
 *      cancel refuses forever.
 *    - PRESERVED HISTORY: when cancel does proceed, only EMI_SCHEDULE rows that are still
 *      untouched (Recover Amount blank AND Write Off Amount blank) are stamped CANCELLED. A
 *      row that already recovered money, or already had a write-off booked, is a locked
 *      record and keeps its existing Status — cancel no longer rewrites the past.
 *    - 3A_Master_SharedEMILockSync.gs was given the matching other half: its decision loop now
 *      skips any reference already marked CANCELLED, so a stale ledger entry can never flip a
 *      cancelled reference's rows back to WRITE OFF/CLOSED on a later scheduled run.
 *
 * ✅ NEW (v6) — advance-eligibility gate before anything is scheduled.
 *    Logic lives in 5_AdvanceEligibility.gs; this file only calls it and
 *    reports the result. Two rules, deliberately with different politics:
 *
 *      AMOUNT — Advance Amount + the employee's existing ACTIVE advance
 *               balances must not exceed his NET SALARY (from the new
 *               "SALARY master" tab, see 4_SalaryMasterSync.gs).
 *               NOT OVERRIDABLE — there is no parameter, payload field or
 *               dialog answer anywhere in this module that can schedule
 *               one of these. The row is skipped and named; every other
 *               eligible row in the same run still schedules.
 *
 *      TENURE — D.O.J + 1 year must have been reached as of TODAY
 *               (D.O.J from the local "EMP master" mirror; the test is
 *               "today", matching the ledger's Eligibility Status formula
 *               so HR's screen and this gate can never disagree).
 *               OVERRIDABLE via one combined Yes/No dialog, same shape as
 *               the v4 duplicate-EMI prompt. An approved override is
 *               STAMPED onto the ledger row — "Eligibility Override By" /
 *               "Eligibility Override On" — so an exception to a financial
 *               limit is never anonymous.
 *
 *    The gate RECOMPUTES everything from source. Advance Ledger's
 *    "Eligible Amount" / "Eligibility Status" formula columns exist so HR
 *    sees the ceiling while typing; they are guidance and are never read
 *    by this code. A formula cell can be stale, pasted over, or sitting on
 *    an error, and none of that may decide whether money is released.
 *
 * ✅ ALSO FIXED (v6) — two hardcoded Advance Ledger ranges that do not
 *    auto-adjust when columns are inserted: the Current Balance seed
 *    formula (was N:P, already stale before this change) and the
 *    protection width in refreshEmiScheduleProtection_ (was 12 columns).
 *
 * ✅ Constants EMI_PMO_USER_, EMI_ALLOWED_USER_, EMI_WEBAPP_URL
 *    declared in 0_WebApp.gs — referenced here directly.
 *
 * Sheets expected (exact names):
 * - Advance Ledger
 * - EMI_SCHEDULE
 * - Shared EMI Summary
 *
 * Menu:
 * Advance → Schedule EMI
 * Advance → Cancel EMI (by EMI Reference)
 ************************************************/

// ✅ Sheet names (edit if your tab names differ)
const ADV_LEDGER_SHEET         = "Advance Ledger";
const EMI_SCHEDULE_SHEET       = "EMI_SCHEDULE";
const SHARED_EMI_SUMMARY_SHEET = "Shared EMI Summary";

// ✅ Protection description — used to find & replace the single protection
const EMI_SCHEDULE_PROTECTION_DESC = "EMI_SCHEDULE_PROTECTION";

/**
 * ✅ Seed formula for "Current Balance" on first schedule run (only if EMI_SCHEDULE has no data rows).
 * Uses header-based placement and writes only to the Current Balance cell at row 2.
 *
 * IMPORTANT:
 * This formula references:
 * - E column = EMI Reference Number
 * - H column = Status
 * - Advance Ledger Q:S VLOOKUP — Q = EMI Reference Number, S = Balance Amount
 *
 * ⚠️ These are HARDCODED A1 ranges and do NOT auto-adjust when columns are
 * inserted on Advance Ledger (Sheets only rewrites formulas that are already
 * live in a cell — this one is a string in code until it is written).
 *
 * FIXED (v6): this constant read 'Advance Ledger'!N:P, which was already stale
 * against the live sheet's O:Q before the eligibility columns were inserted at
 * I, and is Q:S after. It only fires when EMI_SCHEDULE has zero data rows, so
 * it had never actually run — but had it, every Current Balance would have
 * looked up the wrong three columns and the whole settlement cycle reads that
 * value. Re-check this line any time Advance Ledger gains or loses a column.
 *
 * If your columns differ in the future, we can convert this to header-based formula.
 */
const EMI_SCHEDULE_CURRENT_BALANCE_FORMULA =
  '=ARRAYFORMULA(IF(E2:E="","",IF(H2:H="CANCELLED","",IFNA(VLOOKUP(E2:E,\'Advance Ledger\'!Q:S,3,FALSE),""))))';

/* ================================================
 * onOpen — builds menus
 * ================================================ */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Advance")
    .addItem("Schedule EMI (create schedule for new advances)", "scheduleEMI_FromAdvanceLedger")
    .addSeparator()
    .addItem("Cancel EMI (by EMI Reference)", "cancelEMI_ByReference")
    .addSeparator()
    // ✅ NEW (v6) — handler lives in 6_RemoveRequestRows.gs; all files in this
    // project share one global scope, so no import is needed.
    .addItem("Remove Request Rows (selected)", "removeRequestRows_FromSelection")
    .addToUi();

  // ✅ Builds the Master menu (defined in 2_EmpMasterSync.gs)
  addEmpMasterSyncMenu_();
}

/* ================================================
 * MENU WRAPPERS
 * User gate lives here.
 * UI calls (alert, prompt) live here only.
 * Core logic is UI-free and lives in _Core_ functions below.
 * ================================================ */

/**
 * scheduleEMI_FromAdvanceLedger
 * Menu entry point for Schedule EMI.
 *
 * pmo@butlerleather.com   → runs scheduleEMI_Core_(ss) directly
 * nazneen@butlerleather.com → routes to Web App
 * anyone else              → access denied
 *
 * ✅ NEW (v4): before routing, checks for employees who already have
 * an active EMI. If any are found, asks ONE combined Yes/No question
 * naming them all (with their existing active EMI Reference Number).
 * This check + dialog run here because this function always has a
 * real `ui` — it's invoked directly from the open spreadsheet's menu
 * for BOTH users, unlike the Web App path further down which has none.
 */
function scheduleEMI_FromAdvanceLedger() {
  const ui   = SpreadsheetApp.getUi();
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const user = Session.getEffectiveUser().getEmail().toLowerCase();

  if (user !== EMI_PMO_USER_ && user !== EMI_ALLOWED_USER_) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  // ✅ NEW (v4) — read-only pre-check, safe for both users (no write yet)
  let allowExceptions = [];
  try {
    const conflicts = scheduleEMI_FindActiveEmiConflicts_(ss);
    if (conflicts.length > 0) {
      const list = conflicts
        .map(c => `  • ${c.empCode} – ${c.name} (Active EMI Ref: ${c.activeEmiRef})`)
        .join("\n");
      const resp = ui.alert(
        "Employee(s) already have an active EMI",
        `The following employee(s) already have an active EMI:\n\n${list}\n\n` +
        `Schedule a new EMI for them anyway?`,
        ui.ButtonSet.YES_NO
      );
      if (resp === ui.Button.YES) {
        allowExceptions = conflicts.map(c => c.empCode);
      }
      // No → allowExceptions stays empty; those employees are skipped, not the whole run.
    }
  } catch (err) {
    ui.alert("Error checking active EMI conflicts: " + err.message);
    return;
  }

  // ✅ NEW (v6) — eligibility pre-check. Also read-only, also safe for both
  // users. Two rules with deliberately different politics:
  //   AMOUNT  → shown for acknowledgement only. There is no Yes/No here and
  //             no payload field that could carry an override, so no dialog
  //             answer and no crafted request can get one of these scheduled.
  //   TENURE  → a real Yes/No, because "he has not finished a year" is a
  //             policy call somebody is entitled to make, unlike "this is
  //             more money than he can repay".
  let allowTenureExceptions = [];
  try {
    const elig = advElig_FindIssues_(ss);

    // NOTE: amount / missing-record failures raise NO dialog here on purpose.
    // They are not overridable, so there is nothing to ask before the run, and
    // scheduleEMI_Core_ already names every one of them — with the arithmetic —
    // in the result message. Alerting here as well showed the identical list in
    // two consecutive dialogs, which reads as the run having happened twice.
    // The tenure prompt below stays, because that one is a real decision and
    // must be answered BEFORE anything is written.

    if (elig.tenureIssues.length > 0) {
      const resp = ui.alert(
        "Employee(s) have not completed 1 year",
        `The following employee(s) have not completed 1 year of service:\n\n` +
        `${advElig_FormatTenureBlockers_(elig.tenureIssues)}\n\n` +
        `Approve a salary advance for them anyway?\n` +
        `(Approving is recorded on the ledger row against your name.)`,
        ui.ButtonSet.YES_NO
      );
      if (resp === ui.Button.YES) {
        allowTenureExceptions = elig.tenureIssues.map(x => x.empCode);
      }
      // No → list stays empty; those employees are skipped, not the whole run.
    }
  } catch (err) {
    ui.alert("Error checking advance eligibility: " + err.message);
    return;
  }

  const requestedBy = Session.getEffectiveUser().getEmail();

  if (user === EMI_PMO_USER_) {
    // Owner: run core directly
    try {
      const result = scheduleEMI_Core_(ss, allowExceptions, allowTenureExceptions, requestedBy);
      advElig_ShowResultDialog_(ui, result.message);
    } catch (err) {
      ui.alert("Error: " + err.message);
    }
    return;
  }

  // nazneen@: route via Web App — both exception lists travel in the payload.
  // requestedBy is sent explicitly because the Web App runs as the OWNER
  // ("Execute as: Me"), so Session.getEffectiveUser() on the server side is
  // pmo@ regardless of who clicked — it would stamp the wrong name on an
  // override. callEmiWebApp_ already sets requestedBy from the real caller.
  try {
    const result = callEmiWebApp_("scheduleEMI", ss, { allowExceptions, allowTenureExceptions });
    advElig_ShowResultDialog_(ui, result.success
      ? (result.message || "EMI Schedule created ✅")
      : ("Error\n" + (result.message || "Unknown error from Web App."))
    );
  } catch (err) {
    ui.alert("Web App call failed: " + err.message);
  }
}

/**
 * cancelEMI_ByReference
 * Menu entry point for Cancel EMI.
 *
 * ui.prompt() runs HERE (client side) for BOTH paths.
 * emiRef is collected before routing — passed directly to core
 * or sent in the Web App payload.
 *
 * pmo@butlerleather.com   → runs cancelEMI_Core_(ss, emiRef) directly
 * nazneen@butlerleather.com → routes to Web App with emiRef in payload
 * anyone else              → access denied
 */
function cancelEMI_ByReference() {
  const ui   = SpreadsheetApp.getUi();
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const user = Session.getEffectiveUser().getEmail().toLowerCase();

  if (user !== EMI_PMO_USER_ && user !== EMI_ALLOWED_USER_) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  // ✅ Collect emiRef from user BEFORE routing — same for both paths
  const resp = ui.prompt(
    "Cancel EMI",
    'Enter EMI Reference Number (example: "EMI-12")',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const emiRef = str_(resp.getResponseText()).toUpperCase();
  if (!emiRef) {
    ui.alert("Invalid EMI Reference.");
    return;
  }

  if (user === EMI_PMO_USER_) {
    // Owner: run core directly
    try {
      const result = cancelEMI_Core_(ss, emiRef);
      ui.alert(result.message);
    } catch (err) {
      ui.alert("Error: " + err.message);
    }
    return;
  }

  // nazneen@: route via Web App — emiRef travels in payload
  try {
    const result = callEmiWebApp_("cancelEMI", ss, { emiRef });
    ui.alert(result.success
      ? (result.message || "Cancel EMI completed ✅")
      : ("Error: " + (result.message || "Unknown error from Web App."))
    );
  } catch (err) {
    ui.alert("Web App call failed: " + err.message);
  }
}

/* ================================================
 * CORE FUNCTIONS — UI-free
 * Called by menu wrappers (direct path) AND
 * by server handlers in 0_WebApp.gs (Web App path).
 * No ui.alert / ui.prompt / getActiveSpreadsheet inside.
 * ================================================ */

/**
 * scheduleEMI_Core_(ss, allowExceptions)
 *
 * All scheduling logic. Receives ss (Spreadsheet object) — never
 * calls getActiveSpreadsheet() internally.
 *
 * ✅ NEW (v2):
 *   - Validates ALL rows FIRST (all-or-nothing)
 *   - Returns { success: false, message } with alert-friendly message if any row is invalid
 *   - On success: recreates single bulk protection on EMI_SCHEDULE A2:L{lastRow}
 *
 * ✅ NEW (v4) — replaces the old v3 all-abort behaviour:
 *   - allowExceptions (array of Employee Codes, default []) — employees who
 *     were shown in the Yes/No dialog and explicitly approved for a new EMI
 *     despite already having an active one.
 *   - Any newly-eligible employee who already has an active EMI and is NOT
 *     in allowExceptions is SKIPPED (not aborted) — every other eligible
 *     employee in the same run is still scheduled normally.
 *   - Conflict detection itself is delegated to the shared, pure helper
 *     scheduleEMI_BuildActiveEmiConflicts_(), so this always agrees with
 *     scheduleEMI_FindActiveEmiConflicts_() (used by the menu wrapper for
 *     the pre-check dialog) on what counts as a conflict.
 *
 * ✅ NEW (v6) — advance-eligibility gate, see 5_AdvanceEligibility.gs:
 *   - allowTenureExceptions (array of Employee Codes, default []) — employees
 *     shown in the "has not completed 1 year" dialog and explicitly approved.
 *   - requestedBy (string, default = effective user) — stamped onto the ledger
 *     beside any tenure override. Passed in rather than read here because the
 *     Web App executes as the owner, so the effective user is pmo@ no matter
 *     who actually clicked.
 *   - AMOUNT failures have NO allow-list parameter, by design. There is no
 *     argument, payload field or dialog answer that can schedule an advance
 *     exceeding the employee's net salary; the row is always skipped.
 *   - Both parameters are trailing and optional, so an older deployed Web App
 *     calling scheduleEMI_Core_(ss, allowExceptions) still gates correctly —
 *     it simply approves no tenure exceptions, which SKIPS those employees.
 *     Fail-closed: a stale caller refuses money, it never releases it.
 *
 * Returns: { success, message, refsCreated, rowsAdded, skippedIneligible }
 */
function scheduleEMI_Core_(ss, allowExceptions, allowTenureExceptions, requestedBy) {
  // ✅ NEW (v6) — serialised against the other advance operations. The race this
  // closes: syncSalaryMaster_Core_ clears SALARY master before rewriting it, and
  // a read landing in that window would find no salaries and refuse EVERY
  // advance in this run as "no salary on record". See withEmiLock_ in 0_WebApp.gs.
  return withEmiLock_("Schedule EMI", () =>
    scheduleEMI_CoreLocked_(ss, allowExceptions, allowTenureExceptions, requestedBy));
}

function scheduleEMI_CoreLocked_(ss, allowExceptions, allowTenureExceptions, requestedBy) {

  const ledger   = ss.getSheetByName(ADV_LEDGER_SHEET);
  const schedule = ss.getSheetByName(EMI_SCHEDULE_SHEET);

  if (!ledger)   throw new Error(`Sheet not found: ${ADV_LEDGER_SHEET}`);
  if (!schedule) throw new Error(`Sheet not found: ${EMI_SCHEDULE_SHEET}`);

  const ledMap = getHeaderMap_(ledger);
  const schMap = getHeaderMap_(schedule);

  // Required ledger headers
  const L = {
    emp:         req_(ledMap, "EMPLOYEE CODE"),
    name:        req_(ledMap, "NAME"),
    dept:        req_(ledMap, "DEPARTMENT"),
    advAmt:      req_(ledMap, "ADVANCE AMOUNT"),
    advPaid:     req_(ledMap, "ADVANCE PAID MONTH [MM/DD/YY]"),
    emiStart:    req_(ledMap, "EMI START MONTH [MM/DD/YY]"),
    tenure:      req_(ledMap, "TENURE"),
    emiAmt:      req_(ledMap, "EMI AMOUNT"),
    ref:         req_(ledMap, "EMI REFERENCE NUMBER"),
    schedStatus: req_(ledMap, "EMI SCHEDULED STATUS"),
    status:      req_(ledMap, "STATUS"),
  };

  // "EMI Status" is optional-mapped — it is a formula column (ARRAYFORMULA).
  // Read via opt_() so missing header fails gracefully rather than throwing.
  const emiStatusIdx0 = opt_(ledMap, "EMI STATUS");

  // Required schedule headers
  const S = {
    month:  req_(schMap, "MONTH"),
    emp:    req_(schMap, "EMPLOYEE CODE"),
    name:   req_(schMap, "NAME"),
    dept:   req_(schMap, "DEPARTMENT"),
    ref:    req_(schMap, "EMI REFERENCE NUMBER"),
    emiAmt: req_(schMap, "EMI AMOUNT"),
    status: req_(schMap, "STATUS"),
    curBal: opt_(schMap, "CURRENT BALANCE"), // for formula seeding only
  };

  // ---- Read ledger data (values + display for formula columns) ----
  const ledLast = ledger.getLastRow();
  if (ledLast < 2) {
    return { success: false, message: "Advance Ledger has no data rows." };
  }

  const ledRange = ledger.getRange(2, 1, ledLast - 1, ledger.getLastColumn());
  const ledVals  = ledRange.getValues();        // numeric/date-safe
  const ledDisp  = ledRange.getDisplayValues(); // formula-safe for Name/Dept/EMI Status

  // ---- Seed Current Balance formula only if EMI_SCHEDULE has no data rows ----
  seedCurrentBalanceFormulaIfFirstRun_(schedule, schMap);

  let nextRefNum = getNextEmiRefNumber_(ledger, L.ref);
  const nowStamp = stamp_();

  // ✅ NEW (v4) — conflicts are SKIPPED (not aborted) unless explicitly allowed.
  const conflicts = scheduleEMI_BuildActiveEmiConflicts_(ledVals, ledDisp, L, emiStatusIdx0);
  const allowSet  = new Set((allowExceptions || []).map(String));
  const skipSet   = new Set(conflicts.filter(c => !allowSet.has(c.empCode)).map(c => c.empCode));
  const skippedActiveEmi = conflicts.filter(c => skipSet.has(c.empCode));

  // ✅ NEW (v6) — advance-eligibility gate. Recomputed here from SALARY master,
  // EMP master and the ledger's own balance columns; the "Eligible Amount" /
  // "Eligibility Status" formula columns are guidance for HR and are never read.
  const balIdx0        = opt_(ledMap, "BALANCE AMOUNT");
  const elig           = advElig_BuildIssues_(ss, ledVals, ledDisp, L, emiStatusIdx0, balIdx0);
  const allowTenureSet = new Set((allowTenureExceptions || []).map(v => str_(v).toUpperCase()));

  const ineligibleRows     = new Set(); // ledger array indices to skip entirely
  const tenureOverrideRows = new Set(); // scheduled, but only via an override
  const skippedAmount      = [];
  const skippedTenure      = [];

  elig.byRow.forEach((issue, i) => {
    // Amount / missing-data failures are terminal — no allow-list consulted.
    if (issue.noSalary || issue.noDoj || issue.amountFail) {
      ineligibleRows.add(i);
      skippedAmount.push(issue);
      return;
    }
    // Tenure-only failure — overridable.
    if (allowTenureSet.has(issue.empCode.toUpperCase())) {
      tenureOverrideRows.add(i);
    } else {
      ineligibleRows.add(i);
      skippedTenure.push(issue);
    }
  });

  // ✅ PHASE 1 — Validate ALL eligible rows FIRST before writing anything
  // "Eligible" = has Employee Code + no existing ref + not skipped for active-EMI conflict
  // Any eligible row that fails field validation = abort entire run
  for (let i = 0; i < ledVals.length; i++) {
    const row = ledVals[i];

    const empCode = str_(row[L.emp]);
    if (!empCode) continue; // blank employee row — not eligible, skip silently

    const existingRef = str_(row[L.ref]);
    if (existingRef) continue; // already scheduled — not eligible, skip silently

    if (skipSet.has(empCode)) continue; // ✅ NEW (v4) — active-EMI conflict, not approved
    if (ineligibleRows.has(i))  continue; // ✅ NEW (v6) — failed the eligibility gate

    // ✅ This row IS eligible — validate all required fields strictly
    const advAmount    = num_(row[L.advAmt]);
    const tenure       = Math.floor(num_(row[L.tenure]));
    const emiStart     = toMonthDate_(row[L.emiStart]);
    const advPaidMonth = toMonthDate_(row[L.advPaid]);
    const ledgerStatus = str_(row[L.status]).toUpperCase();

    if (!advAmount || advAmount <= 0 ||
        !tenure    || tenure <= 0    ||
        !emiStart                    ||
        !advPaidMonth                ||
        ledgerStatus !== "ACTIVE") {
      return {
        success: false,
        message: "Missing required fields in Advance Ledger — please fill all mandatory columns before scheduling.",
      };
    }
  }

  // ✅ PHASE 2 — All eligible rows passed validation. Now build and write.
  const scheduleRows  = []; // rows to append to EMI_SCHEDULE
  const ledgerUpdates = []; // ledger cells to stamp after append

  for (let i = 0; i < ledVals.length; i++) {
    const row = ledVals[i];

    const empCode = str_(row[L.emp]);
    if (!empCode) continue;

    const existingRef = str_(row[L.ref]);
    if (existingRef) continue; // already scheduled

    if (skipSet.has(empCode)) continue; // ✅ NEW (v4) — active-EMI conflict, not approved
    if (ineligibleRows.has(i))  continue; // ✅ NEW (v6) — failed the eligibility gate

    const advAmount    = num_(row[L.advAmt]);
    const tenure       = Math.floor(num_(row[L.tenure]));
    const emiStart     = toMonthDate_(row[L.emiStart]);
    const advPaidMonth = toMonthDate_(row[L.advPaid]);
    const ledgerStatus = str_(row[L.status]).toUpperCase();

    let emiAmount = num_(row[L.emiAmt]);

    // Basic validations (mirrors Phase 1 — guaranteed to pass here)
    if (!advAmount || advAmount <= 0)  continue;
    if (!tenure    || tenure <= 0)     continue;
    if (!emiStart)                     continue;
    if (!advPaidMonth)                 continue;
    if (ledgerStatus !== "ACTIVE")     continue;

    // If EMI Amount not present, compute (ceiling to 100)
    if (!emiAmount || emiAmount <= 0) {
      emiAmount = ceilingTo_(advAmount / tenure, 100);
    }

    // ✅ Name/Department from DISPLAY values (ARRAYFORMULA safe)
    const name = String(ledDisp[i][L.name] || "").trim();
    const dept = String(ledDisp[i][L.dept] || "").trim();

    const ref = `EMI-${nextRefNum++}`;

    let remaining = advAmount;
    for (let m = 0; m < tenure; m++) {
      const monthDate = addMonths_(emiStart, m);

      let thisEmi = emiAmount;
      if (m === tenure - 1) thisEmi = Math.max(remaining, 0);
      else                  thisEmi = Math.min(thisEmi, remaining);

      scheduleRows.push({
        month:  monthDate,
        emp:    empCode,
        name,
        dept,
        ref,
        emiAmt: thisEmi,
        status: "ACTIVE",
      });

      remaining = Math.max(remaining - thisEmi, 0);
      if (remaining <= 0) break;
    }

    ledgerUpdates.push({
      i,
      r:           i + 2,
      ref,
      schedStatus: `Scheduled - ${nowStamp}`,
    });
  }

  // ✅ NEW (v4) — appended to whichever message is returned below, if anyone was skipped
  let skippedNote = skippedActiveEmi.length > 0
    ? `\n\nSkipped (already have an active EMI, not approved): ${skippedActiveEmi.map(c => `${c.empCode} – ${c.name}`).join(", ")}`
    : "";

  // ✅ NEW (v6) — eligibility skips, reported separately so the reason is never
  // ambiguous. Amount failures are listed with the arithmetic behind them,
  // because "not eligible" alone is not something HR can act on.
  if (skippedAmount.length > 0) {
    skippedNote += `\n\n${advElig_AmountBlockerSection_(skippedAmount)}`;
  }
  if (skippedTenure.length > 0) {
    skippedNote += `\n\nSkipped — under 1 year of service, not approved:\n` +
      advElig_FormatTenureBlockers_(skippedTenure);
  }

  if (ledgerUpdates.length === 0) {
    // The required-fields checklist is shown ONLY when nothing was skipped for a
    // stated reason. Printing it beneath an eligibility refusal was actively
    // misleading — those rows were complete, and it sent HR to check Tenure and
    // Advance Paid Month when the real problem was the Advance Amount.
    const anySkips = skippedActiveEmi.length + skippedAmount.length + skippedTenure.length > 0;
    const preamble = anySkips ? "" :
      "\n\nNo pending advance rows were ready to schedule.\n" +
      "(Required: Status=ACTIVE, Advance Amount, Advance Paid Month,\n" +
      " EMI Start Month, Tenure)";

    return {
      success: false,
      message: "No EMI scheduled." + preamble + skippedNote,
    };
  }

  // ✅ Append schedule rows safely — never writes to Current Balance column
  appendScheduleRowsSelective_(schedule, S, scheduleRows);

  // Stamp ledger: ref + scheduled status
  ledgerUpdates.forEach(u => {
    ledger.getRange(u.r, L.ref + 1).setValue(u.ref);
    ledger.getRange(u.r, L.schedStatus + 1).setValue(u.schedStatus);
  });

  // ✅ NEW (v6) — record every tenure override that actually resulted in a
  // schedule. Stamped only for rows in ledgerUpdates, so a row approved in the
  // dialog but then dropped for some other reason is never marked as overridden.
  // Both columns are opt_(): an older ledger without them loses the audit trail
  // rather than losing the ability to schedule at all.
  const ovrByIdx0 = opt_(ledMap, ADV_ELIG_OVERRIDE_BY_HEADER);
  const ovrOnIdx0 = opt_(ledMap, ADV_ELIG_OVERRIDE_ON_HEADER);
  const overrideBy = str_(requestedBy) || Session.getEffectiveUser().getEmail();

  let overridesStamped = 0;
  if (ovrByIdx0 !== -1 && ovrOnIdx0 !== -1) {
    ledgerUpdates.forEach(u => {
      if (!tenureOverrideRows.has(u.i)) return;
      ledger.getRange(u.r, ovrByIdx0 + 1).setValue(overrideBy);
      ledger.getRange(u.r, ovrOnIdx0 + 1).setValue(nowStamp);
      overridesStamped++;
    });
  }

  // ✅ Recreate single bulk protection on Advance Ledger A2:N{lastRow}
  refreshEmiScheduleProtection_(schedule, ss);

  const overrideNote = overridesStamped > 0
    ? `\n\n⚠️ ${overridesStamped} advance(s) scheduled under a 1-year-service ` +
      `override, recorded against ${overrideBy}.`
    : "";

  return {
    success:     true,
    message:     `EMI Schedule created ✅\nReferences created: ${ledgerUpdates.length}\nEMI rows added: ${scheduleRows.length}` + overrideNote + skippedNote,
    refsCreated: ledgerUpdates.length,
    rowsAdded:   scheduleRows.length,
    skippedIneligible: skippedAmount.length + skippedTenure.length,
  };
}

/**
 * scheduleEMI_FindActiveEmiConflicts_(ss)
 *
 * ✅ NEW (v4) — Read-only pre-check. Safe to call directly from the
 * client-side menu wrapper for BOTH pmo@ and nazneen@: it only reads
 * the Advance Ledger, so it needs no privileged (owner) execution —
 * unlike the actual scheduling write, which still goes through the
 * Web App for nazneen@ exactly as before.
 *
 * Returns [{ empCode, name, activeEmiRef }, ...] for every employee
 * who is newly-eligible for a new EMI (Employee Code present, no
 * EMI Reference Number yet) but already has another row with
 * EMI Status = "ACTIVE" elsewhere in the ledger.
 */
function scheduleEMI_FindActiveEmiConflicts_(ss) {
  const ledger = ss.getSheetByName(ADV_LEDGER_SHEET);
  if (!ledger) throw new Error(`Sheet not found: ${ADV_LEDGER_SHEET}`);

  const ledMap = getHeaderMap_(ledger);
  const L = {
    emp:  req_(ledMap, "EMPLOYEE CODE"),
    name: req_(ledMap, "NAME"),
    ref:  req_(ledMap, "EMI REFERENCE NUMBER"),
  };
  const emiStatusIdx0 = opt_(ledMap, "EMI STATUS");

  const ledLast = ledger.getLastRow();
  if (ledLast < 2) return [];

  const ledRange = ledger.getRange(2, 1, ledLast - 1, ledger.getLastColumn());
  const ledVals  = ledRange.getValues();
  const ledDisp  = ledRange.getDisplayValues();

  return scheduleEMI_BuildActiveEmiConflicts_(ledVals, ledDisp, L, emiStatusIdx0);
}

/**
 * scheduleEMI_BuildActiveEmiConflicts_(ledVals, ledDisp, L, emiStatusIdx0)
 *
 * ✅ NEW (v4) — Shared, pure helper used by BOTH
 * scheduleEMI_FindActiveEmiConflicts_() (client-side pre-check, for the
 * Yes/No dialog) and scheduleEMI_Core_() (the actual write), so the two
 * can never disagree on what counts as a conflict. Takes already-read
 * ledger data — no sheet access here.
 *
 * Returns [{ empCode, name, activeEmiRef }, ...].
 */
function scheduleEMI_BuildActiveEmiConflicts_(ledVals, ledDisp, L, emiStatusIdx0) {
  const activeEmiRefByEmp = new Map(); // empCode -> ref of their ACTIVE EMI row

  if (emiStatusIdx0 !== -1) {
    for (let i = 0; i < ledDisp.length; i++) {
      const empCode   = str_(ledVals[i][L.emp]);
      const emiStatus = str_(ledDisp[i][emiStatusIdx0]).toUpperCase();
      if (empCode && emiStatus === "ACTIVE") {
        activeEmiRefByEmp.set(empCode, str_(ledVals[i][L.ref]) || "(no ref)");
      }
    }
  }

  const conflicts = [];
  for (let i = 0; i < ledVals.length; i++) {
    const empCode = str_(ledVals[i][L.emp]);
    if (!empCode) continue;

    const existingRef = str_(ledVals[i][L.ref]);
    if (existingRef) continue; // already scheduled — not a new row

    if (activeEmiRefByEmp.has(empCode)) {
      const name = str_(ledDisp[i][L.name]) || empCode;
      // Avoid duplicate entries if same employee appears more than once as a new row
      if (!conflicts.some(c => c.empCode === empCode)) {
        conflicts.push({ empCode, name, activeEmiRef: activeEmiRefByEmp.get(empCode) });
      }
    }
  }
  return conflicts;
}

/**
 * cancelEMI_Core_(ss, emiRef)
 *
 * All cancel logic. Receives ss and emiRef — never calls
 * getActiveSpreadsheet() or any UI method internally.
 *
 * ✅ NEW (v5) — nothing is written until every precheck below has passed. Order:
 *   1. Read EMI_SCHEDULE rows for this ref (read-only).
 *   2. BLOCKING PRECHECKS — refuse outright, no writes anywhere, if any row has:
 *        HR Decision = RESIGNED / ABSCOND               → employee marked as leaving
 *        HR Decision = PAY EXTRA / PAY LESS / SKIP       → a decision already approved once
 *        Amount Set By = ADMIN                           → a Close In Months plan is active
 *      These are permanent: once true for this reference, cancel refuses forever, not only
 *      while the condition is current.
 *   3. Only once every precheck has passed: stamp the ledger, then stamp EMI_SCHEDULE —
 *      but ONLY rows that are still untouched (Recover Amount blank AND Write Off Amount
 *      blank). A row that already recovered money or already had a write-off booked is a
 *      locked record, exactly as every pass in 3A_Master_SharedEMILockSync.gs already treats
 *      one, and keeps its existing Status.
 *
 * HR Decision / Amount Set By are read via opt_() rather than req_() — an older sheet
 * missing one of these newer columns loses that one guard rather than losing Cancel EMI
 * entirely.
 *
 * Cancel status rules (unchanged):
 *   Recovered Amount (ledger, aggregate) blank or 0  → "CANCELLED"
 *   Recovered Amount (ledger, aggregate) > 0          → "CANCELLED & GOT PAID"
 *
 * Returns: { success, message, emiRef, ledgerHits,
 *             recoveredAmtForRef, scheduleHits, scheduleRowsPreserved,
 *             statusLabel, sharedRowsDeleted }
 */
function cancelEMI_Core_(ss, emiRef) {

  const ledger   = ss.getSheetByName(ADV_LEDGER_SHEET);
  const schedule = ss.getSheetByName(EMI_SCHEDULE_SHEET);
  const shared   = ss.getSheetByName(SHARED_EMI_SUMMARY_SHEET);

  if (!ledger)   throw new Error(`Sheet not found: ${ADV_LEDGER_SHEET}`);
  if (!schedule) throw new Error(`Sheet not found: ${EMI_SCHEDULE_SHEET}`);
  if (!shared)   throw new Error(`Sheet not found: ${SHARED_EMI_SUMMARY_SHEET}`);

  const nowStamp = stamp_();

  // --- Advance Ledger: confirm the ref exists and read Recovered Amount. READ-ONLY here —
  // the actual stamp is deferred until every precheck below has passed. ---
  const ledMap = getHeaderMap_(ledger);
  const L = {
    ref:         req_(ledMap, "EMI REFERENCE NUMBER"),
    schedStatus: req_(ledMap, "EMI SCHEDULED STATUS"),
    recovered:   req_(ledMap, "RECOVERED AMOUNT"),
  };

  const ledLast = ledger.getLastRow();
  const ledVals = ledLast >= 2
    ? ledger.getRange(2, 1, ledLast - 1, ledger.getLastColumn()).getValues()
    : [];

  let recoveredAmtForRef = 0;
  let foundAny           = false;
  const ledgerRowsToStamp = [];

  for (let i = 0; i < ledVals.length; i++) {
    const rref = str_(ledVals[i][L.ref]).toUpperCase();
    if (rref !== emiRef) continue;

    if (!foundAny) {
      recoveredAmtForRef = num_(ledVals[i][L.recovered]);
      foundAny = true;
    }
    ledgerRowsToStamp.push(i + 2);
  }

  if (!foundAny) {
    return { success: false, message: `EMI Reference not found in Advance Ledger: ${emiRef}` };
  }

  // --- EMI_SCHEDULE: read every row for this ref. READ-ONLY — the prechecks need the full
  // picture before anything is written anywhere. ---
  const schMap = getHeaderMap_(schedule);
  const S = {
    ref:    req_(schMap, "EMI REFERENCE NUMBER"),
    status: req_(schMap, "STATUS"),
    hr:     opt_(schMap, "HR DECISION"),
    recAmt: opt_(schMap, "RECOVER AMOUNT"),
    woAmt:  opt_(schMap, "WRITE OFF AMOUNT"),
    setBy:  opt_(schMap, "AMOUNT SET BY"),
    month:  opt_(schMap, "MONTH"),
  };

  const schLast = schedule.getLastRow();
  const schVals = schLast >= 2
    ? schedule.getRange(2, 1, schLast - 1, schedule.getLastColumn()).getValues()
    : [];

  const monthLabel_ = (row) => {
    if (S.month === -1) return "";
    const v = row[S.month];
    if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "MMMM_yyyy");
    return String(v || "").trim();
  };

  const matchingRows = [];
  for (let i = 0; i < schVals.length; i++) {
    if (str_(schVals[i][S.ref]).toUpperCase() !== emiRef) continue;
    matchingRows.push({ r: i + 2, row: schVals[i] });
  }

  // ✅ NEW (v5) — BLOCKING PRECHECKS. Nothing has been written yet.
  if (S.hr !== -1) {
    for (const m of matchingRows) {
      const decision = str_(m.row[S.hr]).toUpperCase();
      if (decision === "RESIGNED" || decision === "ABSCOND") {
        return {
          success: false,
          message: `Cancel EMI blocked: ${emiRef} has HR Decision "${decision}" recorded ` +
                    `(${monthLabel_(m.row)}). Cancel is not permitted once an employee has ` +
                    `been marked as leaving — use the settlement flow instead.`,
        };
      }
    }
    for (const m of matchingRows) {
      const decision = str_(m.row[S.hr]).toUpperCase();
      if (decision === "PAY EXTRA" || decision === "PAY LESS" || decision === "SKIP") {
        return {
          success: false,
          message: `Cancel EMI blocked: ${emiRef} already has an approved "${decision}" ` +
                    `decision (${monthLabel_(m.row)}). Cancel is not permitted once a ` +
                    `recovery decision has been committed for this advance.`,
        };
      }
    }
  }
  if (S.setBy !== -1) {
    for (const m of matchingRows) {
      if (str_(m.row[S.setBy]).toUpperCase() === "ADMIN") {
        return {
          success: false,
          message: `Cancel EMI blocked: ${emiRef} has a Close In Months plan active ` +
                    `(${monthLabel_(m.row)}). Cancel is not permitted while a plan is active.`,
        };
      }
    }
  }

  // --- Every precheck passed. Now write. ---

  // ✅ STATUS label based on Recovered Amount (unchanged logic)
  const statusLabel = (recoveredAmtForRef && recoveredAmtForRef > 0)
    ? "CANCELLED & GOT PAID"
    : "CANCELLED";

  ledgerRowsToStamp.forEach(r => {
    ledger.getRange(r, L.schedStatus + 1).setValue(`Cancelled - ${nowStamp}`);
  });
  const ledgerHits = ledgerRowsToStamp.length;

  // --- EMI_SCHEDULE: stamp Status, but ONLY on rows that are still untouched. ---
  // ✅ NEW (v5) — a row already carrying a Recover Amount or a Write Off Amount is a locked
  // record; cancel must not rewrite history, only the rows nothing has happened to yet.
  let scheduleHits = 0;
  let scheduleRowsPreserved = 0;

  for (const m of matchingRows) {
    const recovered  = S.recAmt === -1 ? "" : str_(m.row[S.recAmt]);
    const writtenOff = S.woAmt  === -1 ? "" : str_(m.row[S.woAmt]);

    if (recovered !== "" || writtenOff !== "") {
      scheduleRowsPreserved++;
      continue; // locked record — Status left exactly as it is
    }

    schedule.getRange(m.r, S.status + 1).setValue(statusLabel);
    scheduleHits++;
  }

  // --- Shared EMI Summary: delete rows only where Payroll Status is blank ---
  const shMap = getHeaderMap_(shared);
  const H = {
    ref:     req_(shMap, "EMI REFERENCE NUMBER"),
    payroll: req_(shMap, "PAYROLL STATUS"),
  };

  const shLast = shared.getLastRow();
  const shVals = shLast >= 2
    ? shared.getRange(2, 1, shLast - 1, shared.getLastColumn()).getValues()
    : [];

  const rowsToDelete = [];
  for (let i = 0; i < shVals.length; i++) {
    if (str_(shVals[i][H.ref]).toUpperCase() !== emiRef) continue;
    if (str_(shVals[i][H.payroll]) === "") rowsToDelete.push(i + 2);
  }
  // Delete bottom-up to preserve row indices
  rowsToDelete.sort((a, b) => b - a).forEach(rno => shared.deleteRow(rno));

  const preservedNote = scheduleRowsPreserved > 0
    ? `\nRows preserved (already recovered or written off, left untouched): ${scheduleRowsPreserved}`
    : "";

  return {
    success:            true,
    message:            `Cancel EMI completed ✅\nRef: ${emiRef}\nLedger updated: ${ledgerHits}\n` +
                         `Recovered Amount: ${recoveredAmtForRef}\nEMI_SCHEDULE rows marked: ${scheduleHits}` +
                         preservedNote +
                         `\nSTATUS set to: ${statusLabel}\nShared summary rows deleted (Payroll Status empty): ${rowsToDelete.length}`,
    emiRef,
    ledgerHits,
    recoveredAmtForRef,
    scheduleHits,
    scheduleRowsPreserved,
    statusLabel,
    sharedRowsDeleted:  rowsToDelete.length,
  };
}

/* ================================================
 * ✅ NEW (v2) — Single bulk protection helper
 * Finds and removes the one existing EMI_SCHEDULE protection
 * (matched by description), then creates a single new one
 * covering A2:L{lastRow} with pmo@ as editor.
 * Called only after a successful schedule write.
 *
 * ✅ FIX (v2.1):
 * removeEditors() filters out the owner before removing —
 * passing the owner to removeEditors() causes a silent abort
 * in Apps Script, leaving the protection unsaved.
 * ================================================ */

/**
 * refreshEmiScheduleProtection_(scheduleSheet, ss)
 *
 * Removes the old named protection (if any) from Advance Ledger
 * and recreates it as a single range covering A2:L{lastRow}.
 * Always exactly 1 protection — never stacks.
 */
function refreshEmiScheduleProtection_(scheduleSheet, ss) {
  const ledger  = ss.getSheetByName(ADV_LEDGER_SHEET);
  if (!ledger) return; // Advance Ledger sheet not found — skip silently

  // ✅ Use column A scan to find true last data row — avoids formula/format rows
  const lastRow = getLastDataRowByColA_(ledger);
  if (lastRow < 2) return; // nothing to protect

  // ✅ Remove existing protection with our description on Advance Ledger
  const existing = ledger.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  existing.forEach(p => {
    if (p.getDescription() === EMI_SCHEDULE_PROTECTION_DESC) p.remove();
  });

  // ✅ Create one new protection: A2:N{lastRow} on Advance Ledger (data rows only)
  // WIDENED 12 → 14 (v6). This span was A:L back when L was "EMI Start Month".
  // Inserting "Eligible Amount" / "Eligibility Status" at I pushed that column
  // to N, so 12 would now stop two columns short and leave Advance Amount,
  // Tenure, Advance Paid Month and EMI Start Month partly unprotected. This is
  // a COUNT, not a live formula reference — nothing auto-adjusts it.
  const protectRange = ledger.getRange(2, 1, lastRow - 1, 14); // columns A(1) to N(14)
  const protection   = protectRange.protect();

  protection.setDescription(EMI_SCHEDULE_PROTECTION_DESC);

  // ✅ Remove all editors EXCEPT the owner (removing owner causes silent abort)
  // Then explicitly add pmo@ as the sole permitted editor
  const editorsToRemove = protection.getEditors()
    .filter(e => e.getEmail().toLowerCase() !== EMI_PMO_USER_);
  if (editorsToRemove.length > 0) protection.removeEditors(editorsToRemove);
  protection.addEditor(EMI_PMO_USER_);

  // ✅ Disable domain-wide edit if enabled
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

/* ================================================
 * Internal helpers — ALL UNCHANGED from original
 * ================================================ */

function seedCurrentBalanceFormulaIfFirstRun_(scheduleSheet, schHeaderMap) {
  if (scheduleSheet.getLastRow() >= 2) return;

  const curBalIdx0 = opt_(schHeaderMap, "CURRENT BALANCE");
  if (curBalIdx0 === -1) return;

  const cell = scheduleSheet.getRange(2, curBalIdx0 + 1);
  const existingFormula = String(cell.getFormula() || "").trim();
  const existingValue   = String(cell.getDisplayValue() || "").trim();

  if (existingFormula || existingValue) return;

  cell.setFormula(EMI_SCHEDULE_CURRENT_BALANCE_FORMULA);
}

function appendScheduleRowsSelective_(scheduleSheet, S, scheduleRows) {
  if (!scheduleRows || scheduleRows.length === 0) return;

  const startRow = getNextEmptyRowByColA_(scheduleSheet);
  const needLast = startRow + scheduleRows.length - 1;

  if (scheduleSheet.getMaxRows() < needLast) {
    scheduleSheet.insertRowsAfter(scheduleSheet.getMaxRows(), needLast - scheduleSheet.getMaxRows());
  }

  const colMonth  = scheduleRows.map(r => [r.month]);
  const colEmp    = scheduleRows.map(r => [r.emp]);
  const colName   = scheduleRows.map(r => [r.name]);
  const colDept   = scheduleRows.map(r => [r.dept]);
  const colRef    = scheduleRows.map(r => [r.ref]);
  const colEmi    = scheduleRows.map(r => [r.emiAmt]);
  const colStatus = scheduleRows.map(r => [r.status]);

  scheduleSheet.getRange(startRow, S.month  + 1, scheduleRows.length, 1).setValues(colMonth);
  scheduleSheet.getRange(startRow, S.emp    + 1, scheduleRows.length, 1).setValues(colEmp);
  scheduleSheet.getRange(startRow, S.name   + 1, scheduleRows.length, 1).setValues(colName);
  scheduleSheet.getRange(startRow, S.dept   + 1, scheduleRows.length, 1).setValues(colDept);
  scheduleSheet.getRange(startRow, S.ref    + 1, scheduleRows.length, 1).setValues(colRef);
  scheduleSheet.getRange(startRow, S.emiAmt + 1, scheduleRows.length, 1).setValues(colEmi);
  scheduleSheet.getRange(startRow, S.status + 1, scheduleRows.length, 1).setValues(colStatus);
}

function getHeaderMap_(sh) {
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(h => String(h || "").trim().toUpperCase());
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i; });
  return map;
}

function req_(map, headerName) {
  const key = String(headerName || "").trim().toUpperCase();
  if (!(key in map)) throw new Error(`Missing required header: "${headerName}"`);
  return map[key];
}

function opt_(map, headerName) {
  const key = String(headerName || "").trim().toUpperCase();
  return (key in map) ? map[key] : -1;
}

function getNextEmptyRowByColA_(sh) {
  const maxRows = sh.getMaxRows();
  if (maxRows < 2) return 2;

  const colA = sh.getRange(2, 1, maxRows - 1, 1).getDisplayValues();
  let lastDataRow = 1;

  for (let i = colA.length - 1; i >= 0; i--) {
    if (String(colA[i][0] || "").trim() !== "") {
      lastDataRow = i + 2;
      break;
    }
  }
  return Math.max(lastDataRow + 1, 2);
}

/**
 * getLastDataRowByColA_(sh)
 *
 * Returns the last row number that has a non-empty value in column A.
 * Scans from the bottom up — ignores formula/formatting-only rows.
 * Returns 1 (header only) if no data rows found.
 *
 * Used by refreshEmiScheduleProtection_ to protect only actual data rows,
 * not the full sheet extent (which includes empty formatted rows).
 */
function getLastDataRowByColA_(sh) {
  const maxRows = sh.getMaxRows();
  if (maxRows < 2) return 1;

  const colA = sh.getRange(2, 1, maxRows - 1, 1).getDisplayValues();

  for (let i = colA.length - 1; i >= 0; i--) {
    if (String(colA[i][0] || "").trim() !== "") {
      return i + 2; // convert 0-based index back to sheet row number
    }
  }
  return 1; // no data rows found
}

function getNextEmiRefNumber_(ledgerSheet, refColIndex0) {
  const last = ledgerSheet.getLastRow();
  if (last < 2) return 1;
  const vals = ledgerSheet.getRange(2, refColIndex0 + 1, last - 1, 1).getDisplayValues();
  let maxN = 0;
  vals.forEach(r => {
    const v = String(r[0] || "").trim().toUpperCase();
    const m = v.match(/^EMI-(\d+)$/);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  });
  return maxN + 1;
}

function stamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
}

function str_(v) {
  return String(v == null ? "" : v).trim();
}

function num_(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v || "").replace(/,/g, "").trim());
  return isFinite(n) ? n : 0;
}

function ceilingTo_(value, step) {
  if (!isFinite(value) || value <= 0) return 0;
  const s = step > 0 ? step : 1;
  return Math.ceil(value / s) * s;
}

function toMonthDate_(v) {
  if (!v) return null;
  let d = null;

  if (v instanceof Date) d = v;
  else {
    const tryD = new Date(v);
    if (!isNaN(tryD.getTime())) d = tryD;
  }
  if (!d) return null;

  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths_(monthDate, add) {
  return new Date(monthDate.getFullYear(), monthDate.getMonth() + add, 1);
}
