/***********************
 * 01_HashWatcher.gs
 * - Computes stable hash from Employee Master using HEADER NAMES
 * - Hash considers ONLY ACTIVE + STAFF employees
 * - Stores hash in Document Properties (backend; no sheets created)
 * - If hash changes => calls runLeaveMasterSyncSilent_()
 ***********************/

const EMPLOYEE_MASTER_SPREADSHEET_ID = "1yqQ-edwQzZd0pAlaXCAAZt88MbsHfCf4hCcxti4ojCw";
const EMPLOYEE_MASTER_GID = 1874110664; // Employee Master tab gid

// Hash watcher properties keys
const PROP_EMP_HASH = "EMP_MASTER_HASH_ACTIVE_STAFF";
const PROP_LAST_SYNC = "EMP_MASTER_LAST_SYNC_ACTIVE_STAFF";

// Headers used to build hash (Employee Master)
const EM_HASH_HEADERS = {
  ID: "ID.NO",
  NAME: "NAME",
  CATEGORY: "CATEGORY",
  DOJ: "D.O.J",
  STATUS: "STATUS",
};

/**
 * Time-trigger entry point:
 * - Runs silently (backend)
 * - Calls silent sync when ACTIVE+STAFF hash changed
 */
function watchEmployeeMasterHashAndSync() {
  const props = PropertiesService.getDocumentProperties();

  const oldHash = String(props.getProperty(PROP_EMP_HASH) || "").trim();
  const newHash = computeEmployeeMasterHashByHeaders_();

  if (!newHash) return;

  // First time: store hash + run sync once
  if (!oldHash) {
    props.setProperty(PROP_EMP_HASH, newHash);
    props.setProperty(PROP_LAST_SYNC, new Date().toISOString());
    runLeaveMasterSyncSilent_();
    return;
  }

  if (newHash !== oldHash) {
    runLeaveMasterSyncSilent_();
    props.setProperty(PROP_EMP_HASH, newHash);
    props.setProperty(PROP_LAST_SYNC, new Date().toISOString());
  }
}

/**
 * Computes SHA-256 hash from Employee Master rows using header lookup.
 * Includes ONLY ACTIVE + STAFF records.
 * Sorting by ID makes hash stable even if row order changes.
 */
function computeEmployeeMasterHashByHeaders_() {
  const emSS = SpreadsheetApp.openById(EMPLOYEE_MASTER_SPREADSHEET_ID);
  const emSheet = getSheetByGid_(emSS, EMPLOYEE_MASTER_GID);
  if (!emSheet) throw new Error("Employee Master sheet not found by given GID.");

  const sheetName = emSheet.getName();

  // Pull a wide range; script finds columns by headers
  // If your sheet goes beyond Z, change to A1:AZ or A1:ZZ.
  const resp = Sheets.Spreadsheets.Values.get(
    EMPLOYEE_MASTER_SPREADSHEET_ID,
    `${sheetName}!A1:Z`
  );

  const rows = resp.values || [];
  if (rows.length < 2) return "";

  const headerRow = (rows[0] || []).map(h => normalize_(h));
  const idx = (h) => headerRow.indexOf(normalize_(h));

  const idIdx = idx(EM_HASH_HEADERS.ID);
  const nameIdx = idx(EM_HASH_HEADERS.NAME);
  const catIdx = idx(EM_HASH_HEADERS.CATEGORY);
  const dojIdx = idx(EM_HASH_HEADERS.DOJ);
  const statusIdx = idx(EM_HASH_HEADERS.STATUS);

  if ([idIdx, nameIdx, catIdx, dojIdx, statusIdx].some(i => i < 0)) {
    throw new Error(
      `Employee Master missing required headers for hash: ${Object.values(EM_HASH_HEADERS).join(", ")}`
    );
  }

  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];

    const id = normalize_(row[idIdx]);
    if (!id) continue;

    const status = normalize_(row[statusIdx]).toUpperCase();
    const category = normalize_(row[catIdx]).toUpperCase();

    // ✅ HASH ONLY ACTIVE STAFF
    if (status !== "ACTIVE") continue;
    if (category !== "STAFF") continue;

    const name = normalize_(row[nameIdx]);
    const doj = normalizeDateForHash_(row[dojIdx]);

    // Keep stable canonical values in the fingerprint
    data.push([id, name, "STAFF", doj, "ACTIVE"].join("|"));
  }

  data.sort();
  const joined = data.join("\n");

  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    joined,
    Utilities.Charset.UTF_8
  );

  return digest.map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}

/** Utilities */
function normalize_(v) {
  return String(v || "").trim().replace(/\s+/g, " ");
}

function normalizeDateForHash_(v) {
  if (!v) return "";
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return normalize_(v);
}

function getSheetByGid_(ss, gid) {
  const sheets = ss.getSheets();
  for (const sh of sheets) {
    if (sh.getSheetId() === gid) return sh;
  }
  return null;
}
