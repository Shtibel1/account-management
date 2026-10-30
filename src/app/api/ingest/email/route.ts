import { NextResponse } from 'next/server';
import { ingestDocument, isAlreadyIngested } from '@/lib/ingest';
import { findClientByAlias } from '@/lib/clientChannels';
import {
  base64DecodedLength,
  detectDocumentMime,
  ensureExtension,
  extractInboundAliases,
  extractIngestSecret,
  looksLikeDocument,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS_PER_MESSAGE,
  MIN_EMAIL_IMAGE_BYTES,
  normalizeInboundEmail,
  readBodyText,
  safeEqual,
} from '@/lib/ingestHelpers';

export const runtime = 'nodejs';

/**
 * Whole webhook body cap. Postmark accepts inbound messages up to 35MB; base64 inflates that by ~4/3,
 * so 50MB lets the largest Postmark payload through (a 413 would make the provider retry forever).
 */
const MAX_BODY_BYTES = 50 * 1024 * 1024;

interface AttachmentOutcome {
  fileName: string;
  status: 'ingested' | 'skipped' | 'error';
  reason?: string;
  invoiceId?: string;
}

/**
 * Inbound email webhook. Provider-agnostic JSON body (or Postmark's inbound JSON), see docs/ingestion.md.
 * The client is resolved from the recipient alias (<alias>@INBOUND_EMAIL_DOMAIN); each PDF / image
 * attachment becomes an invoice with source='email'.
 *
 * Unknown recipients and mails without documents answer 200 so the provider doesn't retry them.
 */
export async function POST(request: Request) {
  const expectedSecret = process.env.INGEST_EMAIL_SECRET;
  if (!expectedSecret) {
    console.error('[Ingest Email] INGEST_EMAIL_SECRET is not set - rejecting inbound email.');
    return NextResponse.json({ error: 'Email ingestion is not configured' }, { status: 503 });
  }

  const providedSecret = extractIngestSecret(request.headers);
  if (!providedSecret || !safeEqual(providedSecret, expectedSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    const raw = await readBodyText(request, MAX_BODY_BYTES);
    if (raw === null) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    body = JSON.parse(raw);
  } catch (err) {
    console.error('[Ingest Email] Invalid JSON body:', err);
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = normalizeInboundEmail(body);
  if (!email) {
    return NextResponse.json({ error: 'Body must include "to" and "attachments"' }, { status: 400 });
  }

  try {
    const aliases = extractInboundAliases(email.recipients, process.env.INBOUND_EMAIL_DOMAIN);
    const client = aliases.length > 0 ? await findClientByAlias(aliases) : null;
    if (!client) {
      console.warn(`[Ingest Email] No client for recipients ${email.recipients.join(', ')} (from ${email.from ?? 'unknown'})`);
      return NextResponse.json({ status: 'unknown_recipient', ingested: 0 }, { status: 200 });
    }

    const outcomes: AttachmentOutcome[] = [];
    let accepted = 0;

    for (let i = 0; i < email.attachments.length; i++) {
      const att = email.attachments[i];
      const fileName = att.filename;

      if (!looksLikeDocument(att.contentType, fileName)) {
        outcomes.push({ fileName, status: 'skipped', reason: 'unsupported_type' });
        continue;
      }
      if (accepted >= MAX_DOCUMENTS_PER_MESSAGE) {
        outcomes.push({ fileName, status: 'skipped', reason: 'too_many_attachments' });
        continue;
      }
      const size = base64DecodedLength(att.contentBase64);
      if (size === 0) {
        outcomes.push({ fileName, status: 'skipped', reason: 'empty' });
        continue;
      }
      if (size > MAX_DOCUMENT_BYTES) {
        outcomes.push({ fileName, status: 'skipped', reason: 'too_large' });
        continue;
      }

      const bytes = new Uint8Array(Buffer.from(att.contentBase64, 'base64'));
      const mime = detectDocumentMime(bytes);
      if (!mime) {
        outcomes.push({ fileName, status: 'skipped', reason: 'unsupported_type' });
        continue;
      }
      if (mime !== 'application/pdf' && bytes.byteLength < MIN_EMAIL_IMAGE_BYTES) {
        outcomes.push({ fileName, status: 'skipped', reason: 'image_too_small' });
        continue;
      }

      accepted++;
      const sourceRef = email.messageId ? `email:${email.messageId}#${i}` : null;
      if (sourceRef && (await isAlreadyIngested(sourceRef))) {
        outcomes.push({ fileName, status: 'skipped', reason: 'duplicate' });
        continue;
      }

      const result = await ingestDocument({
        clientId: client.id,
        fileName: ensureExtension(fileName, mime),
        mimeType: mime,
        bytes,
        source: 'email',
        sender: email.from,
        sourceRef,
      });
      outcomes.push(
        result.status === 'success'
          ? { fileName, status: 'ingested', invoiceId: result.id }
          : result.duplicate
            ? { fileName, status: 'skipped', reason: 'duplicate' }
            : { fileName, status: 'error', reason: result.error }
      );
    }

    const ingested = outcomes.filter((o) => o.status === 'ingested').length;
    const failed = outcomes.filter((o) => o.status === 'error').length;
    console.log(
      `[Ingest Email] client=${client.id} from=${email.from ?? 'unknown'} ingested=${ingested} failed=${failed} skipped=${outcomes.length - ingested - failed}`
    );

    // Only fail the webhook (so the provider retries) when every document failed to ingest.
    const status = failed > 0 && ingested === 0 ? 500 : 200;
    return NextResponse.json(
      { status: ingested > 0 ? 'ok' : failed > 0 ? 'error' : 'no_documents', clientId: client.id, ingested, attachments: outcomes },
      { status }
    );
  } catch (err) {
    console.error('[Ingest Email] Handler crashed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
