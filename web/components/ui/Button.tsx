import clsx from 'clsx';
import { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

const variants = {
  primary:   'bg-blue-600 text-white hover:bg-blue-700 shadow-sm disabled:opacity-50',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
  danger:    'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  ghost:     'text-slate-600 hover:bg-slate-100',
};

const sizes = {
  sm: 'px-3.5 py-1.5 text-sm',
  md: 'px-5 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export function Button({ variant = 'primary', size = 'md', className, children, ...props }: Props) {
  return (
    <button
      className={clsx('rounded-xl font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5', variants[variant], sizes[size], className)}
      {...props}
    >
      {children}
    </button>
  );
}
