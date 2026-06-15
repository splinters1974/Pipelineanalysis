# Pipeline Analysis

A small, **fully local** web app that turns a Salesforce opportunity report
(CSV export) into a single dashboard view of your pipeline for the **current
calendar year and the following year**.

Everything runs in your browser — **your file is never uploaded anywhere**.
There is no server, no account, and no internet connection required.

## What it shows

For both the current year and next year, side by side:

- **KPI cards** — total pipeline, weighted forecast, and number of opportunities.
- **Value by stage** — pipeline grouped by sales stage.
- **Timeline** — pipeline spread across quarters (toggle to months).
- **By owner** — top sales reps by pipeline.
- **By product / region** — breakdown by product line and region/territory.

"Weighted forecast" = `Amount × win probability`. If your report includes a
probability column it is used directly; otherwise the app estimates a
probability from each opportunity's stage (see *Weighted forecast* below).

## Pipeline Insights

A full-width **Pipeline Insights** card (above the year columns) adds:

- **Avg age of open opportunities** — mean days from Created Date to today
  across all open (non-closed) deals.
- **Won revenue (current year) by owner** — a doughnut of Closed Won value split
  by salesperson, with the total and deal count.
- **Lead source mix** — a doughnut showing the % of the open pipeline coming
  from each lead source.
- **Top 10 proposed opportunities** — the strongest Proposed-stage deals, ranked
  by a blend of win probability (rating), value and nearest close date, with the
  Next Step shown. You can **remove** any row (✕) and **add** any other
  opportunity from the dropdown, so the list is yours to curate.

Each year's **Value by stage** table also shows a **Total** row (pipeline and
weighted) at the bottom.

The **Awarded** stage is treated as open pipeline (not closed) but carries a high
win weighting (90% by default), so it shows in each year's value *and* weighted
charts.

## Column mapping (optional fields)

Beyond the required Amount / Close Date / Stage, you can map: Probability, Owner,
Product, Region, **Last Modified Date** (stale detection), **Created Date** (open
age), **Next Step** (top-5 list) and **Lead Source** (source mix). Each is
auto-detected and adjustable in the mapping panel; features that need a column
they can't find show a short "map this column" hint.

## Saved sessions

Your uploaded data, column mapping, target, toggles and manual top-10 edits are
saved in the browser's **localStorage**, so closing the tab or browser and
reopening `index.html` brings everything straight back — no re-upload needed.
The data stays on your machine. Use the **Reset / new file** button to clear it
and return to the upload screen. (If your browser blocks storage on `file://`,
run the local-server option instead and persistence will work.)

## Exporting the view

Two buttons sit in the dashboard controls:

