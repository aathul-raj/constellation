'use client';

import { useState, useEffect, useRef } from 'react';
import styles from './page.module.css';

interface FileItem {
  key: string;
  size?: number;
  lastModified?: string;
  url: string;
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load files on component mount
  useEffect(() => {
    fetchFiles();
  }, []);

  const fetchFiles = async () => {
    try {
      const response = await fetch('/api/files');
      const data = await response.json();
      if (response.ok) {
        setFiles(data.files || []);
      } else {
        setError(data.error || 'Failed to fetch files');
      }
    } catch (err) {
      setError('Failed to fetch files');
      console.error(err);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (selectedFile.size > 50 * 1024 * 1024) {
        setError('File size exceeds 50MB limit');
        setFile(null);
      } else {
        setFile(selectedFile);
        setError(null);
        // Auto-upload the file
        uploadFile(selectedFile);
      }
    }
  };

  const uploadFile = async (fileToUpload: File) => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const formData = new FormData();
      formData.append('file', fileToUpload);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (response.ok) {
        setSuccess(`File "${fileToUpload.name}" uploaded successfully!`);
        setFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        await fetchFiles(); // Refresh file list
      } else {
        setError(data.error || 'Failed to upload file');
      }
    } catch (err) {
      setError('Failed to upload file');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };


  const handleDelete = async (fileKey: string) => {
    if (!confirm(`Delete "${fileKey}"?`)) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/files/${encodeURIComponent(fileKey)}`, {
        method: 'DELETE',
      });

      const data = await response.json();

      if (response.ok) {
        setSuccess('File deleted successfully!');
        await fetchFiles(); // Refresh file list
      } else {
        setError(data.error || 'Failed to delete file');
      }
    } catch (err) {
      setError('Failed to delete file');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return 'Unknown';
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(2)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Unknown';
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return 'Unknown';
    }
  };

  return (
    <main className={styles.container}>
      <div className={styles.card}>
        <h1>S3 File Manager</h1>

        {/* Upload Section */}
        <section className={styles.uploadSection}>
          <h2>Upload File</h2>
          <div className={styles.fileInput}>
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileSelect}
              disabled={loading}
              id="file-input"
            />
            <label htmlFor="file-input">
              {loading ? 'Uploading...' : 'Choose a file to upload...'}
            </label>
          </div>

          {file && (
            <div className={styles.fileInfo}>
              <p>Name: {file.name}</p>
              <p>Size: {formatFileSize(file.size)}</p>
            </div>
          )}
        </section>

        {/* Messages */}
        {error && <div className={styles.error}>{error}</div>}
        {success && <div className={styles.success}>{success}</div>}

        {/* Files List Section */}
        <section className={styles.filesSection}>
          <h2>Files in S3 Bucket ({files.length})</h2>

          {files.length === 0 ? (
            <p className={styles.emptyState}>No files uploaded yet</p>
          ) : (
            <div className={styles.filesList}>
              {files.map((fileItem) => (
                <div key={fileItem.key} className={styles.fileItem}>
                  <div className={styles.fileDetails}>
                    <h3>{fileItem.key}</h3>
                    <p>Size: {formatFileSize(fileItem.size)}</p>
                    <p>Uploaded: {formatDate(fileItem.lastModified)}</p>
                  </div>
                  <div className={styles.fileActions}>
                    <a
                      href={fileItem.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.downloadButton}
                    >
                      View
                    </a>
                    <button
                      onClick={() => handleDelete(fileItem.key)}
                      disabled={loading}
                      className={styles.deleteButton}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
