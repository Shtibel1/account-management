'use client';

import { useCallback, useEffect, useState } from 'react';
import { Mail, MessageCircle, Copy, Check, Trash2, Plus, Loader2, AlertTriangle } from 'lucide-react';
import {
  addClientContact,
  fetchClientChannels,
  removeClientContact,
  type ChannelSettings,
  type ClientChannelsInfo,
} from '@/lib/api';
import { formatPhoneForDisplay, normalizePhone } from '@/lib/phone';
import { useToast } from '@/components/ui/Toast';
import type { ClientContact } from '@/shared/types';

/** Loads inbound email aliases + WhatsApp contacts for all clients (reloads when `reloadKey` changes). */
export function useClientChannels(reloadKey: unknown) {
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [channels, setChannels] = useState<Record<string, ClientChannelsInfo>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchClientChannels();
      setSettings(data.settings);
      setChannels(Object.fromEntries(data.clients.map((c) => [c.clientId, c])));
      setError(null);
    } catch (err) {
      console.error('[ClientChannels] Failed to load channels:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { load(); }, [load, reloadKey]);

  const setContacts = useCallback((clientId: string, contacts: ClientContact[]) => {
    setChannels((prev) => ({
      ...prev,
      [clientId]: { ...(prev[clientId] ?? { clientId, inboundAlias: null }), contacts },
    }));
  }, []);

  return { settings, channels, error, setContacts };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[ClientChannels] Clipboard write failed:', err);
      toast('ההעתקה נכשלה', 'error');
    }
  };

  return (
    <button
      type="button" onClick={copy} title="העתק"
      className="text-slate-400 hover:text-blue-600 transition-colors shrink-0"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Compact channel info shown at the bottom of a client card. */
export function ClientChannelsSummary({
  info,
  settings,
  onManage,
}: {
  info: ClientChannelsInfo | undefined;
  settings: ChannelSettings | null;
  onManage: () => void;
}) {
  const address = info?.inboundAlias && settings?.emailDomain ? `${info.inboundAlias}@${settings.emailDomain}` : null;
  const contactCount = info?.contacts.length ?? 0;

  return (
    <div className="border-t border-slate-100 px-5 py-3 space-y-2 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <Mail className="h-3.5 w-3.5 text-slate-400 shrink-0" />
        {address ? (
          <>
            <span className="font-mono text-slate-600 truncate" dir="ltr" title={address}>{address}</span>
            <CopyButton text={address} />
          </>
        ) : (
          <span className="text-slate-400">
            {!settings ? 'טוען...' : !settings.emailDomain ? 'קליטת מייל לא הוגדרה' : 'כתובת לא זמינה'}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-slate-500">
          <MessageCircle className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          {contactCount === 0 ? 'אין מספרי וואטסאפ' : contactCount === 1 ? 'מספר וואטסאפ אחד' : `${contactCount} מספרי וואטסאפ`}
        </div>
        <button type="button" onClick={onManage} className="text-blue-600 hover:text-blue-700 font-medium">
          ערוצי קליטה
        </button>
      </div>
    </div>
  );
}

/** Modal for a client's inbound email address and WhatsApp contact phones. */
export function ClientChannelsDialog({
  clientId,
  clientName,
  info,
  settings,
  onContactsChange,
  onClose,
}: {
  clientId: string;
  clientName: string;
  info: ClientChannelsInfo | undefined;
  settings: ChannelSettings | null;
  onContactsChange: (contacts: ClientContact[]) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const contacts = info?.contacts ?? [];
  const address = info?.inboundAlias && settings?.emailDomain ? `${info.inboundAlias}@${settings.emailDomain}` : null;
  const phoneValid = normalizePhone(phone) !== null;

  const handleAdd = async () => {
    if (!phoneValid || saving) return;
    setSaving(true);
    try {
      const contact = await addClientContact(clientId, phone, name);
      onContactsChange([...contacts, contact]);
      setPhone(''); setName('');
      toast('המספר נוסף', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'שגיאה בהוספת מספר', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (contactId: string) => {
    setRemovingId(contactId);
    try {
      await removeClientContact(clientId, contactId);
      onContactsChange(contacts.filter((c) => c.id !== contactId));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'שגיאה במחיקת מספר', 'error');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" style={{ direction: 'rtl' }} onClick={onClose}>
      <div className="bg-white rounded-2xl border border-slate-100 shadow-xl max-w-lg w-full p-6 space-y-5 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 className="text-lg font-bold text-slate-900">ערוצי קליטה · {clientName}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors text-lg font-bold">✕</button>
        </div>

        {/* Email */}
        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <Mail className="h-4 w-4 text-blue-600" /> קליטה במייל
          </h4>
          {address ? (
            <>
              <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                <span className="font-mono text-sm text-slate-700 flex-1 truncate" dir="ltr">{address}</span>
                <CopyButton text={address} />
              </div>
              <p className="text-xs text-slate-500">
                הלקוח (או הספקים שלו) יכולים להעביר חשבוניות לכתובת הזו. קבצי PDF ותמונות המצורפים למייל ייקלטו אוטומטית.
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-500">
              {!settings?.emailDomain
                ? 'לא הוגדר דומיין לקליטת מייל (INBOUND_EMAIL_DOMAIN). ראו docs/ingestion.md.'
                : 'לא נמצאה כתובת ללקוח זה - ודאו שהמיגרציה של ערוצי הקליטה הורצה.'}
            </p>
          )}
          {settings && settings.emailDomain && !settings.emailEnabled && (
            <p className="text-xs text-amber-600 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> קליטת המייל אינה פעילה בשרת (חסר INGEST_EMAIL_SECRET).
            </p>
          )}
        </section>

        {/* WhatsApp */}
        <section className="space-y-3">
          <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-emerald-600" /> קליטה בוואטסאפ
          </h4>
          <p className="text-xs text-slate-500">
            מסמכים שיישלחו מהמספרים האלה
            {settings?.whatsappNumber ? <> למספר <span dir="ltr" className="font-mono">{settings.whatsappNumber}</span></> : null}
            {' '}ייקלטו ללקוח זה.
          </p>
          {settings && !settings.whatsappEnabled && (
            <p className="text-xs text-amber-600 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> קליטת וואטסאפ אינה פעילה בשרת (חסרים פרטי Twilio).
            </p>
          )}

          {contacts.length > 0 && (
            <div className="border border-slate-100 rounded-xl divide-y divide-slate-50">
              {contacts.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="font-mono text-sm text-slate-700" dir="ltr">{formatPhoneForDisplay(c.phone)}</span>
                  <span className="text-sm text-slate-500 flex-1 truncate">{c.name}</span>
                  <button
                    onClick={() => handleRemove(c.id)} disabled={removingId === c.id} title="הסר"
                    className="text-slate-300 hover:text-red-500 disabled:opacity-50 transition-colors"
                  >
                    {removingId === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <input
              value={phone} onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="050-1234567" dir="ltr"
              className="input-base text-left"
            />
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="שם איש קשר (רשות)"
              className="input-base"
            />
            <button
              onClick={handleAdd} disabled={!phoneValid || saving}
              className="flex items-center gap-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-2 rounded-xl text-sm font-semibold transition-colors"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} הוסף
            </button>
          </div>
          {phone.trim() !== '' && !phoneValid && (
            <p className="text-xs text-red-500">מספר טלפון לא תקין</p>
          )}
        </section>
      </div>
    </div>
  );
}
