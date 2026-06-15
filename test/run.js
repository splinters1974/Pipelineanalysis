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
load('js/export.js');
load('js/pdf.js');

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
eq('headers found', table.headers.length, 13);
eq('rows parsed', table.rows.length, 30);

const mapping = PA.analytics && {
  amount: 'Amount', closeDate: 'Close Date', stage: 'Stage',
  probability: 'Probability (%)', owner: 'Opportunity Owner',
  product: 'Product Family', region: 'Region', name: 'Opportunity Name',
  lastModified: 'Last Modified Date', created: 'Created Date',
  nextStep: 'Next Step', leadSource: 'Lead Source'
};

// Two 2026 deals (Globex, Soylent) are stage "Awarded" @ 90% (were 75%):
// delta to weighted = 85500*.15 + 60000*.15 = 21825 -> 449875 + 21825 = 471700
const W2026 = 471700;

// Day-first detection on the DD/MM/YYYY sample
const dayFirst = PA.parse.detectDayFirst(table.rows.map(r => r['Close Date']));
eq('day-first detected', dayFirst, true);

// Analyze for 2026/2027, excluding closed deals
const res = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: false });

approx('2026 total pipeline (open)', res.years[2026].total, 1170500);
approx('2026 weighted forecast', res.years[2026].weighted, W2026);
eq('2026 open count', res.years[2026].count, 12);

// Awarded stage is open (not closed) and carries a high stage weight
approx('awarded stage weight high', PA.analytics.stageWeight('Awarded'), 0.90);
eq('Awarded appears in 2026 by-stage', res.years[2026].byStage.some(s => s.key === 'Awarded'), true);
eq('Awarded appears in 2027 by-stage', res.years[2027].byStage.some(s => s.key === 'Awarded'), true);

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

// ---- Pipeline Health ----
const today = new Date(Date.UTC(2026, 5, 14, 12, 0, 0)); // 14 Jun 2026
const health = PA.analytics.healthMetrics(table.rows, mapping, '1,000,000', today, { includeClosed: false });

eq('health current year', health.currentYear, 2026);
approx('coverage weighted forecast', health.weightedForecast, W2026);
approx('coverage ratio %', health.coverageRatio, W2026 / 1e6 * 100, 0.01);
eq('coverage status red (<50%)', health.coverageStatus, 'red');

// green/amber thresholds
eq('coverage green at 80%', PA.analytics.healthMetrics(table.rows, mapping, String(W2026 / 0.8), today, {}).coverageStatus, 'green');
eq('coverage amber at ~60%', PA.analytics.healthMetrics(table.rows, mapping, String(W2026 / 0.6), today, {}).coverageStatus, 'amber');

// Stale: Acme(15/03), Stark(18/05), Nexus(07/04), Wonka(05/02) — past close in 2026
eq('stale count', health.stale.count, 4);
approx('stale total value', health.stale.totalValue, 120000 + 95000 + 65000 + 175000);
eq('most stale first (Wonka 05/02)', health.stale.items[0].name, 'Wonka Platform');
eq('stale items carry days-since-modified', typeof health.stale.items[0].daysSinceModified, 'number');

// Segments sum back to the current-year open pipeline
const segTotal = health.segments.reduce((s, x) => s + x.total, 0);
approx('segment totals sum to 2026 open pipeline', segTotal, 1170500);
const dataCentres = health.segments.find(s => s.key === 'Data Centres');
approx('Data Centres segment total', dataCentres.total, 200000 + 150000);
const ic = health.segments.find(s => s.key === 'I&C');
approx('I&C segment total', ic.total, 120000 + 60000 + 110000);
eq('segmentFor maps battery -> Grid-Scale', PA.analytics.segmentFor('Grid-Scale Battery Storage'), 'Grid-Scale');
eq('segmentFor unmapped -> Other', PA.analytics.segmentFor('Mystery Product'), 'Other');

// ---- Pipeline Insights ----
const ins = PA.analytics.insightMetrics(table.rows, mapping, today, { includeClosed: false });

// Average open-opportunity age — recomputed independently from the CSV
const openDays = table.rows
  .filter(r => String(r['Stage']).toLowerCase().indexOf('closed') === -1)
  .map(r => PA.parse.parseDate(r['Created Date'], true))
  .filter(Boolean)
  .map(d => Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86400000)));
