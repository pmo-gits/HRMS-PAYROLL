/**
 * _tests/sheets.js — a minimal, honest in-memory emulator of the Google Sheets surface
 * that 3A_Master_SharedEMILockSync.gs actually touches.
 *
 * WHY THIS EXISTS
 * ---------------
 * The settlement engine is welded to Sheets I/O, so the previous run could only *reason*
 * about passes (3), (3a2), (3b), (3c) and (3d). This module makes them EXECUTABLE: the real
 * `.gs` file runs unmodified against real arrays, and the assertions read the resulting
 * grid.
 *
 * WHAT IS MODELLED, AND ON WHOSE AUTHORITY
 * ----------------------------------------
 * Only the Sheets *platform* behaviour is modelled here — getValues vs getDisplayValues,
 * ranges, number formats, row growth. None of the salary-advance BUSINESS rules live in this
 * file. The single business-ish thing modelled is `EMI_SCHEDULE!Current Balance`, which is an
 * ARRAYFORMULA in the live sheet and therefore has to be emulated for the engine to read a
 * residual at all. Its definition is taken from the design doc
 * (_docs/salary-advance-settlement-plan.md): the live per-reference outstanding balance,
 * identical on every row of that reference =
 *
 *     Advance Amount  -  SUM of Recover Amount over that reference's rows
 *
 * A booked Write off Amount does NOT reduce it: `Advance Ledger!EMI Status` keys off the
 * SUMIF of the write-off amount precisely because the balance itself does not move. Both
 * readings are exercised by the scenario suite (see BALANCE_MODEL) so no conclusion depends
 * on the choice.
 *
 * Deliberately NOT modelled: protections, validation, filters, formatting other than number
 * formats, and anything the engine never calls. Any unmodelled call throws.
 */

'use strict';

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

/** Sheets' own display rendering for the value types this codebase puts in cells. */
function display(v, numberFormat) {
  if (v == null || v === '') return '';
  if (isDate(v)) {
    if (numberFormat === 'MMMM_yyyy') return `${MONTHS_LONG[v.getMonth()]}_${v.getFullYear()}`;
    // Sheets' M/d/yyyy drops leading zeroes.
    return `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}`;
  }
  if (typeof v === 'number') return String(v);
  return String(v);
}

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  _each(fn) {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) fn(this.row + r, this.col + c, r, c);
    }
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet._get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getDisplayValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        line.push(display(this.sheet._get(this.row + r, this.col + c), this.sheet._fmt(this.col + c)));
      }
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    if (vals.length !== this.numRows || vals[0].length !== this.numCols) {
      throw new Error(
        `setValues shape mismatch on ${this.sheet.name}: range is ${this.numRows}x${this.numCols}, ` +
        `data is ${vals.length}x${vals[0] && vals[0].length}`
      );
    }
    this._each((r, c, ri, ci) => this.sheet._set(r, c, vals[ri][ci]));
    return this;
  }
  setValue(v) {
    this._each((r, c) => this.sheet._set(r, c, v));
    return this;
  }
  setNumberFormat(fmt) {
    for (let c = 0; c < this.numCols; c++) this.sheet.numberFormats[this.col + c] = fmt;
    return this;
  }
  clearContent() {
    this._each((r, c) => this.sheet._set(r, c, ''));
    return this;
  }
  /**
   * copyTo — values only, which is the only mode this codebase uses
   * (CopyPasteType.PASTE_VALUES). Any other mode throws rather than pretending,
   * per this file's rule that an unmodelled call must fail loudly.
   */
  copyTo(dest, type, transpose) {
    if (type !== 'PASTE_VALUES') {
      throw new Error(`sheets.js models copyTo only with PASTE_VALUES, got: ${type}`);
    }
    if (transpose) throw new Error('sheets.js does not model transposed copyTo');
    if (dest.numRows !== this.numRows || dest.numCols !== this.numCols) {
      throw new Error('sheets.js models copyTo only between equally-shaped ranges');
    }
    const vals = this.getValues();
    this._each((r, c, ri, ci) => dest.sheet._set(dest.row + ri, dest.col + ci, vals[ri][ci]));
    return this;
  }
}

class Sheet {
  /**
   * @param {string} name
   * @param {string[]} headers
   * @param {object} [opts] `computed`: {headerNameUpper: fn(sheet, row1Based) -> value}
   */
  constructor(name, headers, opts) {
    this.name = name;
    this.headers = headers.slice();
    this.numberFormats = {};            // 1-based col -> format string
    this.formulaWrites = [];            // attempted writes into computed columns
    this.maxRows = 1000;
    this.cells = new Map();             // "r,c" -> value
    this.computed = {};                 // 1-based col -> fn(sheet, row)
    headers.forEach((h, i) => this.cells.set(`1,${i + 1}`, h));

    const byName = {};
    headers.forEach((h, i) => { byName[String(h).trim().toUpperCase()] = i + 1; });
    this.colOf = byName;

    const comp = (opts && opts.computed) || {};
    for (const key of Object.keys(comp)) {
      const c = byName[key.toUpperCase()];
      if (!c) throw new Error(`computed column not found on ${name}: ${key}`);
      this.computed[c] = comp[key];
    }
  }

