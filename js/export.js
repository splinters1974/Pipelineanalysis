/*
 * export.js — build a shareable summary of the analysis as CSV text.
 *
 * Pure function (no DOM): takes the analyze() result and the healthMetrics()
 * result and returns a CSV string, so it can be unit-tested. app.js handles
 * the actual file download. Numeric values are rounded for clean spreadsheets.
 */
(function (PA) {
  'use strict';

  function csvEscape(v) {
    var s = (v == null) ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function num(v) {
    return (v == null || isNaN(v)) ? '' : Math.round(v);
  }

  function fmtDate(d) {
    if (!d) return '';
    return d.getUTCDate() + ' ' + PA.analytics.MONTH_LABELS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function buildSummaryCsv(results, health, insights, meta) {
    meta = meta || {};
    var r = results;
    var rows = [];

    rows.push(['Pipeline Analysis summary']);
    rows.push(['Generated', meta.generated || '']);
    rows.push(['Years', r.currentYear + ' & ' + r.nextYear]);
    rows.push(['Closed deals included', r.includeClosed ? 'Yes' : 'No']);
    rows.push([]);

    // KPIs
    rows.push(['KPIs', 'Total pipeline', 'Weighted forecast', 'Opportunities']);
    [r.currentYear, r.nextYear].forEach(function (y) {
      var yr = r.years[y];
      rows.push([y, num(yr.total), num(yr.weighted), yr.count]);
    });
    rows.push([]);

    // Breakdown helper (both years)
    function dump(title, getList) {
      [r.currentYear, r.nextYear].forEach(function (y) {
        rows.push([title + ' — ' + y, 'Pipeline', 'Weighted', 'Count']);
        getList(r.years[y]).forEach(function (o) {
          rows.push([o.key, num(o.total), num(o.weighted), o.count]);
        });
        rows.push([]);
      });
    }
    dump('By stage', function (yr) { return yr.byStage; });
    dump('Timeline (quarter)', function (yr) { return yr.timeline.quarter; });
    dump('By owner', function (yr) { return yr.byOwner; });
    dump('By product', function (yr) { return yr.byProduct; });
    dump('By region', function (yr) { return yr.byRegion; });

    // Pipeline Health (current year)
    if (health) {
      rows.push(['Pipeline Health — ' + health.currentYear]);
      if (health.coverageRatio != null) {
        rows.push(['Coverage ratio %', Math.round(health.coverageRatio)]);
        rows.push(['Target', num(health.target)]);
        rows.push(['Status', health.coverageStatus]);
      } else {
        rows.push(['Coverage', 'no target set']);
      }
      rows.push(['Weighted forecast', num(health.weightedForecast)]);
      rows.push([]);

      rows.push(['By segment', 'Pipeline', 'Count']);
      health.segments.forEach(function (s) { rows.push([s.key, num(s.total), s.count]); });
      rows.push([]);

      rows.push(['Stale deals', health.stale.count, num(health.stale.totalValue)]);
      rows.push(['Name', 'Owner', 'Amount', 'Close date', 'Days since modified']);
      health.stale.items.forEach(function (it) {
        rows.push([it.name, it.owner, num(it.amount), fmtDate(it.closeDate),
          it.daysSinceModified == null ? 'n/a' : it.daysSinceModified]);
      });
      rows.push([]);
    }

    // Pipeline Insights
    if (insights) {
      rows.push(['Pipeline Insights']);
      rows.push(['Avg open opportunity age (days)',
        insights.avgOpenAgeDays == null ? 'n/a' : insights.avgOpenAgeDays]);
      rows.push(['Won revenue ' + insights.currentYear, num(insights.wonTotal),
        insights.wonCount + ' deals']);
      rows.push([]);

      rows.push(['Won by owner', 'Amount', 'Count']);
      insights.wonByOwner.forEach(function (o) { rows.push([o.key, num(o.total), o.count]); });
      rows.push([]);

      rows.push(['Lead source', 'Count', '%']);
      insights.leadSources.forEach(function (o) { rows.push([o.key, o.count, Math.round(o.pct)]); });
      rows.push([]);

      rows.push(['Top 5 proposed', 'Value', 'Close date', 'Rating %', 'Next step']);
      insights.topProposed.forEach(function (it) {
        rows.push([it.name, num(it.amount), fmtDate(it.closeDate),
          Math.round(it.probability * 100), it.nextStep]);
      });
    }

    return rows.map(function (row) {
      return row.map(csvEscape).join(',');
    }).join('\r\n');
  }

  PA.export = { buildSummaryCsv: buildSummaryCsv };
})(window.PA = window.PA || {});