const expAvg = Math.round(openDays.reduce((a, b) => a + b, 0) / openDays.length);
eq('avg open age days', ins.avgOpenAgeDays, expAvg);
eq('open age count', ins.openAgeCount, openDays.length);

// Won revenue 2026 by owner: Wayne(John 310k) + Duff(Jane 135k)
approx('won total 2026', ins.wonTotal, 445000);
eq('won count 2026', ins.wonCount, 2);
eq('won owners sorted desc', ins.wonByOwner[0].total >= ins.wonByOwner[1].total, true);

// Lead source mix percentages sum to ~100
eq('lead sources present', ins.leadSources.length > 0, true);
approx('lead source pct ~100', ins.leadSources.reduce((a, b) => a + b.pct, 0), 100, 0.5);

// Top 10 proposed — sample has 7 Proposal-stage deals, so all 7 show (<=10)
eq('top proposed = 7 candidates (<=10)', ins.topProposed.length, 7);
eq('top proposed sorted by score', ins.topProposed.every((it, i, a) => i === 0 || a[i - 1].score >= it.score), true);
eq('top proposed carries next step', typeof ins.topProposed[0].nextStep, 'string');
eq('allOpps available for add dropdown', ins.allOpps.length > 0, true);

// ---- Summary CSV export ----
const csvOut = PA.export.buildSummaryCsv(res, health, ins, { generated: '2026-06-15' });
function has(label, needle) {
  const ok = csvOut.indexOf(needle) !== -1;
  console.log((ok ? 'PASS' : 'FAIL') + ' csv contains ' + label);
  if (!ok) failures++;
}
has('title', 'Pipeline Analysis summary');
has('generated date', '2026-06-15');
has('KPI header', 'KPIs,Total pipeline,Weighted forecast,Opportunities');
has('2026 total', '1170500');
has('by stage section', 'By stage — 2026');
has('timeline section', 'Timeline (quarter) — 2027');
has('segment section', 'By segment,Pipeline,Count');
has('Data Centres segment', 'Data Centres,350000,2');
has('stale list header', 'Name,Owner,Amount,Close date,Days since modified');
has('cities segment label', 'Cities & Local Government');
has('insights section', 'Pipeline Insights');
has('avg age row', 'Avg open opportunity age (days)');
has('won by owner section', 'Won by owner,Amount,Count');
has('lead source section', 'Lead source,Count,%');
has('top proposed section', 'Top 10 proposed,Value,Close date,Rating %,Next step');
// CRLF line endings for spreadsheet friendliness
eq('csv uses CRLF', /\r\n/.test(csvOut), true);

// ---- PDF report (pure doc-definition builder) ----
const doc = PA.pdf.buildDocDefinition({
  results: res, health: health, insights: ins,
  proposed: ins.topProposed, images: {}, meta: { generated: '2026-06-15' }
});
eq('pdf page size A4', doc.pageSize, 'A4');
eq('pdf footer is a function', typeof doc.footer, 'function');
eq('pdf content is array', Array.isArray(doc.content), true);
const pageBreaks = doc.content.filter(b => b && b.pageBreak === 'before').length;
eq('pdf has 3 pages (2 page-breaks)', pageBreaks, 2);
const docStr = JSON.stringify(doc.content);
function docHas(label, needle) {
  const ok = docStr.indexOf(needle) !== -1;
  console.log((ok ? 'PASS' : 'FAIL') + ' pdf doc contains ' + label);
  if (!ok) failures++;
}
docHas('title', 'Pipeline Analysis');
docHas('current year heading', 'Current year — 2026');
docHas('following year heading', 'Following year — 2027');
docHas('insights page', 'Pipeline Insights — 2026');
docHas('avg age', 'Avg age of open opportunities');
docHas('top 10 heading', 'Top 10 proposed opportunities');
docHas('segments/stale page', 'Segments & Stale deals — 2026');
const foot = doc.footer(2, 3);
eq('pdf footer shows page numbers', JSON.stringify(foot).indexOf('2 / 3') !== -1, true);

console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
