/************************************************
 * 7_SalaryMasterWatcher.gs  (Salary Advance Master)
 *
 * Purpose:
 * - Watch the SALARY REVISION HISTORY spreadsheet for changes using a hash
 *   fingerprint, and rebuild the local "SALARY master" tab when it changes.
 *
 * ⚠️ THIS WATCHES A DIFFERENT SPREADSHEET, which is what makes it unlike
 * 3B_RecoveredLedgerWatcher.gs. 3B hashes "Recovered Amount Ledger", a tab
 * inside its OWN file. This one opens SALARY_REV_SRC_SPREADSHEET_ID — the
 * Salary Revision History file — and hashes its REVISION_HISTORY tab:
 *
 *     Salary Advance Master  ──reads──▶  Salary Revision History
 *       (this file)                        REVISION_HISTORY
 *
 * The ID comes from 4_SalaryMasterSync.gs, so in the sandbox it resolves to
 * TEST_Salary Revision History and in production to the live file. Nothing
 * here needs its own ID or registry key.
 *
 * WHY IT EXISTS:
 *   The eligibility gate in 5_AdvanceEligibility.gs refuses an advance that
 *   exceeds the employee's NET SALARY, and reads that from SALARY master. If
 *   a revision is approved and nobody refreshes the mirror, HR is held to a
 *   stale ceiling — refused at last year's salary, with no way to tell why.
 *   Nobody should have to remember to press a button for that.
 *
 * WHAT IS HASHED — NOT THE WHOLE SHEET:
 *   Only the rows SALARY master actually mirrors: ACTIVE_FOR_PAYROLL = ACTIVE,
 *   columns A:N. Two reasons.
 *
 *   1. REVISION_HISTORY keeps EVERY revision ever made. Hashing all of it
 *      would re-sync on an edit to a superseded or rejected row, which cannot
 *      change any salary the gate uses.
 *   2. Its AADHAAR NO column is a whole-column MAP() spill that stamps "" into
 *      every row down to the end of the reference, so getLastRow() reports a
 *      hugely inflated count — the same trap revisionApprovalCore_ documents.
 *      Row count is taken off ID.NO instead.
 *
 * Trigger:
 * - Time-driven, HOURLY. Salary revisions are rare; 3B runs every few minutes
 *   because payroll locking is time-critical, which this is not.
 *
 * Locking:
 * - This function takes NO lock of its own. It calls syncSalaryMaster_Core_,
 *   which takes the shared module lock (see withEmiLock_ in 0_WebApp.gs).
 *   That lock is NOT reentrant, so taking it here as well would deadlock the
 *   watcher against itself.
 ************************************************/

const SALARY_WATCH_PROP_KEY   = "SALARY_REVISION_HASH_V1";
const SALARY_WATCH_TRIGGER_FN = "watchSalaryRevisionsAndSync";

/* ================================================
 * TRIGGER ENTRY (time-driven) — also the menu action
 * ================================================ */

/**
 * watchSalaryRevisionsAndSync()
 *
 * If Salary Revision History changed since the last run, rebuild SALARY master.
 * Safe to re-run; a no-op when nothing has changed.
 *
 * No trailing underscore: this must be selectable in the Run dropdown and the
 * trigger picker, per this codebase's convention.
 *
 * Returns { changed, message, written } — the menu wrapper shows the message,
 * the trigger ignores it.
 */
function watchSalaryRevisionsAndSync() {
  const ss = SpreadsheetApp.openById(SALARY_ADVANCE_MASTER_SPREADSHEET_ID);

  const newHash = buildSalaryRevisionHash_();
  if (!newHash) {
    return { changed: false, message: "Salary Revision History has no active rows to read.", written: 0 };
  }

  const props   = PropertiesService.getScriptProperties();
  const oldHash = props.getProperty(SALARY_WATCH_PROP_KEY) || "";

  if (newHash === oldHash) {
    return { changed: false, message: "No salary changes since the last check.", written: 0 };
  }

  // Sync FIRST. The hash is stored only after it succeeds, so a failed run is
  // retried on the next tick rather than being silently marked as handled.
  const result = syncSalaryMaster_Core_(ss);

  // DEFENSIVE, AND CURRENTLY UNREACHABLE — kept deliberately, flagged honestly.
  // syncSalaryMaster_Core_ returns success:false in exactly one case (no data
  // rows in REVISION_HISTORY), and that case never gets this far because
  // buildSalaryRevisionHash_ returns "" for it and we bail out above. Every
  // real failure arrives as a THROW, which propagates past here and leaves the
  // hash unadvanced by itself — that is the path the tests actually cover.
  // This exists so a future success:false path added to Core cannot silently
  // advance the hash and mark a failed sync as handled.
  if (!result || result.success !== true) {
    throw new Error(
      "Salary Master refresh failed, hash not advanced: " +
      ((result && result.message) || "unknown error")
    );
  }

  props.setProperty(SALARY_WATCH_PROP_KEY, newHash);

  return {
    changed: true,
    message: "Salary changes detected.\n\n" + result.message,
    written: result.written || 0,
  };
}

/* ================================================
 * MENU WRAPPER
 * ================================================ */

