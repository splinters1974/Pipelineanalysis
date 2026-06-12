/*
 * Headless sanity tests for parsing + analytics (no browser needed).
 * Run: node test/run.js
 *
 * Loads the vendored PapaParse and the app's pure-logic modules under a
 * minimal `window` shim, runs analyze() over the sample CSV, and asserts the
 * key figures computed by hand in the plan's verification section.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

// Minimal browser-ish sandbox.
const sandbox = { window: {}, console: console };
sandbox.window.PA = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

// PapaParse expects a global; load it, then bridge to window.
load('vendor/papaparse.min.js');
// PapaParse (UMD) assigns to module/exports or global Papa; ensure Papa exists.
if (!sandbox.Papa && sandbox.window.Papa) sandbox.Papa = sandbox.window.Papa;
if (!sandbox.Papa && sandbox.module && sandbox.module.exports) sandbox.Papa = sandbox.module.exports;

load('js/parse.js');
load('js/analytics.js');

const PA = sandbox.window.PA;
if (!sandbox.Papa) { console.error('FAIL: PapaParse did not load'); process.exit(1); }

const csv = fs.readFileSync(path.join(root, 'sample/sample_pipeline.csv'), 'utf8');
const table = PA.parse.readText(csv);

let failures = 0;
function approx(label, actual, expected, tol) {
  tol = tol || 0.5;
  const ok = Math.abs(actual - expected) <= tol;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + ' = ' + actual + (ok ? '' : ' (expected ' + expected + ')'));
  if (!ok) failures++;
}
function eq(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + ' = ' + actual + (ok ? '' : ' (expected ' + expected + ')'));
  if (!ok) failures++;
}

// Header detection
eq('headers found', table.headers.length, 9);
eq('rows parsed', table.rows.length, 30);

const mapping = PA.analytics && {
  amount: 'Amount', closeDate: 'Close Date', stage: 'Stage',
  probability: 'Probability (%)', owner: 'Opportunity Owner',
  product: 'Product Family', region: 'Region', name: 'Opportunity Name'
};

// Day-first detection on the DD/MM/YYYY sample
const dayFirst = PA.parse.detectDayFirst(table.rows.map(r => r['Close Date']));
eq('day-first detected', dayFirst, true);

// Analyze for 2026/2027, excluding closed deals
const res = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: false });

approx('2026 total pipeline (open)', res.years[2026].total, 1170500);
approx('2026 weighted forecast', res.years[2026].weighted, 449875);
eq('2026 open count', res.years[2026].count, 12);

// Include closed should add Wayne(310k)+Vehement(70k)+Duff(135k) = 515k to 2026 total
const resClosed = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: true });
approx('2026 total incl. closed', resClosed.years[2026].total, 1170500 + 515000);

// 2025 rows (Legacy 90k won, Old 30k) must be out of range, not counted
eq('out-of-range count > 0', res.outOfRange >= 2, true);

// Currency cleaning: "£120,000" -> 120000
approx('cleanNumber £120,000', PA.parse.cleanNumber('£120,000'), 120000);
approx('cleanNumber (70,000) negative', PA.parse.cleanNumber('(70,000)'), -70000);

// Stage-weight fallback when no probability column
const noProb = Object.assign({}, mapping, { probability: null });
const resNoProb = PA.analytics.analyze(table.rows, noProb, { currentYear: 2026, includeClosed: false });
console.log('INFO 2026 weighted (stage-based fallback) = ' + Math.round(resNoProb.years[2026].weighted));
eq('fallback weighted is positive', resNoProb.years[2026].weighted > 0, true);

console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
