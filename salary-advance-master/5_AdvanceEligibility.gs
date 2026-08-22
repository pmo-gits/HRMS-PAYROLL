/************************************************
 * 5_AdvanceEligibility.gs
 * Bind this script to SALARY ADVANCE MASTER spreadsheet
 *
 * Advance-eligibility gate for Schedule EMI. Two independent rules:
 *
 *   TENURE  — D.O.J + 1 year must have been reached as of TODAY.
 *             OVERRIDABLE via a Yes/No dialog; the override is stamped
 *             onto the Advance Ledger row (who + when).
 *
 *   AMOUNT  — Advance Amount + the employee's existing ACTIVE advance
 *             balances must not exceed his NET SALARY.
 *             NOT OVERRIDABLE. The row is skipped, named, and the rest
 *             of the batch still schedules.
 *
 * WHY THIS RECOMPUTES INSTEAD OF READING THE SHEET:
 *   Advance Ledger carries "Eligible Amount" / "Eligibility Status"
 *   formula columns so HR sees the ceiling while typing. Those are
 *   guidance only. This file never reads them — a formula cell can be
 *   stale, overwritten by a paste, or sitting on #REF!, and the gate that
 *   actually releases money must not depend on any of that. Everything
 *   below is recomputed from SALARY master, EMP master and the ledger's
 *   own balance columns.
 *
 * WHY IT LIVES IN ITS OWN FILE:
 *   Same reason scheduleEMI_BuildActiveEmiConflicts_ is a shared pure
 *   helper — the read-only pre-check that raises the dialog and the
 *   write path inside scheduleEMI_Core_ must never disagree on who is
 *   eligible. Both call advElig_BuildIssues_.
 *
 * Sheets read: "SALARY master", "EMP master", "Advance Ledger".
 ************************************************/

/** Ledger columns this gate stamps when a TENURE override is used. */
const ADV_ELIG_OVERRIDE_BY_HEADER = "ELIGIBILITY OVERRIDE BY";
const ADV_ELIG_OVERRIDE_ON_HEADER = "ELIGIBILITY OVERRIDE ON";

/**
 * The eligible amount is rounded DOWN to a multiple of this — an advance is
 * handed over as cash, so 34,999 is not a real figure; 34,500 is.
 *
 * ⚠️ THIS MUST MATCH Advance Ledger!I2's FLOOR(..., 500). If the two ever
 * disagree, HR is shown one ceiling and refused at another, which reads as the
 * gate malfunctioning. Change both together, or neither.
 *
 * Rounding DOWN is the safe direction: it can only ever refuse money the
 * unrounded rule would have allowed, never release money it would have refused.
 * A residual ceiling under 500 therefore floors to 0 and blocks the advance
 * outright — correct, since no advance that small would be paid out anyway.
 */
const ADV_ELIG_ROUND_TO = 500;

/* ================================================
 * READ-ONLY PRE-CHECK (client side, both users)
 * ================================================ */

/**
 * advElig_FindIssues_(ss)
 *
 * Read-only. Safe to call directly from the menu wrapper for BOTH pmo@
 * and nazneen@ — it only reads sheets, so it needs no privileged
 * execution, exactly like scheduleEMI_FindActiveEmiConflicts_.
 *
 * Returns the same shape as advElig_BuildIssues_.
 */
function advElig_FindIssues_(ss) {
  const ledger = ss.getSheetByName(ADV_LEDGER_SHEET);
  if (!ledger) throw new Error(`Sheet not found: ${ADV_LEDGER_SHEET}`);

  const ledMap = getHeaderMap_(ledger);
  const L = {
    emp:    req_(ledMap, "EMPLOYEE CODE"),
    name:   req_(ledMap, "NAME"),
    advAmt: req_(ledMap, "ADVANCE AMOUNT"),
    ref:    req_(ledMap, "EMI REFERENCE NUMBER"),
  };
  const emiStatusIdx0 = opt_(ledMap, "EMI STATUS");
  const balIdx0       = opt_(ledMap, "BALANCE AMOUNT");

  const ledLast = ledger.getLastRow();
  if (ledLast < 2) return advElig_EmptyIssues_();

  const ledRange = ledger.getRange(2, 1, ledLast - 1, ledger.getLastColumn());
  return advElig_BuildIssues_(
    ss, ledRange.getValues(), ledRange.getDisplayValues(), L, emiStatusIdx0, balIdx0
  );
}

