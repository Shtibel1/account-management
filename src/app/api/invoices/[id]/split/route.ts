import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { PDFDocument } from 'pdf-lib';
import { saveInvoiceFileHash, sha256Hex } from '@/lib/fileHash';
import { validateSplitRanges } from '@/shared/documentSplit';
import { requireInvoiceAccess } from '@/lib/auth';
import { isClientStorageFileUrl } from '@/lib/ingestHelpers';
import { isMockMode, supabaseUrl } from '@/lib/supabaseConfig';
import { downloadInvoiceFile, redactUrlForLog, storedFileUrlFor } from '@/lib/invoiceFiles';

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

  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;

  try {
    const body = await request.json();
    const { splits: requestedSplits } = body as { splits: unknown };

    if (!requestedSplits || !Array.isArray(requestedSplits) || requestedSplits.length === 0) {
      return NextResponse.json({ error: 'לא התקבלו טווחי עמודים לפיצול' }, { status: 400 });
    }

    // 1. Fetch current invoice record
    const { data: invoice, error: fetchErr } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !invoice) {
      console.error(`[Split API] Failed to fetch invoice ${id}:`, fetchErr);
      return NextResponse.json({ error: 'החשבונית לא נמצאה' }, { status: 404 });
    }

    // 2. Download the original invoice file (file_url is user-editable: only our own storage URLs for this client)
    if (!isMockMode() && !isClientStorageFileUrl(invoice.file_url, invoice.client_id, process.env.SUPABASE_URL || supabaseUrl())) {
      console.error(`[Split API] Refusing to fetch untrusted file URL for invoice ${id}`);
      return NextResponse.json({ error: 'קובץ החשבונית אינו קובץ אחסון של הלקוח, ולכן לא ניתן לפצל אותו' }, { status: 400 });
    }
    console.log(`[Split API] Downloading original PDF from: ${redactUrlForLog(invoice.file_url)}`);
    // Service-role Storage read of the object (file_url is a storage reference, not a link - QA #31)
    const fileBuffer = await downloadInvoiceFile(invoice.file_url, invoice.client_id);
    if (!fileBuffer) {
      throw new Error('Failed to download original invoice file from storage');
    }

    const originalFileName = invoice.file_name || 'invoice.pdf';
    const lastDot = originalFileName.lastIndexOf('.');
    const ext = lastDot !== -1 ? originalFileName.substring(lastDot) : '.pdf';
    const nameWithoutExt = lastDot !== -1 ? originalFileName.substring(0, lastDot) : originalFileName;

    const originalDoc = await PDFDocument.load(fileBuffer);

    // Ranges must be 1-based, contiguous, non-overlapping and cover every page of this file
    const rangeCheck = validateSplitRanges(requestedSplits, originalDoc.getPageCount());
    if (!rangeCheck.ok) {
      return NextResponse.json({ error: rangeCheck.error }, { status: 400 });
    }
    if (rangeCheck.ranges.length < 2) {
      return NextResponse.json({ error: 'נדרשים לפחות שני חלקים כדי לפצל את המסמך' }, { status: 400 });
    }
    const splits = rangeCheck.ranges.map((r) => ({ startPage: r.start_page, endPage: r.end_page }));

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
      const splitFileHash = sha256Hex(splitBuffer);

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

      // Stored as a storage reference, not a bearer link (QA #31)
      const splitFileUrl = storedFileUrlFor(uploadPath);

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
        // The invoice now points at the split part, so its fingerprint changes with it
        await saveInvoiceFileHash(supabase, id, splitFileHash);

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
        await saveInvoiceFileHash(supabase, newInvoice.id, splitFileHash);

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
    return NextResponse.json({ error: 'פיצול המסמך נכשל. נסו שוב.' }, { status: 500 });
  }
}
