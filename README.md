# Time Sheet

Personal time sheet web app. Multi-segment work days, configurable pay
periods, PTO/Sick tracking, paychecks. Built originally as an Excel workbook,
now a web app that syncs across devices.

## What it does

- **Daily log** — clock in/out, multiple segments per day (clock out for
  personal then back in), notes, time-off (PTO/Sick/Holiday/Unpaid)
- **Pay period view** — weekly, bi-weekly, semi-monthly, monthly, or advanced
  custom cycle; current/last/other period selector; regular + OT + time-off
  totals; per-week breakdown
- **Balances** — PTO pool with split Taken / Scheduled / Remaining display
- **Paychecks** — gross / take-home / hours / company, YTD totals
- **Cross-device sync** — uses Anthropic `window.storage` when opened inside
  Claude.ai, falls back to `localStorage` otherwise

## Quick start

### Open the built file (simplest)

After `npm run build`, just open `dist/timesheet.html` in a browser. Works
double-clicked, on a USB stick, or deployed anywhere.

### Develop with live source files

```bash
# Install once
npm install

# Dev server (needed because ES modules don't work over file://)
npm run dev

# Then open http://localhost:5173/
```

### Build single-file distribution

```bash
npm run build
# → dist/timesheet.html  (one self-contained file, ~120 KB)
# → dist/index.html      (same content, named for static hosts)
```

## Deploy to GitHub Pages

The fastest path to a public URL. Free, automatic HTTPS, your own domain
optional.

### One-time setup

1. **Create a GitHub repository.** Push the whole project folder. The repo
   can be private or public; GitHub Pages works with either if you have a
   paid account, or only public on a free account.

2. **Build before pushing:**

   ```bash
   npm run build
   git add dist/
   git commit -m "build"
   git push
   ```

3. **Enable Pages in repo settings:**
   - Go to `Settings → Pages` in your repo on github.com
   - Source: **Deploy from a branch**
   - Branch: `main` (or whatever branch you push to)
   - Folder: `/dist`
   - Click Save

4. **Wait 1–2 minutes**, then visit
   `https://<your-username>.github.io/<repo-name>/`

### Updating

Every time you change the code:

```bash
npm run build
git add -A
git commit -m "your message"
git push
```

GitHub Pages picks up the new `dist/` automatically.

### Custom domain (optional)

In repo `Settings → Pages → Custom domain`, enter your domain. Add a CNAME
or A record at your DNS provider per GitHub's instructions. SSL is free and
automatic.

## Deploying somewhere other than GitHub Pages

The `dist/` folder is a vanilla static site, so it deploys to anything:

- **Cloudflare Pages** — `wrangler pages deploy dist`. Best free tier, no
  bandwidth limit.
- **Netlify** — drag `dist/` onto netlify.com/drop, or connect the repo.
- **Vercel** — `vercel --prod` from the project root. Free for personal
  (non-commercial) use.
- **Surge** — `npx surge dist`. One command, no account juggling.
- **Your own server / NAS** — copy `dist/timesheet.html` anywhere a web
  server can find it.

## Project layout

```
timesheet/
├── CLAUDE.md            Start here if you're new (or a fresh Claude session)
├── README.md            This file
├── docs/
│   ├── CONTEXT.md       Living progress doc (update each session)
│   ├── DECISIONS.md     Architectural decisions log
│   ├── ROADMAP.md       Future direction (multi-tenant, hardware punch)
│   └── EXCEL_LOGIC.md   Rules preserved from the original Excel workbook
├── index.html           HTML shell (uses src/ at dev time)
├── assets/styles.css    All styles
├── src/                 ES module source code
│   ├── app.js               Entry point
│   ├── core/{time,period,balances,format}.js   Pure logic
│   ├── data/{storage,schema,seed}.js           Persistence + defaults
│   ├── ui/{topbar,toast,tabs,dashboard,log,paychecks,settings}.js
│   ├── modals/{entryModal,payModal}.js
│   └── auth/roles.js        Capability checks (multi-tenant scaffolding)
├── scripts/build.mjs    esbuild bundle script
├── dist/                Build output (committed for GitHub Pages)
└── package.json
```

## What's where

| If you want to change…                | Look in…                          |
| ------------------------------------- | --------------------------------- |
| How hours are calculated              | `src/core/time.js`                |
| Pay period system (weekly/biweekly…)  | `src/core/period.js`              |
| PTO pool math                         | `src/core/balances.js`            |
| Where data is stored                  | `src/data/storage.js`             |
| Default settings, time-off types      | `src/data/schema.js`              |
| The pre-loaded entries (Ravi's data)  | `src/data/seed.js`                |
| A view's UI                           | `src/ui/<viewname>.js`            |
| Entry editor                          | `src/modals/entryModal.js`        |
| Styles                                | `assets/styles.css`               |

## Tech stack

- **Vanilla ES modules.** No framework. Hand-rolled state, manual rerender.
- **esbuild** for production bundling to a single file.
- **`window.storage`** for cross-device sync inside Claude.ai;
  **`localStorage`** fallback for plain-file use.
- **No external runtime dependencies.** Everything ships in one HTML file.

## Working with Claude (Claude Code or chat)

When starting a new Claude session on this project:

1. Read `CLAUDE.md` first — it's the orientation doc.
2. Read `docs/CONTEXT.md` — current state and what's next.
3. Read `docs/DECISIONS.md` — the "why" behind architectural choices.

When ending a session, append a session-log entry to `docs/CONTEXT.md` so the
next session starts informed.

## License

Personal project. Add a LICENSE file if you intend to share or sell.
