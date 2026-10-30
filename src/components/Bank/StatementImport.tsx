'use client';

import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { importBankStatement } from '@/lib/api';
import { readStatementFile } from '@/lib/bankStatementFile';
import { formatIsoDateHe } from '@/lib/exporters/missingInvoices';
import { formatAmount } from '@/components/Bank/format';
import {
  BankColumnMapping,
  findHeaderRow,
  guessColumnMapping,
  normalizeStatementRows,
  StatementCell,
  validateMapping,
} from '@/shared/bankStatement';

interface Props {
  clientId: string;
  /** Account labels already used by this client - the dedupe key is per account, so reuse them. */
  existingAccountLabels?: string[];
  onImported: () => void;
  onCancel: () => void;
}

interface ParsedFile {
  name: string;
  rows: StatementCell[][];
}

const PREVIEW_ROWS = 8;

function columnLabel(header: StatementCell, index: number): string {
  const text = header == null ? '' : String(header).trim();
  return text || `עמודה ${index + 1}`;
}

function defaultAccountLabel(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').slice(0, 60);
}

export function StatementImport({ clientId, existingAccountLabels = [], onImported, onCancel }: Props) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<BankColumnMapping | null>(null);
  const [accountLabel, setAccountLabel] = useState('');
  const [importing, setImporting] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    e.target.value = '';
    if (!selected) return;
    setReading(true);
    setReadError('');
    try {
      const rows = await readStatementFile(selected);
      const headerIndex = findHeaderRow(rows);
      setFile({ name: selected.name, rows });
      setHeaderRow(headerIndex);
      setMapping(guessColumnMapping(rows[headerIndex] ?? []));
      // A new statement of the client's only account keeps its label, so overlapping periods dedupe.
      setAccountLabel(existingAccountLabels.length === 1 ? existingAccountLabels[0] : defaultAccountLabel(selected.name));
    } catch (err) {
      console.error('[bank] Failed to read statement file:', err);
      setReadError(err instanceof Error ? err.message : 'שגיאה בקריאת הקובץ');
      setFile(null);
    } finally {
      setReading(false);
    }
  };

  const headers = useMemo(() => {
    if (!file) return [];
    const width = Math.max(0, ...file.rows.slice(headerRow, headerRow + 50).map((r) => r.length));
    const row = file.rows[headerRow] ?? [];
    return Array.from({ length: width }, (_, i) => columnLabel(row[i], i));
  }, [file, headerRow]);

  const changeHeaderRow = (rowNumber: number) => {
    if (!file) return;
    const index = Math.min(Math.max(rowNumber - 1, 0), file.rows.length - 1);
    setHeaderRow(index);
    setMapping(guessColumnMapping(file.rows[index] ?? []));
  };

  const errors = mapping ? validateMapping(mapping) : [];
  const normalized = useMemo(
    () => (file && mapping && validateMapping(mapping).length === 0 ? normalizeStatementRows(file.rows, headerRow, mapping) : null),
    [file, mapping, headerRow]
  );
  const debits = normalized?.rows.filter((r) => r.amount < 0) ?? [];
  const skippedByReason = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of normalized?.skipped ?? []) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
    return counts;
  }, [normalized]);

  const update = (patch: Partial<BankColumnMapping>) => setMapping((m) => (m ? { ...m, ...patch } : m));

  const handleImport = async () => {
    if (!file || !normalized || normalized.rows.length === 0) return;
    setImporting(true);
    try {
      const result = await importBankStatement({
        clientId,
        accountLabel: accountLabel.trim(),
        fileName: file.name,
        rows: normalized.rows,
      });
      const parts = [`יובאו ${result.inserted} תנועות`];
      if (result.duplicates > 0) parts.push(`${result.duplicates} כבר קיימות ודולגו`);
      parts.push(`${result.matched} הותאמו אוטומטית`);
      toast(parts.join(' · '), 'success');
      setFile(null);
      setMapping(null);
      onImported();
    } catch (err) {
      console.error('[bank] Import failed:', err);
      toast(err instanceof Error ? err.message : 'שגיאה בייבוא', 'error');
    } finally {
      setImporting(false);
    }
  };

  const columnSelect = (label: string, value: number, onChange: (v: number) => void, optional = false) => (
    <label className="block">
      <span className="text-xs font-semibold text-slate-500 mb-1 block">
        {label}
        {optional && <span className="font-normal text-slate-400"> (רשות)</span>}
      </span>
      <select
        className={clsx('input-base', !optional && value < 0 && 'input-error')}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        <option value={-1}>— לא נבחר —</option>
        {headers.map((h, i) => (
          <option key={i} value={i}>{h}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="card p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-slate-900">ייבוא דף חשבון / פירוט כרטיס אשראי</h3>
          <p className="text-xs text-slate-500 mt-0.5">קבצי CSV / Excel כפי שיוצאו מאתר הבנק או חברת האשראי</p>
        </div>
        <button onClick={onCancel} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="סגור">
          <X className="h-4 w-4" />
        </button>
      </div>

      <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,.tsv,.txt" className="hidden" onChange={handleFile} />

      {!file && (
        <button
          onClick={() => inputRef.current?.click()}
          disabled={reading}
          className="w-full border-2 border-dashed border-slate-300 rounded-2xl py-10 flex flex-col items-center gap-2 text-slate-500 hover:border-blue-400 hover:bg-blue-50/40 transition-colors"
        >
          {reading ? <Loader2 className="h-7 w-7 animate-spin" /> : <Upload className="h-7 w-7" />}
          <span className="text-sm font-medium">{reading ? 'קורא את הקובץ...' : 'בחר קובץ דף חשבון'}</span>
        </button>
      )}

      {readError && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {readError}
        </div>
      )}

      {file && mapping && (
        <>
          <div className="flex items-center justify-between gap-3 bg-slate-50 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-slate-700 min-w-0">
              <FileSpreadsheet className="h-4 w-4 text-emerald-600 shrink-0" />
              <span className="font-medium truncate">{file.name}</span>
              <span className="text-slate-400 shrink-0">· {file.rows.length} שורות</span>
            </div>
            <button onClick={() => inputRef.current?.click()} className="text-xs text-blue-600 hover:underline shrink-0">
              קובץ אחר
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="block">
              <span className="text-xs font-semibold text-slate-500 mb-1 block">שם החשבון / הכרטיס</span>
              <input
                className="input-base"
                value={accountLabel}
                maxLength={100}
                placeholder='למשל: לאומי 12-345 / ויזה 1234'
                list="bank-account-labels"
                onChange={(e) => setAccountLabel(e.target.value)}
              />
              <datalist id="bank-account-labels">
                {existingAccountLabels.map((l) => <option key={l} value={l} />)}
              </datalist>
              {existingAccountLabels.length > 0 && (
                <span className="text-xs text-slate-400 mt-1 block">
                  לדף נוסף של חשבון קיים בחר את אותו השם, כדי שתנועות חופפות לא ייובאו פעמיים
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-slate-500 mb-1 block">שורת הכותרות</span>
              <input
                type="number"
                min={1}
                max={file.rows.length}
                className="input-base"
                value={headerRow + 1}
                onChange={(e) => changeHeaderRow(Number(e.target.value))}
              />
            </label>
            <div>
              <span className="text-xs font-semibold text-slate-500 mb-1 block">סוג עמודת סכום</span>
              <div className="flex rounded-xl border border-slate-300 overflow-hidden text-sm">
                {(['single', 'debit_credit'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => update({ amountMode: mode })}
                    className={clsx(
                      'flex-1 py-2.5 transition-colors',
                      mapping.amountMode === mode ? 'bg-blue-600 text-white font-semibold' : 'bg-white text-slate-600 hover:bg-slate-50'
                    )}
                  >
                    {mode === 'single' ? 'עמודת סכום אחת' : 'חובה / זכות'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {columnSelect('תאריך', mapping.date, (v) => update({ date: v }))}
            {columnSelect('תיאור', mapping.description, (v) => update({ description: v }))}
            {mapping.amountMode === 'single' ? (
              columnSelect('סכום', mapping.amount, (v) => update({ amount: v }))
            ) : (
              <>
                {columnSelect('חובה (יציאה)', mapping.debit, (v) => update({ debit: v }), mapping.credit >= 0)}
                {columnSelect('זכות (כניסה)', mapping.credit, (v) => update({ credit: v }), mapping.debit >= 0)}
              </>
            )}
            {columnSelect('אסמכתא', mapping.reference, (v) => update({ reference: v }), true)}
          </div>

          {mapping.amountMode === 'single' && (
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
                checked={mapping.negateAmounts}
                onChange={(e) => update({ negateAmounts: e.target.checked })}
              />
              סכומים חיוביים הם חיובים (פירוט כרטיס אשראי)
            </label>
          )}

          {errors.length > 0 && (
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-0.5">
              {errors.map((e) => <p key={e}>{e}</p>)}
            </div>
          )}

          {normalized && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                <span className="text-slate-700"><b>{normalized.rows.length}</b> תנועות</span>
                <span className="text-rose-700"><b>{debits.length}</b> חיובים</span>
                <span className="text-emerald-700"><b>{normalized.rows.length - debits.length}</b> זיכויים</span>
                {Object.entries(skippedByReason).map(([reason, count]) => (
                  <span key={reason} className="text-slate-400">{count} שורות דולגו ({reason})</span>
                ))}
              </div>

              {normalized.rows.length > 0 && debits.length === 0 && (
                <p className="text-xs text-amber-700">
                  לא נמצאו חיובים - אם זה פירוט כרטיס אשראי, סמן &quot;סכומים חיוביים הם חיובים&quot;.
                </p>
              )}

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-xs">
                    <tr>
                      <th className="text-right font-semibold px-3 py-2">תאריך</th>
                      <th className="text-right font-semibold px-3 py-2">תיאור</th>
                      <th className="text-right font-semibold px-3 py-2">אסמכתא</th>
                      <th className="text-left font-semibold px-3 py-2">סכום</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {normalized.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 whitespace-nowrap">{formatIsoDateHe(r.txn_date)}</td>
                        <td className="px-3 py-2">{r.description}</td>
                        <td className="px-3 py-2 text-slate-500">{r.reference ?? ''}</td>
                        <td dir="ltr" className={clsx('px-3 py-2 text-left tabular-nums whitespace-nowrap', r.amount < 0 ? 'text-rose-700' : 'text-emerald-700')}>
                          {formatAmount(r.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {normalized.rows.length > PREVIEW_ROWS && (
                <p className="text-xs text-slate-400">מוצגות {PREVIEW_ROWS} השורות הראשונות</p>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onCancel} disabled={importing}>ביטול</Button>
            <Button
              onClick={handleImport}
              disabled={importing || !normalized || normalized.rows.length === 0 || !accountLabel.trim()}
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {normalized ? `ייבא ${normalized.rows.length} תנועות` : 'ייבא'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
