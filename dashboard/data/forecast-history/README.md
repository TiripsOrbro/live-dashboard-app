# Forecast history backfill

The forecast tool shapes **hourly** Macromatix forecasts from **5 weeks** of stored hourly actual sales.

## What to send (Area 22 or any store)

Provide **hourly actual sales $** for each store and each day (ideally 35 consecutive days ending yesterday).

### Preferred format — JSON file

Copy `import-template.json` and fill in the `days` object:

```json
{
  "days": {
    "2026-05-12": {
      "3811": {
        "openHour": 10,
        "closeHour": 22,
        "actual": [120.5, 340.2, 580.0, 620.1, 410.5, 380.0, 720.4, 890.2, 950.0, 880.1, 620.0, 410.3]
      },
      "3806": { "openHour": 10, "closeHour": 22, "actual": [ ... ] }
    }
  }
}
```

### Field rules

| Field | Required | Meaning |
|--------|----------|---------|
| `date` key | Yes | `YYYY-MM-DD` trading date |
| `actual` | Yes | Hourly actual **Ex Tax sales $** for the trading window |
| `openHour` | Recommended | First hour in `actual[]` (24h clock, e.g. `10` = 10am) |
| `closeHour` | Recommended | Close hour (e.g. `22`); length of `actual[]` should be `closeHour - openHour` |
| `actualTotal` | Optional | Day total; computed from `actual[]` if omitted |
| `actualRaw` | Optional | Full Macromatix Labour Scheduler array (index 0 = **5am**). Set `"actualFormat": "raw-mmx"` |

### Area 22 store numbers (7 stores)

`3806`, `3808`, `3811`, `3901`, `3902`, `3903`, `3904`

Perth stores (`3901`–`3904`) may have different trading hours — include correct `openHour` / `closeHour` per store.

### Macromatix "Sales by Hour Interval" CSV

If you export **Sales by Hour Interval** from Macromatix (6 weeks × 7 stores), import directly:

```bash
npm run import-forecast-history-csv -- "C:/path/Sales_by_Hour_Interval.csv"
```

The parser reads week-ending dates from the row below the `Standard Day of Week` header, maps columns C–H through AM–AR to the Area 22 stores above, and builds hourly `actual[]` arrays aligned to each store's trading window.

### Area 22 Forecast Calculator workbook (`.xlsx`)

One tab per store (skips first two summary tabs). Each store tab has **Current Week**, **Last Week**, **Two Weeks Ago**, and **Three Weeks Ago** sections with hourly **Sales** per weekday column.

```bash
npm run import-forecast-history-xlsx -- "C:/path/A) Forecast Calculator - A22.xlsx"
npm run import-forecast-history-xlsx -- file.xlsx --as-of 2026-06-13 --force
```

`--as-of` sets which calendar week is treated as "Current Week" (defaults to today). Week-ending Sunday is derived from that date.

**Canonical Area 22 backfill file:** `area22-backfill-xlsx.json` (175 store-days, 25 per store, 4 weeks from the calculator workbook). Re-import after updating the xlsx:

```bash
npm run import-forecast-history-xlsx -- "path/to/A) Forecast Calculator - A22.xlsx" --as-of YYYY-MM-DD --out dashboard/data/forecast-history/area22-backfill-xlsx.json --force
```

### Where the numbers come from in Macromatix

**Labour Scheduler → Day view → Actual Sales row** (same hourly grid the live dashboard uses).

- One value per hour from store open through close (not the full 5am–midnight grid unless you use `actualRaw`).
- Use **final end-of-day** numbers (after close), not intraday partials.

## Import

```bash
npm run import-forecast-history -- dashboard/data/forecast-history/your-area22-backfill.json
npm run import-forecast-history -- dashboard/data/forecast-history/your-file.json --force
```

After import, open **Admin menu → Forecast tool**. The **History** column turns green when each weekday has at least **3** sample days in the rolling 35-day window.

## Live capture

After backfill, the server appends one finalized day per store automatically **after close** each trading day.

Older days roll into a **compact archive** (hourly totals kept; heavy `actualRaw` grids dropped). Default retention:

| Setting | Default | Purpose |
|---------|---------|---------|
| `FORECAST_HISTORY_DAYS` | 35 | Hot window used for forecast calculations |
| `FORECAST_HISTORY_ARCHIVE_DAYS` | 182 (~26 weeks) | How far back the sales history UI can browse |

Set `FORECAST_HISTORY_ARCHIVE_DAYS` equal to `FORECAST_HISTORY_DAYS` to disable archiving and delete data after the hot window (previous behaviour).

## Minimum data to run forecast

- **35 days** ideal (5 samples per weekday)
- **At least 3 days per weekday** required (Mon–Sun) before **Run** is enabled
