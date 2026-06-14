/*
 * charts.js — thin wrappers around Chart.js for the dashboard.
 * Keeps a registry of live charts so we can destroy/recreate on re-compute.
 */
(function (PA) {
  'use strict';

  var registry = {};

  // Brand-ish palette; current year vs next year get distinct hues.
  var COLORS = {
    current: '#2563eb',
    currentSoft: 'rgba(37, 99, 235, 0.55)',
    next: '#7c3aed',
    nextSoft: 'rgba(124, 58, 237, 0.55)',
    weighted: 'rgba(16, 185, 129, 0.85)'
  };

  function destroy(id) {
    if (registry[id]) { registry[id].destroy(); delete registry[id]; }
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
          ticks: { callback: function (v) { return PA.format.compact(v); } }
        }
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
          { label: 'Pipeline', data: totals, backgroundColor: softColor, borderColor: yearColor, borderWidth: 1 },
          { label: 'Weighted', data: weighted, backgroundColor: COLORS.weighted, borderColor: COLORS.weighted, borderWidth: 1 }
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
          { label: 'Pipeline', data: totals, borderColor: yearColor,
            backgroundColor: 'rgba(37,99,235,0.10)', fill: true, tension: 0.25, pointRadius: 3 },
          { label: 'Weighted', data: weighted, borderColor: COLORS.weighted,
            backgroundColor: 'rgba(16,185,129,0.08)', fill: true, tension: 0.25, pointRadius: 3 }
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
          backgroundColor: soft, borderColor: color, borderWidth: 1
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
          x: { beginAtZero: true, ticks: { callback: function (v) { return PA.format.compact(v); } } }
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
    categoryBar: categoryBar,
    timelineChart: timelineChart,
    horizontalBar: horizontalBar,
    colorsForYear: colorsForYear,
    COLORS: COLORS
  };
})(window.PA = window.PA || {});
