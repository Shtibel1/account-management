import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { buildStoragePath } from '@/lib/ingestHelpers';

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

    const filePath = buildStoragePath(clientId, fileName);

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
