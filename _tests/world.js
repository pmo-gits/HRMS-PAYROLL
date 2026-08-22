/**
 * _tests/world.js — build a seeded EMI_SCHEDULE / Recovered Amount Ledger / Shared EMI Summary
 * and run the REAL `syncSharedEmiPayrollStatusFromRecoveredLedger` against it.
 *
 * Column sets come from salary-advance-master/CLAUDE.md (Config section), which documents the
 * live sheets — not from reading the engine.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { Sheet, Spreadsheet, makeGlobals } = require('./sheets');
const { formatDate, forbidden, REPO_ROOT } = require('./harness');

const GS = 'salary-advance-master/3A_Master_SharedEMILockSync.gs';

// EMI_SCHEDULE columns, 2026-08-17 (module CLAUDE.md)
const EMI_HEADERS = [
  'Month', 'Employee Code', 'Name', 'Department', 'EMI Reference Number', 'EMI Amount',
  'Current Balance', 'Status', 'HR Decision', 'Recover Amount', 'WRITE OFF AMOUNT',
  'WRITE OFF TIME STAMP', 'Settlement Stage', 'Last Working Day', 'Amount Set By',
];

// Recovered Amount Ledger — 13 columns, ending HR Decision | Recovered Amount | Settlement
// Stage | Last Working Day | Close In Months (module CLAUDE.md).
const REC_HEADERS = [
  'Month', 'Employee Code', 'Name', 'Department', 'EMI Reference Number', 'EMI Amount',
  'Current Balance', 'Planned EMI', 'HR Decision', 'Recovered Amount', 'Settlement Stage',
  'Last Working Day', 'Close In Months',
];

// Shared EMI Summary — 9 columns, must not be widened (module CLAUDE.md).
const SHARED_HEADERS = [
  'Month', 'Employee Code', 'Name', 'Department', 'EMI Reference Number', 'EMI Amount',
  'Current Balance', 'Status', 'Payroll Status',
];

function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

/**
 * @param {object} spec
 *   advances: { REF: {advance: number, cancelled?: boolean} }
 *   emiRows:  [{month: Date, emp, name, dept, ref, emiAmt, status, setBy, stage, lwd, recover, woAmt}]
 *   balanceModel: 'recover-only' (default) | 'net-of-writeoff'
 */
