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
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
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
              className="mr-1 opacity-70 hover:opacity-100"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <X className="h-3 w-3" />
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
