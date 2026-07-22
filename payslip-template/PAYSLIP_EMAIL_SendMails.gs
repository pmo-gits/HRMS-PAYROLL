/*******************************************************
 * PAYSLIP EMAIL — SEND MAILS (core logic)
 *
 * Reads the "Staff Email Master" tab in THIS Payslip file, finds
 * every Staff row that:
 *   - has a non-blank "PDF File ID" (PDF already generated), AND
 *   - has NOT already been marked "Email Sent On" (not yet sent),
 *     AND
 *   - has a non-blank "Email" address.
 *
 * GUARD (new): before doing anything else, this checks
 * _GENERATED_LOG!F1 in THIS Payslip file for a timestamp, written
 * by getStaffEmailsServer_() in PAYSLIP_EMAIL_GetEmails.gs. If
 * that cell is blank, it means "Get Staff Emails" has never been
 * run for this month's file, and the whole send is blocked with
 * an explanatory message — nothing is sent.
 *
 * Attaches that employee's exact PDF (fetched directly by Drive
 * file ID — no folder search, no filename matching) and emails
 * it, one employee at a time: fetch -> send -> mark "Email Sent
 * On" -> next employee. A mid-run failure only leaves the
 * unmarked ones pending for the next click — nothing to
 * reconcile.
 *
 * Employees with a blank Email are skipped and reported (now with
 * the actual employee code/name list, not just a count) — they
 * simply need an address before their turn comes. Employees whose
 * PDF isn't generated yet are likewise skipped and reported.
 *
 * Every sent email is CC'd to zafar@butlerleather.com.
 *******************************************************/

const PES_TAB_NAME = 'Staff Email Master';

const PES_HEADERS = Object.freeze({
  EMP_CODE: 'Employee Code',
  NAME: 'Name',
  EMAIL: 'Email',
  PDF_FILE_ID: 'PDF File ID',
  EMAIL_SENT_ON: 'Email Sent On',
});

const PES_COMPANY_NAME = 'Butler Leather Goods Factory India Pvt Ltd';
const PES_FILE_PREFIX = 'Payslip'; // matches PSG.FILE_PREFIX in PAYROLL_GEN_10 — same naming convention
const PES_CC_EMAIL = 'zafar@butlerleather.com';

/* =========================================================
   CORE SERVER FUNCTION (runs as owner always)
========================================================= */

