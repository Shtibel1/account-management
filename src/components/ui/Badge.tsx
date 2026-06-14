import clsx from 'clsx';

const statusConfig: Record<string, { label: string; className: string; dot: string }> = {
  processing: { label: 'מעבד...', className: 'bg-blue-50 text-blue-700 border-blue-200',   dot: 'bg-blue-400 animate-pulse' },
  review:     { label: 'לבדיקה',  className: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-400' },
  approved:   { label: 'אושר',    className: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  rejected:   { label: 'לא אושר',  className: 'bg-rose-50 text-rose-700 border-rose-200',    dot: 'bg-rose-500' },
  exported:   { label: 'יוצא',    className: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400' },
  error:      { label: 'חריג',     className: 'bg-red-50 text-red-700 border-red-200',       dot: 'bg-red-500' },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? { label: status, className: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400' };
  return (
    <span className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border', cfg.className)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', cfg.dot)} />
      {cfg.label}
    </span>
  );
}