/* ================================================
 * SHARED PURE-ISH BUILDER
 * Takes already-read ledger arrays; reads only the two
 * lookup tabs itself. Used by the pre-check AND by Core.
 * ================================================ */

/**
 * advElig_BuildIssues_(ss, ledVals, ledDisp, L, emiStatusIdx0, balIdx0)
 *
 * Evaluates every CANDIDATE ledger row — Employee Code present, no EMI
 * Reference Number yet — against both rules.
 *
 * MULTIPLE NEW ADVANCES IN ONE RUN: a candidate row has no EMI Reference
 * Number, so its own EMI Status formula is blank and it is never counted
 * as one of the employee's existing ACTIVE balances. That is correct for
 * a single row but would let two new advances for the same employee each
 * pass the amount test on their own while together exceeding his salary.
 * Approved candidate amounts are therefore accumulated into pendingByEmp
 * and charged against the ceiling of every later candidate row for the
 * same employee, in sheet order.
 *
 * Deliberately conservative: an amount is added to pendingByEmp when it
 * passes the AMOUNT rule, regardless of whether the row is later skipped
 * for a TENURE failure. The builder does not know the tenure allow-list —
 * keeping it out is what lets the pre-check and Core produce identical
 * results — so a second advance for the same employee can be held to a
 * slightly tighter ceiling than strictly necessary. Erring toward
 * refusing money is the right direction here.
 *
 * Returns:
 *   {
 *     byRow: Map(ledgerArrayIndex -> issue),   // only rows WITH an issue
 *     tenureIssues: [issue, ...],              // overridable, unique by empCode
 *     amountIssues: [issue, ...],              // NOT overridable
 *   }
 * where issue = { i, empCode, name, requested, net, existingBal, eligible,
 *                 excess, doj, noSalary, noDoj, tenureFail, amountFail }
 */
function advElig_BuildIssues_(ss, ledVals, ledDisp, L, emiStatusIdx0, balIdx0) {
  const out = advElig_EmptyIssues_();

  const netByEmp = advElig_ReadNetSalaryByEmp_(ss);
  const dojByEmp = advElig_ReadDojByEmp_(ss);
  const today    = advElig_TodayDateOnly_();

  // ---- Existing ACTIVE balances, per employee ----
  // Both columns are formula-driven. Balance Amount is read from VALUES
  // (a display string like "₹22,000" parses to NaN — the same trap
  // vpBuildMaxRecoverableMap_ documents in 5.Validate Payroll), while EMI
  // Status is read from DISPLAY, matching how the v4 conflict scan reads it.
  const activeBalByEmp = new Map();
  if (emiStatusIdx0 !== -1 && balIdx0 !== -1) {
    for (let i = 0; i < ledVals.length; i++) {
      const empCode = str_(ledVals[i][L.emp]);
      if (!empCode) continue;
      if (str_(ledDisp[i][emiStatusIdx0]).toUpperCase() !== "ACTIVE") continue;
      const key = empCode.toUpperCase();
      activeBalByEmp.set(key, (activeBalByEmp.get(key) || 0) + num_(ledVals[i][balIdx0]));
    }
  }

  // ---- Evaluate candidate rows in sheet order ----
  const pendingByEmp   = new Map(); // approved-this-run amounts, charged forward
  const seenTenureEmp  = new Set();

  for (let i = 0; i < ledVals.length; i++) {
    const empCode = str_(ledVals[i][L.emp]);
    if (!empCode) continue;
    if (str_(ledVals[i][L.ref])) continue; // already scheduled — not a candidate

    const key  = empCode.toUpperCase();
    const name = str_(ledDisp[i][L.name]) || empCode;

    const net         = netByEmp.has(key) ? netByEmp.get(key) : null;
    const doj         = dojByEmp.has(key) ? dojByEmp.get(key) : null;
    const existingBal = (activeBalByEmp.get(key) || 0) + (pendingByEmp.get(key) || 0);
    const requested   = num_(ledVals[i][L.advAmt]);

    const noSalary = (net === null);
    const noDoj    = (doj === null);

    const eligible = noSalary ? 0 : advElig_FloorTo_(Math.max(0, net - existingBal), ADV_ELIG_ROUND_TO);
    // A blank/zero Advance Amount is not an eligibility failure — Phase 1
    // field validation already rejects it, with a clearer message.
    const amountFail = !noSalary && requested > 0 && requested > eligible;
    const tenureFail = !noDoj && advElig_OneYearFrom_(doj) > today;

    if (!noSalary && !noDoj && !amountFail && !tenureFail) {
      // Fully eligible — charge it forward against this employee's later rows.
      if (requested > 0) pendingByEmp.set(key, (pendingByEmp.get(key) || 0) + requested);
      continue;
    }

    const issue = {
      i, empCode, name, requested, net, existingBal, eligible,
      excess: amountFail ? (requested - eligible) : 0,
      doj, noSalary, noDoj, tenureFail, amountFail,
    };

    out.byRow.set(i, issue);

    if (noSalary || noDoj || amountFail) {
      // Terminal. NOT also offered in the tenure dialog even when he fails
      // tenure too: approving that override would change nothing (the amount
      // branch skips him regardless), so asking would invite HR to grant an
      // approval that silently does nothing — and to believe money moved.
      out.amountIssues.push(issue);
      continue;
    }

    // Tenure-only failure. Charge the amount forward — it is otherwise
    // affordable and may yet be approved through the override dialog.
    if (requested > 0) pendingByEmp.set(key, (pendingByEmp.get(key) || 0) + requested);

    // Tenure is a property of the employee, not of the row — the dialog
    // asks about him once even if he has two candidate rows.
    if (!seenTenureEmp.has(key)) {
      seenTenureEmp.add(key);
      out.tenureIssues.push(issue);
    }
  }

  return out;
}

