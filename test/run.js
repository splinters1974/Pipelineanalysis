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

// Stale = OPEN deals (any year) not amended in >6 months (before 14 Dec 2025).
// Only "Stale Lead 2025" (LM 15/08/2025, Prospecting, £30k @10%) qualifies.
const staleCut = Date.UTC(2025, 11, 14, 12, 0, 0);
const recsAll = PA.analytics.buildRecords(table.rows, mapping, {}).records;
let stc = 0, stt = 0, stw = 0;
recsAll.forEach(r => {
  if (r.closed || !r.lastModified) return;
  if (r.lastModified.getTime() < staleCut) { stc++; stt += r.amount; stw += r.weighted; }
});
eq('stale count (6mo, all open)', health.stale.count, stc);
eq('stale count is 1 in sample', health.stale.count, 1);
approx('stale total value', health.stale.totalValue, stt);
approx('stale total is £30k', health.stale.totalValue, 30000);
approx('stale weighted value', health.stale.weightedValue, stw);
approx('stale weighted is £3k', health.stale.weightedValue, 3000);
eq('stale threshold months', health.stale.thresholdMonths, 6);

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

// Awarded opportunities (CURRENT YEAR only): Globex 85.5k + Soylent 60k (2026)
// = 2 deals, 145.5k, sorted by value desc (Umbrella/Tyrell are 2027, excluded).
eq('awarded count (2026 only)', ins.awarded.length, 2);
approx('awarded total', ins.awardedTotal, 145500);
eq('awarded sorted by value desc', ins.awarded.every((a, i, arr) => i === 0 || arr[i - 1].amount >= a.amount), true);
eq('awarded carries owner', ins.awarded[0].owner === 'John Doe', true); // Globex 85.5k is top
eq('awarded carries name + value', ins.awarded[0].name === 'Globex Expansion' && ins.awarded[0].amount === 85500, true);

// ---- Filters ----
const dv = PA.analytics.distinctFilterValues(table.rows, mapping, { currentYear: 2026 });
eq('distinct owners = 4', dv.owner.length, 4);
eq('distinct regions = 3', dv.region.length, 3);
eq('distinct lead sources = 5', dv.leadSource.length, 5);
eq('distinct segments = 5', dv.segment.length, 5);

// applyFilters: owner = Jane Smith
const janeRecs = PA.analytics.applyFilters(
  PA.analytics.buildRecords(table.rows, mapping, {}).records, { owner: ['Jane Smith'] });
eq('applyFilters keeps only Jane', janeRecs.every(r => r.owner === 'Jane Smith'), true);
// analyze with that filter: 2026 open = Acme 120k + Initech 40k + Soylent 60k = 220k
const resJane = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: false, filters: { owner: ['Jane Smith'] } });
approx('filtered (Jane) 2026 open total', resJane.years[2026].total, 220000);
// no-op filter equals unfiltered
const resAll = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: false, filters: { owner: [] } });
approx('empty filter == unfiltered', resAll.years[2026].total, 1170500);

// ---- coverage() helper ----
eq('coverage 80% green', PA.analytics.coverage(80, 100).status, 'green');
eq('coverage 50% amber', PA.analytics.coverage(50, 100).status, 'amber');
eq('coverage 49% red', PA.analytics.coverage(49, 100).status, 'red');
eq('coverage no target = null', PA.analytics.coverage(50, '').ratio, null);

// ---- Sales performance ----
const perf = PA.analytics.performanceMetrics(table.rows, mapping, today, {});
eq('perf won count 2026', perf.wonCount, 2);
eq('perf lost count 2026', perf.lostCount, 1);
eq('perf open count 2026', perf.openCount, 12);
approx('perf win rate (count) %', perf.winRatePct, 200 / 3, 0.05);
approx('perf win rate (value) %', perf.winRateValuePct, 445000 / 515000 * 100, 0.05);
// avg cycle recomputed independently over 2026 closed-won deals with a created date
const wonCycle = table.rows.filter(r => r['Close Date'].endsWith('2026') && /won/i.test(r['Stage']) && r['Created Date'])
  .map(r => Math.floor((PA.parse.parseDate(r['Close Date'], true) - PA.parse.parseDate(r['Created Date'], true)) / 86400000));
const expCycle = Math.round(wonCycle.reduce((a, b) => a + b, 0) / wonCycle.length);
eq('perf avg sales cycle days', perf.avgCycleDays, expCycle);
// velocity is internally consistent and positive
const expVel = (perf.openCount * perf.avgDealSize * (perf.winRatePct / 100)) / perf.avgCycleDays;
approx('perf velocity £/day', perf.velocityPerDay, expVel, 0.01);
eq('perf velocity positive', perf.velocityPerDay > 0, true);

// ---- Forecast outlook (anchored to today's month: Jun 2026) ----
const fc = PA.analytics.forecastMetrics(table.rows, mapping, today, {});
eq('forecast month label', fc.monthLabel, 'Jun 2026');
eq('forecast 90 label', fc.next90Label, 'Jun 2026 – Aug 2026');
eq('forecast 365 label', fc.next365Label, 'Jun 2026 – May 2027');
// Recompute the windows independently from the parsed rows (open opps only).
const curStart = Date.UTC(2026, 5, 1), nextM = Date.UTC(2026, 6, 1),
      e90 = Date.UTC(2026, 8, 1), e365 = Date.UTC(2027, 5, 1);
