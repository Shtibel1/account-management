#!/usr/bin/env node
/**
 * Validates agent skills in .claude/skills/ (see .claude/skills/self-improve/SKILL.md).
 * Errors (exit 1): bad frontmatter, name != folder, skill missing from AGENTS.md,
 *                  backticked repo paths that don't exist, missing self-improve footer.
 * Warnings: SKILL.md over 150 lines, "Last verified" missing or older than 90 days.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');
const MAX_LINES = 150;
const STALE_DAYS = 90;
// Paths that are referenced on purpose but are generated or local-only.
const ALLOWED_MISSING = new Set(['src/shared/supabase-types.ts', 'mock_db.json', '.env.local']);
const PATH_RE = /`((?:src|docs|scripts|legacy|scratch|\.claude)\/[^`\s]+|[A-Za-z_]+\.(?:md|json|yml|ts|js))`/g;

const errors = [];
const warnings = [];

function checkPaths(file, text, baseDir) {
  for (const match of text.matchAll(PATH_RE)) {
    const ref = match[1].replace(/[),.:;]+$/, '');
    if (/[<>*]/.test(ref) || ALLOWED_MISSING.has(ref)) continue;
    const candidates = [path.join(ROOT, ref), path.join(baseDir, ref)];
    if (!candidates.some((p) => fs.existsSync(p))) {
      errors.push(`${file}: referenced path does not exist: ${ref}`);
    }
  }
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

const agentsMdPath = path.join(ROOT, 'AGENTS.md');
const agentsMd = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, 'utf8') : '';
if (!agentsMd) errors.push('AGENTS.md is missing');
else checkPaths('AGENTS.md', agentsMd, ROOT);

const skillDirs = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

for (const name of skillDirs) {
  const rel = `.claude/skills/${name}/SKILL.md`;
  const file = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (!fs.existsSync(file)) {
    errors.push(`${rel}: missing`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(text);
  if (!fm) {
    errors.push(`${rel}: missing YAML frontmatter`);
  } else {
    if (fm.name !== name) errors.push(`${rel}: frontmatter name "${fm.name}" != folder "${name}"`);
    if (!fm.description || fm.description.length < 40) errors.push(`${rel}: description missing or too short`);
  }
  if (agentsMd && !agentsMd.includes(`\`${name}\``)) errors.push(`${rel}: not listed in AGENTS.md skills table`);
  if (name !== 'self-improve' && !text.includes('`self-improve`')) errors.push(`${rel}: missing self-improve footer`);

  const lines = text.split(/\r?\n/).length;
  if (lines > MAX_LINES) warnings.push(`${rel}: ${lines} lines (> ${MAX_LINES}); move detail to references/`);

  if (name !== 'self-improve') {
    const verified = text.match(/Last verified against code:\s*(\d{4}-\d{2}-\d{2})/);
    if (!verified) {
      warnings.push(`${rel}: no "Last verified against code: YYYY-MM-DD" line`);
    } else {
      const ageDays = (Date.now() - new Date(verified[1]).getTime()) / 86_400_000;
      if (ageDays > STALE_DAYS) warnings.push(`${rel}: last verified ${verified[1]} (${Math.floor(ageDays)} days ago) — re-audit`);
    }
  }

  checkPaths(rel, text, path.join(SKILLS_DIR, name));
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`skills:check — ${skillDirs.length} skills, ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length > 0 ? 1 : 0);
