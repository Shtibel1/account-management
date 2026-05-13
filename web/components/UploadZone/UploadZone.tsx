'use client';

import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import clsx from 'clsx';
import { Upload, FileText, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { uploadInvoices } from '@/lib/api';

interface FileState {
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

export function UploadZone({ clientId }: { clientId: string }) {
  const [files, setFiles] = useState<FileState[]>([]);
  const [uploading, setUploading] = useState(false);

  const onDrop = useCallback((accepted: File[]) => {
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

  const handleUpload = async () => {
    if (!files.length || uploading) return;
    setUploading(true);
    const pending = files.filter((f) => f.status === 'pending');
    setFiles((prev) => prev.map((f) => f.status === 'pending' ? { ...f, status: 'uploading' } : f));
    try {
      await uploadInvoices(clientId, pending.map((f) => f.file));
      setFiles((prev) => prev.map((f) => f.status === 'uploading' ? { ...f, status: 'done' } : f));
    } catch (e: any) {
      setFiles((prev) => prev.map((f) => f.status === 'uploading' ? { ...f, status: 'error', error: e.message } : f));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={clsx(
          'border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors',
          isDragActive ? 'border-primary-500 bg-primary-50' : 'border-gray-300 hover:border-primary-400 hover:bg-gray-50'
        )}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto h-12 w-12 text-gray-400 mb-3" />
        <p className="text-lg font-medium text-gray-700">
          {isDragActive ? 'שחרר כאן...' : 'גרור קבצים לכאן'}
        </p>
        <p className="text-sm text-gray-500 mt-1">או לחץ לבחירת קבצים</p>
        <p className="text-xs text-gray-400 mt-2">PDF, JPG, PNG — ניתן לבחור מרובים</p>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-white rounded-lg border border-gray-200">
              <FileText className="h-5 w-5 text-gray-400 shrink-0" />
              <span className="flex-1 text-sm text-gray-700 truncate">{f.file.name}</span>
              {f.status === 'pending'   && <span className="text-xs text-gray-400">ממתין</span>}
              {f.status === 'uploading' && <Loader2 className="h-4 w-4 text-primary-500 animate-spin" />}
              {f.status === 'done'      && <CheckCircle className="h-4 w-4 text-green-500" />}
              {f.status === 'error'     && <XCircle className="h-4 w-4 text-red-500" />}
            </div>
          ))}
        </div>
      )}

      {files.some((f) => f.status === 'pending') && (
        <button
          onClick={handleUpload}
          disabled={uploading}
          className="w-full py-3 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
        >
          {uploading ? 'מעלה...' : `העלה ${files.filter((f) => f.status === 'pending').length} קבצים`}
        </button>
      )}
    </div>
  );
}
