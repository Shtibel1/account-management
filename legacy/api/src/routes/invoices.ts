import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';
import { runExtractionPipeline } from '../services/ai/graph.js';

export async function invoiceRoutes(app: FastifyInstance) {
  // GET /api/invoices?clientId=&status=
  app.get('/invoices', async (req, reply) => {
    const { clientId, status } = req.query as Record<string, string>;
    let q = supabase.from('invoices').select('*').order('created_at', { ascending: false });
    if (clientId) q = q.eq('client_id', clientId);
    if (status)   q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return reply.code(500).send({ error: error.message });
    return data;
  });

  // GET /api/invoices/:id
  app.get('/invoices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { data, error } = await supabase.from('invoices').select('*').eq('id', id).single();
    if (error) return reply.code(404).send({ error: 'לא נמצא' });
    return data;
  });

  // PATCH /api/invoices/:id
  app.patch('/invoices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const { data, error } = await supabase
      .from('invoices')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) return reply.code(500).send({ error: error.message });
    return data;
  });

  // POST /api/invoices/upload  (multipart)
  app.post('/invoices/upload', async (req, reply) => {
    const parts = req.parts();
    let clientId = '';
    const uploadedIds: string[] = [];

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'clientId') {
        clientId = part.value as string;
        continue;
      }
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        const fileName = part.filename;
        const filePath = `${clientId}/${Date.now()}_${fileName}`;
        const mimeType = part.mimetype;

        // העלה ל-Supabase Storage
        const { error: storageErr } = await supabase.storage
          .from('raw-invoices')
          .upload(filePath, buffer, { contentType: mimeType, upsert: false });

        if (storageErr) {
          app.log.error(storageErr, 'storage upload failed');
          continue;
        }

        // signed URL עם תוקף שנה — עובד גם עם bucket פרטי
        const { data: signedData, error: signErr } = await supabase.storage
          .from('raw-invoices')
          .createSignedUrl(filePath, 60 * 60 * 24 * 365);

        if (signErr || !signedData?.signedUrl) {
          app.log.error(signErr, 'signed URL generation failed');
          continue;
        }

        const fileUrl = signedData.signedUrl;

        // צור רשומה ב-DB
        const { data: invoice, error: dbErr } = await supabase
          .from('invoices')
          .insert({
            client_id: clientId,
            file_url: fileUrl,
            file_name: fileName,
            status: 'processing',
          })
          .select()
          .single();

        if (dbErr) { app.log.error(dbErr); continue; }
        uploadedIds.push(invoice.id);

        // הפעל AI בסביבה אסינכרונית (לא חוסם את ה-response)
        runExtractionPipeline(invoice.id, fileUrl, mimeType).catch((e) =>
          app.log.error(e, `AI pipeline failed for ${invoice.id}`)
        );
      }
    }

    return reply.code(201).send({ ids: uploadedIds, count: uploadedIds.length });
  });
}
