/**
 * Response headers of the Move-in download (POST /api/export).
 *
 * The body is Windows-1255 bytes. It must NOT be labelled text/*: on Amplify Hosting (SSR compute
 * behind CloudFront) a text/* response body is handled as a UTF-8 string, so every Hebrew byte
 * (0xE0-0xFA, an invalid UTF-8 lead byte) was replaced with U+FFFD (EF BF BD) - the Hebrew was lost
 * and each 332-byte line grew to 382 bytes. application/octet-stream is passed through as binary
 * by every proxy / CDN, and the browser saves it as is (the file is consumed by Move-in, not
 * displayed). The encoding is stated in X-Content-Charset for clients / support.
 */
export const MOVEIN_FILE_NAME = 'movein.dat';
export const MOVEIN_CONTENT_TYPE = 'application/octet-stream';
export const MOVEIN_CHARSET = 'windows-1255';

export function moveinDownloadHeaders(byteLength: number, fileName: string = MOVEIN_FILE_NAME): Headers {
  const headers = new Headers();
  headers.set('Content-Type', MOVEIN_CONTENT_TYPE);
  headers.set('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  headers.set('Content-Length', String(byteLength));
  headers.set('X-Content-Charset', MOVEIN_CHARSET);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store');
  return headers;
}
