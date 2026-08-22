/**
 * _tests/harness.js — load a real Apps Script .gs file into Node.
 *
 * The .gs files in this repo are plain V8 JavaScript; the only thing stopping Node from
 * evaluating them is the Apps Script global object graph. This module supplies just enough
 * of that graph for a file's TOP-LEVEL declarations to evaluate, and deliberately supplies
 * NOTHING usable for the Sheets I/O surface: SpreadsheetApp, PropertiesService, DriveApp,
 * UrlFetchApp and LockService are booby-trapped Proxies that throw on ANY property access.
 *
 * That is the point. A test that accidentally reaches into Sheets must fail loudly rather
 * than quietly pass against a hand-written fake that agrees with the implementation.
 *
 * Usage:
 *   const { loadGs } = require('./harness');
 *   const sb = loadGs('salary-advance-master/3A_Master_SharedEMILockSync.gs');
 *   sb.numOrZero_('₹14,000');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = MONTHS_LONG.map(m => m.slice(0, 3));

/**
 * Split a Date into calendar parts as seen from `tz`. Uses Intl so the emulation matches
 * what Apps Script actually does (format in the SCRIPT's timezone, not the machine's).
 */
function partsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  // Intl can emit hour "24" for midnight in some ICU versions.
  if (out.hour === '24') out.hour = '00';
  return {
    year: Number(out.year),
    month: Number(out.month),   // 1-based
    day: Number(out.day),
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Utilities.formatDate — ONLY the three patterns this codebase actually uses.
 * Anything else throws, so an unnoticed new pattern surfaces as a test failure rather
 * than as a silently wrong string.
 */
function formatDate(date, tz, pattern) {
  if (Object.prototype.toString.call(date) !== '[object Date]' || isNaN(date.getTime())) {
    throw new Error('Utilities.formatDate: first argument must be a valid Date');
  }
  const p = partsInTz(date, tz);
  switch (pattern) {
    case 'MMMM_yyyy':
      return `${MONTHS_LONG[p.month - 1]}_${p.year}`;
    case 'yyyy-MM-dd HH:mm':
      return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${p.hour}:${p.minute}`;
    case 'dd-MMM-yyyy':
      return `${pad2(p.day)}-${MONTHS_SHORT[p.month - 1]}-${p.year}`;
    default:
      throw new Error(
        `Utilities.formatDate: unsupported pattern "${pattern}". ` +
        `The harness models only MMMM_yyyy, "yyyy-MM-dd HH:mm" and dd-MMM-yyyy. ` +
        `If the codebase now uses another pattern, add it here deliberately.`
      );
  }
}

/** A global that throws on ANY property access — so reaching for Sheets fails loudly. */
function forbidden(name) {
  const boom = (op, prop) => {
    throw new Error(
      `Apps Script I/O reached from a unit test: ${name}.${String(prop)} (${op}). ` +
      `These tests run against pure helpers only. If a test needs this, the code under ` +
      `test is not pure and must not be asserted on in this harness.`
    );
  };
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === Symbol.toStringTag) {
        return () => `[forbidden ${name}]`;
      }
      return boom('get', prop);
    },
    set: (t, prop) => boom('set', prop),
    apply: () => boom('call', '()'),
    construct: () => boom('new', ''),
    has: (t, prop) => boom('in', prop),
  });
}

function makeSandbox(extraGlobals) {
  const sandbox = {
    // --- real-ish Apps Script services the pure helpers touch ---
    Utilities: {
      formatDate,
      // Anything else on Utilities is not modelled.
      get base64Encode() { throw new Error('Utilities.base64Encode is not modelled by the harness'); },
      get computeDigest() { throw new Error('Utilities.computeDigest is not modelled by the harness'); },
      get sleep() { throw new Error('Utilities.sleep is not modelled by the harness'); },
    },
    Session: {
      getScriptTimeZone: () => 'Asia/Kolkata',
      getActiveUser: () => { throw new Error('Session.getActiveUser is not modelled by the harness'); },
      getEffectiveUser: () => { throw new Error('Session.getEffectiveUser is not modelled by the harness'); },
    },

    // --- deliberately hostile: any access throws ---
    SpreadsheetApp: forbidden('SpreadsheetApp'),
    PropertiesService: forbidden('PropertiesService'),
    DriveApp: forbidden('DriveApp'),
    UrlFetchApp: forbidden('UrlFetchApp'),
    LockService: forbidden('LockService'),

    // --- ordinary JS globals the loaded file may rely on ---
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    isNaN,
    parseFloat,
    parseInt,
  };
  Object.assign(sandbox, extraGlobals || {});
  sandbox.globalThis = sandbox;
  return sandbox;
}

/**
 * Load an Apps Script file and return its sandbox (its global object).
 * @param {string} relPath repo-relative path, e.g. 'salary-advance-master/3A_….gs'
 * @param {object} [extraGlobals] extra globals to inject before evaluation
 */
function loadGs(relPath, extraGlobals) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(REPO_ROOT, relPath);
  const src = fs.readFileSync(abs, 'utf8');
  const sandbox = makeSandbox(extraGlobals);
  const ctx = vm.createContext(sandbox);
  new vm.Script(src, { filename: abs }).runInContext(ctx);
  return sandbox;
}

/**
 * loadGsMany — evaluate SEVERAL .gs files into ONE shared context, in order.
 *
 * Apps Script gives every file in a project a single shared global scope, so a helper
 * declared in one file is visible from another with no import. A test that needs a file
 * whose helpers live elsewhere must reproduce that, and the honest way is to load the
 * real other file — not to hand-write stand-ins for str_/num_/req_, which would only
 * prove the test's fakes agree with the test's expectations.
 *
 * Load order matters exactly as it does in the real project: for a name declared in two
 * files, the LAST one evaluated wins.
 */
function loadGsMany(relPaths, extraGlobals) {
  const sandbox = makeSandbox(extraGlobals);
  const ctx = vm.createContext(sandbox);
  for (const relPath of relPaths) {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(REPO_ROOT, relPath);
    const src = fs.readFileSync(abs, 'utf8');
    new vm.Script(src, { filename: abs }).runInContext(ctx);
  }
  return sandbox;
}

module.exports = { loadGs, loadGsMany, formatDate, forbidden, REPO_ROOT };
