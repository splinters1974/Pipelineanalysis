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

  var STORAGE_KEY = 'pipelineAnalysis.v1';

  var state = {
    table: null,        // { headers, rows }
    mapping: null,
    results: null,
    timelineGranularity: 'quarter',
    includeClosed: false,
    target: '',          // raw text from the coverage target input
    proposedRemoved: {}, // {name: true} manually removed from the top-10 list
    proposedAdded: [],   // [name] manually added to the top-10 list
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
    el.targetInput = $('targetInput');
    el.exportCsvBtn = $('exportCsvBtn');
    el.pdfReportBtn = $('pdfReportBtn');
    el.resetBtn = $('resetBtn');
    el.topProposedTable = $('topProposedTable');
    el.addProposedSelect = $('addProposedSelect');
    el.addProposedBtn = $('addProposedBtn');
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
      render(); saveState();
    });
    el.includeClosed.addEventListener('change', function () {
      state.includeClosed = el.includeClosed.checked;
      recompute(); render(); saveState();
    });
    // Coverage target: re-render just the health card, no CSV re-parse.
    el.targetInput.addEventListener('input', function () {
      state.target = el.targetInput.value;
      renderHealth(); saveState();
    });

    el.exportCsvBtn.addEventListener('click', exportSummaryCsv);
    el.pdfReportBtn.addEventListener('click', generatePdfReport);
    el.resetBtn.addEventListener('click', resetAll);

    // Manual edits to the top-10 proposed list (event delegation: rows redraw).
    el.topProposedTable.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.remove-proposed');
      if (!btn) return;
      var name = btn.getAttribute('data-name');
      state.proposedRemoved[name] = true;
      state.proposedAdded = state.proposedAdded.filter(function (n) { return n !== name; });
      renderInsights(); saveState();
    });
    el.addProposedBtn.addEventListener('click', function () {
      var name = el.addProposedSelect.value;
      if (!name) return;
      delete state.proposedRemoved[name];
      if (state.proposedAdded.indexOf(name) === -1) state.proposedAdded.push(name);
      renderInsights(); saveState();
    });

    // Charts don't reflow for print on their own — resize them first.
    window.addEventListener('beforeprint', function () { PA.charts.resizeAll(); });

    restoreState();
  }

  function currentHealth() {
    return PA.analytics.healthMetrics(state.table.rows, state.mapping, state.target,
      new Date(), { includeClosed: state.includeClosed });
  }

  function exportSummaryCsv() {
    if (!state.results) return;
    var csv = PA.export.buildSummaryCsv(state.results, currentHealth(), currentInsights(), {
      generated: new Date().toISOString().slice(0, 10)
    });
    downloadFile('pipeline-analysis-' + new Date().toISOString().slice(0, 10) + '.csv',
      csv, 'text/csv;charset=utf-8');
  }

  // The curated top-proposed list shown in the UI = auto top-10 minus removed,
  // plus any manually added opportunities. Shared by the table and the PDF.
  function computeShownProposed(ins) {
    var shown = ins.topProposed.filter(function (it) { return !state.proposedRemoved[it.name]; });
    var names = {};
    shown.forEach(function (it) { names[it.name] = true; });
    state.proposedAdded.forEach(function (name) {
      if (names[name]) return;
      var opp = ins.allOpps.filter(function (o) { return o.name === name; })[0];
      if (opp) { shown.push(opp); names[name] = true; }
    });
    return { shown: shown, names: names };
  }

  function generatePdfReport() {
    if (!state.results) return;
    var ins = currentInsights();
    var docDef = PA.pdf.buildDocDefinition({
      results: state.results,
      health: currentHealth(),
      insights: ins,
      proposed: computeShownProposed(ins).shown,
      images: {
        timelineCurrent: PA.charts.getImage('timelineChart_current'),
        timelineNext: PA.charts.getImage('timelineChart_next'),
        won: PA.charts.getImage('wonChart'),
        lead: PA.charts.getImage('leadChart'),
        segment: PA.charts.getImage('segmentChart')
      },
      meta: { generated: new Date().toISOString().slice(0, 10) }
    });
    PA.pdf.download(docDef, 'pipeline-analysis-' + new Date().toISOString().slice(0, 10) + '.pdf');
  }

  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
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

  function onTableLoaded(table, restored) {
    if (!table.headers.length || !table.rows.length) {
      setStatus('No data rows found in that file.', 'error');
      return;
    }
    state.table = table;
    // A freshly loaded file starts with auto-mapping and no manual list edits;
    // a restored session keeps whatever was saved.
    if (!restored) {
      state.mapping = PA.mapping.autoDetect(table.headers);
      state.proposedRemoved = {};
      state.proposedAdded = [];
    }
    PA.mapping.renderPanel(el.mappingPanel, table.headers, state.mapping, function (m) {
      state.mapping = m;
      recompute(); render(); saveState();
    });
    el.mappingSection.style.display = 'block';
    recompute(); render();
    if (!restored) saveState();
  }

  // ---- Persistence: keep the loaded data + settings across browser sessions ----
  function saveState() {
    if (!state.table) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        table: state.table,
        mapping: state.mapping,
        timelineGranularity: state.timelineGranularity,
        includeClosed: state.includeClosed,
        target: state.target,
        proposedRemoved: state.proposedRemoved,
        proposedAdded: state.proposedAdded
      }));
    } catch (e) {
      // Most likely the dataset is too large for localStorage; carry on without
      // persistence rather than breaking the app.
      setStatus('Note: data is loaded but too large to save for next time.', 'warn');
    }
  }

  function restoreState() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { return; }
    if (!saved || !saved.table) return;

    state.mapping = saved.mapping || null;
    state.timelineGranularity = saved.timelineGranularity || 'quarter';
    state.includeClosed = !!saved.includeClosed;
    state.target = saved.target || '';
    state.proposedRemoved = saved.proposedRemoved || {};
    state.proposedAdded = saved.proposedAdded || [];

    // Reflect restored settings in the controls.
    el.granularity.value = state.timelineGranularity;
    el.includeClosed.checked = state.includeClosed;
    el.targetInput.value = state.target;

    onTableLoaded(saved.table, true);
  }

  function resetAll() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    state.table = null;
    state.mapping = null;
    state.results = null;
    state.target = '';
    state.includeClosed = false;
    state.timelineGranularity = 'quarter';
    state.proposedRemoved = {};
    state.proposedAdded = [];
    el.targetInput.value = '';
    el.includeClosed.checked = false;
    el.granularity.value = 'quarter';
    el.fileInput.value = '';
    el.mappingPanel.innerHTML = '';
    el.mappingSection.style.display = 'none';
    el.dashboard.style.display = 'none';
    setStatus('Data cleared. Upload a Salesforce CSV to start again.', 'info');
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
    renderHealth();
    renderInsights();
  }

  function currentInsights() {
    return PA.analytics.insightMetrics(state.table.rows, state.mapping, new Date(),
      { includeClosed: state.includeClosed });
  }

  // Pipeline Insights card: avg open age, won-by-owner, lead source, top 10 proposed.
  function renderInsights() {
    if (!state.results || !state.table || !state.mapping) return;
    var ins = currentInsights();

    // Avg age of open opportunities
    if (ins.avgOpenAgeDays == null) {
      $('avgAgeStat').textContent = '—';
      $('avgAgeSub').textContent = ins.hasCreated
        ? 'No open opportunities with a created date.'
        : 'Map a Created Date column to see this.';
    } else {
      $('avgAgeStat').textContent = ins.avgOpenAgeDays + ' days';
      $('avgAgeSub').textContent = 'across ' + ins.openAgeCount +
        ' open opportunities (created → today)';
    }

    // Won revenue by owner (current year, closed won)
    $('wonYearLabel').textContent = ins.currentYear;
    $('wonTotalLabel').textContent = ins.wonCount
      ? 'Total won: ' + currency(ins.wonTotal) + ' · ' + ins.wonCount +
        (ins.wonCount === 1 ? ' deal' : ' deals')
      : 'No closed-won deals in ' + ins.currentYear + '.';
    PA.charts.pieChart('wonChart',
      ins.wonByOwner.map(function (o) { return o.key; }),
      ins.wonByOwner.map(function (o) { return o.total; }),
      { kind: 'currency', counts: ins.wonByOwner.map(function (o) { return o.count; }) });

    // Lead source mix
    if (!ins.hasLeadSource) {
      PA.charts.destroy('leadChart');
      $('leadNote').textContent = 'Map a Lead Source column to see this.';
    } else {
      $('leadNote').textContent = '';
      PA.charts.pieChart('leadChart',
        ins.leadSources.map(function (o) { return o.key; }),
        ins.leadSources.map(function (o) { return o.count; }),
        { kind: 'count' });
    }

    // Top 10 proposed (auto-ranked) with manual add/remove.
    var curated = computeShownProposed(ins);
    var shown = curated.shown, shownNames = curated.names;

    var headers = ['Opportunity', 'Value', 'Close date', 'Rating', 'Next step', ''];
    var thead = '<thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>';
    var body = shown.map(function (it) {
      return '<tr>' +
        '<td>' + escapeHtml(it.name) + '</td>' +
        '<td class="num">' + currency(it.amount) + '</td>' +
        '<td class="num">' + fmtDate(it.closeDate) + '</td>' +
        '<td class="num">' + Math.round(it.probability * 100) + '%</td>' +
        '<td class="next-step">' + escapeHtml(it.nextStep || '—') + '</td>' +
        '<td class="num"><button type="button" class="remove-proposed" title="Remove" ' +
          'data-name="' + escapeHtml(it.name) + '">✕</button></td>' +
      '</tr>';
    }).join('');
    el.topProposedTable.innerHTML = thead + '<tbody>' +
      (body || '<tr><td colspan="6" class="muted">No proposed opportunities.</td></tr>') + '</tbody>';

    // Populate the "add" dropdown with opportunities not already shown.
    var options = ['<option value="">Select an opportunity…</option>'];
    ins.allOpps.forEach(function (o) {
      if (shownNames[o.name]) return;
      options.push('<option value="' + escapeHtml(o.name) + '">' +
        escapeHtml(o.name) + ' — ' + currency(o.amount) + ' (' + escapeHtml(o.stage) + ')</option>');
    });
    el.addProposedSelect.innerHTML = options.join('');
  }

  // Pipeline Health card — current year only. Safe to call on its own
  // (e.g. when the target input changes) without re-parsing the CSV.
  function renderHealth() {
    if (!state.results || !state.table || !state.mapping) return;
    var h = currentHealth();

    $('healthYearLabel').textContent = h.currentYear;

    // Panel 1 — Coverage
    var cov = $('coverageResult');
    if (h.coverageRatio == null) {
      cov.className = 'coverage-result';
      cov.innerHTML = '<p class="muted">Enter a target to see coverage.<br>Weighted forecast so far: <strong>' +
        currency(h.weightedForecast) + '</strong></p>';
    } else {
      cov.className = 'coverage-result ' + h.coverageStatus;
      cov.innerHTML =
        '<div class="coverage-ratio">' + Math.round(h.coverageRatio) + '%</div>' +
        '<div class="coverage-sub">' + compact(h.weightedForecast) +
        ' weighted against ' + compact(h.target) + ' target</div>';
    }

    // Panel 2 — Stale deals
    $('staleSummary').innerHTML = '<strong>' + h.stale.count + '</strong> stale ' +
      (h.stale.count === 1 ? 'deal' : 'deals') + ' · ' + currency(h.stale.totalValue);
    var listHtml = h.stale.items.map(function (it) {
      var mod = it.daysSinceModified == null ? 'modified n/a'
              : (it.daysSinceModified + 'd since modified');
      return '<div class="stale-item">' +
        '<span class="stale-name">' + escapeHtml(it.name || '(unnamed)') + '</span>' +
        '<span class="stale-meta">' + escapeHtml(it.owner) + ' · ' + currency(it.amount) +
        ' · close ' + fmtDate(it.closeDate) + ' · ' + mod + '</span>' +
      '</div>';
    }).join('');
    $('staleList').innerHTML = listHtml || '<p class="muted">No stale deals — nice and fresh.</p>';

    // Panel 3 — By segment
    PA.charts.horizontalBar('segmentChart',
      h.segments.map(function (s) { return s.key; }),
      h.segments.map(function (s) { return s.total; }),
      h.segments.map(function (s) { return s.count; }),
      PA.charts.COLORS.current, PA.charts.COLORS.currentSoft);
  }

  function fmtDate(d) {
    if (!d) return '—';
    return d.getUTCDate() + ' ' + PA.analytics.MONTH_LABELS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
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

    // Stage chart + table, with a Pipeline/Weighted total row at the bottom
    PA.charts.categoryBar('stageChart_' + which,
      year.byStage.map(kKey), year.byStage.map(kTotal), year.byStage.map(kWeighted),
      c.solid, c.soft);
    renderTable('stageTable_' + which, ['Stage', 'Pipeline', 'Weighted', '#'], year.byStage,
      { key: 'Total', total: year.total, weighted: year.weighted, count: year.count });

    // Timeline
    var tl = year.timeline[state.timelineGranularity];
    PA.charts.timelineChart('timelineChart_' + which,
      tl.map(kKey), tl.map(kTotal), tl.map(kWeighted), c.solid);

    // Owners (top 8)
    var owners = year.byOwner.slice(0, 8);
    PA.charts.categoryBar('ownerChart_' + which,
      owners.map(kKey), owners.map(kTotal), owners.map(kWeighted), c.solid, c.soft);
    renderTable('ownerTable_' + which, ['Owner', 'Pipeline', 'Weighted', '#'], owners);
  }

  function kKey(o) { return o.key; }
  function kTotal(o) { return o.total; }
  function kWeighted(o) { return o.weighted; }

  function renderTable(id, headers, rows, totals) {
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
    var tfoot = '';
    if (totals) {
      tfoot = '<tfoot><tr class="total-row">' +
        '<td>' + escapeHtml(totals.key) + '</td>' +
        '<td class="num">' + currency(totals.total) + '</td>' +
        '<td class="num">' + currency(totals.weighted) + '</td>' +
        '<td class="num">' + totals.count + '</td>' +
      '</tr></tfoot>';
    }
    tbl.innerHTML = thead + '<tbody>' + (body || '<tr><td colspan="4" class="muted">No data</td></tr>') + '</tbody>' + tfoot;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.PA = window.PA || {});