function advElig_EmptyIssues_() {
  return { byRow: new Map(), tenureIssues: [], amountIssues: [] };
}

/**
 * advElig_FloorTo_(value, step) — round DOWN to a multiple of step.
 * The mirror image of ceilingTo_() in 1_Advance_EMIScheduler.gs, which rounds
 * instalments UP. Guards against float noise the same way that one does not:
 * (net - balance) is a difference of two sheet-sourced numbers, so a value that
 * should be exactly 34500 can arrive as 34499.999999999996 and floor a whole
 * 500 too far. Anything within a rupee of the next step up is treated as
 * being on it.
 */
function advElig_FloorTo_(value, step) {
  const s = step > 0 ? step : 1;
  const v = num_(value);
  if (!isFinite(v) || v <= 0) return 0;
  return Math.floor((v + 1e-6) / s) * s;
}

/* ================================================
 * Lookup readers
 * ================================================ */

/**
 * advElig_ReadNetSalaryByEmp_(ss) → Map(EMPCODE_UPPER -> number)
 *
 * An employee with no ACTIVE salary row is ABSENT from the map — not
 * present with 0. The two mean completely different things: absent
 * blocks the advance ("no salary on record"), whereas 0 would silently
 * read as a real ceiling of zero. num_() cannot express that difference,
 * which is why the raw cell is inspected before conversion.
 */
function advElig_ReadNetSalaryByEmp_(ss) {
  const sh = ss.getSheetByName(SALARY_MASTER_SHEET_NAME);
  if (!sh) {
    throw new Error(
      `Sheet not found: ${SALARY_MASTER_SHEET_NAME}. ` +
      `Run "Master → Refresh Salary Master" before scheduling EMIs.`
    );
  }

  const map    = getHeaderMap_(sh);
  const idIdx0 = req_(map, "ID.NO");
  const netIdx0 = req_(map, "NET SALARY");

  const out  = new Map();
  const last = findLastDataRowByColumn_(sh, idIdx0 + 1);
  if (last < 2) return out;

  const vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  for (let i = 0; i < vals.length; i++) {
    const empCode = str_(vals[i][idIdx0]);
    if (!empCode) continue;

    const raw = vals[i][netIdx0];
    if (raw === "" || raw === null || raw === undefined) continue; // no salary on record
    const n = num_(raw);
    if (!isFinite(n)) continue;

    const key = empCode.toUpperCase();
    if (!out.has(key)) out.set(key, n); // first wins, mirroring VLOOKUP
  }
  return out;
}

