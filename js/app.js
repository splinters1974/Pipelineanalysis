/*
 * app.js — orchestration and DOM wiring.
 * Flow: load file -> PA.parse -> PA.mapping (auto + UI) -> PA.analytics
 *       -> render KPIs, charts (PA.charts) and tables.
 *
 * State is held in `state`; any change (new file, remapped column, toggle)
 * calls recompute() then render().
 */
(function (PA) {
  'use strict';

  // ---- formatting helpers (shared with charts.js) ----
  var nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  function currency(n) {
    if (n == null || isNaN(n)) return '—';
    return '£' + nf0.format(Math.round(n));
  }
  function compact(n) {
    var abs = Math.abs(n);
    if (abs >= 1e9) return '£' + (n / 1e9).toFixed(1) + 'bn';
    if (abs >= 1e6) return '£' + (n / 1e6).toFixed(1) + 'm';
    if (abs >= 1e3) return '£' + (n / 1e3).toFixed(0) + 'k';
    return '£' + nf0.format(n);
  }
  PA.format = { currency: currency, compact: compact };

  var state = {
    table: null,        // { headers, rows }
    mapping: null,
    results: null,
    timelineGranularity: 'quarter',
    includeClosed: false,
    currentYear: 2026   // overridable; defaults to system year below
  };
  state.currentYear = new Date().getFullYear();

  var el = {};

  function $(id) { return document.getElementById(id); }

  function init() {
    el.fileInput = $('fileInput');
    el.dropZone = $('dropZone');
    el.sampleBtn = $('loadSampleBtn');
    el.mappingPanel = $('mappingPanel');
    el.mappingSection = $('mappingSection');
    el.dashboard = $('dashboard');
    el.status = $('statusBar');
    el.granularity = $('granularitySelect');
    el.includeClosed = $('includeClosedToggle');
    el.yearLabels = { current: $('yearLabelCurrent'), next: $('yearLabelNext') };

    el.fileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
    });

    // Drag & drop
    ['dragover', 'dragenter'].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) { e.preventDefault(); el.dropZone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) { e.preventDefault(); el.dropZone.classList.remove('drag'); });
    });
    el.dropZone.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    el.sampleBtn.addEventListener('click', loadSample);

    el.granularity.addEventListener('change', function () {
      state.timelineGranularity = el.granularity.value;
      render();
    });
    el.includeClosed.addEventListener('change', function () {
      state.includeClosed = el.includeClosed.checked;
      recompute(); render();
    });
  }

  function setStatus(msg, kind) {
    el.status.textContent = msg || '';
    el.status.className = 'status-bar' + (kind ? ' ' + kind : '');
    el.status.style.display = msg ? 'block' : 'none';
  }

  function loadFile(file) {
    setStatus('Reading ' + file.name + ' …', 'info');
    PA.parse.readFile(file).then(function (table) {
      onTableLoaded(table);
    }).catch(function (err) {
      setStatus('Could not read file: ' + err.message, 'error');
    });
  }

  function loadSample() {
    setStatus('Loading sample data …', 'info');
    // Try fetch (works over http://). Fall back to a clear message over file://.
    fetch('sample/sample_pipeline.csv').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      onTableLoaded(PA.parse.readText(text));
    }).catch(function () {
      setStatus('Sample auto-load is blocked when opening via file://. ' +
        'Use the upload button and pick sample/sample_pipeline.csv, or run a local server.', 'error');
    });
  }

  function onTableLoaded(table) {
    if (!table.headers.length || !table.rows.length) {
      setStatus('No data rows found in that file.', 'error');
      return;
    }
    state.table = table;
    state.mapping = PA.mapping.autoDetect(table.headers);
    PA.mapping.renderPanel(el.mappingPanel, table.headers, state.mapping, function (m) {
      state.mapping = m;
      recompute(); render();
    });
    el.mappingSection.style.display = 'block';
    recompute(); render();
  }

  function recompute() {
    if (!state.table || !state.mapping) { state.results = null; return; }
    var missing = PA.mapping.requiredMissing(state.mapping);
    if (missing.length) {
      state.results = null;
      setStatus('Map the required column(s): ' + missing.join(', '), 'warn');
      el.dashboard.style.display = 'none';
      return;
    }
    state.results = PA.analytics.analyze(state.table.rows, state.mapping, {
      currentYear: state.currentYear,
      includeClosed: state.includeClosed
    });

    var r = state.results;
    var bits = [
      r.totalRecords + ' opportunities parsed',
      r.outOfRange + ' outside ' + r.currentYear + '/' + r.nextYear,
      r.skipped + ' skipped (bad amount/date)'
    ];
    if (!state.mapping.probability) bits.push('no probability column — weighted forecast uses stage-based estimates');
    bits.push('dates read as ' + (r.dayFirst ? 'day/month/year' : 'month/day/year'));
    setStatus(bits.join('  •  '), 'info');
  }

  function render() {
    var r = state.results;
    if (!r) return;
    el.dashboard.style.display = 'block';
    el.yearLabels.current.textContent = r.currentYear;
    el.yearLabels.next.textContent = r.nextYear;

    renderColumn('current', r.years[r.currentYear], r.currentYear);
    renderColumn('next', r.years[r.nextYear], r.nextYear);
  }

  function renderColumn(which, year, yearNum) {
    var c = PA.charts.colorsForYear(which);

    // KPI cards
    $('kpiTotal_' + which).textContent = currency(year.total);
    $('kpiWeighted_' + which).textContent = currency(year.weighted);
    $('kpiCount_' + which).textContent = year.count;

    if (year.count === 0) {
      $('emptyNote_' + which).style.display = 'block';
    } else {
      $('emptyNote_' + which).style.display = 'none';
    }

    // Stage chart + table
    PA.charts.categoryBar('stageChart_' + which,
      year.byStage.map(kKey), year.byStage.map(kTotal), year.byStage.map(kWeighted),
      c.solid, c.soft);
    renderTable('stageTable_' + which, ['Stage', 'Pipeline', 'Weighted', '#'], year.byStage);

    // Timeline
    var tl = year.timeline[state.timelineGranularity];
    PA.charts.timelineChart('timelineChart_' + which,
      tl.map(kKey), tl.map(kTotal), tl.map(kWeighted), c.solid);

    // Owners (top 8)
    var owners = year.byOwner.slice(0, 8);
    PA.charts.categoryBar('ownerChart_' + which,
      owners.map(kKey), owners.map(kTotal), owners.map(kWeighted), c.solid, c.soft);
    renderTable('ownerTable_' + which, ['Owner', 'Pipeline', 'Weighted', '#'], owners);

    // Product / Region combined table (charts shown for product, region as table)
    var products = year.byProduct.slice(0, 8);
    PA.charts.categoryBar('productChart_' + which,
      products.map(kKey), products.map(kTotal), products.map(kWeighted), c.solid, c.soft);
    renderTable('regionTable_' + which, ['Region', 'Pipeline', 'Weighted', '#'], year.byRegion);
  }

  function kKey(o) { return o.key; }
  function kTotal(o) { return o.total; }
  function kWeighted(o) { return o.weighted; }

  function renderTable(id, headers, rows) {
    var tbl = $(id);
    if (!tbl) return;
    var thead = '<thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>';
    var body = rows.map(function (o) {
      return '<tr>' +
        '<td>' + escapeHtml(o.key) + '</td>' +
        '<td class="num">' + currency(o.total) + '</td>' +
        '<td class="num">' + currency(o.weighted) + '</td>' +
        '<td class="num">' + o.count + '</td>' +
      '</tr>';
    }).join('');
    tbl.innerHTML = thead + '<tbody>' + (body || '<tr><td colspan="4" class="muted">No data</td></tr>') + '</tbody>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.PA = window.PA || {});
