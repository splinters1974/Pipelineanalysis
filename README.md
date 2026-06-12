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
   **Product / Product Family**, **Region / Territory**.
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
