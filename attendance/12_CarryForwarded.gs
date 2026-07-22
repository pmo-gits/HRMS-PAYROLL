/************************************************
 * 12_CarryForwarded.gs
 * Carry Forwarded sheet automation (CLEAR ONLY)
 *
 * New sheet structure (no roster pull from Employee Master):
 * Employee Code | Name | Department | Designation |
 * Carry Forwarded Days | Carry Forwarded From Month [MM/DD/YY] |
 * Carry forwarded Type | Remarks
 *
 * On Refresh Month:
 * - Keep header row intact
 * - Clear selected columns by HEADER NAME from row 2..maxRows (values only)
 *
 * Sync behavior: NOT REQUIRED (no functions for sync)
 ************************************************/

function refreshCarryForwardedSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CARRY_FORWARDED_SHEET_NAME);

  if (!sh) {
    throw new Error(`Sheet "${CARRY_FORWARDED_SHEET_NAME}" not found. Please create it in the file.`);
  }

  const startRow = 2;
  const endRow = sh.getMaxRows();
  const numRows = Math.max(endRow - startRow + 1, 0);
  if (numRows <= 0) return;

  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(h => String(h || "").trim().toUpperCase());

  const targets = [
    "EMPLOYEE CODE",
    "CARRY FORWARDED DAYS",
    "CARRY FORWARDED FROM MONTH [MM/DD/YY]",
    "CARRY FORWARDED TYPE",
    "REMARKS"
  ];

  targets.forEach(t => {
    const idx = headers.indexOf(t);
    if (idx === -1) return; // skip if header not found
    sh.getRange(startRow, idx + 1, numRows, 1).clearContent();
  });
}
