---
name: verify-changes
description: How to verify a change in this repo before calling it done - type check, build, running in mock mode vs real Supabase, exercising the pipeline and UI, and what to report. Use before finishing any code task, or when asked "does it work?".
---

# Verify changes

Last verified against code: 2026-10-29

There is **no test suite** and **no working lint**: `npm run lint` calls `next lint`, which was removed in Next 16. Don't report lint as passed. Verification is:

1. **Type check (always):** `npx tsc --noEmit`. `legacy/` is excluded. Fix new errors you introduced. Note pre-existing ones and leave them alone.
2. **Build (for route, config or dependency changes):** `npm run build`. This is what Amplify runs (`amplify.yml`).
3. **Pure logic:** for functions without I/O (validation helpers, `matchBboxesWithOcr`, encoding, exporter lines), run them on concrete inputs with a throwaway script (`npx tsx -e "..."`, or a file in `scratch/`) and state the inputs and outputs in your report.
4. **Pipeline / external APIs:** needs `.env.local` with Google Vision, Anthropic and Supabase keys. If they're missing, say so: don't claim the pipeline was verified. `scratch/test_*.js` are prior ad-hoc probes; reuse them, and expect some to be stale.
5. **UI changes:** `npm run dev` (port 3001). Open the affected page (`/upload`, `/review/[id]`, `/clients`, `/mappings`), interact, and take a screenshot. The UI is RTL Hebrew, so check the alignment and that the bbox highlights in `ImageViewer` land on the right words.

## Mock-mode caveat

With no Supabase env vars, everything runs on `mock_db.json`. Upload, storage and some queries behave differently, and some validation checks are skipped (see `supabase-data`). Say "verified in mock mode" explicitly.

## Report format

What you ran, what passed, what you couldn't run and why. Never "should work".

## Before commit

- Conventional commit message.
- Code change: `npm run bump-version`, as `docs/coding_standards.md` requires.
- Run the `self-improve` skill, then `npm run skills:check`.

---
Finished the task? Run the `self-improve` skill.
