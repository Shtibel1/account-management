# Coding Standards & Workflow Guidelines

This document outlines strict coding rules, style guides, and operational git workflows required when modifying this project.

---

## 🎨 TypeScript Rules

### 1. Strict Typing (No `any`)
- The `any` keyword is **strictly forbidden**. Every variable, function parameter, and return value must have an explicit, descriptive type.
- If a type is unknown or dynamic, prefer `unknown` or a strict interface over `any`.
- Define shared interfaces inside [types.ts](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/src/shared/types.ts).

```typescript
// ❌ Bad
function process(data: any): any {
  return data.value;
}

//  Good
import type { ExtractedData } from '@/shared/types';

function process(data: ExtractedData): string | null {
  return data.supplier_name;
}
```

### 2. Absolute Imports
- Always use absolute imports with the path alias `@/` for project directories (e.g., `@/components`, `@/lib`, `@/shared`, `@/utils`).
- **Do not** use relative paths like `../../components` or `../../../lib` when importing items outside of a component's own sub-directory.

```typescript
// ❌ Bad
import { InvoiceTable } from '../../components/InvoiceTable/InvoiceTable';

//  Good
import { InvoiceTable } from '@/components/InvoiceTable/InvoiceTable';
```

---

## 🛑 Error Handling
- Never catch errors silently. All catch blocks must either:
  1. Rethrow the error.
  2. Throw a wrapped, descriptive custom error.
  3. Log the error using `console.error` and update database pipeline status if applicable.
- Throw custom error instances rather than plain strings when checking validation rules or configuration issues (e.g., `throw new Error('Message')` instead of `throw 'Message'`).

```typescript
// ❌ Bad
try {
  await dbCall();
} catch (e) {
  // Silent or undocumented failure
}

//  Good
try {
  await dbCall();
} catch (err) {
  console.error('[Service] Failed to complete database action:', err);
  throw new Error(`Database transaction failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

---

## 🤖 AI Operational Rules & Git Workflow

### 1. Self-Documenting Files
- After completing a task or coding a feature, if any file layouts, dependencies, environment variables, or databases changes occurred, the agent **MUST** update [PROJECT_CONTEXT.md](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/PROJECT_CONTEXT.md) and related markdown documents in the `docs/` folder to reflect the changes.

### 2. Git Commit Protocol (Conventional Commits)
All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
- `feat:` for new features (e.g. `feat: implement Hashavshevet exporter`).
- `fix:` for bug fixes (e.g. `fix: correct math check tolerance in validation`).
- `docs:` for documentation updates (e.g. `docs: update database schema doc`).
- `refactor:` for code restructuring that doesn't change functionality.
- `test:` for adding or modifying tests.

### 3. Automatic Push to GitHub
- Once the implementation is complete, linted, type-checked, and manual verification is successful:
  1. Stage the files (`git add .`).
  2. Commit with a conventional commit message (`git commit -m "..."`).
  3. Push to origin (`git push origin main` or current working branch).
