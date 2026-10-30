import { NextResponse } from 'next/server';
import { registerStoredDocument, schedulePipeline, type RegisterResult } from '@/lib/ingest';
import { requireClientAccess } from '@/lib/auth';
import { isOwnStoragePath } from '@/lib/ingestHelpers';
import { checkUploadDeclaration, mimeFromFileName } from '@/shared/uploadValidation';

/** Max files registered in one request. */
const MAX_FILES = 50;

/**
 * Registers files the browser already PUT into raw-invoices (see /api/invoices/upload-url).
 * registerStoredDocument checks the stored bytes (size, empty, real PDF / image by magic bytes):
 * a rejected file gets no invoice row and is reported per file with a Hebrew error.
 * Each registered row is queued for processing here, on the server (`queued: true` per result), so
 * processing never depends on the browser's /process call (QA round 3); the scheduled worker and the
 * review screens drive the queued jobs.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
  }
  const { clientId, files } = (body && typeof body === 'object' ? body : {}) as {
    clientId?: unknown;
    files?: unknown;
  };

  if (typeof clientId !== 'string' || !clientId) {
    return NextResponse.json({ error: 'לא נבחר לקוח' }, { status: 400 });
  }

  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;

  if (!Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: 'לא נבחרו קבצים' }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `ניתן לרשום עד ${MAX_FILES} קבצים בבקשה אחת` }, { status: 400 });
  }

  // Only files under this client's folder (as issued by /api/invoices/upload-url) may be
  // registered - otherwise a user could attach another tenant's stored document.
  const typed = files as { filePath?: unknown; fileName?: unknown }[];
  if (typed.some((f) => !f || typeof f.filePath !== 'string' || typeof f.fileName !== 'string' || !isOwnStoragePath(clientId, f.filePath))) {
    return NextResponse.json({ error: 'נתיב הקובץ אינו שייך ללקוח זה' }, { status: 400 });
  }

  try {
    const results: RegisterResult[] = [];
    for (const file of typed as { filePath: string; fileName: string }[]) {
      const declared = checkUploadDeclaration({ fileName: file.fileName });
      if (!declared.ok) {
        results.push({ fileName: file.fileName, status: 'error', error: declared.error });
        continue;
      }
      // registerStoredDocument also fingerprints the stored bytes (invoices.file_hash) before
      // returning, so the hash is in place before the job is queued.
      const registered = await registerStoredDocument({ clientId, filePath: file.filePath, fileName: file.fileName, source: 'upload' });
      results.push(
        registered.status === 'success'
          ? { ...registered, queued: await schedulePipeline(registered.id, mimeFromFileName(file.fileName)) }
          : registered
      );
    }

    const anySuccess = results.some((r) => r.status === 'success');
    return NextResponse.json({ results, count: results.length }, { status: anySuccess ? 201 : 422 });
  } catch (err) {
    console.error('Upload handler crashed:', err);
    return NextResponse.json({ error: 'רישום הקבצים נכשל. יש לנסות שוב' }, { status: 500 });
  }
}
