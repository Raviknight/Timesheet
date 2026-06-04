# CLAUDE.md

**Read this first.** This file is the entrypoint for any Claude (chat or Claude
Code) picking up work on this project. It points to everything else.

## What this project is

A personal time sheet web app. Tracks daily clock in/out, multi-segment work
days, time-off (PTO/Sick/Holiday/Unpaid), pay periods, and paychecks. Built
originally as an Excel workbook (`Time_Sheet_2026.xlsx`), now a web app so the
data syncs across phone + desktop.

**Owner:** Ravi Sharma (Quality Engineer, Ferry Machines).
**Stage:** Personal use today. Future: sell to small companies for
multi-employee tracking with supervisor approval and biometric/badge punch
integration.

## Where to look for what

| Need to understand…              | Read                          |
| -------------------------------- | ----------------------------- |
| Current state + what's next      | `docs/CONTEXT.md`             |
| Architecture decisions made      | `docs/DECISIONS.md`           |
| How to run / build / deploy      | `README.md`                   |
| The Excel logic this replaces    | `docs/EXCEL_LOGIC.md`         |
| Roadmap / future expansion       | `docs/ROADMAP.md`             |

Each `src/` subfolder has its own short header comment in every file
explaining what it does. Start there before opening the code itself.

## Working agreements

These are the conventions Ravi and previous Claude sessions have settled on.
Stick to them unless explicitly told otherwise.

1. **No em dashes** in user-facing text or commit messages. Use commas, colons,
   or two short sentences.
2. **No emojis** in code, UI, or docs.
3. **Use the user's existing form names** (F-02, F-67, etc.) when relevant.
   This project doesn't touch them, but the broader work context does.
4. **Round numbers before display.** All hours shown go through `toFixed(2)`.
   Money is `toLocaleString` with 0 decimals.
5. **Time math uses 15-minute rounding** (matches the original Excel
   `ROUND(x*96,0)/96` logic).
6. **Break is deducted per segment**, not per day, and only when that segment
   is > 5h on a weekday. See `src/core/time.js` for the canonical
   implementation.
7. **Storage layer is abstracted.** Code never calls `window.storage` or
   `localStorage` directly. Always go through `src/data/storage.js`.
8. **Schema versioning is real.** Bump `SCHEMA_VERSION` and add a migration
   in `src/data/schema.js` whenever the entry/pay shape changes.

## Module map

```
src/
├── app.js              Boot, view switching, top-level wiring
├── core/
│   ├── time.js         Time/date helpers, segment hours math
│   ├── period.js       Pay period systems (weekly/biweekly/semi/monthly/advanced)
│   ├── balances.js     PTO/sick pool calculations
│   └── format.js       Display formatting, escapeHtml
├── data/
│   ├── storage.js      Persistence abstraction
│   ├── schema.js       Defaults + migrations
│   └── seed.js         First-run seed data (Ravi's original entries)
├── ui/
│   ├── topbar.js       Top bar with user/sync indicator
│   ├── tabs.js         Tab switching
│   ├── dashboard.js    Pay Period view
│   ├── log.js          Daily Log view
│   ├── paychecks.js    Paychecks view
│   └── settings.js     Settings view
├── modals/
│   ├── entryModal.js   Multi-segment entry editor
│   └── payModal.js     Paycheck editor
└── auth/
    └── roles.js        Capability checks (scaffolded for multi-tenant future)
```

## Quick start (for a new Claude session)

```bash
# 1. Read these in order
cat CLAUDE.md
cat docs/CONTEXT.md     # what we did, what's next
cat docs/DECISIONS.md   # the "why" behind big choices

# 2. Run locally (any of these)
npx serve .             # easiest: any static server works
python3 -m http.server  # if Python is handy

# 3. Build the single-file distribution
npm run build           # outputs dist/timesheet.html

# 4. Run tests (when added)
npm test
```

## How to update this doc

When you finish a meaningful chunk of work, update `docs/CONTEXT.md` with:

- What was done this session
- What's in flight
- What's blocked or undecided

That way the next session (whether it's you tomorrow, a different chat, or
Claude Code in VS Code) picks up cleanly.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
