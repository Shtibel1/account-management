// Upload rules shared by the browser (UploadZone) and the server (upload-url / upload routes).
// Pure: no Node or browser APIs, so it is safe in client components.

/** Max size of one document - the same 20 MB the email / WhatsApp channels enforce. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Types Google Vision can OCR and the review screen can show. HEIC is not supported by Vision. */
export type UploadMimeType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

export const UPLOAD_MIME_BY_EXTENSION: Record<string, UploadMimeType> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** react-dropzone `accept` value. */
export const DROPZONE_ACCEPT: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
};

export const UNSUPPORTED_TYPE_MESSAGE = 'סוג קובץ לא נתמך - ניתן להעלות PDF, JPG, PNG או WEBP בלבד';
export const TOO_LARGE_MESSAGE = 'הקובץ גדול מ-20MB - יש לפצל או לכווץ אותו';
export const EMPTY_FILE_MESSAGE = 'הקובץ ריק';
export const CONTENT_MISMATCH_MESSAGE = 'תוכן הקובץ אינו PDF או תמונה תקינים - יש להעלות קובץ אחר';

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

/** The upload type implied by the file name, or null when the extension isn't supported. */
export function mimeFromFileName(fileName: string): UploadMimeType | null {
  return UPLOAD_MIME_BY_EXTENSION[fileExtension(fileName)] ?? null;
}

export type UploadCheck = { ok: true; mimeType: UploadMimeType } | { ok: false; error: string };

/**
 * Checks what the browser declares before anything is stored: a supported extension, a declared
 * type that agrees with it (empty / octet-stream are allowed: some browsers send nothing), and a
 * size within the limit when it is known.
 */
export function checkUploadDeclaration(input: { fileName: unknown; mimeType?: unknown; size?: unknown }): UploadCheck {
  if (typeof input.fileName !== 'string' || !input.fileName.trim()) {
    return { ok: false, error: 'חסר שם קובץ' };
  }
  const byName = mimeFromFileName(input.fileName);
  if (!byName) return { ok: false, error: UNSUPPORTED_TYPE_MESSAGE };

  const declared = typeof input.mimeType === 'string' ? input.mimeType.toLowerCase().split(';')[0].trim() : '';
  if (declared && declared !== 'application/octet-stream') {
    const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;
    if (normalized !== byName) return { ok: false, error: UNSUPPORTED_TYPE_MESSAGE };
  }

  if (input.size !== undefined && input.size !== null) {
    if (typeof input.size !== 'number' || !Number.isFinite(input.size) || input.size < 0) {
      return { ok: false, error: 'גודל הקובץ אינו תקין' };
    }
    if (input.size === 0) return { ok: false, error: EMPTY_FILE_MESSAGE };
    if (input.size > MAX_UPLOAD_BYTES) return { ok: false, error: TOO_LARGE_MESSAGE };
  }
  return { ok: true, mimeType: byName };
}

/** Real type from the first bytes (magic numbers); null when it is none of the supported types. */
export function sniffUploadMime(bytes: Uint8Array): UploadMimeType | null {
  const b = bytes;
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'image/png';
  if (
    b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  return null;
}

/** Server-side check of the stored bytes (size + magic bytes). */
export function checkStoredBytes(bytes: Uint8Array): UploadCheck {
  if (bytes.byteLength === 0) return { ok: false, error: EMPTY_FILE_MESSAGE };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: TOO_LARGE_MESSAGE };
  const mime = sniffUploadMime(bytes);
  if (!mime) return { ok: false, error: CONTENT_MISMATCH_MESSAGE };
  return { ok: true, mimeType: mime };
}

/** "קובץ אחד" / "3 קבצים" */
export function filesLabel(count: number): string {
  return count === 1 ? 'קובץ אחד' : `${count} קבצים`;
}
