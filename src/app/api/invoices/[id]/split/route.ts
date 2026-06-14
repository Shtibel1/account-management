import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { PDFDocument } from 'pdf-lib';

function sanitizeStorageFilename(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  const ext = lastDot !== -1 ? fileName.substring(lastDot) : '';
  const nameWithoutExt = lastDot !== -1 ? fileName.substring(0, lastDot) : fileName;
  
  let sanitized = nameWithoutExt
    .replace(/[^a-zA-Z0-9-.]/g, '_')
    .replace(/__+/g, '_')
    .replace(/--+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '');
    
  if (!sanitized) {
    sanitized = Buffer.from(nameWithoutExt).toString('hex').substring(0, 16);
  }
  
  return `${sanitized}${ext}`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { splits } = body as { splits: { startPage: number; endPage: number }[] };

    if (!splits || !Array.isArray(splits) || splits.length === 0) {
      return NextResponse.json({ error: 'Missing or invalid splits parameter' }, { status: 400 });
    }

    // 1. Fetch current invoice record
    const { data: invoice, error: fetchErr } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !invoice) {
      console.error(`[Split API] Failed to fetch invoice ${id}:`, fetchErr);
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // 2. Download the original invoice file
    console.log(`[Split API] Downloading original PDF from: ${invoice.file_url}`);
    const downloadRes = await fetch(invoice.file_url);
    if (!downloadRes.ok) {
      throw new Error(`Failed to download original invoice file from storage: ${downloadRes.statusText}`);
    }
    const fileBuffer = Buffer.from(await downloadRes.arrayBuffer());

    const originalFileName = invoice.file_name || 'invoice.pdf';
    const lastDot = originalFileName.lastIndexOf('.');
    const ext = lastDot !== -1 ? originalFileName.substring(lastDot) : '.pdf';
    const nameWithoutExt = lastDot !== -1 ? originalFileName.substring(0, lastDot) : originalFileName;

    const originalDoc = await PDFDocument.load(fileBuffer);
    const results: { id: string; fileUrl: string; mimeType: string }[] = [];

    // 3. Process each split range
    for (let idx = 0; idx < splits.length; idx++) {
      const split = splits[idx];
      const startPage = split.startPage;
      const endPage = split.endPage;

      console.log(`[Split API] Processing part ${idx + 1}/${splits.length}: pages ${startPage}-${endPage}`);

      // Extract the pages and create a new PDF buffer
      const newDoc = await PDFDocument.create();
      const pagesToCopy: number[] = [];
      for (let p = startPage - 1; p <= endPage - 1; p++) {
        pagesToCopy.push(p);
      }
      const copiedPages = await newDoc.copyPages(originalDoc, pagesToCopy);
      copiedPages.forEach((page) => newDoc.addPage(page));
      const pdfBytes = await newDoc.save();
      const splitBuffer = Buffer.from(pdfBytes);

      // Upload split file to storage
      const splitFileName = `${nameWithoutExt}_חלק_${idx + 1}${ext}`;
      const sanitizedBase = sanitizeStorageFilename(nameWithoutExt);
      const storageFileName = `${sanitizedBase}_part_${idx + 1}${ext}`;
      const uploadPath = `${invoice.client_id}/${Date.now()}_${storageFileName}`;

      const { data: uploadData, error: uploadErr } = await supabase.storage
        .from('raw-invoices')
        .upload(uploadPath, splitBuffer, {
          contentType: 'application/pdf',
          upsert: true,
        });

      if (uploadErr || !uploadData) {
        throw new Error(`Failed to upload split PDF part ${idx + 1} to storage: ${uploadErr?.message}`);
      }

      // Generate signed URL
      const { data: signedData, error: signErr } = await supabase.storage
        .from('raw-invoices')
        .createSignedUrl(uploadPath, 60 * 60 * 24 * 365);

      if (signErr || !signedData?.signedUrl) {
        throw new Error(`Failed to create signed URL for split PDF part ${idx + 1}: ${signErr?.message}`);
      }

      const splitFileUrl = signedData.signedUrl;

      if (idx === 0) {
        // Update primary (current) invoice to represent the first split part
        const { error: updateErr } = await supabase
          .from('invoices')
          .update({
            file_url: splitFileUrl,
            file_name: splitFileName,
            status: 'processing',
            extracted_data: null,
            validated_data: null,
            ai_confidence: null,
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', id);

        if (updateErr) {
          throw new Error(`Failed to update primary invoice with split file: ${updateErr.message}`);
        }

        results.push({
          id,
          fileUrl: splitFileUrl,
          mimeType: 'application/pdf',
        });
      } else {
        // Insert new invoice record for other split parts
        const { data: newInvoice, error: insertErr } = await supabase
          .from('invoices')
          .insert({
            client_id: invoice.client_id,
            file_url: splitFileUrl,
            file_name: splitFileName,
            status: 'processing',
          })
          .select()
          .single();

        if (insertErr || !newInvoice) {
          throw new Error(`Failed to insert split invoice record for part ${idx + 1}: ${insertErr?.message}`);
        }

        results.push({
          id: newInvoice.id,
          fileUrl: splitFileUrl,
          mimeType: 'application/pdf',
        });
      }
    }

    console.log(`[Split API] Manual splitting complete for invoice ${id}. Generated ${results.length} parts.`);
    return NextResponse.json({ success: true, invoices: results });

  } catch (err) {
    console.error(`[Split API] Error during splitting of invoice ${id}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
