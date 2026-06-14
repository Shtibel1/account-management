# Database Schema (Supabase)

The database schema is dynamic and managed directly inside Supabase. Rather than manually updating this document when the schema changes, the TypeScript types should be automatically generated from the live database.

---

## 🔄 Automatic Type Generation

To synchronize local TypeScript types with the live Supabase schema, run:

```bash
npm run db:pull-types
```

This script generates type-safe database definitions and saves them to:
- `src/shared/supabase-types.ts` (Dynamic Supabase Definitions)

### Requirements:
To run the pull script successfully, you must be logged into Supabase CLI on your machine:
```bash
npx supabase login
```
*(Alternatively, ensure the `SUPABASE_ACCESS_TOKEN` environment variable is set in your session).*

---

## 📚 Codebase Sources of Truth
When coding or performing database operations, refer to:
1. **[supabase-types.ts](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/src/shared/supabase-types.ts):** The auto-generated database contracts.
2. **[types.ts](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/src/shared/types.ts):** Domain-specific TypeScript models and pipeline states.
3. **[schemas.ts](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/src/shared/schemas.ts):** Run-time validation schemas (Zod).
