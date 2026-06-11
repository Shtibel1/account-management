import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

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
    const { clientId, fileName, mimeType } = body as {
      clientId: string;
      fileName: string;
      mimeType: string;
    };

    if (!clientId || !fileName) {
      return NextResponse.json({ error: 'Missing clientId or fileName' }, { status: 400 });
    }

    const sanitizedName = sanitizeStorageFilename(fileName);
    const filePath = `${clientId}/${Date.now()}_${sanitizedName}`;

    // Generate signed upload URL
    const { data, error } = await supabase.storage
      .from('raw-invoices')
      .createSignedUploadUrl(filePath);

    if (error || !data?.signedUrl) {
      console.error('Failed to create signed upload URL:', error);
      return NextResponse.json(
        { error: `Failed to create signed upload URL: ${error?.message || 'Unknown error'}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      signedUrl: data.signedUrl,
      token: data.token, // Some SDK methods might use this
      filePath,
    });
  } catch (err) {
    console.error('Upload URL handler crashed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
