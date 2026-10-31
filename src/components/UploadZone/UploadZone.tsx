'use client';

import { useCallback, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import clsx from 'clsx';
import { CloudUpload, FileText, CheckCircle2, XCircle, Loader2, FileImage } from 'lucide-react';
import { uploadInvoices } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import {
  DROPZONE_ACCEPT,
  MAX_UPLOAD_BYTES,
  TOO_LARGE_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
  checkUploadDeclaration,
  filesLabel,
} from '@/shared/uploadValidation';
import { useProcessingTicks } from '@/components/Processing/ProcessingStatus';

interface FileState {
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Hebrew reason for a file the dropzone refused (type / size). */
function rejectionMessage(rejection: FileRejection): string {
  const codes = rejection.errors.map((e) => e.code);
  if (codes.includes('file-too-large')) return TOO_LARGE_MESSAGE;
  if (codes.includes('file-invalid-type')) return UNSUPPORTED_TYPE_MESSAGE;
  return 'לא ניתן להעלות את הקובץ';
}

export function UploadZone({ clientId, disabled = false }: { clientId: string; disabled?: boolean }) {
  const [files, setFiles] = useState<FileState[]>([]);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  // Invoices queued from this screen: keep their processing moving while the user stays here
  const [queuedIds, setQueuedIds] = useState<string[]>([]);
  const { toast } = useToast();
  useProcessingTicks(
    queuedIds.map((id) => ({ id, status: 'processing' as const })),
    (id) => setQueuedIds((prev) => prev.filter((x) => x !== id))
  );

  // Rejected files are listed with their reason instead of disappearing silently
  const onDrop = useCallback((accepted: File[], rejected: FileRejection[]) => {
    setDone(false);
    setFiles((prev) => [
      ...prev,
      ...accepted.map((f): FileState => {
        const check = checkUploadDeclaration({ fileName: f.name, mimeType: f.type, size: f.size });
        return check.ok ? { file: f, status: 'pending' } : { file: f, status: 'error', error: check.error };
      }),
      ...rejected.map((r): FileState => ({ file: r.file, status: 'error', error: rejectionMessage(r) })),
    ]);
    if (rejected.length > 0) {
      toast(rejected.length === 1 ? 'קובץ אחד לא נוסף' : `${rejected.length} קבצים לא נוספו`, 'error');
    }
  }, [toast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: DROPZONE_ACCEPT,
    maxSize: MAX_UPLOAD_BYTES,
    multiple: true,
    disabled,
  });

  const pendingFiles = files.filter((f) => f.status === 'pending');

  const handleUpload = async () => {
    if (!pendingFiles.length || uploading) return;
    setUploading(true);
    setFiles((prev) => prev.map((f) => f.status === 'pending' ? { ...f, status: 'uploading' } : f));
    try {
      const response = await uploadInvoices(clientId, pendingFiles.map((f) => f.file));
      const fileResults = response.results || [];
      
      setFiles((prev) =>
        prev.map((f) => {
          if (f.status !== 'uploading') return f;
          const result = fileResults.find((r: any) => r.fileName === f.file.name);
          if (result) {
            if (result.status === 'success') {
              return { ...f, status: 'done' };
            } else {
              return { ...f, status: 'error', error: result.error || 'שגיאה בהעלאה' };
            }
          }
          // No answer for this file: don't claim success
          return { ...f, status: 'error', error: 'לא התקבלה תשובה עבור הקובץ - יש לבדוק במסך בדיקה ואישור' };
        })
      );

      const newIds = fileResults.filter((r) => r.status === 'success' && r.id).map((r) => r.id as string);
      if (newIds.length > 0) setQueuedIds((prev) => [...prev, ...newIds.filter((x) => !prev.includes(x))]);

      const hasSuccess = fileResults.some((r: any) => r.status === 'success');
      const hasError = fileResults.some((r: any) => r.status === 'error');

      if (hasSuccess) {
        setDone(true);
      }

      if (hasError && !hasSuccess) {
        toast('כל ההעלאות נכשלו', 'error');
      } else if (hasError && hasSuccess) {
        toast('חלק מהקבצים נכשלו בהעלאה', 'info');
      }
    } catch (e: any) {
      setFiles((prev) => prev.map((f) => f.status === 'uploading' ? { ...f, status: 'error', error: e?.message || 'העלאת הקובץ נכשלה' } : f));
      toast('שגיאה בתקשורת עם השרת', 'error');
    } finally {
      setUploading(false);
    }
  };

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        {...getRootProps()}
        className={clsx(
          'relative border-2 border-dashed rounded-2xl p-8 sm:p-12 text-center cursor-pointer transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
          isDragActive
            ? 'border-blue-500 bg-blue-50 scale-[1.01]'
            : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'
        )}
      >
        <input {...getInputProps()} aria-label="בחירת קבצי חשבוניות להעלאה" />
        <div className={clsx('mx-auto mb-4 rounded-2xl p-4 w-fit transition-colors', isDragActive ? 'bg-blue-100' : 'bg-slate-100')}>
          <CloudUpload className={clsx('h-10 w-10 transition-colors', isDragActive ? 'text-blue-600' : 'text-slate-400')} />
        </div>
        <p className="text-lg font-semibold text-slate-700">
          {isDragActive ? 'שחררו כאן...' : 'גררו קבצים לכאן'}
        </p>
        <p className="text-sm text-slate-500 mt-1">או <span className="text-blue-600 font-medium">לחצו לבחירה</span></p>
        <p className="text-xs text-slate-400 mt-3">PDF, JPG, PNG, WEBP · עד 20MB לקובץ · מרובים בו-זמנית</p>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">{filesLabel(files.length)}</span>
            {!uploading && files.some(f => f.status === 'pending' || f.status === 'error') && (
              <button type="button" onClick={() => setFiles([])} className="text-xs text-slate-500 hover:text-slate-700 px-2 -mx-2 min-h-[44px] md:min-h-0 md:py-1">נקה הכל</button>
            )}
          </div>
          <div className="divide-y divide-slate-50">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className={clsx('rounded-lg p-1.5', f.file.type === 'application/pdf' ? 'bg-red-50' : 'bg-blue-50')}>
                  {f.file.type === 'application/pdf'
                    ? <FileText className="h-4 w-4 text-red-500" />
                    : <FileImage className="h-4 w-4 text-blue-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700 truncate font-medium" title={f.file.name}><bdi>{f.file.name}</bdi></p>
                  {f.status === 'error' && f.error ? (
                    <p className="text-xs text-red-500 font-medium truncate" title={f.error}>{f.error}</p>
                  ) : (
                    <p className="text-xs text-slate-400">{formatSize(f.file.size)}</p>
                  )}
                </div>
                {f.status === 'pending'   && <button type="button" onClick={() => removeFile(i)} aria-label={`הסרת ${f.file.name} מהרשימה`} className="-m-2 p-2 max-md:p-3.5 max-md:-m-3.5 text-slate-400 hover:text-slate-600 rounded-lg"><XCircle className="h-4 w-4" /></button>}
                {f.status === 'uploading' && <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />}
                {f.status === 'done'      && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                {f.status === 'error'     && <button type="button" onClick={() => removeFile(i)} title="הסר מהרשימה" aria-label={`הסרת ${f.file.name} מהרשימה`} className="-m-2 p-2 max-md:p-3.5 max-md:-m-3.5 rounded-lg"><XCircle className="h-4 w-4 text-red-500" /></button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upload button */}
      {pendingFiles.length > 0 && (
        <button
          onClick={handleUpload} disabled={uploading || disabled}
          className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-xl font-semibold text-sm transition-colors shadow-sm"
        >
          {uploading ? (
            <span className="flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> מעלה...</span>
          ) : (
            `העלאת ${filesLabel(pendingFiles.length)} לסריקה`
          )}
        </button>
      )}

      {/* Success state */}
      {done && (
        <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <p className="font-semibold text-sm">
              {files.some((f) => f.status === 'error') ? 'חלק מהקבצים הועלו' : 'ההעלאה הושלמה!'}
            </p>
            <p className="text-xs mt-0.5">
              {'החשבוניות נשלחו לסריקה אוטומטית. המשיכו ל'}
              <a href="/review" className="underline mx-1">בדיקה ואישור</a>
              {' - כשהניתוח יסתיים תקבל התראה.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
