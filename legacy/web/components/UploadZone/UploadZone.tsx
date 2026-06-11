'use client';

import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import clsx from 'clsx';
import { CloudUpload, FileText, CheckCircle2, XCircle, Loader2, FileImage } from 'lucide-react';
import { uploadInvoices } from '@/lib/api';

interface FileState {
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function UploadZone({ clientId }: { clientId: string }) {
  const [files, setFiles] = useState<FileState[]>([]);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);

  const onDrop = useCallback((accepted: File[]) => {
    setDone(false);
    setFiles((prev) => [
      ...prev,
      ...accepted.map((f) => ({ file: f, status: 'pending' as const })),
    ]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'], 'image/*': ['.jpg', '.jpeg', '.png'] },
    multiple: true,
  });

  const pendingFiles = files.filter((f) => f.status === 'pending');

  const handleUpload = async () => {
    if (!pendingFiles.length || uploading) return;
    setUploading(true);
    setFiles((prev) => prev.map((f) => f.status === 'pending' ? { ...f, status: 'uploading' } : f));
    try {
      await uploadInvoices(clientId, pendingFiles.map((f) => f.file));
      setFiles((prev) => prev.map((f) => f.status === 'uploading' ? { ...f, status: 'done' } : f));
      setDone(true);
    } catch (e: any) {
      setFiles((prev) => prev.map((f) => f.status === 'uploading' ? { ...f, status: 'error', error: e.message } : f));
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
          'relative border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200',
          isDragActive
            ? 'border-blue-500 bg-blue-50 scale-[1.01]'
            : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'
        )}
      >
        <input {...getInputProps()} />
        <div className={clsx('mx-auto mb-4 rounded-2xl p-4 w-fit transition-colors', isDragActive ? 'bg-blue-100' : 'bg-slate-100')}>
          <CloudUpload className={clsx('h-10 w-10 transition-colors', isDragActive ? 'text-blue-600' : 'text-slate-400')} />
        </div>
        <p className="text-lg font-semibold text-slate-700">
          {isDragActive ? 'שחרר כאן...' : 'גרור קבצים לכאן'}
        </p>
        <p className="text-sm text-slate-500 mt-1">או <span className="text-blue-600 font-medium">לחץ לבחירה</span></p>
        <p className="text-xs text-slate-400 mt-3">PDF, JPG, PNG · עד 20MB לקובץ · מרובים בו-זמנית</p>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">{files.length} קבצים</span>
            {!uploading && files.some(f => f.status === 'pending') && (
              <button onClick={() => setFiles([])} className="text-xs text-slate-400 hover:text-slate-600">נקה הכל</button>
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
                  <p className="text-sm text-slate-700 truncate font-medium">{f.file.name}</p>
                  <p className="text-xs text-slate-400">{formatSize(f.file.size)}</p>
                </div>
                {f.status === 'pending'   && <button onClick={() => removeFile(i)} className="text-slate-300 hover:text-slate-500"><XCircle className="h-4 w-4" /></button>}
                {f.status === 'uploading' && <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />}
                {f.status === 'done'      && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                {f.status === 'error'     && <XCircle className="h-4 w-4 text-red-500" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upload button */}
      {pendingFiles.length > 0 && (
        <button
          onClick={handleUpload} disabled={uploading}
          className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-xl font-semibold text-sm transition-colors shadow-sm"
        >
          {uploading ? (
            <span className="flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> מעלה...</span>
          ) : (
            `העלה ${pendingFiles.length} קבצים לעיבוד AI`
          )}
        </button>
      )}

      {/* Success state */}
      {done && (
        <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <p className="font-semibold text-sm">ההעלאה הושלמה!</p>
            <p className="text-xs mt-0.5">
              החשבוניות נשלחות לניתוח AI. עבור ל
              <a href="/review" className="underline mr-1">בדיקה ואישור</a>
              כשהניתוח יסתיים תקבל התראה.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
