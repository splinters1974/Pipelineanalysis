/*
 * charts.js — thin wrappers around Chart.js for the dashboard.
 * Keeps a registry of live charts so we can destroy/recreate on re-compute.
 */
(function (PA) {
  'use strict';

  var registry = {};

  // Brand-ish palette; current year vs next year get distinct hues.
  var COLORS = {
    current: '#4f46e5',
    currentSoft: 'rgba(79, 70, 229, 0.55)',
    next: '#7c3aed',
    nextSoft: 'rgba(124, 58, 237, 0.55)',
    weighted: 'rgba(16, 185, 129, 0.85)'
  };

  // Shared look-and-feel for every chart (fonts, axis colour, grid lines).
  if (window.Chart) {
    Chart.defaults.font.family = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#475569';
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
    if (Chart.defaults.plugins.tooltip) {
      Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(15, 23, 42, 0.92)';
      Chart.defaults.plugins.tooltip.padding = 10;
      Chart.defaults.plugins.tooltip.cornerRadius = 8;
      Chart.defaults.plugins.tooltip.boxPadding = 4;
    }
  }

  // Translucent fill from a hex colour (for area charts).
  function hexToRgba(hex, alpha) {
    var h = hex.replace('#', '');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  // Soft grid styling reused across cartesian charts.
  var GRID = { color: 'rgba(148, 163, 184, 0.15)', drawBorder: false };

  function destroy(id) {
    if (registry[id]) { registry[id].destroy(); delete registry[id]; }
  }

  // Resize every live chart to fit its (possibly changed) container — used
  // before printing so canvases reflow into the print layout instead of
  // overflowing their boxes.
  function resizeAll() {
    Object.keys(registry).forEach(function (id) { registry[id].resize(); });
  }

  // PNG data URL of a rendered chart (for embedding in the PDF report).
  function getImage(id) {
    return registry[id] ? registry[id].toBase64Image('image/png', 1.0) : null;
  }

  function currency(n) { return PA.format.currency(n); }

  function baseOptions(extra) {
    var o = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              return ctx.dataset.label + ': ' + currency(ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed);
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: GRID,
          ticks: { callback: function (v) { return PA.format.compact(v); } }
        },
        x: { grid: { display: false } }
      }
    };
    return Object.assign(o, extra || {});
  }

  // Grouped bar: total vs weighted, for one year's category breakdown.
  function categoryBar(canvasId, labels, totals, weighted, yearColor, softColor) {
    destroy(canvasId);
    var ctx = document.getElementById(canvasId).getContext('2d');
    registry[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Pipeline', data: totals, backgroundColor: softColor, borderColor: yearColor, borderWidth: 1, borderRadius: 6, maxBarThickness: 38 },
          { label: 'Weighted', data: weighted, backgroundColor: COLORS.weighted, borderColor: COLORS.weighted, borderWidth: 1, borderRadius: 6, maxBarThickness: 38 }
        ]
      },
      options: baseOptions()
    });
  }

  // Timeline: line for pipeline + line for weighted across periods.
  function timelineChart(canvasId, labels, totals, weighted, yearColor) {
    destroy(canvasId);
    var ctx = document.getElementById(canvasId).getContext('2d');
    registry[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Pipeline', data: totals, borderColor: yearColor, borderWidth: 2,
            backgroundColor: hexToRgba(yearColor, 0.10), fill: true, tension: 0.35,
            pointRadius: 3, pointBackgroundColor: yearColor, pointBorderColor: '#fff', pointBorderWidth: 1.5 },
          { label: 'Weighted', data: weighted, borderColor: '#10b981', borderWidth: 2,
            backgroundColor: 'rgba(16,185,129,0.08)', fill: true, tension: 0.35,
            pointRadius: 3, pointBackgroundColor: '#10b981', pointBorderColor: '#fff', pointBorderWidth: 1.5 }
        ]
      },
      options: baseOptions()
    });
  }

  // Horizontal bar of pipeline value per category; deal count shown in tooltip.
  function horizontalBar(canvasId, labels, totals, counts, color, soft) {
    destroy(canvasId);
    var ctx = document.getElementById(canvasId).getContext('2d');
    registry[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Pipeline', data: totals,
          backgroundColor: soft, borderColor: color, borderWidth: 1, borderRadius: 5, maxBarThickness: 26
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var n = counts[ctx.dataIndex];
                return currency(ctx.parsed.x) + ' · ' + n + (n === 1 ? ' deal' : ' deals');
              }
            }
          }
        },
        scales: {
          x: { beginAtZero: true, grid: GRID, ticks: { callback: function (v) { return PA.format.compact(v); } } },
          y: { grid: { display: false } }
        }
      }
    });
  }

  // Distinct palette for categorical pie/doughnut slices.
  var PIE_PALETTE = ['#4f46e5', '#7c3aed', '#10b981', '#f59e0b', '#ef4444',
                     '#06b6d4', '#db2777', '#84cc16', '#6366f1', '#f97316'];

  /*
   * Doughnut chart. opts.kind = 'currency' (default) or 'count' controls value
   * formatting; opts.counts (optional) adds a deal count to currency tooltips.
   * Tooltip always shows the slice's share of the total as a percentage.
   */
  function pieChart(canvasId, labels, values, opts) {
    destroy(canvasId);
    opts = opts || {};
    var counts = opts.counts || null;
    var fmtVal = opts.kind === 'count'
      ? function (v) { return v + (v === 1 ? ' deal' : ' deals'); }
      : function (v) { return currency(v); };
    var bg = labels.map(function (_, i) { return PIE_PALETTE[i % PIE_PALETTE.length]; });
    var sum = values.reduce(function (a, b) { return a + b; }, 0) || 1;
    var ctx = document.getElementById(canvasId).getContext('2d');
    registry[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: bg, borderColor: '#fff', borderWidth: 2, hoverOffset: 6 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 8, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: function (c) {
                var v = c.parsed;
                var pct = Math.round((v / sum) * 100);
                var extra = (counts && opts.kind !== 'count') ? ' · ' + counts[c.dataIndex] + ' deals' : '';
                return c.label + ': ' + fmtVal(v) + ' (' + pct + '%)' + extra;
              }
            }
          }
        }
      }
    });
  }

  function colorsForYear(which) {
    return which === 'next'
      ? { solid: COLORS.next, soft: COLORS.nextSoft }
      : { solid: COLORS.current, soft: COLORS.currentSoft };
  }

  PA.charts = {
    destroy: destroy,
    resizeAll: resizeAll,
    getImage: getImage,
    categoryBar: categoryBar,
    timelineChart: timelineChart,
    horizontalBar: horizontalBar,
    pieChart: pieChart,
    colorsForYear: colorsForYear,
    COLORS: COLORS
  };
})(window.PA = window.PA || {});
