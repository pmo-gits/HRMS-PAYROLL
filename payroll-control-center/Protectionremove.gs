function removeAllProtections() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var protections = ss.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  
  var count = 0;
  for (var i = 0; i < protections.length; i++) {
    protections[i].remove();
    count++;
  }
  
  // Also remove sheet-level protections if any
  var sheetProtections = ss.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  for (var j = 0; j < sheetProtections.length; j++) {
    sheetProtections[j].remove();
    count++;
  }
  
  SpreadsheetApp.getUi().alert('Done! Removed ' + count + ' protection(s).');
}
