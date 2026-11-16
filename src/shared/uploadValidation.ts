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

/** A PDF header followed by garbage, a truncated file, a PDF pdf-lib can't parse or whose page tree can't be read (QA rounds 4-5). */
export const DAMAGED_PDF_MESSAGE = 'קובץ ה-PDF פגום ולא ניתן לקרוא אותו - יש לייצא או לסרוק אותו מחדש ולהעלות שוב';

/** Bytes searched for the first PDF object (every real PDF has one right after its header). */
const PDF_OBJECT_SCAN_BYTES = 64 * 1024;
/** No real PDF (header, one object, xref / trailer) is this small. */
const MIN_PDF_BYTES = 64;
/**
 * Bytes at the end searched for the trailer. Readers look in the last 1 KB; some producers append
 * whitespace, NULs or a stray line after %%EOF, so twice that is tolerated.
 */
export const PDF_TRAILER_SCAN_BYTES = 2 * 1024;

const PDF_EOF_MARKER = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
const PDF_STARTXREF_MARKER = [0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66]; // startxref

function endsRegionContains(bytes: Uint8Array, from: number, marker: number[]): boolean {
  for (let i = bytes.byteLength - marker.length; i >= from; i--) {
    let k = 0;
    while (k < marker.length && bytes[i + k] === marker[k]) k++;
    if (k === marker.length) return true;
  }
  return false;
}

/**
 * True when the file ends like a complete PDF: '%%EOF' or 'startxref' within the last
 * PDF_TRAILER_SCAN_BYTES. A file cut off mid-way (a broken download or copy) ends inside a stream
 * instead, which pdf-lib may still "load" with a wrong page count (QA round 5 #3). With incremental
 * updates the last update ends with its own trailer, so only the end matters.
 */
export function hasPdfTrailer(bytes: Uint8Array): boolean {
  const from = Math.max(0, bytes.byteLength - PDF_TRAILER_SCAN_BYTES);
  return endsRegionContains(bytes, from, PDF_EOF_MARKER) || endsRegionContains(bytes, from, PDF_STARTXREF_MARKER);
}

/**
 * Cheap structural check of a file that starts with '%PDF-': it is not tiny, ends with a trailer
 * (hasPdfTrailer) and has an indirect object ("<n> <gen> obj") near its start. Catches a header
 * followed by garbage, or a truncated file, before anything is stored or OCR'd; deeper damage shows
 * when the page tree is read (readPdfPageCount).
 */
export function hasPdfStructure(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MIN_PDF_BYTES) return false;
  if (!hasPdfTrailer(bytes)) return false;
  const end = Math.min(bytes.byteLength, PDF_OBJECT_SCAN_BYTES);
  // "obj" preceded by whitespace and a digit (the generation number), e.g. "1 0 obj"
  for (let i = 2; i + 2 < end; i++) {
    if (bytes[i] === 0x6f && bytes[i + 1] === 0x62 && bytes[i + 2] === 0x6a) {
      let j = i - 1;
      if (bytes[j] !== 0x20 && bytes[j] !== 0x0a && bytes[j] !== 0x0d && bytes[j] !== 0x09) continue;
      while (j > 0 && (bytes[j] === 0x20 || bytes[j] === 0x0a || bytes[j] === 0x0d || bytes[j] === 0x09)) j--;
      if (bytes[j] >= 0x30 && bytes[j] <= 0x39) return true;
    }
  }
  return false;
}

/**
 * Page count of a parsed PDF, or null when its page tree can't be read: pdf-lib loads some damaged
 * files without throwing and only fails on getPageCount() (TypeError reading 'Pages', QA round 4).
 */
export function readPdfPageCount(doc: { getPageCount(): number }): number | null {
  try {
    const n = doc.getPageCount();
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Server-side check of the stored bytes (size + magic bytes, and a PDF's basic structure). */
export function checkStoredBytes(bytes: Uint8Array): UploadCheck {
  if (bytes.byteLength === 0) return { ok: false, error: EMPTY_FILE_MESSAGE };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: TOO_LARGE_MESSAGE };
  const mime = sniffUploadMime(bytes);
  if (!mime) return { ok: false, error: CONTENT_MISMATCH_MESSAGE };
  if (mime === 'application/pdf' && !hasPdfStructure(bytes)) return { ok: false, error: DAMAGED_PDF_MESSAGE };
  return { ok: true, mimeType: mime };
}

/** "קובץ אחד" / "3 קבצים" */
export function filesLabel(count: number): string {
  return count === 1 ? 'קובץ אחד' : `${count} קבצים`;
}
