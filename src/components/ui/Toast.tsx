'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import clsx from 'clsx';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastCtx {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastCtx>({ toast: () => {} });

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++counter;
    setToasts((prev) => [...prev, { id, message, type }]);
    // Errors stay longer: they usually need to be read (and acted on)
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), type === 'error' ? 8000 : 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed top-4 inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            className={clsx(
              'flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium pointer-events-auto animate-in fade-in slide-in-from-top-2 duration-200',
              t.type === 'success' && 'bg-green-600 text-white',
              t.type === 'error'   && 'bg-red-600 text-white',
              t.type === 'info'    && 'bg-gray-900 text-white',
            )}
          >
            {t.type === 'success' && <CheckCircle className="h-4 w-4 shrink-0" />}
            {t.type === 'error'   && <AlertCircle className="h-4 w-4 shrink-0" />}
            {t.type === 'info'    && <Info className="h-4 w-4 shrink-0" />}
            {t.message}
            <button
              type="button"
              aria-label="סגירת ההודעה"
              className="-my-2 -ml-2 mr-1 h-8 w-8 shrink-0 inline-flex items-center justify-center rounded opacity-70 hover:opacity-100"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
