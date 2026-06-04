# Timesheet

A personal web app for tracking work hours, time off, and paychecks across
multiple companies. It started life as an Excel workbook and became a web app
so the data syncs across phone and desktop.

**Live:** https://raviknight.github.io/Timesheet/

## What it does

- **Daily log** — clock in/out with multiple segments per day (clock out for a
  personal errand, then back in), notes, and time-off entries (PTO, Sick,
  Holiday, Unpaid).
- **Pay periods** — weekly, bi-weekly, semi-monthly, monthly, or a custom
  cycle; current / last / other period selector; regular, overtime, and
  time-off totals with a per-week breakdown.
- **Balances** — PTO and sick pools shown as Taken / Scheduled / Remaining.
- **Paychecks** — gross, take-home, hours, and company, with year-to-date
  totals.
- **Multiple companies** — track more than one employer and switch the active
  company.
- **Cross-device sync** — records persist locally or to a hosted backend so the
  same data shows up on every device.

## Tech stack

- **Vanilla JavaScript, ES modules** — no framework. The browser loads the
  source modules directly during development.
- **esbuild** — bundles the whole app into a single distributable HTML file
  that runs from anywhere, even double-clicked off a USB stick.
- **Supabase** — Postgres, authentication, and row-level security for the
  hosted, synced storage mode.
- **GitHub Pages** — hosts the live build.

## Repository structure

| Path          | What lives there                                                        |
| ------------- | ----------------------------------------------------------------------- |
| `src/core/`   | Pure logic: time and date math, pay-period systems, balance pools, and display formatting. |
| `src/data/`   | Persistence: a storage abstraction with local and remote modes, schema defaults and migrations, seed data, and account bootstrap. |
| `src/ui/`     | Views: the pay-period dashboard, daily log, paychecks, settings, top bar, tabs, and sign-in. |
| `src/modals/` | Editors: the multi-segment day entry editor and the paycheck editor.    |
| `docs/`       | Project context, architecture decisions, and the original Excel logic this app replaces. |

The UI layer never touches storage directly. It goes through the `src/data`
abstraction, which is the single place that decides between local and synced
persistence.

## Usage and license

This project is **source-available**, not open source. It is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE).

- You may read the code, study it, and learn from how it is built.
- You may use and modify it for personal and other noncommercial purposes.
- You may **not** run a competing or commercial copy.

The repository is public so others can read and learn from it. It is not
intended as a self-hosting guide. See [LICENSE](LICENSE) for the full terms.
