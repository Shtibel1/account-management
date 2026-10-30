// Bank / credit-card statement parsing: header detection, column mapping and value normalization.
// Pure functions (no I/O) so they run in the browser import step and in unit checks.
import type { NormalizedBankRow } from '@/shared/types';

export type StatementCell = string | number | boolean | Date | null | undefined;

export type AmountMode = 'single' | 'debit_credit';

/** Column indexes into the statement rows (-1 = not mapped). */
export interface BankColumnMapping {
  date: number;
  description: number;
  reference: number;
  amountMode: AmountMode;
  amount: number;
  debit: number;
  credit: number;
  /** Credit-card exports list charges as positive numbers; flip them so debits are negative. */
  negateAmounts: boolean;
}

export interface SkippedStatementRow {
  row: number;      // 1-based row number in the file, as the user sees it in Excel
  reason: string;
}

export interface NormalizedStatement {
  rows: NormalizedBankRow[];
  skipped: SkippedStatementRow[];
}

const HEADER_SCAN_ROWS = 30;
// Keep in sync with NormalizedBankRowSchema (src/shared/schemas.ts)
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_REFERENCE_LENGTH = 100;
const DAY_MS = 86_400_000;
// Excel serial day 0 (accounts for the 1900 leap-year bug for any date after March 1900)
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

// Known headers per field, most specific first (Israeli banks and card issuers + English exports).
const HEADER_ALIASES: Record<'date' | 'description' | 'reference' | 'amount' | 'debit' | 'credit', string[]> = {
  date: ['תאריך עסקה', 'תאריך העסקה', 'תאריך', 'תאריך פעולה', 'תאריך רכישה', 'תאריך ערך', 'תאריך חיוב', 'date', 'transaction date'],
  description: ['שם בית העסק', 'שם בית עסק', 'בית עסק', 'תיאור', 'תאור', 'תיאור התנועה', 'תיאור הפעולה', 'הפעולה', 'פרטים', 'פרטי העסקה', 'description', 'details', 'payee'],
  reference: ['אסמכתא', 'אסמכתה', 'מספר אסמכתא', 'מס אסמכתא', 'מס. אסמכתא', 'שובר', 'מספר שובר', 'reference', 'ref'],
  amount: ['סכום חיוב', 'סכום החיוב', 'סכום חיוב בש"ח', 'סכום', 'סכום בש"ח', 'סכום העסקה', 'סכום עסקה', 'amount', 'charge amount'],
  debit: ['חובה', 'בחובה', 'חיוב', 'סכום בחובה', 'debit', 'withdrawal', 'withdrawals'],
  credit: ['זכות', 'בזכות', 'זיכוי', 'סכום בזכות', 'credit', 'deposit', 'deposits'],
};

