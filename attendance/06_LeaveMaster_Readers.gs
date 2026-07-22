/************************************************
 * 06_LeaveMaster_Readers.gs
 ************************************************/
function getSharedSummaryForAttendance_(attendanceName) {
  const title = getSheetTitleByIdCached_(LEAVE_MASTER_SPREADSHEET_ID, SHARED_SUMMARY_SHEET_ID);
  const res = Sheets.Spreadsheets.Values.get(LEAVE_MASTER_SPREADSHEET_ID, `${title}!A1:H`).values || [];
  if (res.length < 2) return [];

  return res.slice(1)
    .filter(r => String(r[0] || "").trim() === attendanceName)
    .map(r => [r[1], r[2], r[3], r[4], r[5], r[6], r[7]]);
}

function getAllBalancesFromLeaveMaster_() {
  const title = getSheetTitleByIdCached_(LEAVE_MASTER_SPREADSHEET_ID, LEAVE_MASTER_SHEET_ID);
  const res = Sheets.Spreadsheets.Values.get(LEAVE_MASTER_SPREADSHEET_ID, `${title}!A1:N`).values || [];
  if (res.length < 2) return [];

  const headers = (res[0] || []).map(v => String(v || "").trim().toUpperCase());
  const idx = (n) => headers.indexOf(n);

  const iId = idx("ID.NO");
  const iName = idx("NAME");
  const iCat = idx("CATEGORY");
  const iDoj = idx("D.O.J");
  const iEl = idx("EL BALANCE");
  const iCl = idx("CL BALANCE");
  const iSl = idx("SL BALANCE");

  const required = [iId, iName, iCat, iDoj, iEl, iCl, iSl];
  if (required.some(i => i === -1)) {
    throw new Error("LEAVE_MASTER headers not found. Expected: ID.NO, NAME, CATEGORY, D.O.J, EL BALANCE, CL BALANCE, SL BALANCE");
  }

  return res.slice(1)
    .filter(r => String(r[iId] || "").trim() !== "")
    .map(r => [r[iId], r[iName], r[iCat], r[iDoj], r[iEl], r[iCl], r[iSl]]);
}

function appendToSharedSummary_(attendanceName, rows) {
  const title = getSheetTitleByIdCached_(LEAVE_MASTER_SPREADSHEET_ID, SHARED_SUMMARY_SHEET_ID);
  const colA = Sheets.Spreadsheets.Values.get(LEAVE_MASTER_SPREADSHEET_ID, `${title}!A:A`).values || [];
  const startRow = Math.max(colA.length + 1, 2);

  const data = rows.map(r => [attendanceName, ...r]);

  Sheets.Spreadsheets.Values.update(
    { values: data },
    LEAVE_MASTER_SPREADSHEET_ID,
    `${title}!A${startRow}:H${startRow + data.length - 1}`,
    { valueInputOption: "RAW" }
  );
}
