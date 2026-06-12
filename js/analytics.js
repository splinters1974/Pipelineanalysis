/*
 * analytics.js — turn mapped rows into the pipeline analysis dataset.
 *
 * Pure functions: input rows + mapping + options -> a plain results object.
 * No DOM access here so the calculations stay testable.
 */
(function (PA) {
  'use strict';

  // Default stage -> win probability, used when the report has no
  // probability column. Matching is case-insensitive substring, so
  // "Proposal/Price Quote" matches "proposal". Editable here and surfaced
  // in the UI.
  var DEFAULT_STAGE_WEIGHTS = [
    { match: 'closed won', weight: 1.00 },
    { match: 'closed lost', weight: 0.00 },
    { match: 'negotiat', weight: 0.75 },
    { match: 'proposal', weight: 0.50 },
    { match: 'quote', weight: 0.50 },
    { match: 'qualif', weight: 0.25 },
    { match: 'discovery', weight: 0.20 },
    { match: 'prospect', weight: 0.10 },
    { match: 'lead', weight: 0.10 }
  ];
  var FALLBACK_WEIGHT = 0.20; // unknown stage

  var MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function stageWeight(stage, table) {
    var s = String(stage || '').toLowerCase();
    var rules = table || DEFAULT_STAGE_WEIGHTS;
    for (var i = 0; i < rules.length; i++) {
      if (s.indexOf(rules[i].match) !== -1) return rules[i].weight;
    }
    return FALLBACK_WEIGHT;
  }

  function isClosedStage(stage) {
    return String(stage || '').toLowerCase().indexOf('closed') !== -1;
  }

  // Normalise a probability cell to a 0..1 fraction. Accepts "75", "75%", "0.75".
  function normProbability(raw) {
    var n = PA.parse.cleanNumber(raw);
    if (isNaN(n)) return null;
    if (n > 1) return n / 100;       // "75" or "75%"
    if (n < 0) return 0;
    return n;                        // already a fraction
  }

  /*
   * Build normalised records from raw rows + mapping.
   * Returns { records, skipped, dayFirst }.
   * Each record: { amount, date, year, month, quarter, stage, owner,
   *                product, region, name, probability, weighted }.
   */
  function buildRecords(rows, mapping, opts) {
    opts = opts || {};
    var stageTable = opts.stageWeights || DEFAULT_STAGE_WEIGHTS;

    // Decide date format once across the whole column.
    var dateValues = rows.map(function (r) { return r[mapping.closeDate]; });
    var dayFirst = opts.dayFirst != null ? opts.dayFirst
                                         : PA.parse.detectDayFirst(dateValues);

    var records = [];
    var skipped = 0;

    rows.forEach(function (r) {
      var amount = PA.parse.cleanNumber(r[mapping.amount]);
      var date = PA.parse.parseDate(r[mapping.closeDate], dayFirst);
      if (isNaN(amount) || !date) { skipped++; return; }

      var stage = mapping.stage ? (r[mapping.stage] || '') : '';
      var owner = mapping.owner ? (r[mapping.owner] || '—') : '—';
      var product = mapping.product ? (r[mapping.product] || '—') : '—';
      var region = mapping.region ? (r[mapping.region] || '—') : '—';
      var name = mapping.name ? (r[mapping.name] || '') : '';

      var prob = null;
      if (mapping.probability) prob = normProbability(r[mapping.probability]);
      if (prob == null) prob = stageWeight(stage, stageTable);

      records.push({
        amount: amount,
        date: date,
        year: date.getUTCFullYear(),
        month: date.getUTCMonth(),
        quarter: Math.floor(date.getUTCMonth() / 3) + 1,
        stage: stage || '(blank)',
        owner: owner,
        product: product,
        region: region,
        name: name,
        probability: prob,
        weighted: amount * prob,
        closed: isClosedStage(stage)
      });
    });

    return { records: records, skipped: skipped, dayFirst: dayFirst };
  }

  // Sum a numeric field of records grouped by a key function.
  function groupSum(records, keyFn, valFn) {
    var map = {};
    records.forEach(function (rec) {
      var k = keyFn(rec);
      if (!map[k]) map[k] = { key: k, total: 0, weighted: 0, count: 0 };
      map[k].total += valFn ? valFn(rec) : rec.amount;
      map[k].weighted += rec.weighted;
      map[k].count += 1;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function byDesc(arr) {
    return arr.slice().sort(function (a, b) { return b.total - a.total; });
  }

  // Compute every view for a single year's records.
  function computeYear(records) {
    var total = 0, weighted = 0;
    records.forEach(function (r) { total += r.amount; weighted += r.weighted; });

    var byStage = byDesc(groupSum(records, function (r) { return r.stage; }));
    var byOwner = byDesc(groupSum(records, function (r) { return r.owner; }));
    var byProduct = byDesc(groupSum(records, function (r) { return r.product; }));
    var byRegion = byDesc(groupSum(records, function (r) { return r.region; }));

    // Timeline buckets: quarters Q1-Q4 and months Jan-Dec, in calendar order.
    var quarters = [1, 2, 3, 4].map(function (q) {
      var recs = records.filter(function (r) { return r.quarter === q; });
      return reduceBucket('Q' + q, recs);
    });
    var months = MONTH_LABELS.map(function (lbl, idx) {
      var recs = records.filter(function (r) { return r.month === idx; });
      return reduceBucket(lbl, recs);
    });

    return {
      total: total,
      weighted: weighted,
      count: records.length,
      byStage: byStage,
      byOwner: byOwner,
      byProduct: byProduct,
      byRegion: byRegion,
      timeline: { quarter: quarters, month: months }
    };
  }

  function reduceBucket(label, recs) {
    var total = 0, weighted = 0;
    recs.forEach(function (r) { total += r.amount; weighted += r.weighted; });
    return { key: label, total: total, weighted: weighted, count: recs.length };
  }

  /*
   * Top-level analysis.
   * opts: { currentYear, includeClosed, dayFirst, stageWeights }
   * Returns:
   *   { years: {2026:{...}, 2027:{...}}, currentYear, nextYear,
   *     skipped, dayFirst, outOfRange, includeClosed }
   */
  function analyze(rows, mapping, opts) {
    opts = opts || {};
    var currentYear = opts.currentYear || new Date().getFullYear();
    var nextYear = currentYear + 1;
    var includeClosed = !!opts.includeClosed;

    var built = buildRecords(rows, mapping, opts);
    var inYears = [];
    var outOfRange = 0;

    built.records.forEach(function (rec) {
      if (rec.year !== currentYear && rec.year !== nextYear) { outOfRange++; return; }
      if (!includeClosed && rec.closed) return;
      inYears.push(rec);
    });

    var result = { years: {}, currentYear: currentYear, nextYear: nextYear };
    [currentYear, nextYear].forEach(function (y) {
      var recs = inYears.filter(function (r) { return r.year === y; });
      result.years[y] = computeYear(recs);
    });

    result.skipped = built.skipped;
    result.dayFirst = built.dayFirst;
    result.outOfRange = outOfRange;
    result.includeClosed = includeClosed;
    result.totalRecords = built.records.length;
    return result;
  }

  PA.analytics = {
    analyze: analyze,
    buildRecords: buildRecords,
    stageWeight: stageWeight,
    DEFAULT_STAGE_WEIGHTS: DEFAULT_STAGE_WEIGHTS,
    MONTH_LABELS: MONTH_LABELS
  };
})(window.PA = window.PA || {});