/**
 * advElig_ReadDojByEmp_(ss) → Map(EMPCODE_UPPER -> Date)
 * Read from the local EMP master mirror, so this adds no new
 * cross-spreadsheet dependency. Absent = no D.O.J on record.
 */
function advElig_ReadDojByEmp_(ss) {
  const sh = ss.getSheetByName(EMP_TARGET_SHEET_NAME);
  if (!sh) throw new Error(`Sheet not found: ${EMP_TARGET_SHEET_NAME}`);

  const map     = getHeaderMap_(sh);
  const idIdx0  = req_(map, "ID.NO");
  const dojIdx0 = req_(map, "D.O.J");

  const out  = new Map();
  const last = findLastDataRowByColumn_(sh, idIdx0 + 1);
  if (last < 2) return out;

  const vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  for (let i = 0; i < vals.length; i++) {
    const empCode = str_(vals[i][idIdx0]);
    if (!empCode) continue;

    const d = advElig_ToRealDate_(vals[i][dojIdx0]);
    if (!d) continue;

    const key = empCode.toUpperCase();
    if (!out.has(key)) out.set(key, d);
  }
  return out;
}

/* ================================================
 * Date helpers
 * ================================================ */

/**
 * advElig_ToRealDate_(v)
 *
 * Accepts a real Date or a parseable string. A BARE SPREADSHEET SERIAL
 * IS REJECTED: new Date("46266") yields the year 46266, the exact trap
 * 3A_Master_SharedEMILockSync.gs guards against on Last Working Day. A
 * D.O.J that parses to an absurd year would silently make a brand-new
 * joiner look like a 40-year veteran, so anything outside a sane range
 * is treated as no D.O.J at all — which blocks, rather than passes.
 */
function advElig_ToRealDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return advElig_StripTime_(v);
  }
  const s = str_(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return null; // bare serial — refuse

  const d = new Date(s);
  if (isNaN(d.getTime())) return null;

  const y = d.getFullYear();
  if (y < 1950 || y > 2200) return null;

  return advElig_StripTime_(d);
}

function advElig_StripTime_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function advElig_TodayDateOnly_() {
  return advElig_StripTime_(new Date());
}

/**
 * advElig_OneYearFrom_(doj) — the date one year after D.O.J.
 * Matches EDATE(doj, 12) used by Advance Ledger's Eligibility Status
 * formula, including its handling of 29 February (rolls to 1 March in a
 * non-leap year, exactly as the JS Date constructor does).
 */
function advElig_OneYearFrom_(doj) {
  return new Date(doj.getFullYear() + 1, doj.getMonth(), doj.getDate());
}

/* ================================================
 * Message builders — used by the menu wrapper's dialogs
 * and by Core's result message. Kept here so both worded
 * the same way.
 * ================================================ */

/**
 * One labelled block per blocked employee. Rendered inside a monospace <pre>
 * by advElig_ShowResultDialog_, which is what makes the figures line up —
 * ui.alert's proportional font would leave these ragged, which is half the
 * reason the result box moved to an HTML modal.
 */
function advElig_FormatAmountBlockers_(amountIssues) {
  return amountIssues.map(x => {
    const head = `${x.empCode} – ${x.name}`;
    if (x.noSalary) return `${head}\n   No active salary in SALARY master`;
    if (x.noDoj)    return `${head}\n   No D.O.J in EMP master`;
    return `${head}\n` +
           `   Requested: ${advElig_Money_(x.requested)}\n` +
           `   Eligible:  ${advElig_Money_(x.eligible)}\n` +
           `   Over by:   ${advElig_Money_(x.excess)}`;
  }).join("\n\n");
}

