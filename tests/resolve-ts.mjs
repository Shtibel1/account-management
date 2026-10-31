import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function findFile(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // Next's entry points (next/server, next/headers) are CommonJS files without an exports map: ESM
  // needs the extension (route guards in src/lib/auth.ts import NextResponse).
  if (/^next\/(server|headers)$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
  if (specifier.startsWith('@/')) {
    const file = findFile(path.join(SRC, specifier.slice(2)));
    if (file) return { url: pathToFileURL(file).href, format: 'module', shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:') && !path.extname(specifier)) {
    const file = findFile(path.join(path.dirname(fileURLToPath(context.parentURL)), specifier));
    if (file) return { url: pathToFileURL(file).href, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // App sources are ES modules whatever package.json says (no "type": "module" here)
  if (url.startsWith('file:') && /\.tsx?$/.test(url)) {
    return nextLoad(url, { ...context, format: 'module-typescript' });
  }
  return nextLoad(url, context);
}
