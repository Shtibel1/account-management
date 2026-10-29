# AGENTS.md — start here

Entry point for any coding agent (Claude Code, Codex, Cursor, Copilot, ...). Read this file first, then load only the skills that match your task.

## What this is

**Invoice Scan** (`invoice-validator-fullstack`): a Next.js 16 app for Israeli bookkeeping firms. Accountants upload Hebrew invoices (PDF/images) per client, a LangGraph pipeline runs OCR (Google Vision), extraction (Claude), and deterministic validation. A human then approves each invoice side by side with the original, and approved invoices are exported to the Move-in ERP format.

## Commands

| Command | Use |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Dev server on http://localhost:3001 |
| `npx tsc --noEmit` | Type check. This is the main automated gate, because the repo has no test suite |
| `npm run build` | Production build (what AWS Amplify runs) |
| `npm run skills:check` | Validate the agent skills (paths exist, index in sync) |
| `npm run db:pull-types` | Regenerate `src/shared/supabase-types.ts` after a schema change (needs Supabase CLI login) |
| `npm run bump-version` | Bump the patch version (`package.json` + `src/shared/version.json`) |

Without Supabase env vars, the app runs against a local JSON mock DB (`mock_db.json`). See the `supabase-data` skill.

## Map

```
src/agents/      LangGraph pipeline: supervisor (graph) → preprocessor → extraction → validation → approval
src/app/         Next.js routes: (dashboard), (marketing), api/
src/components/  InvoiceTable, SplitPane (ImageViewer + ValidationForm), UploadZone, ui/
src/lib/         supabase.ts (server client), api.ts (browser API client), exporters/movein.ts
src/shared/      types.ts (domain types), schemas.ts (Zod), version.json
src/utils/       encoding.ts (Win-1255 / visual Hebrew), businessLookup.ts (data.gov.il), supabase/ (clients + mock)
docs/            coding_standards.md, db_schema.md
scratch/         ad-hoc debug scripts (not part of the app)
legacy/          old Express + separate web app. Excluded from tsconfig. Read-only reference; don't edit
```

## Skills (`.claude/skills/<name>/SKILL.md`)

Claude Code loads these automatically. Other agents should open the matching file before starting.

| Skill | Load when |
|---|---|
| `invoice-pipeline` | Touching anything in `src/agents/`, pipeline routing, retries, OCR, LLM calls, HITL approval, cost tracking |
| `israeli-invoice-rules` | VAT IDs, amounts/VAT math, exempt suppliers, credit notes, expense categories, supplier lookup |
| `erp-export` | Export files, Move-in format, Windows-1255 / visual Hebrew, adding a new exporter |
| `supabase-data` | DB tables, storage, Supabase clients, the mock DB, schema changes |
| `verify-changes` | Before declaring any task done |
| `self-improve` | **At the end of every task.** It keeps these skills correct |

## Hard rules

1. **No `any`** in new code. Use the shared types in `src/shared/types.ts`. Use `@/` absolute imports. See `docs/coding_standards.md`.
2. **Never catch errors silently.** Log with a `[Module]` prefix and rethrow, or mark the invoice `status: 'error'` with `error_message`.
3. **Hebrew in export files** must go through `toVisualHebrew` and then `encodeWindows1255` (`src/utils/encoding.ts`).
4. **Keep `src/shared/types.ts` and `src/shared/schemas.ts` in sync.** They have already drifted (see the `supabase-data` skill).
5. **Secrets:** never commit `.env*` and never print keys. Env var names are listed in `README.md`.
6. **Don't edit `legacy/`.** Don't add `scratch/` scripts to the app build.
7. **Commits** follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`). After a completed code task, run `npm run bump-version` and commit, as `docs/coding_standards.md` requires.

## Self-improvement (required)

Before you finish **any** task, run the loop in `.claude/skills/self-improve/SKILL.md`:

- Did a skill or doc say something that turned out to be wrong? Fix it now.
- Did you learn a non-obvious fact that cost you time? Add it to the right skill's **Gotchas** section.
- Run `npm run skills:check` and log what you changed in `.claude/skills/CHANGELOG.md`.

A task is not done while the skills still describe the old behavior of code you changed.

## Other docs

- `PROJECT_CONTEXT.md`: architecture overview and the original AI protocol
- `docs/coding_standards.md`: TypeScript, error handling, git rules
- `docs/db_schema.md`: how DB types are generated
- `src/agents/*/agent.md`: per-agent specs. **Where code and spec disagree, the code is current behavior.** The skills list the known disagreements.