function sendStaffPayslipEmailsServer_(payload) {
  const spreadsheetId = String(payload.spreadsheetId || '').trim();

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { success: false, message: 'Another email send is already running. Please wait and try again.' };
  }

  try {
    const ss = SpreadsheetApp.openById(spreadsheetId);

    // ---- GUARD: Get Staff Emails must have been run for this month ----
    const logSh = ss.getSheetByName(GSE_LOG_TAB_NAME);
    if (!logSh) {
      return { success: false, message: `Missing tab: ${GSE_LOG_TAB_NAME}. Cannot verify Get Staff Emails has run.` };
    }
    const stamp = String(logSh.getRange(GSE_LOG_STAMP_CELL).getDisplayValue() || '').trim();
    if (!stamp) {
      return {
        success: false,
        message: 'Get Staff Emails has not been run for this month. Please run "Get Staff Emails" first, then try sending again.',
      };
    }

    const sh = ss.getSheetByName(PES_TAB_NAME);
    if (!sh) throw new Error(`Missing tab: ${PES_TAB_NAME}`);

    const monthLabel = pesParseMonthLabel_(ss.getName());

    const lastCol = sh.getLastColumn();
    const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    const idx = pesBuildHeaderIndex_(headers);

    const cCode = pesRequireHeader_(idx, PES_HEADERS.EMP_CODE);
    const cName = pesRequireHeader_(idx, PES_HEADERS.NAME);
    const cEmail = pesRequireHeader_(idx, PES_HEADERS.EMAIL);
    const cFileId = pesRequireHeader_(idx, PES_HEADERS.PDF_FILE_ID);
    const cSentOn = pesRequireHeader_(idx, PES_HEADERS.EMAIL_SENT_ON);

    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      return { success: true, message: 'Staff Email Master has no rows yet — nothing to send.' };
    }

    // getDisplayValues() on the "PDF File ID" HYPERLINK formula cell
    // (set by psgMarkStaffPdfFileId_ in PAYROLL_GEN_10) returns the
    // rendered link text, which is the file ID itself — same convention
    // used for PAYSLIP_FILE_ID / PAYSLIP_FOLDER_ID elsewhere.
    const data = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();

    let sentCount = 0;
    let skippedNoEmail = 0;
    let skippedNoPdf = 0;
    let alreadySent = 0;
    const errors = [];
    const missingEmailList = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const sheetRow = i + 2;

      const empCode = String(row[cCode] || '').trim();
      if (!empCode) continue;

      const sentOn = String(row[cSentOn] || '').trim();
      if (sentOn) { alreadySent++; continue; }

      const fileId = String(row[cFileId] || '').trim();
      if (!fileId) { skippedNoPdf++; continue; }

      const name = String(row[cName] || '').trim();

      const email = String(row[cEmail] || '').trim();
      if (!email) {
        skippedNoEmail++;
        missingEmailList.push(`${empCode} (${name || 'no name'})`);
        continue;
      }

      try {
        const file = DriveApp.getFileById(fileId);
        const blob = file.getBlob();

        pesSendOneEmail_(email, name, monthLabel, blob);

        // Mark THIS row done immediately — the only completion marker.
        const nowText = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
        sh.getRange(sheetRow, cSentOn + 1).setValue(nowText);

        sentCount++;
      } catch (err) {
        // One employee's failure (e.g. bad file ID, invalid email) does
        // not stop the run — collect it and continue to the next.
        errors.push(`${empCode} (${name || 'no name'}): ${err && err.message ? err.message : err}`);
      }
    }

    const messageParts = [
      `Staff payslip emails processed for ${monthLabel}.`,
      '',
      `Sent: ${sentCount}`,
      `Already sent (skipped): ${alreadySent}`,
      `Skipped — PDF not generated yet: ${skippedNoPdf}`,
      `Skipped — no Email address: ${skippedNoEmail}`,
    ];
    if (missingEmailList.length) {
      messageParts.push('', `Missing Email (${missingEmailList.length}):`, ...missingEmailList);
    }
    if (errors.length) {
      messageParts.push('', `Errors (${errors.length}):`, ...errors);
    }

    return { success: true, message: messageParts.join('\n') };

  } catch (err) {
    return { success: false, message: `Error: ${err && err.message ? err.message : err}` };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* =========================================================
   EMAIL SEND
========================================================= */

function pesSendOneEmail_(toEmail, name, monthLabel, pdfBlob) {
  const displayName = name || 'Employee';
  const subject = `Payslip - ${displayName} - ${monthLabel}`;

  const htmlBody =
    `<p>Dear ${pesEscapeHtml_(displayName)},</p>` +
    `<p>Please find attached your payslip for <b>${pesEscapeHtml_(monthLabel)}</b>.</p>` +
    `<p>Regards,<br>${pesEscapeHtml_(PES_COMPANY_NAME)}</p>`;

  const plainBody =
    `Dear ${displayName},\n\n` +
    `Please find attached your payslip for ${monthLabel}.\n\n` +
    `Regards,\n${PES_COMPANY_NAME}`;

  MailApp.sendEmail({
    to: toEmail,
    cc: PES_CC_EMAIL,
    subject: subject,
    body: plainBody,
    htmlBody: htmlBody,
    attachments: [pdfBlob],
    name: PES_COMPANY_NAME,
  });
}

/* =========================================================
   SMALL HELPERS (pes-prefixed — self-contained in this project;
   this is a SEPARATE Apps Script project from PAYROLL_GEN_10, so
   there is no shared scope and no naming collision risk with
   psg-prefixed helpers there).
========================================================= */

function pesNorm_(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function pesBuildHeaderIndex_(headers) {
  const idx = {};
  headers.forEach((h, i) => {
    const k = pesNorm_(h);
    if (k && idx[k] === undefined) idx[k] = i;
  });
  return idx;
}

function pesRequireHeader_(idx, headerName) {
  const k = pesNorm_(headerName);
  if (idx[k] === undefined) throw new Error(`Missing required header "${headerName}" in ${PES_TAB_NAME}.`);
  return idx[k];
}

function pesEscapeHtml_(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Parses "Payslip_JUNE_2026" -> "JUNE_2026" (matches PSG.FILE_PREFIX
// naming convention from PAYROLL_GEN_10). Falls back to the raw file
// name if the prefix doesn't match, so the email/subject still works.
function pesParseMonthLabel_(fileName) {
  const prefix = `${PES_FILE_PREFIX}_`;
  if (fileName.indexOf(prefix) === 0) {
    return fileName.substring(prefix.length);
  }
  return fileName;
}
