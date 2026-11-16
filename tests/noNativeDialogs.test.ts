import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Native confirm/alert/prompt block the tab, ignore the app's RTL styling and break browser
// automation (QA found "פתח מחדש לבדיקה" on /review/<id> opening one). The app asks through
// useConfirm() / <ConfirmDialog> (src/components/ui/ConfirmDialog.tsx) and reports through toasts.

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// window.confirm( / globalThis.alert( / self.prompt( / bare confirm( - not foo.confirm( or askConfirm(.
const NATIVE_DIALOG = /(?:\b(?:window|globalThis|self|top|parent)\s*\.\s*|(?<![\w$.]))(confirm|alert|prompt)\s*\(/g;
// window['confirm'](
const NATIVE_DIALOG_INDEXED = /\b(?:window|globalThis|self)\s*\[\s*['"`](confirm|alert|prompt)['"`]\s*\]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name)) out.push(path);
  }
  return out;
}

/** Blanks out comments (keeping line numbers) so a mention in a comment does not count. */
export function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}

export function findNativeDialogs(code: string): { line: number; call: string }[] {
  const clean = stripComments(code);
  const hits: { line: number; call: string }[] = [];
  for (const re of [NATIVE_DIALOG, NATIVE_DIALOG_INDEXED]) {
    for (const m of clean.matchAll(re)) {
      const before = clean.slice(0, m.index);
      // A declaration such as `function confirm(` or a method `confirm(x) {` is not a call of the native one.
      if (/\bfunction\s*$/.test(before)) continue;
      hits.push({ line: before.split('\n').length, call: m[0].trim() });
    }
  }
  return hits;
}

test('the detector catches native dialogs and ignores look-alikes', () => {
  assert.equal(findNativeDialogs('if (!window.confirm("x")) return;').length, 1);
  assert.equal(findNativeDialogs('alert("x")').length, 1);
  assert.equal(findNativeDialogs('const v = prompt ("x")').length, 1);
  assert.equal(findNativeDialogs('globalThis.alert(1)').length, 1);
  assert.equal(findNativeDialogs("window['confirm']('x')").length, 1);
  assert.equal(findNativeDialogs('await askConfirm({ message: "x" })').length, 0);
  assert.equal(findNativeDialogs('dialog.confirm(x); api.alert(y)').length, 0);
  assert.equal(findNativeDialogs('// window.confirm("x")\n/* alert(1) */').length, 0);
  assert.equal(findNativeDialogs('const url = "https://x"; alert(1)').length, 1);
});

test('src/ uses no native confirm/alert/prompt (use useConfirm() or a toast)', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    for (const hit of findNativeDialogs(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(SRC, file)}:${hit.line} ${hit.call}`);
    }
  }
  assert.deepEqual(offenders, [], `native dialogs in src/:\n${offenders.join('\n')}`);
});
