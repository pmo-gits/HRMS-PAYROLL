/**
 * _tests/mutate.js — proves the multi-advance suite actually has teeth.
 *
 * A suite that is green against correct code tells you nothing unless you also know it goes RED
 * against incorrect code. This script writes deliberately broken copies of
 * `3A_Master_SharedEMILockSync.gs` into the scratch directory, points `_tests/run-multi.js` at
 * each one via SA_3A_PATH, and reports which assertions caught the break.
 *
 * Each mutation models exactly the failure mode the multi-advance work was commissioned to hunt:
 * one employee's two references colliding with each other.
 *
 * NOTHING IN THE REPO IS MODIFIED. The broken copies live in os.tmpdir().
 *
 * Run:  node _tests/mutate.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const GS = path.join(REPO_ROOT, 'salary-advance-master', '3A_Master_SharedEMILockSync.gs');
const SUITE = path.join(__dirname, 'run-multi.js');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mutate-'));

const src = fs.readFileSync(GS, 'utf8');

const MUTATIONS = [
  {
    id: 'MUT-1',
    what: 'residual is the employee\'s COMBINED balance, not the reference\'s own',
    apply: s => s.split('residualByRef.has(ref) ? residualByRef.get(ref) : 0')
      .join('residualByRef.has(ref) ? [...residualByRef.values()].reduce(function(a,b){return a+b;},0) : 0'),
  },
  {
    id: 'MUT-2',
    what: 'the Close In Months plan leaks onto EVERY reference of the employee',
    // (3c) walks the plan reference's own rows; make it walk every reference's rows instead.
    apply: s => s.replace(
      'const all = refRowList.get(ref) || [];',
      'const all = [].concat.apply([], [...refRowList.values()]);'
    ),
  },
  {
    id: 'MUT-3',
    what: 'the write-off books only ONCE per run (one reference suppresses the other)',
    apply: s => s.replace(
      '    if (norm_(stageCol[i][0]) !== "FINAL") {\n      stageCol[i][0] = "FINAL";\n      changedStage = true;\n    }\n  }\n\n  // =========================================================\n  // (3b) Close leftover months',
      '    if (norm_(stageCol[i][0]) !== "FINAL") {\n      stageCol[i][0] = "FINAL";\n      changedStage = true;\n    }\n    break;\n  }\n\n  // =========================================================\n  // (3b) Close leftover months'
    ),
  },
  {
    id: 'MUT-4',
    what: 'the settlement window is keyed by EMPLOYEE, so the second decision row overwrites the first',
    apply: s => s.replace(
      'settlementLwdByRef.set(ref, lwdMonth);',
      'settlementLwdByRef.set(emp, lwdMonth);'
    ),
  },
];

/** run the suite and return the set of FAILing assertion names */
function runSuite(gsPath) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [SUITE], {
      env: Object.assign({}, process.env, gsPath ? { SA_3A_PATH: gsPath } : {}),
      encoding: 'utf8',
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  return {
    fails: new Set(out.split('\n').filter(l => l.trim().startsWith('FAIL'))
      .map(l => l.trim().slice(6).split('  --')[0].trim())),
    tally: (out.match(/^\d+ passed, \d+ failed.*$/m) || [''])[0],
    raw: out,
  };
}

// The suite has KNOWN failures against unmutated code (the M8 Last Working Day finding). A
// mutation only counts as caught if it produces failures BEYOND that baseline.
const baseline = runSuite(null);
console.log(`baseline against unmutated code: ${baseline.tally}`);
if (baseline.fails.size) {
  console.log(`  known failures excluded from every mutation below:`);
  [...baseline.fails].forEach(f => console.log(`    - ${f}`));
}

let allCaught = true;

for (const m of MUTATIONS) {
  const mutated = m.apply(src);
  if (mutated === src) {
    console.log(`\n${m.id}  ${m.what}\n  SKIPPED — the mutation did not apply (source moved); ` +
      `this mutation must be re-anchored before it means anything.`);
    allCaught = false;
    continue;
  }
  const file = path.join(OUT, `${m.id}.gs`);
  fs.writeFileSync(file, mutated);

  const r = runSuite(file);
  const caught = [...r.fails].filter(f => !baseline.fails.has(f));

  console.log(`\n${m.id}  ${m.what}`);
  console.log(`  suite result: ${r.tally || '(crashed: ' + r.raw.split('\n').slice(-4).join(' | ').slice(0, 200) + ')'}`);
  if (caught.length) {
    console.log(`  CAUGHT by ${caught.length} assertion(s) beyond the baseline:`);
    caught.slice(0, 8).forEach(c => console.log(`    - ${c}`));
    if (caught.length > 8) console.log(`    ... and ${caught.length - 8} more`);
  } else if (!r.tally) {
    console.log('  CAUGHT — the suite errored out rather than asserting cleanly.');
  } else {
    console.log('  *** NOT CAUGHT — no assertion failed beyond the known baseline. ***');
    allCaught = false;
  }
}

console.log(`\nBroken copies left in: ${OUT}`);
console.log(allCaught
  ? '\nEvery mutation was caught. The multi-advance suite discriminates.'
  : '\nAt least one mutation survived — see above.');
process.exit(allCaught ? 0 : 1);