/**
 * checkSalaryRevisionsNow()
 * Menu entry: runs the same check on demand.
 *
 * Distinct from "Refresh Salary Master", which rebuilds unconditionally. This
 * one rebuilds only if Salary Revision History actually changed, and says so
 * either way — useful for answering "has the new salary come through yet?"
 * without rewriting the tab.
 */
function checkSalaryRevisionsNow() {
  const ui   = SpreadsheetApp.getUi();
  const user = Session.getEffectiveUser().getEmail().toLowerCase();

  if (user !== EMI_PMO_USER_ && user !== EMI_ALLOWED_USER_) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  try {
    const r = watchSalaryRevisionsAndSync();
    ui.alert(r.changed ? "Salary Master updated" : "No change", r.message, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert("Error: " + err.message);
  }
}

/* ================================================
 * TRIGGER MANAGEMENT
 * None of these end in "_" — they must be selectable
 * in the Apps Script Run dropdown.
 * ================================================ */

/**
 * installSalaryMasterWatcher()
 * Creates the hourly trigger. Any existing trigger for the same function is
 * removed first, so repeated runs can never stack duplicates — every extra
 * copy would be another full rebuild of SALARY master per hour.
 *
 * The trigger runs as whoever installs it. Install as pmo@.
 */
function installSalaryMasterWatcher() {
  removeSalaryMasterWatcher();

  ScriptApp.newTrigger(SALARY_WATCH_TRIGGER_FN)
    .timeBased()
    .everyHours(1)
    .create();

  // Seed on install so the very first tick does not fire against an empty
  // stored hash and rebuild for no reason.
  seedSalaryMasterHash();
}

/**
 * removeSalaryMasterWatcher()
 * Removes every trigger pointing at the watcher. Safe when none exist.
 */
function removeSalaryMasterWatcher() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === SALARY_WATCH_TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
}

/**
 * seedSalaryMasterHash()
 * Stores the current fingerprint WITHOUT syncing — marks "as of now, we are
 * up to date". Run after a manual Refresh Salary Master so the watcher does
 * not immediately repeat work that was just done by hand.
 */
function seedSalaryMasterHash() {
  const h = buildSalaryRevisionHash_();
  if (!h) return;
  PropertiesService.getScriptProperties().setProperty(SALARY_WATCH_PROP_KEY, h);
}

/* ================================================
 * Helpers
 * ================================================ */

/**
 * buildSalaryRevisionHash_()
 *
 * MD5 (base64) over the ACTIVE rows of the REMOTE Salary Revision History
 * file, columns A:N — exactly the projection SALARY master mirrors.
 *
 * A RENAMED copied column does not produce a different hash — it THROWS, from
 * the req_ lookup below, before any hashing happens. That is deliberate and is
 * the same way syncSalaryMaster_Core_ behaves, since both resolve columns by
 * header name. The stored hash is not advanced, so the watcher keeps failing
 * loudly on every tick until somebody fixes the source header, rather than
 * quietly mirroring the wrong columns. The header row is still included in the
 * payload as belt-and-braces for any column that later becomes optional.
 *
 * Read with getDisplayValues() rather than getValues(): a Date renders to a
 * stable string, whereas a Date object stringifies with a timezone that can
 * differ between executions and would produce a spurious change.
 *
 * Returns "" when there is nothing to hash — the caller treats that as "no
 * data", never as "changed to empty", so an unreachable source can never
 * trigger a rebuild that empties the local mirror.
 */
function buildSalaryRevisionHash_() {
  const srcSS = SpreadsheetApp.openById(SALARY_REV_SRC_SPREADSHEET_ID);
  const srcSh = srcSS.getSheetByName(SALARY_REV_SRC_SHEET_NAME);
  if (!srcSh) throw new Error(`Source sheet not found: ${SALARY_REV_SRC_SHEET_NAME}`);

  const srcMap     = getHeaderMap_(srcSh);
  const idIdx0     = req_(srcMap, "ID.NO");
  const activeIdx0 = req_(srcMap, "ACTIVE_FOR_PAYROLL");
  const copyIdx0   = SALARY_MASTER_COPY_HEADERS.map(h => req_(srcMap, h));

  // Off ID.NO, not getLastRow() — see the AADHAAR NO spill note in the header.
  const lastRow = findLastDataRowByColumn_(srcSh, idIdx0 + 1);
  if (lastRow < 2) return "";

  const disp = srcSh.getRange(1, 1, lastRow, srcSh.getLastColumn()).getDisplayValues();

  // Header row first, so a column rename registers as a change.
  const lines = [copyIdx0.map(c => disp[0][c]).join("␟")];

  for (let r = 1; r < disp.length; r++) {
    if (String(disp[r][idIdx0] || "").trim() === "") continue;
    if (String(disp[r][activeIdx0] || "").trim().toUpperCase() !== "ACTIVE") continue;
    lines.push(copyIdx0.map(c => disp[r][c]).join("␟"));
  }

  if (lines.length < 2) return ""; // header only — no active salaries

  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    lines.join("\n"),
    Utilities.Charset.UTF_8
  );

  return Utilities.base64Encode(raw);
}
