import clsx from 'clsx';

const statusLabels: Record<string, string> = {
  processing: 'מעבד...',
  review:     'ממתין לבדיקה',
  approved:   'אושר',
  exported:   'יוצא',
  error:      'שגיאה',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium', `status-${status}`)}>
      {statusLabels[status] ?? status}
    </span>
  );
}
