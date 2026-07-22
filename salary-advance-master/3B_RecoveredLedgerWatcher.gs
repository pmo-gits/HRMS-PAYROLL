/************************************************
 * 3B_RecoveredLedgerWatcher.gs  (Salary Advance Master)
 *
 * Purpose:
 * - Watch "Recovered Amount Ledger" for changes using a hash fingerprint
 * - If changed, run: syncSharedEmiPayrollStatusFromRecoveredLedger()
 *
 * Trigger:
 * - Time-driven (recommended every 5 minutes / 10 minutes)
 *
 * Design:
 * - Safe re-run
 * - Uses PropertiesService to store last hash
 ************************************************/



var WATCH_RECOVERED_LEDGER_SHEET = "Recovered Amount Ledger";
var WATCH_PROP_KEY = "RECOVERED_LEDGER_HASH_V1";

/**
 * ✅ TRIGGER ENTRY (time-driven)
 * If Recovered Amount Ledger changed since last run, call the lock sync.
 */
function watchRecoveredLedgerAndSyncLocks() {
  const ss = SpreadsheetApp.openById(SALARY_ADVANCE_MASTER_SPREADSHEET_ID);
  const sh = ss.getSheetByName(WATCH_RECOVERED_LEDGER_SHEET);
  if (!sh) throw new Error(`Sheet not found: ${WATCH_RECOVERED_LEDGER_SHEET}`);

  const newHash = buildRecoveredLedgerHash_(sh);
  if (!newHash) return; // nothing to hash (empty sheet)

  const props = PropertiesService.getScriptProperties();
  const oldHash = props.getProperty(WATCH_PROP_KEY) || "";

  if (newHash === oldHash) {
    // No change -> do nothing
    return;
  }

  // ✅ Run sync first
  syncSharedEmiPayrollStatusFromRecoveredLedger();

  // ✅ Save new hash only after successful sync
  props.setProperty(WATCH_PROP_KEY, newHash);
}

/**
 * Optional: Run once manually to initialize the stored hash (so first trigger doesn't fire).
 */
function seedRecoveredLedgerHash() {
  const ss = SpreadsheetApp.openById(SALARY_ADVANCE_MASTER_SPREADSHEET_ID);
  const sh = ss.getSheetByName(WATCH_RECOVERED_LEDGER_SHEET);
  if (!sh) throw new Error(`Sheet not found: ${WATCH_RECOVERED_LEDGER_SHEET}`);

  const h = buildRecoveredLedgerHash_(sh);
  if (!h) return;

  PropertiesService.getScriptProperties().setProperty(WATCH_PROP_KEY, h);
}

/* =========================
 * Helpers
 * ========================= */

/**
 * Builds a stable hash of the recovered ledger.
 * Strategy:
 * - Use display values
 * - Hash only the USED RANGE (all rows/cols with data)
 * - Includes header row to detect column changes too
 */
function buildRecoveredLedgerHash_(sh) {
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return "";

  const values = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();

  // Join with separators that rarely appear in cells
  const payload = values.map(r => r.join("\u241F")).join("\n");

  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    payload,
    Utilities.Charset.UTF_8
  );

  return Utilities.base64Encode(raw);
}
