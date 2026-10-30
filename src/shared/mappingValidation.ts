// Format checks for bookkeeping codes typed by users (account mappings, the client's input-VAT
// account). These values go into the exports (e.g. Move-in pads them to 15 characters), so they
// must be digits only. These rows are written straight through PostgREST (RLS), so every form that
// writes them (mappings page + Excel import, review form, new-client form) runs these checks.
// No DB CHECK constraint: legacy rows with free text would then fail unrelated updates.
import { isValidVatIdChecksum, normalizeVatId } from '@/shared/vatId';

/** Longest account code the exports can hold (Move-in account columns are 15 wide). */
export const ACCOUNT_CODE_MAX_LENGTH = 15;

const DIGITS = /^\d+$/;

/** Hebrew error for an account code (מספר כרטיס / קוד חשבון), or null when valid. Empty is allowed only when not required. */
export function accountCodeError(value: string | null | undefined, opts: { required?: boolean } = {}): string | null {
  const code = (value ?? '').trim();
  if (!code) return opts.required ? 'יש להזין קוד חשבון' : null;
  if (!DIGITS.test(code)) return 'קוד החשבון חייב להכיל ספרות בלבד';
  if (code.length > ACCOUNT_CODE_MAX_LENGTH) return `קוד החשבון ארוך מדי (עד ${ACCOUNT_CODE_MAX_LENGTH} ספרות)`;
  return null;
}

/** Hebrew error for the client's input-VAT account (קוד חשבון מע"מ תשומות, optional), or null when valid. */
export function vatAccountError(value: string | null | undefined): string | null {
  const code = (value ?? '').trim();
  if (!code) return null;
  if (!DIGITS.test(code)) return 'קוד חשבון מע"מ חייב להכיל ספרות בלבד (לדוגמה 1310)';
  if (code.length > ACCOUNT_CODE_MAX_LENGTH) return `קוד חשבון מע"מ ארוך מדי (עד ${ACCOUNT_CODE_MAX_LENGTH} ספרות)`;
  return null;
}

/** Hebrew error for an optional supplier VAT ID (ח.פ. / עוסק מורשה), or null when empty or valid. */
export function supplierVatIdError(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (/[^\d\s-]/.test(raw)) return 'מספר תיק מע"מ חייב להכיל ספרות בלבד';
  if (!normalizeVatId(raw)) return 'מספר תיק מע"מ חייב להיות בן 9 ספרות';
  if (!isValidVatIdChecksum(raw)) return 'מספר תיק מע"מ אינו תקין (ספרת ביקורת שגויה)';
  return null;
}

export interface MappingInput {
  mapping_type: 'supplier' | 'category';
  key: string;
  account_code: string;
  vat_id?: string | null;
}

export type MappingErrors = Partial<Record<'key' | 'account_code' | 'vat_id', string>>;

/** Field errors for a mapping typed in the mappings form (empty object = valid). */
export function validateMappingInput(input: MappingInput, opts: { requireAccountCode?: boolean } = {}): MappingErrors {
  const errors: MappingErrors = {};
  if (!input.key.trim()) errors.key = input.mapping_type === 'supplier' ? 'יש להזין שם ספק' : 'יש להזין שם קטגוריה';
  const codeErr = accountCodeError(input.account_code, { required: opts.requireAccountCode ?? true });
  if (codeErr) errors.account_code = codeErr;
  if (input.mapping_type === 'supplier') {
    const vatErr = supplierVatIdError(input.vat_id);
    if (vatErr) errors.vat_id = vatErr;
  }
  return errors;
}

/** Hebrew message for a PostgREST error on account_mappings (check / unique violation), else null. */
export function mappingDbErrorMessage(error: { code?: string; message?: string } | null | undefined): string | null {
  if (!error) return null;
  if (error.code === '23514') {
    if (/vat_account/.test(error.message ?? '')) return 'קוד חשבון מע"מ חייב להכיל ספרות בלבד';
    if (/vat_id/.test(error.message ?? '')) return 'מספר תיק מע"מ חייב להיות בן 9 ספרות';
    return 'קוד החשבון חייב להכיל ספרות בלבד';
  }
  if (error.code === '23505') return 'מיפוי בשם זה כבר קיים ללקוח';
  return null;
}
