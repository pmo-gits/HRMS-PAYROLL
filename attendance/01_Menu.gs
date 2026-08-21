/************************************************
 * 01_Menu.gs
 ************************************************/
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu("Attendance")
    .addItem("Refresh the attendance month - full sheet", "refreshAttendanceMonth_FullSheet")
    .addSeparator()
    .addItem("Sync New Employees - add new rows", "syncNewEmployeesAppendOnly")
    .addSeparator()
    .addItem("Remove Inactive Employee", "removeInactiveEmployee")
    .addToUi();

  ui.createMenu("Leave")
    .addItem("Get Leave Balances", "getLeaveBalances_Button")
    .addSeparator()
    .addItem("Calculate late penalty", "recalcLateEntryLeavePenaltyCount")
    .addToUi();

  // ✅ Salary Advance
  ui.createMenu("Salary Advance")
    .addItem("Get Salary Advance EMI", "getSalaryAdvanceEMI_Button")
    .addSeparator()
    .addItem("Refresh Salary Advance EMI", "refreshSalaryAdvanceEMI_Button")
    .addToUi();

  // ✅ Help — see 14_FixAuth.gs
  ui.createMenu("Help")
    .addItem("Fix Permissions (Re-authorize)", "resetMyAttendanceAuthorization")
    .addToUi();
}
