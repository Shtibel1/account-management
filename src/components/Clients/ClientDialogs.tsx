'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { Client } from '@/shared/types';
import { clientNameError } from '@/shared/clientName';
import { vatAccountError } from '@/shared/mappingValidation';
import { useEscapeKey } from '@/components/ui/useEscapeKey';

/** Error answer of the clients API: `field` says which input the message belongs to. */
export interface ClientApiError {
  error: string;
  field?: 'name' | 'vat_account';
}

async function readError(res: Response, fallback: string): Promise<ClientApiError> {
  try {
    const body = (await res.json()) as Partial<ClientApiError>;
    return { error: typeof body.error === 'string' && body.error ? body.error : fallback, field: body.field };
  } catch {
    return { error: fallback };
  }
}

/** POST /api/clients. Resolves to the new client or the server's (Hebrew) error. */
export async function createClientRequest(input: { name: string; vatAccount: string; orgId: string | null }): Promise<{ client: Client } | ClientApiError> {
  try {
    const res = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: input.name, vatAccount: input.vatAccount, ...(input.orgId ? { orgId: input.orgId } : {}) }),
    });
    if (!res.ok) return readError(res, 'יצירת הלקוח נכשלה. ודאו שאתם משויכים למשרד ונסו שוב.');
    return (await res.json()) as { client: Client };
  } catch {
    return { error: 'יצירת הלקוח נכשלה. בדקו את החיבור ונסו שוב.' };
  }
}