let mC = 0, mT = 0, n90C = 0, n90T = 0, n365C = 0, n365T = 0;
table.rows.forEach(r => {
  if (/closed/i.test(r['Stage'])) return;
  const d = PA.parse.parseDate(r['Close Date'], true); if (!d) return;
  const amt = PA.parse.cleanNumber(r['Amount']); if (isNaN(amt)) return;
  const t = d.getTime();
  if (t < curStart) return;
  if (t < nextM) { mC++; mT += amt; }
  if (t < e90) { n90C++; n90T += amt; }
  if (t < e365) { n365C++; n365T += amt; }
});
eq('forecast month count', fc.month.count, mC);
approx('forecast month total', fc.month.total, mT);
eq('forecast 90 count', fc.next90.count, n90C);
approx('forecast 90 total', fc.next90.total, n90T);
eq('forecast 365 count', fc.next365.count, n365C);
approx('forecast 365 total', fc.next365.total, n365T);
eq('forecast windows nested (month<=90<=365)', fc.month.total <= fc.next90.total && fc.next90.total <= fc.next365.total, true);
// Strategic All Time — no £10m+ deals in the sample
eq('strategic none at £10m', fc.strategic.count, 0);
approx('strategic total £0', fc.strategic.total, 0);
approx('strategic weighted £0', fc.strategic.weighted, 0);
// Lower the threshold to exercise detection + total/weighted
const fcLow = PA.analytics.forecastMetrics(table.rows, mapping, today, { strategicThreshold: 150000 });
const recsLow = PA.analytics.buildRecords(table.rows, mapping, {}).records;
let sC = 0, sT = 0, sW = 0;
recsLow.forEach(r => {
  if (r.closed || r.amount < 150000) return;
  sC++; sT += r.amount; sW += r.weighted;
});
eq('strategic count @150k', fcLow.strategic.count, sC);
approx('strategic total @150k', fcLow.strategic.total, sT);
approx('strategic weighted @150k', fcLow.strategic.weighted, sW);
// Filters flow through (Jane is a subset of everyone)
const fcJane = PA.analytics.forecastMetrics(table.rows, mapping, today, { filters: { owner: ['Jane Smith'] } });
eq('forecast respects salesperson filter', fcJane.next365.total <= fc.next365.total, true);

// ---- Summary CSV export ----
const csvOut = PA.export.buildSummaryCsv(res, health, ins, {
  generated: '2026-06-15', performance: perf, forecast: fcLow,
  filterSummary: 'Salesperson: Jane Smith', person: 'Jane Smith'
});
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
has('stale section header', 'Stale deals (not amended in more than 6 months),Count,Total,Weighted');
has('cities segment label', 'Cities & Local Government');
has('insights section', 'Pipeline Insights');
has('avg age row', 'Avg open opportunity age (days)');
has('won by owner section', 'Won by owner,Amount,Count');
has('awarded section', 'Awarded opportunities,Value,Owner');
has('awarded total row', 'Total awarded,145500,2');
has('lead source section', 'Lead source,Count,%');
has('top proposed section', 'Top 10 proposed,Value,Close date,Rating %,Next step');
has('filters applied row', 'Filters applied,Salesperson: Jane Smith');
has('salesperson title', 'Pipeline Analysis summary — Jane Smith');
has('salesperson row', 'Salesperson,Jane Smith');
has('sales performance section', 'Sales performance — 2026');
has('velocity row', 'Pipeline velocity (£/day)');
has('forecast section', 'Forecast outlook — Jun 2026');
has('forecast month row', 'Orders this month (Jun 2026)');
has('forecast strategic all time', 'Strategic All Time (£10m+),');
// CRLF line endings for spreadsheet friendliness
eq('csv uses CRLF', /\r\n/.test(csvOut), true);

// ---- PDF report (pure doc-definition builder) ----
const doc = PA.pdf.buildDocDefinition({
  results: res, health: health, insights: ins, proposed: ins.topProposed,
  performance: perf, forecast: fcLow, images: {},
  meta: { generated: '2026-06-15', filterSummary: 'Salesperson: Jane Smith', person: 'Jane Smith' }
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
docHas('value by stage on page 1', 'Value by stage');
docHas('by owner on page 1', 'By owner');
docHas('filter note', 'Filtered by — Salesperson: Jane Smith');
docHas('person title', 'Pipeline Analysis — Jane Smith');
docHas('person tag', 'Salesperson report');
docHas('forecast heading', 'Forecast outlook — Jun 2026');
docHas('forecast kpi', 'Orders this month');
docHas('forecast strategic all time', 'Strategic All Time (£10m+)');
docHas('sales performance row', 'Sales performance');
docHas('win rate kpi', 'Win rate (count)');
docHas('insights page', 'Pipeline Insights — 2026');
docHas('awarded section', 'Awarded opportunities — 2026');
docHas('awarded total', 'Total awarded');
docHas('stale summary line', 'Open deals not amended in more than 6 months');
docHas('avg age', 'Avg age of open opportunities');
docHas('top 10 heading', 'Top 10 proposed opportunities');
docHas('segments/stale page', 'Segments & Stale deals — 2026');
const foot = doc.footer(2, 3);
eq('pdf footer shows page numbers', JSON.stringify(foot).indexOf('2 / 3') !== -1, true);

console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
