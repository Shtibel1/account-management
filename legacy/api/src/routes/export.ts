import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';
import { MoveinExporter } from '../services/exporters/movein.js';
import type { Invoice, AccountMapping } from '@invoice/shared-types';

export async function exportRoutes(app: FastifyInstance) {
  app.post('/export', async (req, reply) => {
    const { ids } = req.body as { ids: string[] };

    if (!ids?.length) return reply.code(400).send({ error: 'לא נבחרו חשבוניות' });

    // שליפת חשבוניות
    const { data: invoices, error } = await supabase
      .from('invoices')
      .select('*')
      .in('id', ids)
      .eq('status', 'approved');

    if (error) return reply.code(500).send({ error: error.message });
    if (!invoices?.length) return reply.code(400).send({ error: 'לא נמצאו חשבוניות מאושרות' });

    const clientId = (invoices[0] as Invoice).client_id;

    // שליפת לקוח + מיפויים
    const [{ data: client }, { data: rawMappings }] = await Promise.all([
      supabase.from('clients').select('*').eq('id', clientId).single(),
      supabase.from('account_mappings').select('*').eq('client_id', clientId),
    ]);

    const mappings = (rawMappings as AccountMapping[]) ?? [];

    // בדיקת מיפויים חסרים
    const missing: string[] = [];
    for (const inv of invoices as Invoice[]) {
      const data = inv.validated_data ?? inv.extracted_data;
      if (!data) continue;
      if (data.supplier_name && !mappings.find((m) => m.mapping_type === 'supplier' && m.key === data.supplier_name)) {
        missing.push(`ספק: ${data.supplier_name}`);
      }
      if (data.expense_category && !mappings.find((m) => m.mapping_type === 'category' && m.key === data.expense_category)) {
        missing.push(`קטגוריה: ${data.expense_category}`);
      }
    }

    if (missing.length) {
      return reply.code(422).send({
        error: 'מיפויים חסרים',
        missing: [...new Set(missing)],
      });
    }

    // ייצוא
    const exporter = new MoveinExporter();
    const buffer = exporter.export(invoices as Invoice[], mappings, client.vat_account);

    // עדכון סטטוס
    await supabase
      .from('invoices')
      .update({ status: 'exported', exported_at: new Date().toISOString() })
      .in('id', ids);

    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="movein_${Date.now()}.txt"`)
      .send(buffer);
  });
}
