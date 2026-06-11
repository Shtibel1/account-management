import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { runOrchestrationPipeline } from '@/agents/supervisor';

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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { clientId, files } = body as {
      clientId: string;
      files: { filePath: string; fileName: string; mimeType: string }[];
    };

    if (!clientId) {
      return NextResponse.json({ error: 'Missing clientId' }, { status: 400 });
    }

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files specified' }, { status: 400 });
    }

    const results: { fileName: string; status: 'success' | 'error'; id?: string; error?: string }[] = [];

    for (const file of files) {
      const { filePath, fileName, mimeType } = file;

      // 1. Generate signed URL valid for 1 year
      const { data: signedData, error: signErr } = await supabase.storage
        .from('raw-invoices')
        .createSignedUrl(filePath, 60 * 60 * 24 * 365);

      if (signErr || !signedData?.signedUrl) {
        console.error('Signed URL generation failed:', signErr);
        const errMsg = `Signed URL generation failed: ${signErr?.message || 'Unknown error'}`;

        // Record failure in database
        const { data: invoice, error: dbErr } = await supabase
          .from('invoices')
          .insert({
            client_id: clientId,
            file_url: '',
            file_name: fileName,
            status: 'error',
            error_message: errMsg,
          })
          .select()
          .single();

        results.push({
          fileName,
          status: 'error',
          id: invoice?.id,
          error: errMsg + (dbErr ? `. Also DB insert failed: ${dbErr.message}` : ''),
        });
        continue;
      }

      const fileUrl = signedData.signedUrl;

      // 2. Insert Invoice record in database
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

      if (dbErr) {
        console.error('Database insertion failed:', dbErr);
        results.push({
          fileName,
          status: 'error',
          error: `Database insertion failed: ${dbErr.message}`,
        });
        continue;
      }

      results.push({
        fileName,
        status: 'success',
        id: invoice.id,
      });

      // 3. Trigger LangGraph flow asynchronously (non-blocking)
      runOrchestrationPipeline(invoice.id, fileUrl, mimeType, clientId).catch((err) => {
        console.error(`LangGraph Pipeline failed for invoice ${invoice.id}:`, err);
      });
    }

    return NextResponse.json({ results, count: results.length }, { status: 201 });
  } catch (err) {
    console.error('Upload handler crashed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