/** Per-card menu: edit (every member) and delete (office owners only). */
export function ClientCardMenu({ clientName, canDelete, onEdit, onDelete }: {
  clientName: string;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEscapeKey(() => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`פעולות ללקוח ${clientName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full mt-1 z-20 w-40 bg-white border border-slate-200 rounded-xl shadow-lg py-1 text-sm">
          <button
            type="button" role="menuitem"
            onClick={() => { setOpen(false); onEdit(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-right text-slate-700 hover:bg-slate-50"
          >
            <Pencil className="h-3.5 w-3.5" /> עריכת לקוח
          </button>
          {canDelete && (
            <button
              type="button" role="menuitem"
              onClick={() => { setOpen(false); onDelete(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-right text-red-600 hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> מחיקת לקוח
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DialogShell({ titleId, onClose, children }: { titleId: string; onClose: () => void; children: React.ReactNode }) {
  useEscapeKey(onClose);
  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" style={{ direction: 'rtl' }} onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="bg-white rounded-2xl border border-slate-100 shadow-xl max-w-md w-full p-6 space-y-4 text-right max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** Rename / change the VAT code (PATCH /api/clients/[id]); a duplicate name shows the server's 409 message inline. */
export function EditClientDialog({ client, onClose, onSaved }: { client: Client; onClose: () => void; onSaved: (client: Client) => void }) {
  const [name, setName] = useState(client.name);
  const [vatAccount, setVatAccount] = useState(client.vat_account ?? '');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<ClientApiError | null>(null);

  const vatErr = vatAccountError(vatAccount) ?? (serverError?.field === 'vat_account' ? serverError.error : null);
  const nameErr = (name.trim() ? null : clientNameError(name)) ?? (serverError?.field === 'name' ? serverError.error : null);
  const generalErr = serverError && !serverError.field ? serverError.error : null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || clientNameError(name) || vatAccountError(vatAccount)) return;
    setSaving(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, vatAccount }),
      });
      if (!res.ok) {
        setServerError(await readError(res, 'עדכון הלקוח נכשל'));
        return;
      }
      const { client: saved } = (await res.json()) as { client: Client };
      onSaved({ ...client, ...saved });
    } catch {
      setServerError({ error: 'עדכון הלקוח נכשל. בדקו את החיבור ונסו שוב.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell titleId="edit-client-title" onClose={onClose}>
      <form onSubmit={save} noValidate className="space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 id="edit-client-title" className="text-lg font-bold text-slate-900">עריכת לקוח</h3>
          <button type="button" onClick={onClose} aria-label="סגור" className="text-slate-400 hover:text-slate-600 transition-colors text-lg font-bold">✕</button>
        </div>
        <div>
          <label htmlFor="edit-client-name" className="block text-sm font-medium text-slate-700 mb-1.5">שם הלקוח *</label>
          <input
            id="edit-client-name" value={name} autoFocus
            onChange={(e) => { setName(e.target.value); if (serverError?.field === 'name') setServerError(null); }}
            aria-invalid={!!nameErr || undefined}
            aria-describedby={nameErr ? 'edit-client-name-error' : undefined}
            className={nameErr ? 'input-base input-error' : 'input-base'}
          />
          {nameErr && <p id="edit-client-name-error" role="alert" className="text-xs text-red-600 mt-1">{nameErr}</p>}
        </div>
        <div>
          <label htmlFor="edit-client-vat-account" className="block text-sm font-medium text-slate-700 mb-1.5">קוד חשבון מע"מ תשומות</label>
          <input
            id="edit-client-vat-account" value={vatAccount} inputMode="numeric" dir="ltr" placeholder="1310"
            onChange={(e) => { setVatAccount(e.target.value); if (serverError?.field === 'vat_account') setServerError(null); }}
            aria-invalid={!!vatErr || undefined}
            aria-describedby={vatErr ? 'edit-client-vat-account-error' : undefined}
            className={vatErr ? 'input-base input-error text-right' : 'input-base text-right'}
          />
          {vatErr && <p id="edit-client-vat-account-error" role="alert" className="text-xs text-red-600 mt-1">{vatErr}</p>}
        </div>
        {generalErr && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{generalErr}</p>}
        <div className="flex gap-2 pt-1">
          <button
            type="submit" disabled={saving || !name.trim() || !!vatAccountError(vatAccount)}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2 rounded-xl text-sm font-semibold transition-colors"
          >
            {saving ? 'שומר...' : 'שמור שינויים'}
          </button>
          <button type="button" onClick={onClose} className="px-5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
            ביטול
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** In-app confirmation for DELETE /api/clients/[id]; a refusal shows the server's Hebrew reason. */
export function DeleteClientDialog({ client, onClose, onDeleted }: { client: Client; onClose: () => void; onDeleted: (id: string) => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${client.id}`, { method: 'DELETE' });
      if (!res.ok) {
        setError((await readError(res, 'מחיקת הלקוח נכשלה')).error);
        return;
      }
      onDeleted(client.id);
    } catch {
      setError('מחיקת הלקוח נכשלה. בדקו את החיבור ונסו שוב.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <DialogShell titleId="delete-client-title" onClose={deleting ? () => {} : onClose}>
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <h3 id="delete-client-title" className="text-lg font-bold text-slate-900">מחיקת לקוח</h3>
        <button type="button" onClick={onClose} disabled={deleting} aria-label="סגור" className="text-slate-400 hover:text-slate-600 transition-colors text-lg font-bold">✕</button>
      </div>
      <p className="text-sm text-slate-700">
        למחוק את הלקוח <strong className="font-semibold text-slate-900 break-words">{client.name}</strong>?
      </p>
      <p className="text-xs text-slate-500">
        הלקוח, המיפויים והקבצים שלו יימחקו לצמיתות. ניתן למחוק רק לקוח שכל החשבוניות שלו נכשלו בעיבוד או ממתינות לבדיקה.
      </p>
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button
          type="button" onClick={confirmDelete} disabled={deleting}
          className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-5 py-2 rounded-xl text-sm font-semibold transition-colors"
        >
          {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
          {deleting ? 'מוחק...' : 'מחק לקוח'}
        </button>
        <button type="button" onClick={onClose} disabled={deleting} className="px-5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
          ביטול
        </button>
      </div>
    </DialogShell>
  );
}
