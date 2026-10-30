import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'הזמנה | סריקה בעברית' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