  _fmt(c) { return this.numberFormats[c]; }

  _get(r, c) {
    if (r > 1 && this.computed[c]) return this.computed[c](this, r);
    const v = this.cells.get(`${r},${c}`);
    return v === undefined ? '' : v;
  }

  _set(r, c, v) {
    if (r > this.maxRows) throw new Error(`write past maxRows on ${this.name}: row ${r} > ${this.maxRows}`);
    if (r > 1 && this.computed[c]) {
      // A formula cell. The write is ignored rather than thrown, because some
      // callers legitimately write a full-width row and rely on Sheets keeping
      // the ARRAYFORMULA. But it IS recorded: on a real sheet this write would
      // replace the formula with a static value for the whole column, so a test
      // that cares can assert nothing ever landed here.
      this.formulaWrites.push({ row: r, col: c, header: this.headers[c - 1], value: v });
      return;
    }
    if (v === '' || v == null) this.cells.delete(`${r},${c}`);
    else this.cells.set(`${r},${c}`, v);
  }

  /**
   * deleteRow — removes the row and shifts everything below it up by one, which
   * is what makes row numbers captured before a delete unsafe to reuse after.
   */
  deleteRow(r) {
    if (r === 2 && Object.keys(this.computed).length) {
      // Row 2 is where this sheet's ARRAYFORMULA / MAP formulas live. Deleting
      // it deletes the formulas themselves, and every computed column goes dead
      // for the WHOLE sheet — silently, and not recoverable except by re-typing
      // them. Modelled by dropping the definitions so a test reading those
      // columns afterwards sees what a user would: nothing.
      this.anchorsDestroyed = true;
      this.computed = {};
    }
    const next = new Map();
    for (const [k, v] of this.cells) {
      const [rr, cc] = k.split(',').map(Number);
      if (rr === r) continue;
      next.set(rr > r ? `${rr - 1},${cc}` : k, v);
    }
    this.cells = next;
    return this;
  }

  setFrozenRows(n) { this.frozenRows = n; return this; }

  getMaxRows() { return this.maxRows; }

  getLastRow() {
    let last = 1;
    for (const k of this.cells.keys()) {
      const r = Number(k.split(',')[0]);
      if (r > last) last = r;
    }
    return last;
  }

  getLastColumn() {
    let last = 0;
    for (const k of this.cells.keys()) {
      const c = Number(k.split(',')[1]);
      if (c > last) last = c;
    }
    return last;
  }

  getRange(row, col, numRows, numCols) {
    return new Range(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
  }

  insertRowsAfter(after, howMany) {
    if (after !== this.maxRows) {
      throw new Error('sheets.js models insertRowsAfter only at the bottom of the grid');
    }
    this.maxRows += howMany;
  }

  /** test helper: whole grid down to the last used row, as raw values */
  dump() {
    const last = this.getLastRow();
    const cols = this.headers.length;
    const out = [];
    for (let r = 2; r <= last; r++) {
      const o = {};
      for (let c = 1; c <= cols; c++) o[this.headers[c - 1]] = this._get(r, c);
      o._row = r;
      out.push(o);
    }
    return out;
  }
}

class Spreadsheet {
  constructor(sheets) {
    this.sheets = sheets;
  }
  getSheetByName(n) { return this.sheets[n] || null; }
  /** Created with no headers; the caller writes row 1 itself, as the real code does. */
  insertSheet(n) {
    if (this.sheets[n]) throw new Error(`insertSheet: ${n} already exists`);
    const sh = new Sheet(n, []);
    sh.cells.clear();
    this.sheets[n] = sh;
    return sh;
  }
}

/** Build the SpreadsheetApp / PropertiesService globals the engine expects. */
function makeGlobals(spreadsheet, props) {
  const store = props || new Map();
  return {
    SALARY_ADVANCE_MASTER_SPREADSHEET_ID: 'TEST_SS_ID',
    SpreadsheetApp: {
      openById: () => spreadsheet,
      flush: () => {},
      CopyPasteType: { PASTE_VALUES: 'PASTE_VALUES' },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (store.has(k) ? store.get(k) : null),
        setProperty: (k, v) => { store.set(k, v); },
        deleteProperty: k => { store.delete(k); },
      }),
    },
    __PROPS__: store,
  };
}

module.exports = { Sheet, Spreadsheet, Range, makeGlobals, display, isDate, MONTHS_LONG };
