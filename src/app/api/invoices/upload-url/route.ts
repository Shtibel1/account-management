import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { buildStoragePath } from '@/lib/ingestHelpers';
import { requireClientAccess } from '@/lib/auth';
import { checkUploadDeclaration } from '@/shared/uploadValidation';

/**
 * Issues a signed Storage upload URL for one file. The declared name / type / size are checked
 * first (PDF, JPG, PNG, WEBP up to 20 MB); the stored bytes are checked again by /api/invoices/upload.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
  }
  const { clientId, fileName, mimeType, size } = (body && typeof body === 'object' ? body : {}) as {
    clientId?: unknown;
    fileName?: unknown;
    mimeType?: unknown;
    size?: unknown;
  };

  if (typeof clientId !== 'string' || !clientId) {
    return NextResponse.json({ error: 'לא נבחר לקוח' }, { status: 400 });
  }

  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;

  const check = checkUploadDeclaration({ fileName, mimeType, size });
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.error.includes('20MB') ? 413 : 400 });
  }

  try {
    const filePath = buildStoragePath(clientId, fileName as string);

    // Generate signed upload URL
    const { data, error } = await supabase.storage
      .from('raw-invoices')
      .createSignedUploadUrl(filePath);

    if (error || !data?.signedUrl) {
      console.error('Failed to create signed upload URL:', error);
      return NextResponse.json({ error: 'לא ניתן היה להכין את העלאת הקובץ. יש לנסות שוב' }, { status: 500 });
    }

    return NextResponse.json({
      signedUrl: data.signedUrl,
      token: data.token, // Some SDK methods might use this
      filePath,
    });
  } catch (err) {
    console.error('Upload URL handler crashed:', err);
    return NextResponse.json({ error: 'לא ניתן היה להכין את העלאת הקובץ. יש לנסות שוב' }, { status: 500 });
  }
}
