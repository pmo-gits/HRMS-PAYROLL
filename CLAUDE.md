# HRMS — Butler Leather Goods Factory India Pvt Ltd

Root-level memory for the HRMS workspace. This file loads on **every session, every module** — keep it to cross-cutting rules only. Module-specific detail belongs in that module's own `CLAUDE.md`, not here.

## System overview

In-house HRMS built entirely on Google Apps Script + Google Sheets. Zero third-party dependencies, runs entirely within Google's infrastructure. Workforce categories: Workers (Tamil-speaking and Hindi-speaking/migrant) and Staff.

**Owner/Admin:** pmo@butlerleather.com
**Collaborators:** hrassist@butlerleather.com (HR assistant, delegate access via Web App) · nazneen@butlerleather.com (Finance Admin, viewer/delegate) · Zafar sir (authorizing signatory for salary revisions — physical signature required, not a system role)

## Modules (this workspace)

- `attendance/` — attendance file scripts (sync, refresh, leave balances, lock, late entry, penalty calc, carry-forward)
- `attendance-control-center/` — Attendance Control Center menu/entry point
- `leave-master/` — Leave Master sync, hash watcher
- `payroll-control-center/` — Payroll Control Center menu/entry point
- `payroll-generator/` — 9-stage payroll pipeline, PAYROLL_GEN_1 through GEN_10
- `payslip-template/` — Payslip Generator (PAYROLL_GEN_10), A5 layout template work
- `salary-advance-master/` — EMI scheduler, shared lock sync, recovered ledger watcher
- `salary-revision-history/` — Revision approval, submit approval workflow

A 9-stage payroll pipeline connects these modules sequentially: Employee Master → Attendance → Salary Advance → Salary Revision → Payroll → Bank Transfer.

## Naming conventions (apply to script filenames inside each module — not folder names)

Individual `.gs` files inside these folders still carry their production prefixes: `PAYROLL_GEN_N`, `ATTN_NN_Description`, `SALARY_ADV_N_`, `SALARY_REV_`, `LEAVE_MASTER_`. The folder itself is just a plain container name (e.g. `payroll-generator/PAYROLL_GEN_5.Validate_Payroll.gs`). Never hardcode column positions — see header-name-based lookups below.

## Non-negotiable technical principles

- **Header-name-based lookups everywhere.** Column positions are never hardcoded. This makes column insertions safe with zero or minimal script changes.
- **Template is the single source of truth** for visual formatting in the payslip system — layout properties are baked into the template file, never set programmatically.
- **STRIDE must cover spacer rows.** Row-height-run readers must be scoped to `STRIDE`, not `BLOCK_ROWS`, or spacer row heights are never replicated to cloned blocks.
- **`normalizeNumberIfPossible_()` must never run on identifier-type columns** (Bank Account No, UAN No, ESI No, IFSC Code) — leading zeros and precision loss are real risks.
- **`readTabAsMapByKey_` is last-write-wins.** Use `readSumByKey_()` for any field where multiple rows per employee are valid (OT Hours, Salary Advance Deductions).
- **All-or-nothing pattern** is the established production standard for batch operations (EMI scheduling, payroll locking).
- **`|| ""` treats 0 as falsy.** A recovered amount of zero writes blank string instead of "0" — guard with explicit `parseFloat > 0` checks.
- **Font-size / layout calculations must derive from original baseline measurements**, never from already-rounded prior-version values (rounding compounds).
- **Web App deployment: "Execute as: Me"** is correct. "User accessing the web app" causes auth-layer HTML interception before doPost executes, breaking JSON responses.
- **Print area must be explicitly set** per tab to prevent phantom extra pages from stray formatted cells.
- **A trailing underscore in a function name marks it "private" in Apps Script** — it's hidden from the editor's Run dropdown, the trigger picker, and cannot be called by `google.script.run`. This codebase uses trailing underscore as its convention for internal helpers (`gpdFindDuplicateAadhaar_`, `normalizeNumberIfPossible_`, etc.), which is correct and intentional. But any function meant to be **manually run or selected** — a menu handler, a `doGet`/`doPost` entry point, a test runner — must NOT end in `_`, or it silently won't appear where you need to select it.

## Working approach — confirm-first, always

- **No code before explicit plan confirmation in chat.** State the blast radius before writing any code.
- **Full script replacements, not diffs**, for production-tested logic — unless a targeted diff is explicitly agreed for that task. Production-tested logic stays byte-identical unless specifically in scope.
- **Surgical changes only.** Never touch unrelated logic, even if it looks improvable.
- **Iterative verification.** Changes are tested with real data and reported via specific evidence (screenshots, log output), not abstract descriptions.
- **Quantitative precision for layout work.** Fill percentages, pixel widths, row heights — stated explicitly, not approximated.
- Acknowledge mistakes plainly when caught; don't rationalize.

## Tools & platform

- Google Apps Script + Google Sheets. Native Apps Script Web App hosting (`doGet` + `HtmlService` + `google.script.run`) is the default — evaluate this before any external hosting option.
- Version control: separate GitHub repo per module.

## Key file IDs

- Template Payslip: `1IrcvPh6zASMqxOrBjAZkt_E5lQt_Slj8Lhvpkx9qyOQ`
- Employee Master spreadsheet: `1yqQ-edwQzZd0pAlaXCAAZt88MbsHfCf4hCcxti4ojCw` (GID `1874110664`)
- Monthly Payslip Drive folder: `1x2SxEqGO1NFNypcOnC6Rr2VlVz8BSe2S`

## Before treating anything here as current

This file is a starting orientation, not live ground truth. For anything where correctness matters — before approving a change, before confirming current pipeline behavior — read the actual file on disk or grep the codebase rather than relying on this summary alone.
