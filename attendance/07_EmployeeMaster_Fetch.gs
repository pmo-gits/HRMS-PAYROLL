/************************************************
 * 07_EmployeeMaster_Fetch.gs
 * Sheets API - Advanced Service
 ************************************************/
function fetchActiveEmployees_() {
  const cache = CacheService.getScriptCache();
  const titleCacheKey = `EMP_SHEET_TITLE_${EMP_MASTER_SPREADSHEET_ID}_${EMP_MASTER_SHEET_ID}`;
  let sheetTitle = cache.get(titleCacheKey);

  if (!sheetTitle) {
    const meta = Sheets.Spreadsheets.get(EMP_MASTER_SPREADSHEET_ID, {
      fields: "sheets(properties(sheetId,title))"
    });
    const found = (meta.sheets || []).find(s => s.properties && s.properties.sheetId === EMP_MASTER_SHEET_ID);
    if (!found) throw new Error("Employee Master sheet not found by sheetId. Check EMP_MASTER_SHEET_ID.");
    sheetTitle = found.properties.title;
    cache.put(titleCacheKey, sheetTitle, 21600);
  }

  const range = `${sheetTitle}!A1:AR`;
  const res = Sheets.Spreadsheets.Values.get(EMP_MASTER_SPREADSHEET_ID, range);
  const values = res.values || [];
  if (values.length < 2) return [];

  const headers = (values[0] || []).map(h => String(h).trim().toUpperCase());
  const idx0 = (name) => headers.indexOf(name);

  const iSno = idx0("S.NO");
  const iId = idx0("ID.NO");
  const iName = idx0("NAME");
  const iGender = idx0("GENDER");
  const iCat = idx0("CATEGORY");
  const iDept = idx0("DEPARTMENT");
  const iDesig = idx0("DESIGNATION");
  const iDoj = idx0("D.O.J");
  const iStatus = idx0("STATUS");

  const required = [iSno, iId, iName, iGender, iCat, iDept, iDesig, iDoj, iStatus];
  if (required.some(i => i === -1)) {
    throw new Error("Employee Master headers don't match expected names (S.NO, ID.NO, NAME, GENDER, CATEGORY, DEPARTMENT, DESIGNATION, D.O.J, STATUS).");
  }

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const status = String(row[iStatus] || "").trim().toUpperCase();
    if (status !== "ACTIVE") continue;

    out.push([
      row[iSno] || "",
      row[iId] || "",
      row[iName] || "",
      row[iGender] || "",
      row[iCat] || "",
      row[iDept] || "",
      row[iDesig] || "",
      row[iDoj] || ""
    ]);
  }
  return out;
}
