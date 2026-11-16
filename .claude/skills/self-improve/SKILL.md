---
name: self-improve
description: Mandatory end-of-task loop that keeps this repo's agent skills and docs correct - fix wrong instructions, record new gotchas, create a skill when a pattern repeats, prune stale content, run the skills checker, and log the change. Use at the end of every task, whenever a skill or doc turned out to be wrong, when the user corrects you, or when asked to improve/audit the skills.
---

# Self-improvement loop

The skills in `.claude/skills/` are this repo's memory for agents. They are only useful while they're true. Every agent that works here leaves them more accurate than it found them.

## When to run

- **At the end of every task.** It takes about two minutes and is usually a no-op.
- **Immediately** when a skill or doc instruction proved wrong, when you lost more than 10 minutes on something non-obvious, or when the user corrected you.

## The loop

### 1. Reflect (answer these silently)

- Which skills did I use? Was anything in them **wrong, missing or misleading** for this task?
- Did I change code that a skill describes: file paths, function names, flow, defaults, models, prices, the status list?
- What did I learn that the next agent would otherwise rediscover the hard way?
- Did the user correct me, or state a preference about how to work in this repo?

If all the answers are "no", skip to step 5 and only run the checker.

### 2. Fix in place first

- A wrong statement gets **edited or deleted** where it is. Don't append "actually..." below it.
- If you changed behavior a skill describes, update that skill in the **same commit** as the code.
- Update the `Last verified against code:` date on any skill whose content you re-checked against the code.

### 3. Add a gotcha (only if it passes the bar)

Add it to the **Gotchas** section of the most specific skill. A gotcha must be:

- **Verified:** observed in code or in a run, never guessed. If you suspect something but didn't confirm it, mark it `Unverified:` and say how to check it.
- **Non-obvious:** something the code doesn't make clear at a glance.
- **Actionable:** it says what to do or check.
- **Anchored:** it names the file or function. Use names, not line numbers, because lines drift.

Format: `- **<short claim>.** <evidence / what to do>.` One to three lines.

User preferences and decisions ("Nadav wants X") go in the relevant skill as a rule with the date, for example: `(Nadav, 2026-10-29)`.

### 4. Structural changes (rare)

- **New skill:** only when the same kind of task has needed knowledge from scratch twice, or a skill's section has grown past about 60 lines on one topic. Copy `references/skill-template.md`, add the skill to the table in `AGENTS.md`, and keep `name` equal to the folder name.
- **Size:** keep each `SKILL.md` under about 150 lines. Move deep detail into `.claude/skills/<name>/references/*.md` and link to it.
- **Prune:** delete gotchas that no longer apply because the bug was fixed or the code was removed. A fixed bug is not a gotcha.
- **Upstream docs:** if `PROJECT_CONTEXT.md`, `docs/*.md` or `src/agents/*/agent.md` contradict the code, fix them too, or list the contradiction in the relevant skill if fixing it needs a decision from Nadav.

### 5. Check and log

```bash
npm run skills:check
```

It fails on missing frontmatter, a name/folder mismatch, a skill missing from the `AGENTS.md` table, or backticked repo paths that no longer exist. It warns on oversized skills and on `Last verified` dates older than 90 days. Fix every failure.

Append one line per change to `.claude/skills/CHANGELOG.md`:

```
- 2026-10-29 · <skill> · <what changed> · <why: task / evidence>
```

### 6. Commit

Commit skill changes together with the code they describe. If there's no related code change, commit them separately as `docs(skills): <summary>`.

## Never

- Never write secrets, tokens, customer names or invoice data into skills.
- Never record speculation as fact.
- Never rewrite another skill's scope wholesale without a reason in the changelog.
- Never delete the self-improvement footer from a skill.

## Periodic audit (when asked to "improve the skills")

For each skill: re-read it against the current code, re-verify every claim, update `Last verified`, merge duplicates, prune, and run the checker. Report what changed and what still needs a decision from Nadav.