/**
 * Headline + body for the amount-blocker section.
 *
 * The wording narrows only when it is actually true: "exceed what the employee
 * can repay" is wrong for a row blocked because nobody has a salary on record,
 * so a mixed batch gets the neutral phrasing instead. A message that overstates
 * its own diagnosis sends HR to fix the wrong column.
 */
function advElig_AmountBlockerSection_(amountIssues) {
  const allOverLimit = amountIssues.every(x => x.amountFail);
  const n = amountIssues.length;
  const headline = allOverLimit
    ? `${n} advance(s) exceed what the employee can repay:`
    : `${n} advance(s) cannot be scheduled:`;

  // The remedy is narrowed the same way. Telling someone to correct an Advance
  // Amount when the real problem is a missing salary record wastes their time.
  const advice = allOverLimit
    ? `These cannot be overridden. Correct the Advance Amount in the\n` +
      `ledger and run again.`
    : `These cannot be overridden. Correct the Advance Amount, or refresh\n` +
      `Salary Master / EMP master, then run again.`;

  return `${headline}\n\n${advElig_FormatAmountBlockers_(amountIssues)}\n\n${advice}`;
}

function advElig_FormatTenureBlockers_(tenureIssues) {
  return tenureIssues.map(x =>
    `  • ${x.empCode} – ${x.name} (D.O.J ${advElig_DateText_(x.doj)}, ` +
    `1 year completes ${advElig_DateText_(advElig_OneYearFrom_(x.doj))})`
  ).join("\n");
}

/* ================================================
 * Result dialog
 * ================================================ */

/**
 * advElig_ShowResultDialog_(ui, message)
 *
 * Shows the Schedule EMI result as an HTML modal instead of ui.alert.
 *
 * WHY NOT ui.alert: it renders plain text in a proportional font — it cannot
 * emphasise the headline, and it cannot hold the "Requested / Eligible / Over
 * by" figures in a column. Both were asked for; neither is possible there.
 *
 * The FIRST LINE of `message` becomes the heading and everything after it the
 * body, so Core keeps returning one plain string. That matters: the same string
 * still travels back through the Web App as JSON for the delegate path, where
 * there is no UI at all and it must remain readable as plain text.
 *
 * Falls back to ui.alert if the modal cannot be shown, so a UI problem can
 * never swallow the result of a run that already wrote to the sheet.
 */
function advElig_ShowResultDialog_(ui, message) {
  const text  = String(message == null ? "" : message);
  const nl    = text.indexOf("\n");
  const head  = (nl === -1 ? text : text.slice(0, nl)).trim();
  const body  = (nl === -1 ? "" : text.slice(nl + 1)).replace(/^\n+/, "");

  try {
    const html = HtmlService
      .createHtmlOutput(
        '<div style="font-family:Roboto,Arial,sans-serif;color:#202124;padding:4px 2px;">' +
          '<div style="font-size:19px;font-weight:700;line-height:1.3;margin:0 0 14px;">' +
            advElig_EscapeHtml_(head) +
          '</div>' +
          '<pre style="font-family:Roboto Mono,Consolas,monospace;font-size:13px;' +
            'line-height:1.55;white-space:pre-wrap;word-break:break-word;margin:0;">' +
            advElig_EscapeHtml_(body) +
          '</pre>' +
        '</div>'
      )
      .setWidth(460)
      .setHeight(advElig_DialogHeight_(body));

    ui.showModalDialog(html, "Schedule EMI");
  } catch (err) {
    ui.alert(text);
  }
}

/** Rough fit: enough height for the content, capped so it never fills the screen. */
function advElig_DialogHeight_(body) {
  const lines = String(body || "").split("\n").length;
  return Math.min(560, Math.max(160, 110 + lines * 21));
}

function advElig_EscapeHtml_(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Thousands-grouped integer for dialog text. Deliberately NOT
 * toLocaleString("en-IN") — locale-aware formatting depends on ICU data that
 * the Apps Script runtime does not reliably carry, and it fails by silently
 * returning an ungrouped or differently-grouped string rather than throwing.
 */
function advElig_Money_(n) {
  const v = Math.round(num_(n));
  const sign = v < 0 ? "-" : "";
  return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function advElig_DateText_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "—";
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd-MMM-yyyy");
}
