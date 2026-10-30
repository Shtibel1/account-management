import { NextResponse } from 'next/server';
import { registerStoredDocument, type RegisterResult } from '@/lib/ingest';

/**
 * Registers files the browser already PUT into raw-invoices (see /api/invoices/upload-url).
 * The browser then triggers /api/invoices/[id]/process for each successful row.
 */
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

    const results: RegisterResult[] = [];

    for (const file of files) {
      results.push(
        await registerStoredDocument({ clientId, filePath: file.filePath, fileName: file.fileName, source: 'upload' })
      );
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