/** Lowercases and strips quotes, bidi marks and extra whitespace so header variants compare equal. */
export function normalizeHeader(value: StatementCell): string {
  if (value == null) return '';
  return String(value)
    .replace(/[‎‏‪-‮﻿]/g, '')
    .replace(/["'״׳`]/g, '"')
    .replace(/[:*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const NORMALIZED_ALIASES = Object.fromEntries(
  Object.entries(HEADER_ALIASES).map(([field, aliases]) => [field, aliases.map((a) => normalizeHeader(a))])
) as Record<keyof typeof HEADER_ALIASES, string[]>;

const ALL_ALIASES = new Set(Object.values(NORMALIZED_ALIASES).flat());

function isBlank(cell: StatementCell): boolean {
  return cell == null || String(cell).trim() === '';
}

/** Index of the header row: the row among the first lines with the most recognized column names. */
export function findHeaderRow(rows: StatementCell[][]): number {
  let best = 0;
  let bestHits = 0;
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const hits = (rows[i] ?? []).filter((c) => ALL_ALIASES.has(normalizeHeader(c))).length;
    if (hits > bestHits) {
      best = i;
      bestHits = hits;
    }
  }
  if (bestHits > 0) return best;
  // No known header: first row that has at least two non-empty cells
  const firstFilled = rows.findIndex((r) => (r ?? []).filter((c) => !isBlank(c)).length >= 2);
  return firstFilled === -1 ? 0 : firstFilled;
}

type MappedField = keyof typeof NORMALIZED_ALIASES;

// Containment matching ("תאריך עסקה מקורי" contains "תאריך") only for aliases long enough not to
// collide: "חיוב" would otherwise grab "סכום חיוב ₪" as a debit column.
const MIN_CONTAINS_ALIAS = 5;

/** Best-effort initial mapping from the header row; the user confirms or fixes it in the UI. */
export function guessColumnMapping(headerRow: StatementCell[]): BankColumnMapping {
  const headers = headerRow.map((h) => normalizeHeader(h));
  const taken = new Set<number>();
  // Debit/credit before the generic amount so "סכום בחובה" isn't taken as the single amount column.
  const order: MappedField[] = ['date', 'debit', 'credit', 'amount', 'description', 'reference'];
  const found: Record<MappedField, number> = { date: -1, description: -1, reference: -1, amount: -1, debit: -1, credit: -1 };

  // Pass 1: exact header names (aliases in priority order). Pass 2: header contains an alias.
  for (const exact of [true, false]) {
    for (const field of order) {
      if (found[field] !== -1) continue;
      for (const alias of NORMALIZED_ALIASES[field]) {
        if (!exact && alias.length < MIN_CONTAINS_ALIAS) continue;
        const idx = headers.findIndex((h, i) => !taken.has(i) && (exact ? h === alias : h.includes(alias)));
        if (idx !== -1) {
          found[field] = idx;
          taken.add(idx);
          break;
        }
      }
    }
  }

  const amountMode: AmountMode = found.debit !== -1 && found.credit !== -1 ? 'debit_credit' : 'single';
  // Card statements ("סכום חיוב") report charges as positive amounts.
  const amountHeader = found.amount !== -1 ? headers[found.amount] : '';
  const negateAmounts = amountMode === 'single' && amountHeader.includes('חיוב');

  return { ...found, amountMode, negateAmounts };
}

/** Hebrew error messages for a mapping that can't produce transactions (empty = OK). */
export function validateMapping(mapping: BankColumnMapping): string[] {
  const errors: string[] = [];
  if (mapping.date < 0) errors.push('יש לבחור עמודת תאריך');
  if (mapping.description < 0) errors.push('יש לבחור עמודת תיאור');
  if (mapping.amountMode === 'single') {
    if (mapping.amount < 0) errors.push('יש לבחור עמודת סכום');
  } else if (mapping.debit < 0 && mapping.credit < 0) {
    errors.push('יש לבחור עמודת חובה ו/או זכות');
  }
  return errors;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31/02 and friends (Date rolls them over to the next month)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function expandYear(y: number): number {
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y;
}

/**
 * Statement date -> YYYY-MM-DD. Accepts Excel serial numbers, Date cells, dd/mm/yyyy (also . or -
 * separators and 2-digit years), yyyy-mm-dd and yyyymmdd. Day comes first: Israeli exports never use mm/dd.
 */
export function parseStatementDate(value: StatementCell): string | null {
  if (value == null || typeof value === 'boolean') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return toIsoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value >= 19000101 && value <= 22001231 && Number.isInteger(value)) {
      return parseStatementDate(String(value));
    }
    // Excel serial (1954..2119); the fraction is the time of day
    if (value >= 20000 && value < 80000) {
      const d = new Date(EXCEL_EPOCH_MS + Math.floor(value) * DAY_MS);
      return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }

  const s = String(value).replace(/[‎‏‪-‮﻿]/g, '').trim().split(/[\sT]/)[0];
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) return toIsoDate(expandYear(Number(m[3])), Number(m[2]), Number(m[1]));

  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));

  // A numeric string from a CSV may still be an Excel serial
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseStatementDate(Number(s));
  return null;
}

/**
 * Statement amount -> number. Handles '1,234.56', '₪ 1,234.56', '(123.45)' and a trailing minus
 * ('123.45-', common in Israeli bank exports). Returns null for empty / non-numeric cells.
 */
export function parseStatementAmount(value: StatementCell): number | null {
  if (value == null || typeof value === 'boolean' || value instanceof Date) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? round2(value) : null;

  let s = String(value)
    .replace(/[‎‏‪-‮﻿ \s]/g, '')
    .replace(/₪|ש"ח|ש״ח|nis|ils/gi, '');
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) {
    // European format (1.234,56 / 12,50)
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;

  const n = round2(Number(s));
  return negative ? -n : n;
}

function cellText(cell: StatementCell): string {
  if (cell == null) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).replace(/[‎‏‪-‮﻿]/g, '').replace(/\s+/g, ' ').trim();
}

function rowAmount(row: StatementCell[], mapping: BankColumnMapping): number | null {
  if (mapping.amountMode === 'single') {
    const amount = parseStatementAmount(row[mapping.amount]);
    if (amount == null) return null;
    return mapping.negateAmounts ? -amount : amount;
  }
  const debit = mapping.debit >= 0 ? parseStatementAmount(row[mapping.debit]) : null;
  const credit = mapping.credit >= 0 ? parseStatementAmount(row[mapping.credit]) : null;
  if (debit == null && credit == null) return null;
  // Debit columns are usually positive numbers; the sign comes from the column, not the cell.
  return round2(Math.abs(credit ?? 0) - Math.abs(debit ?? 0));
}

/** Applies the column mapping to the data rows below the header, skipping totals/blank lines. */
export function normalizeStatementRows(
  rows: StatementCell[][],
  headerRowIndex: number,
  mapping: BankColumnMapping
): NormalizedStatement {
  const result: NormalizedStatement = { rows: [], skipped: [] };
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every(isBlank)) continue;

    const rowNumber = i + 1;
    const txnDate = parseStatementDate(row[mapping.date]);
    if (!txnDate) {
      result.skipped.push({ row: rowNumber, reason: 'תאריך לא תקין' });
      continue;
    }
    const amount = rowAmount(row, mapping);
    if (amount == null || amount === 0) {
      result.skipped.push({ row: rowNumber, reason: 'סכום חסר' });
      continue;
    }
    const reference = mapping.reference >= 0 ? cellText(row[mapping.reference]) : '';
    result.rows.push({
      txn_date: txnDate,
      description: cellText(row[mapping.description]).slice(0, MAX_DESCRIPTION_LENGTH),
      amount,
      reference: reference.slice(0, MAX_REFERENCE_LENGTH) || null,
    });
  }
  return result;
}

function keyText(value: string | null): string {
  return (value ?? '').replace(/[‎‏‪-‮﻿]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Stable identity per statement line, used by the (client_id, account_label, dedupe_key) unique index.
 * Identical lines in the same file (two equal coffees on one day) get #1, #2... so they stay distinct,
 * while re-importing the same file - or an overlapping period - produces the same keys again.
 */
export function bankDedupeKeys(rows: NormalizedBankRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = [r.txn_date, r.amount.toFixed(2), keyText(r.description), keyText(r.reference)].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
}

/** Decodes a CSV upload: UTF-8 (with or without BOM), falling back to Windows-1255 used by older bank exports. */
export function decodeStatementText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    // Not valid UTF-8 -> legacy Hebrew code page
    return new TextDecoder('windows-1255').decode(bytes);
  }
}