function makeWorld(spec) {
  const advances = spec.advances || {};
  const balanceModel = spec.balanceModel || 'recover-only';

  const emi = new Sheet('EMI_SCHEDULE', EMI_HEADERS, {
    computed: {
      'CURRENT BALANCE': (sh, r) => {
        const ref = String(sh._get(r, sh.colOf['EMI REFERENCE NUMBER']) || '').trim();
        if (!ref) return '';
        const a = advances[ref];
        // Current Balance renders "" for a cancelled advance (module CLAUDE.md, Known risks).
        if (!a || a.cancelled) return '';
        let recovered = 0;
        let written = 0;
        const last = sh.getLastRow();
        for (let rr = 2; rr <= last; rr++) {
          if (String(sh._get(rr, sh.colOf['EMI REFERENCE NUMBER']) || '').trim() !== ref) continue;
          recovered += num(sh._get(rr, sh.colOf['RECOVER AMOUNT']));
          written += num(sh._get(rr, sh.colOf['WRITE OFF AMOUNT']));
        }
        const bal = a.advance - recovered - (balanceModel === 'net-of-writeoff' ? written : 0);
        return Math.round(bal * 100) / 100;
      },
    },
  });
  emi.numberFormats[emi.colOf['MONTH']] = 'MMMM_yyyy';
  emi.numberFormats[emi.colOf['LAST WORKING DAY']] = 'M/d/yyyy';

  const rec = new Sheet('Recovered Amount Ledger', REC_HEADERS);
  const shared = new Sheet('Shared EMI Summary', SHARED_HEADERS);

  const C = emi.colOf;
  (spec.emiRows || []).forEach((r, i) => {
    const row = i + 2;
    emi._set(row, C['MONTH'], r.month);
    emi._set(row, C['EMPLOYEE CODE'], r.emp);
    emi._set(row, C['NAME'], r.name || '');
    emi._set(row, C['DEPARTMENT'], r.dept || '');
    emi._set(row, C['EMI REFERENCE NUMBER'], r.ref);
    emi._set(row, C['EMI AMOUNT'], r.emiAmt === undefined ? '' : r.emiAmt);
    emi._set(row, C['STATUS'], r.status === undefined ? 'ACTIVE' : r.status);
    emi._set(row, C['HR DECISION'], r.hr || '');
    emi._set(row, C['RECOVER AMOUNT'], r.recover === undefined ? '' : r.recover);
    emi._set(row, C['WRITE OFF AMOUNT'], r.woAmt === undefined ? '' : r.woAmt);
    emi._set(row, C['SETTLEMENT STAGE'], r.stage || '');
    emi._set(row, C['LAST WORKING DAY'], r.lwd || '');
    emi._set(row, C['AMOUNT SET BY'], r.setBy || '');
  });

  const ss = new Spreadsheet({
    EMI_SCHEDULE: emi,
    'Recovered Amount Ledger': rec,
    'Shared EMI Summary': shared,
  });

  const props = new Map();
  // SA_3A_PATH lets the mutation check (_tests/mutate.js) point the world at a deliberately
  // broken copy of the engine, to prove the assertions actually fail when the behaviour is wrong.
  const src = fs.readFileSync(process.env.SA_3A_PATH || path.join(REPO_ROOT, GS), 'utf8');

  const world = {
    emi, rec, shared, props, advances,

    /** append a Recovered Amount Ledger row (what a locked payroll pushes) */
    ledger(r) {
      const L = rec.colOf;
      const row = rec.getLastRow() + 1;
      rec._set(row, L['MONTH'], r.month);
      rec._set(row, L['EMPLOYEE CODE'], r.emp);
      rec._set(row, L['NAME'], r.name || '');
      rec._set(row, L['EMI REFERENCE NUMBER'], r.ref);
      rec._set(row, L['HR DECISION'], r.hr === undefined ? '' : r.hr);
      rec._set(row, L['RECOVERED AMOUNT'], r.recovered === undefined ? '' : r.recovered);
      rec._set(row, L['SETTLEMENT STAGE'], r.stage || '');
      rec._set(row, L['LAST WORKING DAY'], r.lwd || '');
      rec._set(row, L['CLOSE IN MONTHS'], r.closeIn === undefined ? '' : r.closeIn);
      return world;
    },

    /** run the real engine, in a fresh script execution, against the persistent sheets */
    sync() {
      const sandbox = {
        Utilities: { formatDate },
        Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
        DriveApp: forbidden('DriveApp'),
        UrlFetchApp: forbidden('UrlFetchApp'),
        LockService: forbidden('LockService'),
        console, Date, Math, JSON, Map, Set, Array, Object, String, Number, Boolean,
        RegExp, Error, isNaN, parseFloat, parseInt,
      };
      Object.assign(sandbox, makeGlobals(ss, props));
      sandbox.globalThis = sandbox;
      const ctx = vm.createContext(sandbox);
      new vm.Script(src, { filename: GS }).runInContext(ctx);
      sandbox.syncSharedEmiPayrollStatusFromRecoveredLedger();
      return world;
    },

    /** EMI_SCHEDULE rows for one reference, month-sorted, as plain comparable objects */
    rows(ref) {
      return emi.dump()
        .filter(r => String(r['EMI Reference Number'] || '').trim() === ref)
        .map(r => ({
          month: monthLabel(r['Month']),
          emiAmt: String(r['EMI Amount']),
          status: String(r['Status']),
          recover: String(r['Recover Amount']),
          stage: String(r['Settlement Stage']),
          woAmt: String(r['WRITE OFF AMOUNT']),
          setBy: String(r['Amount Set By']),
          bal: r['Current Balance'],
          lwd: monthLabel(r['Last Working Day']),
        }))
        .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    },

    /** everything that could differ between two runs */
    snapshot() {
      return JSON.stringify({
        grid: emi.dump().map(r => EMI_HEADERS.map(h => stable(r[h]))),
        props: [...props.entries()].sort(),
        maxRows: emi.getMaxRows(),
      });
    },
  };

  return world;
}

function stable(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return `D:${v.toISOString()}`;
  return v === '' || v == null ? '' : String(v);
}

function monthLabel(v) {
  if (Object.prototype.toString.call(v) !== '[object Date]') return v === '' || v == null ? '' : String(v);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}

function D(y, m1, d) { return new Date(y, m1 - 1, d || 1); }

module.exports = { makeWorld, D, EMI_HEADERS, monthLabel };
