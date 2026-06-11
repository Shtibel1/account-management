import clsx from 'clsx';

interface Props {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'dark' | 'light';
}

const sizes = { sm: 28, md: 36, lg: 48 };

export function Logo({ size = 'md', variant = 'light' }: Props) {
  const px = sizes[size];
  const textColor = variant === 'dark' ? 'text-white' : 'text-slate-900';
  const subColor = variant === 'dark' ? 'text-blue-400' : 'text-blue-600';

  return (
    <div className="flex items-center gap-2.5 select-none">
      <svg width={px} height={px} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* רקע מעוגל */}
        <rect width="40" height="40" rx="10" fill="#2563EB" />
        {/* מסמך */}
        <rect x="10" y="7" width="16" height="20" rx="2" fill="white" fillOpacity="0.15" />
        <rect x="10" y="7" width="16" height="20" rx="2" stroke="white" strokeWidth="1.5" strokeOpacity="0.6" />
        {/* שורות טקסט */}
        <line x1="13" y1="13" x2="23" y2="13" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.7" />
        <line x1="13" y1="17" x2="21" y2="17" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.7" />
        <line x1="13" y1="21" x2="19" y2="21" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.5" />
        {/* עיגול ✓ */}
        <circle cx="28" cy="28" r="8" fill="#10B981" />
        <polyline points="24,28 27,31 32,25" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      <div className="leading-none">
        <p className={clsx('font-bold tracking-tight', textColor, size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-xl' : 'text-base')}>
          חשבוניות
        </p>
        <p className={clsx('font-semibold', subColor, size === 'sm' ? 'text-xs' : 'text-sm')}>
          Pro
        </p>
      </div>
    </div>
  );
}
