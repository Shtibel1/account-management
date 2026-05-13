'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Invoice } from '@invoice/shared-types';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { exportInvoices } from '@/lib/api';
import { format } from 'date-fns';

interface Props {
  invoices: Invoice[];
  onExported?: () => void;
}

export function InvoiceTable({ invoices, onExported }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const approved = invoices.filter((i) => i.status === 'approved');
  const toggleAll = () => {
    if (selected.size === approved.length) setSelected(new Set());
    else setSelected(new Set(approved.map((i) => i.id)));
  };

  const handleExport = async () => {
    if (!selected.size) return;
    setExporting(true);
    try {
      const blob = await exportInvoices([...selected]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `יומן_${format(new Date(), 'yyyyMMdd_HHmm')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      onExported?.();
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {selected.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-primary-50 rounded-lg border border-primary-200">
          <span className="text-sm text-primary-700 font-medium">{selected.size} חשבוניות נבחרו</span>
          <Button onClick={handleExport} disabled={exporting} size="sm">
            {exporting ? 'מייצא...' : 'ייצא ל-Move-in'}
          </Button>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="p-3 text-right w-10">
                <input
                  type="checkbox"
                  checked={selected.size === approved.length && approved.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <th className="p-3 text-right font-medium text-gray-600">שם קובץ</th>
              <th className="p-3 text-right font-medium text-gray-600">ספק</th>
              <th className="p-3 text-right font-medium text-gray-600">תאריך</th>
              <th className="p-3 text-right font-medium text-gray-600">סה"כ</th>
              <th className="p-3 text-right font-medium text-gray-600">סטטוס</th>
              <th className="p-3 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {invoices.map((inv) => {
              const data = inv.validated_data ?? inv.extracted_data;
              return (
                <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                  <td className="p-3">
                    {inv.status === 'approved' && (
                      <input
                        type="checkbox"
                        checked={selected.has(inv.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          e.target.checked ? next.add(inv.id) : next.delete(inv.id);
                          setSelected(next);
                        }}
                      />
                    )}
                  </td>
                  <td className="p-3 text-gray-700 max-w-[180px] truncate">{inv.file_name}</td>
                  <td className="p-3 text-gray-700">{data?.supplier_name ?? '—'}</td>
                  <td className="p-3 text-gray-500">{data?.invoice_date ?? '—'}</td>
                  <td className="p-3 text-gray-700">
                    {data?.total_amount != null
                      ? `₪${data.total_amount.toLocaleString('he-IL')}`
                      : '—'}
                  </td>
                  <td className="p-3"><StatusBadge status={inv.status} /></td>
                  <td className="p-3">
                    {(inv.status === 'review' || inv.status === 'approved') && (
                      <Link href={`/review/${inv.id}`} className="text-primary-600 hover:underline text-xs font-medium">
                        פתח
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-gray-400">אין חשבוניות</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