- **Download PDF report** — generates a clean, paginated PDF with
  [pdfmake](https://pdfmake.github.io/) (vendored, offline). Vector tables print
  crisply; charts are embedded at a controlled size; every page has a footer with
  the date and page numbers. Layout:
  1. **Page 1** — current year (2026) and following year (2027) side by side:
     KPIs, value-by-stage chart + table (with totals), quarterly timeline, and
     by-owner chart + table.
  2. **Page 2** — average age of open opportunities, the two pie charts
     (won-by-owner, lead source) and the top-10 proposed table.
  3. **Page 3** — by segment and the stale-deal list.

  The document is assembled by the pure, testable `PA.pdf.buildDocDefinition`
  in `js/pdf.js`; `js/app.js` captures the chart images and triggers the
  download. (Browser `Ctrl/Cmd+P` still works too, via a print stylesheet.)
- **Download summary (CSV)** — exports all the computed figures (KPIs,
  by-stage with totals, by-owner, quarterly timeline, coverage, segments,
  stale-deal list and the insights) as a spreadsheet-friendly CSV. Built by the
  pure `PA.export.buildSummaryCsv` function in `js/export.js`.

## Pipeline Health

A full-width **Pipeline Health** card sits above the year columns and focuses on
the **current year**. It has three panels:

1. **Coverage** — type a £ target; shows weighted-forecast ÷ target as a
   colour-coded percentage (green ≥ 80%, amber 50–79%, red < 50%).
2. **Stale deals** — flags open deals whose **Close Date is in the past** or
   whose **Last Modified Date** is more than `STALE_THRESHOLD_DAYS` (default 30)
   days old. Shows a count, total value and a scrollable list (most stale first).
3. **By segment** — maps the Product / Product Family column to Ameresco's five
   segments (I&C, Cities & Local Government, Public Sector, Grid-Scale, Data
   Centres) and charts pipeline value per segment; unmapped products go to
   *Other*.

Both the stale threshold (`STALE_THRESHOLD_DAYS`) and the product→segment rules
(`SEGMENT_MAP`) live at the top of `js/analytics.js` for easy editing. To map
"days since last modified", include a **Last Modified Date** column in your
report (optional — staleness still works off close dates without it).

## How to run

### Option A — just open it (simplest)

Double-click **`index.html`** to open it in your browser. Then click **Choose
file** and pick your Salesforce CSV export.

> Note: when opened this way (via `file://`), the **Load sample data** button
> can't auto-read the bundled sample because browsers block local file reads.
> Use **Choose file** and select `sample/sample_pipeline.csv` instead — that
> always works.

### Option B — run a tiny local server (enables the sample button)

From this folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000> and use **Load sample data** or upload your own.

## How to export the report from Salesforce

1. Go to **Reports** and open (or build) an **Opportunities** report.
2. Make sure the report includes at least: **Amount**, **Close Date**, and
   **Stage**. Helpful extras: **Probability**, **Opportunity Owner**,
   **Product / Product Family**, **Region / Territory**, **Last Modified Date**.
3. Click the dropdown (▾) → **Export**.
4. Choose **Details Only** and format **Comma Delimited (.csv)**, then export.
5. Upload that file here.

The app tolerates the "Formatted" export too — it skips report-title and
grand-total/footer rows automatically — but **Details Only** is cleanest.

## Column mapping

After you upload, the app guesses which columns to use and shows a mapping
panel. Required fields are **Amount**, **Close Date**, and **Stage** (marked
with `*`). Correct any wrong guess with the dropdowns; the dashboard recomputes
instantly. Owner, Product and Region are optional and their charts simply show
"—" if absent.

## Weighted forecast (stage estimates)

When no probability column is mapped, these default stage → win-probability
estimates are used (editable in `js/analytics.js`, `DEFAULT_STAGE_WEIGHTS`):

| Stage contains | Probability |
| --- | --- |
| closed won | 100% |
| negotiation | 75% |
| proposal / quote | 50% |
| qualification | 25% |
| discovery | 20% |
| prospecting / lead | 10% |
| closed lost | 0% |
| (anything else) | 20% |

## Notes & assumptions

- **Years** are calendar years based on **Close Date**. "Current year" is taken
  from your computer's clock; "following year" is the year after.
- **Closed deals** (Won/Lost) are excluded from the pipeline by default; tick
  *Include closed deals* to add them.
- **Dates**: the app auto-detects day-first (DD/MM/YYYY) vs month-first
  (MM/DD/YYYY) from your data and shows which it chose in the status bar.
- **Amounts**: currency symbols, thousands separators and `(parentheses)`
  negatives are cleaned automatically.

## Project layout

```
index.html              App shell + dashboard layout
css/styles.css          Styling
js/parse.js             CSV reading + Salesforce-export cleanup
js/mapping.js           Column auto-detection + mapping UI
js/analytics.js         Pipeline calculations (pure, testable)
js/charts.js            Chart.js render helpers
js/export.js            Summary CSV builder (pure, testable)
js/pdf.js               PDF report builder via pdfmake (pure doc-definition)
js/app.js               Orchestration + DOM wiring
vendor/                 PapaParse + Chart.js (vendored, offline)
sample/sample_pipeline.csv   Synthetic Salesforce-style report
test/run.js             Headless logic tests (node test/run.js)
```

## Tests

```bash
node test/run.js
```

Runs the parsing and analytics logic against the sample data and checks the
totals, weighted forecast, year filtering and currency cleaning.
