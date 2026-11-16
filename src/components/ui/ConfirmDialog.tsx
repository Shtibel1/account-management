'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { useEscapeKey } from '@/components/ui/useEscapeKey';

/**
 * In-app replacement for the browser's native confirm(): native dialogs block the tab, ignore the
 * app's RTL styling and break automation (tests/noNativeDialogs.test.ts keeps them out of src/).
 *
 * Usage:
 *   const askConfirm = useConfirm();
 *   if (!(await askConfirm({ message: 'למחוק?', tone: 'danger' }))) return;
 */
export interface ConfirmOptions {
  message: ReactNode;
  title?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' paints the confirm button red (removals, deletes, double export). */
  tone?: 'default' | 'danger';
}

type AskConfirm = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<AskConfirm | null>(null);

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let counter = 0;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const askConfirm = useCallback<AskConfirm>((options) => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      // A new question while one is open answers the old one with "no" (as if cancelled).
      pendingRef.current?.resolve(false);
      const next = { ...opts, id: ++counter, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(ok);
  }, []);

  // Never leave a caller awaiting forever if the provider unmounts.
  useEffect(() => () => { pendingRef.current?.resolve(false); }, []);

  return (
    <ConfirmContext.Provider value={askConfirm}>
      {children}
      {pending && (
        <ConfirmDialog
          key={pending.id}
          {...pending}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/** Returns askConfirm(options) → Promise<boolean>, resolved true on "confirm", false on cancel/Esc/backdrop. */
export function useConfirm(): AskConfirm {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({
  message,
  title = 'אישור פעולה',
  confirmLabel = 'אישור',
  cancelLabel = 'ביטול',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => { restoreFocus.current?.focus?.(); };
  }, []);
  useEscapeKey(onCancel);

  // Focus trap: Tab / Shift+Tab cycle inside the dialog.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
      e.preventDefault(); first.focus();
    }
  };

  const danger = tone === 'danger';
  const Icon = danger ? AlertTriangle : HelpCircle;

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
      style={{ direction: 'rtl' }}
      onClick={onCancel}
      data-testid="confirm-dialog-backdrop"
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="bg-white rounded-2xl border border-slate-100 shadow-xl max-w-md w-full p-6 space-y-4 text-right max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h3 id="confirm-dialog-title" className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Icon className={danger ? 'h-5 w-5 text-rose-600 shrink-0' : 'h-5 w-5 text-blue-600 shrink-0'} aria-hidden="true" />
          {title}
        </h3>
        <div id="confirm-dialog-message" className="text-sm text-slate-600 whitespace-pre-line break-words">
          {message}
        </div>
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-sm rounded-xl transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={
              (danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700') +
              ' flex-1 py-2.5 text-white font-semibold text-sm rounded-xl transition-colors'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
