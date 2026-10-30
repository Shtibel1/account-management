// Lets `node --test` run the TypeScript unit tests without a build step (npm test): Node's own type
// transform (--experimental-transform-types) plus this resolver for the `@/` alias of tsconfig.json
// and extensionless relative imports. Only for tests: Next.js builds the app itself.
import { createRequire, register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);

// The local mock DB (src/utils/supabase/mockDb.ts) loads `fs` through eval("require('fs')"), which
// Next's CommonJS server bundle provides; ES modules have no `require`.
globalThis.require ??= createRequire(import.meta.url);
