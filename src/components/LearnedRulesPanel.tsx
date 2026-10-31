'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Brain, ChevronDown, ChevronUp, Loader2, Trash2 } from 'lucide-react';
import { fetchLearnedRules, forgetLearnedRule, type LearnedRuleRow } from '@/lib/api';
import { learnableFieldName } from '@/shared/learning';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/ConfirmDialog';

/**
 * "The system learned X rules from your corrections" (mappings page): rules learned from corrected
 * fields whose right value was printed in the document, with a button to forget each one.
 */
export function LearnedRulesPanel({ clientId }: { clientId: string }) {
  const { toast } = useToast();
  const askConfirm = useConfirm();
  const [rules, setRules] = useState<LearnedRuleRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async (id: string) => {
    try {
      const res = await fetchLearnedRules(id);
      setRules(res.rules);
    } catch {
      setRules([]);
    }
  };

  useEffect(() => {
    setRules(null);
    if (clientId) load(clientId);
  }, [clientId]);

  if (!clientId || rules === null || rules.length === 0) return null;
  const active = rules.filter((r) => r.active).length;

  const forget = async (rule: LearnedRuleRow) => {
    const supplier = rule.supplier_name ?? rule.supplier_vat_id ?? 'הספק';
    const ok = await askConfirm({
      title: 'שכחת כלל',
      message: `לשכוח את הכלל "${learnableFieldName(rule.field)}" של ${supplier}? החשבוניות הבאות של הספק יזוהו בלי הכלל.`,
      confirmLabel: 'שכח כלל',
      tone: 'danger',
    });
    if (!ok) return;
    setDeleting(rule.id);
    try {
      await forgetLearnedRule(rule.id);
      toast('הכלל נמחק', 'success');
      await load(clientId);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'מחיקת הכלל נכשלה', 'error');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="card p-4 sm:p-5" data-testid="learned-rules">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-right"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 font-semibold text-slate-900 min-w-0">
          <Brain className="h-4 w-4 shrink-0 text-violet-500" />
          <span>המערכת למדה {active === 1 ? 'כלל אחד' : `${active} כללים`} מהתיקונים שלך{rules.length > active && ` (ועוד ${rules.length - active} מושהים)`}</span>
        </span>
        {open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-slate-500">
            כשמתקנים שדה וערך הנכון מודפס בחשבונית, המערכת זוכרת היכן הספק מדפיס אותו ומשתמשת בזה בחשבוניות הבאות שלו.
            תיקון יחיד לא משנה כלל קיים; כלל עם תיקונים סותרים מושהה עד שיש רוב ברור.
          </p>
          <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 p-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-medium text-slate-900 break-words">
                    {r.supplier_name ?? 'ספק'}
                    {r.supplier_vat_id && <span className="text-xs text-slate-400 font-mono mr-2" dir="ltr">{r.supplier_vat_id}</span>}
                  </div>
                  <div className="text-slate-600 break-words">
                    {learnableFieldName(r.field)}: הערך {r.line_offset === 1 ? 'שמתחת ל' : 'שליד '}
                    &quot;{r.label}&quot;
                    {r.wrong_label && <> ולא ליד &quot;{r.wrong_label}&quot;</>}
                  </div>
                  <div className="text-xs text-slate-400">
                    {r.support === 1 ? 'נלמד מתיקון אחד' : `נלמד מ-${r.support} תיקונים`}
                    {r.conflicts > 0 && ` · ${r.conflicts} סותרים`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={clsx(
                      'text-xs px-2 py-0.5 rounded-full border whitespace-nowrap',
                      r.active ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-amber-700 bg-amber-50 border-amber-200'
                    )}
                  >
                    {r.active ? 'פעיל' : 'מושהה'}
                  </span>
                  <button
                    type="button"
                    onClick={() => forget(r)}
                    disabled={deleting === r.id}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                    aria-label="שכח כלל"
                    title="שכח כלל"
                  >
                    {deleting === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
