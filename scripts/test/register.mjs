// Unit tests run on Node's built-in runner with its TypeScript support (no extra dependencies):
//   npm test  ->  node --experimental-transform-types --import ./scripts/test/register.mjs --test ...
// This hook resolves the "@/..." path alias (tsconfig paths) and extension-less relative imports
// to the .ts / .tsx sources, the way the Next.js bundler does.
import { register } from 'node:module';

register('./resolve-hooks.mjs', import.meta.url);
