/************************************************
 * 04_Leave_GetBalances.gs
 * FINALIZED: if snapshot missing => pull FULL LEAVE_MASTER rows
 ************************************************/
function getLeaveBalances_Button() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const user = Session.getEffectiveUser().getEmail();
  const PMO = "pmo@butlerleather.com";
  const ALLOWED = "hrassist@butlerleather.com";

  // User gate
  if (user !== PMO && user !== ALLOWED) {
    ui.alert("Access Denied", "You are not authorised to run this action.", ui.ButtonSet.OK);
    return;
  }

  if (isAttendanceLocked_()) {
    ui.alert("This attendance file is LOCKED.\nNo changes allowed.");
    return;
  }

  const idsInAttendance = getAttendanceEmployeeIds_();
  if (idsInAttendance.size === 0) {
    ui.alert("No employee IDs found in Attendance entry sheet.");
    return;
  }

  const confirm = ui.alert(
    "Lock confirmation",
    "Shall I lock the file and fetch leave balances?\n\n(This action is ONE TIME only.)",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) {
    ui.alert("Cancelled. No changes made.");
    return;
  }

  // Dispatch
  if (user === PMO) {
    const attendanceFileName = ss.getName().trim();
    const rows = computeLeaveBalancesRows_(attendanceFileName);
    if (rows.length === 0) {
      ui.alert("No leave balances found.");
      return;
    }
    writeLeaveBalancesToAttendance_(rows);
    setAttendanceLocked_();
    protectLeaveBalancesTab_();
    ui.alert(`LOCKED ✅\nLeave balances updated successfully.\n\nRows: ${rows.length}`);
  } else {
    // tally -> Web App
    try {
      const payload = { action: "getLeaveBalances", caller: user, spreadsheetId: ss.getId() };
      const response = UrlFetchApp.fetch(ATTENDANCE_WEBAPP_URL, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const result = JSON.parse(response.getContentText());
      if (result.status === "success") {
        ui.alert(result.message || "Leave balances updated successfully.");
      } else {
        ui.alert("Error: " + (result.message || "Unknown error from Web App."));
      }
    } catch (e) {
      ui.alert("Web App call failed: " + e.message);
    }
  }
}

function computeLeaveBalancesRows_(attendanceFileName) {
  const cachedAllForMonth = getSharedSummaryForAttendance_(attendanceFileName);
  if (cachedAllForMonth.length > 0) {
    return cachedAllForMonth;
  }

  const allRows = getAllBalancesFromLeaveMaster_();
  if (allRows.length > 0) {
    appendToSharedSummary_(attendanceFileName, allRows);
  }
  return allRows;
}

function getAttendanceEmployeeIds_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ATTENDANCE_SHEET_NAME);
  const out = new Set();
  if (!sh) return out;

  const last = sh.getLastRow();
  if (last < 2) return out;

  const vals = sh.getRange(2, 2, last - 1, 1).getValues();
  vals.forEach(r => {
    const id = String(r[0] || "").trim();
    if (id) out.add(id);
  });
  return out;
}

function writeLeaveBalancesToAttendance_(rows) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LEAVE_BALANCES_SHEET_NAME);
  if (!sh) throw new Error(`Sheet "${LEAVE_BALANCES_SHEET_NAME}" not found.`);

  sh.clearContents();
  sh.getRange(1, 1, 1, 7).setValues([[
    "ID.NO","NAME","CATEGORY","D.O.J","EL BALANCE","CL BALANCE","SL BALANCE"
  ]]);
  sh.getRange(2, 1, rows.length, 7).setValues(rows);
}

function protectLeaveBalancesTab_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(LEAVE_BALANCES_SHEET_NAME);
  if (!sh) throw new Error(`Sheet "${LEAVE_BALANCES_SHEET_NAME}" not found.`);

  // Remove any existing protections on this sheet
  const existing = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  existing.forEach(p => p.remove());

  // Apply new protection — pmo only
  const protection = sh.protect();
  protection.setDescription("Leave Balances — locked after Get Leave Balances");
  protection.removeEditors(protection.getEditors());
  protection.addEditor("pmo@butlerleather.com");
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}
