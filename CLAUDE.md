@AGENTS.md

## Claude Code notes

- Skills live in `.claude/skills/` and load by their `description`. If a task touches an area that a skill covers, read that skill before editing.
- At the end of a task, run the `self-improve` skill. Don't skip it for "small" changes: small changes are where skills silently go stale.
