/************************************************
 * 05_Lock.gs
 ************************************************/
function isAttendanceLocked_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sh) return false;
  const val = String(sh.getRange(2, LOCK_COL).getDisplayValue() || "").trim().toUpperCase();
  return val.startsWith("LOCKED");
}

function autoUnlockAttendance_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sh) return;

  const protections = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  protections.forEach(p => {
    const desc = p.getDescription() || "";
    if (desc.startsWith(LOCK_PROTECTION_PREFIX)) {
      try { p.remove(); } catch (e) {}
    }
  });

  const maxRows = sh.getMaxRows();
  sh.getRange(1, LOCK_COL, maxRows, 1).clearContent();
}

function setAttendanceLocked_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sh) throw new Error(`Sheet "${ATTENDANCE_SHEET_NAME}" not found.`);

  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
  sh.getRange(1, LOCK_COL).setValue("LOCKED STATUS");

  const lastRow = sh.getLastRow();
  let lastIdRow = 1;
  if (lastRow >= 2) {
    const ids = sh.getRange(2, 2, lastRow - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0] || "").trim() !== "") {
        lastIdRow = i + 2;
        break;
      }
    }
  }

  const lockText = `LOCKED - ${now}`;
  const numRows = Math.max(lastIdRow - 1, 1);
  const values = Array.from({ length: numRows }, () => [lockText]);
  sh.getRange(2, LOCK_COL, numRows, 1).setValues(values);

  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => {
    if ((p.getDescription() || "").startsWith(LOCK_PROTECTION_PREFIX)) {
      try { p.remove(); } catch (e) {}
    }
  });

  const range = sh.getRange(1, LOCK_COL, Math.max(lastIdRow, 2), 1);
  const protection = range.protect();
  protection.setDescription(`${LOCK_PROTECTION_PREFIX}${ss.getId()}`);
  protection.setWarningOnly(false);
  try {
    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
  } catch (e) {}
}
