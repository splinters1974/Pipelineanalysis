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
    target: '',          // current-year coverage target (raw text)
    nextTarget: '',      // next-year coverage target (raw text)
    filters: { owner: [], region: [], segment: [], stage: [], leadSource: [] },
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
    el.salespersonSelect = $('salespersonSelect');
    el.includeClosed = $('includeClosedToggle');
    el.targetInput = $('targetInput');
    el.nextTargetInput = $('nextTargetInput');
    el.filtersRow = $('filtersRow');
    el.filtersSummary = $('filtersSummary');
    el.clearFiltersBtn = $('clearFiltersBtn');
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
    el.salespersonSelect.addEventListener('change', onSalespersonChange);
    // Coverage targets: re-render just the health card, no CSV re-parse.
    el.targetInput.addEventListener('input', function () {
      state.target = el.targetInput.value;
      renderHealth(); saveState();
    });
    el.nextTargetInput.addEventListener('input', function () {
      state.nextTarget = el.nextTargetInput.value;
      renderHealth(); saveState();
    });
    el.clearFiltersBtn.addEventListener('click', clearFilters);
    // Close any open filter popover when clicking elsewhere.
    document.addEventListener('click', closeAllPopovers);

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
      new Date(), { includeClosed: state.includeClosed, filters: state.filters });
  }

  function currentPerformance() {
    return PA.analytics.performanceMetrics(state.table.rows, state.mapping,
      new Date(), { includeClosed: state.includeClosed, filters: state.filters });
  }

  function currentForecast() {
    return PA.analytics.forecastMetrics(state.table.rows, state.mapping,
      new Date(), { filters: state.filters });
  }

  // Slug for filenames, e.g. "Jane Smith" -> "-jane-smith" (empty for everyone).
  function personSlug() {
    var p = selectedPerson();
    return p ? '-' + p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
  }

  function exportSummaryCsv() {
    if (!state.results) return;
    var csv = PA.export.buildSummaryCsv(state.results, currentHealth(), currentInsights(), {
      generated: new Date().toISOString().slice(0, 10),
      performance: currentPerformance(),
      forecast: currentForecast(),
      filterSummary: filterSummaryText(),
      person: selectedPerson()
    });
    downloadFile('pipeline-analysis' + personSlug() + '-' + new Date().toISOString().slice(0, 10) + '.csv',
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
      performance: currentPerformance(),
      forecast: currentForecast(),
      images: {
        stageCurrent: PA.charts.getImage('stageChart_current'),
        stageNext: PA.charts.getImage('stageChart_next'),
        timelineCurrent: PA.charts.getImage('timelineChart_current'),
        timelineNext: PA.charts.getImage('timelineChart_next'),
        ownerCurrent: PA.charts.getImage('ownerChart_current'),
        ownerNext: PA.charts.getImage('ownerChart_next'),
        won: PA.charts.getImage('wonChart'),
        lead: PA.charts.getImage('leadChart'),
        segment: PA.charts.getImage('segmentChart')
      },
      meta: {
        generated: new Date().toISOString().slice(0, 10),
        filterSummary: filterSummaryText(),
        person: selectedPerson()
      }
    });
    PA.pdf.download(docDef, 'pipeline-analysis' + personSlug() + '-' + new Date().toISOString().slice(0, 10) + '.pdf');
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
      populateFilters(); recompute(); render(); saveState();
    });
    el.mappingSection.style.display = 'block';
    populateFilters();
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
        nextTarget: state.nextTarget,
        filters: state.filters,
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
    state.nextTarget = saved.nextTarget || '';
    state.filters = Object.assign({ owner: [], region: [], segment: [], stage: [], leadSource: [] }, saved.filters || {});
    state.proposedRemoved = saved.proposedRemoved || {};
    state.proposedAdded = saved.proposedAdded || [];

    // Reflect restored settings in the controls.
    el.granularity.value = state.timelineGranularity;
    el.includeClosed.checked = state.includeClosed;
    el.targetInput.value = state.target;
    el.nextTargetInput.value = state.nextTarget;

    onTableLoaded(saved.table, true);
  }

  function resetAll() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    state.table = null;
    state.mapping = null;
    state.results = null;
    state.target = '';
    state.nextTarget = '';
    state.includeClosed = false;
    state.timelineGranularity = 'quarter';
    state.filters = { owner: [], region: [], segment: [], stage: [], leadSource: [] };
    state.proposedRemoved = {};
    state.proposedAdded = [];
    el.targetInput.value = '';
    el.nextTargetInput.value = '';
    el.includeClosed.checked = false;
    el.granularity.value = 'quarter';
    el.fileInput.value = '';
    el.filtersRow.innerHTML = '';
    el.salespersonSelect.innerHTML = '<option value="">All salespeople</option>';
    el.mappingPanel.innerHTML = '';
    el.mappingSection.style.display = 'none';
    el.dashboard.style.display = 'none';
    setStatus('Data cleared. Upload a Salesforce CSV to start again.', 'info');
  }

  // ---- Filters ----
  // All filterable dimensions (used for summaries/clear). Owner is driven by the
  // dedicated single-select "Salesperson" control; the rest render as the
  // multi-select pills in the filters row.
  var FILTER_DIMS = [
    ['owner', 'Salesperson'], ['region', 'Region'], ['segment', 'Segment'],
    ['stage', 'Stage'], ['leadSource', 'Lead source']
  ];
  var MULTI_DIMS = FILTER_DIMS.filter(function (d) { return d[0] !== 'owner'; });

  function populateFilters() {
    if (!state.table || !state.mapping) return;
    if (PA.mapping.requiredMissing(state.mapping).length) {
      el.filtersRow.innerHTML = '';
      el.salespersonSelect.innerHTML = '<option value="">All salespeople</option>';
      return;
    }
    var vals = PA.analytics.distinctFilterValues(state.table.rows, state.mapping, { currentYear: state.currentYear });

    // Salesperson dropdown (single person) — drives state.filters.owner.
    state.filters.owner = (state.filters.owner || []).filter(function (v) { return vals.owner.indexOf(v) !== -1; });
    var selectedPerson = state.filters.owner.length === 1 ? state.filters.owner[0] : '';
    el.salespersonSelect.innerHTML = '<option value="">All salespeople</option>' +
      vals.owner.map(function (o) {
        return '<option value="' + escapeHtml(o) + '"' + (o === selectedPerson ? ' selected' : '') + '>' +
          escapeHtml(o) + '</option>';
      }).join('');

    // The remaining dimensions as multi-select pills.
    el.filtersRow.innerHTML = '';
    MULTI_DIMS.forEach(function (d) {
      var key = d[0];
      state.filters[key] = (state.filters[key] || []).filter(function (v) { return vals[key].indexOf(v) !== -1; });
      createMultiSelect(el.filtersRow, d[1], vals[key], state.filters[key], function (selected) {
        state.filters[key] = selected;
        recompute(); render(); saveState();
      });
    });
    updateFiltersSummary();
  }

  function onSalespersonChange() {
    var val = el.salespersonSelect.value;
    state.filters.owner = val ? [val] : [];
    recompute(); render(); saveState();
  }

  // The currently selected single salesperson, or null when viewing everyone.
  function selectedPerson() {
    return state.filters.owner && state.filters.owner.length === 1 ? state.filters.owner[0] : null;
  }

  function createMultiSelect(container, label, values, selected, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'ms';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ms-btn';
    var pop = document.createElement('div');
    pop.className = 'ms-pop';
    pop.style.display = 'none';
    var chosen = selected.slice();

    function refreshLabel() { btn.textContent = label + ': ' + (chosen.length ? chosen.length + ' selected' : 'All'); }
    refreshLabel();

    values.forEach(function (v) {
      var row = document.createElement('label');
      row.className = 'ms-opt';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = chosen.indexOf(v) !== -1;
      cb.addEventListener('change', function () {
        if (cb.checked) { if (chosen.indexOf(v) === -1) chosen.push(v); }
        else { chosen = chosen.filter(function (x) { return x !== v; }); }
        refreshLabel();
        onChange(chosen.slice());
      });
      var span = document.createElement('span');
      span.textContent = v || '(blank)';
      row.appendChild(cb); row.appendChild(span);
      pop.appendChild(row);
    });
    if (!values.length) {
      var empty = document.createElement('div');
      empty.className = 'muted'; empty.style.padding = '6px 8px';
      empty.textContent = 'No values'; pop.appendChild(empty);
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = pop.style.display !== 'none';
      closeAllPopovers();
      pop.style.display = isOpen ? 'none' : 'block';
    });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });

    wrap.appendChild(btn); wrap.appendChild(pop);
    container.appendChild(wrap);
  }

  function closeAllPopovers() {
    var pops = document.querySelectorAll('.ms-pop');
    for (var i = 0; i < pops.length; i++) pops[i].style.display = 'none';
  }

  function activeFilterKeys() {
    return FILTER_DIMS.map(function (d) { return d[0]; })
      .filter(function (k) { return state.filters[k] && state.filters[k].length; });
  }

  function updateFiltersSummary() {
    var active = activeFilterKeys();
    var labels = {}; FILTER_DIMS.forEach(function (d) { labels[d[0]] = d[1]; });
    el.filtersSummary.textContent = active.length
      ? 'Filtering: ' + active.map(function (k) { return labels[k] + ' (' + state.filters[k].length + ')'; }).join(', ')
      : 'No filters applied — showing all opportunities.';
  }

  function filterSummaryText() {
    var active = activeFilterKeys();
    if (!active.length) return '';
    var labels = {}; FILTER_DIMS.forEach(function (d) { labels[d[0]] = d[1]; });
    return active.map(function (k) { return labels[k] + ': ' + state.filters[k].join(', '); }).join('  ·  ');
  }

  function clearFilters() {
    FILTER_DIMS.forEach(function (d) { state.filters[d[0]] = []; });
    el.salespersonSelect.value = '';
    populateFilters(); recompute(); render(); saveState();
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
      includeClosed: state.includeClosed,
      filters: state.filters
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
    renderPerformance();
    renderForecast();
    renderInsights();
    updateFiltersSummary();
  }

  // Forecast Outlook card — anchored to the report month.
  function renderForecast() {
    if (!state.results) return;
    var f = currentForecast();
    $('fcMonthLabel').textContent = f.monthLabel;

    $('fcOrdersMonth').textContent = f.month.count + (f.month.count === 1 ? ' order' : ' orders');
    $('fcOrdersMonthSub').textContent = f.monthLabel + ' · ' + currency(f.month.total) + ' total · ' +
      currency(f.month.weighted) + ' weighted';

    $('fc90').textContent = currency(f.next90.total);
    $('fc90Sub').textContent = f.next90Label + ' · ' + currency(f.next90.weighted) + ' weighted · ' +
      f.next90.count + (f.next90.count === 1 ? ' deal' : ' deals');

    $('fc365').textContent = currency(f.next365.total);
    $('fc365Sub').textContent = f.next365Label + ' · ' + currency(f.next365.weighted) + ' weighted · ' +
      f.next365.count + (f.next365.count === 1 ? ' deal' : ' deals');

    $('fcStrategic').textContent = currency(f.strategic.total);
    $('fcStrategicSub').textContent = currency(f.strategic.weighted) + ' weighted · ' +
      (f.strategic.count
        ? f.strategic.count + (f.strategic.count === 1 ? ' opportunity' : ' opportunities')
        : 'none £10m+');
  }

  // Sales Performance card (current year).
  function renderPerformance() {
    if (!state.results) return;
    var p = currentPerformance();
    $('perfYearLabel').textContent = p.currentYear;
    $('perfWinRate').textContent = p.winRatePct == null ? '—' : Math.round(p.winRatePct) + '%';
    $('perfWinSub').textContent = (p.wonCount + p.lostCount)
      ? (p.wonCount + ' won / ' + p.lostCount + ' lost') : 'no closed deals yet';
    $('perfWinRateValue').textContent = p.winRateValuePct == null ? '—' : Math.round(p.winRateValuePct) + '%';
    $('perfCycle').textContent = p.avgCycleDays == null ? '—' : p.avgCycleDays + ' days';
    $('perfCycleSub').textContent = p.avgCycleDays == null
      ? (p.hasCreated ? 'no closed-won deals' : 'map a Created Date column')
      : ('over ' + p.cycleCount + ' won ' + (p.cycleCount === 1 ? 'deal' : 'deals'));
    $('perfVelocity').textContent = p.velocityPerDay == null ? '—' : currency(p.velocityPerDay) + '/day';
    $('perfVelocitySub').textContent = p.velocityPerDay == null
      ? 'needs win rate + sales cycle' : (currency(p.velocityPerMonth) + '/month');
  }

  function currentInsights() {
    return PA.analytics.insightMetrics(state.table.rows, state.mapping, new Date(),
      { includeClosed: state.includeClosed, filters: state.filters });
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

    // Awarded opportunities (current+next year) — name, value, owner + total.
    $('awardedYearLabel').textContent = ins.currentYear;
    var awHead = '<thead><tr><th>Opportunity</th><th>Value</th><th>Owner</th></tr></thead>';
    var awBody = ins.awarded.map(function (a) {
      return '<tr>' +
        '<td>' + escapeHtml(a.name) + '</td>' +
        '<td class="num">' + currency(a.amount) + '</td>' +
        '<td>' + escapeHtml(a.owner) + '</td>' +
      '</tr>';
    }).join('');
    var awFoot = ins.awarded.length
      ? '<tfoot><tr class="total-row">' +
          '<td>Total awarded</td>' +
          '<td class="num">' + currency(ins.awardedTotal) + '</td>' +
          '<td>' + ins.awarded.length + (ins.awarded.length === 1 ? ' deal' : ' deals') + '</td>' +
        '</tr></tfoot>'
      : '';
    $('awardedTable').innerHTML = awHead + '<tbody>' +
      (awBody || '<tr><td colspan="3" class="muted">No awarded opportunities.</td></tr>') +
      '</tbody>' + awFoot;

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

  function renderCoverage(elm, ratio, status, weighted, target, year) {
    if (ratio == null) {
      elm.className = 'coverage-result';
      elm.innerHTML = '<p class="muted">Enter a ' + year + ' target to see coverage.<br>Weighted forecast: <strong>' +
        currency(weighted) + '</strong></p>';
    } else {
      elm.className = 'coverage-result ' + status;
      elm.innerHTML =
        '<div class="coverage-ratio">' + Math.round(ratio) + '%</div>' +
        '<div class="coverage-sub">' + compact(weighted) + ' weighted against ' + compact(target) + ' target</div>';
    }
  }

  // Pipeline Health card — current year only. Safe to call on its own
  // (e.g. when the target input changes) without re-parsing the CSV.
  function renderHealth() {
    if (!state.results || !state.table || !state.mapping) return;
    var h = currentHealth();

    $('healthYearLabel').textContent = h.currentYear;
    var nextYear = state.results.nextYear;
    $('targetLabelCurrent').textContent = h.currentYear;
    $('targetLabelNext').textContent = nextYear;

    // Panel 1 — Coverage (current year)
    renderCoverage($('coverageResult'), h.coverageRatio, h.coverageStatus, h.weightedForecast, h.target, h.currentYear);

    // Next-year coverage (weighted forecast already excludes closed unless toggled)
    var nextWeighted = state.results.years[nextYear].weighted;
    var covNext = PA.analytics.coverage(nextWeighted, state.nextTarget);
    renderCoverage($('coverageResultNext'), covNext.ratio, covNext.status, nextWeighted, covNext.target, nextYear);

    // Panel 2 — Stale deals (open deals not amended in 6+ months)
    if (!h.hasLastModified) {
      $('staleSummary').innerHTML = '<span class="muted">Map a Last Modified Date column to see stale deals.</span>';
    } else {
      $('staleSummary').innerHTML =
        '<strong>' + h.stale.count + '</strong> stale ' + (h.stale.count === 1 ? 'deal' : 'deals') +
        '<div class="stale-values">' + currency(h.stale.totalValue) + ' total · ' +
        currency(h.stale.weightedValue) + ' weighted</div>';
    }

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
