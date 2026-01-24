'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import Spreadsheet from 'react-spreadsheet';
import { Upload, X, Plus, Minus, Download, Columns, Rows } from 'lucide-react';

interface CSVEditorProps {
  data: string;
  fileName: string;
  nodeId: string;
  hasUnsavedChanges: boolean;
  onDataChange: (data: string) => void;
  onUpload: () => void;
  onCancel: () => void;
  isUploading?: boolean;
}

export default function CSVEditor({
  data,
  fileName,
  nodeId,
  hasUnsavedChanges,
  onDataChange,
  onUpload,
  onCancel,
  isUploading = false
}: CSVEditorProps) {
  const spreadsheetData = useMemo(() => {
    const lines = data.trim().split('\n');
    if (lines.length === 0) return [];

    return lines.map(line => {
      // Simple CSV parsing (doesn't handle quoted commas properly)
      const cells = line.split(',').map(cell => cell.trim());
      return cells.map(value => ({ value }));
    });
  }, [data]);

  // Automatically save to localStorage whenever data changes
  useEffect(() => {
    const storageKey = `csv-edit-${nodeId}`;
    localStorage.setItem(storageKey, data);
  }, [data, nodeId]);

  const handleChange = useCallback((newData: any) => {
    // Convert spreadsheet data back to CSV
    const csvLines = newData.map((row: any[]) =>
      row.map((cell: any) => cell?.value || '').join(',')
    );
    const csvString = csvLines.join('\n');
    onDataChange(csvString);
  }, [onDataChange]);

  const handleAddRow = useCallback(() => {
    const columnCount = spreadsheetData[0]?.length || 0;
    const newRow = Array(columnCount).fill({ value: '' });
    const newData = [...spreadsheetData, newRow];
    handleChange(newData);
  }, [spreadsheetData, handleChange]);

  const handleDeleteRow = useCallback(() => {
    if (spreadsheetData.length <= 1) return; // Keep at least header row
    const newData = spreadsheetData.slice(0, -1);
    handleChange(newData);
  }, [spreadsheetData, handleChange]);

  const handleAddColumn = useCallback(() => {
    const newData = spreadsheetData.map(row => [...row, { value: '' }]);
    handleChange(newData);
  }, [spreadsheetData, handleChange]);

  const handleDeleteColumn = useCallback(() => {
    if (spreadsheetData[0]?.length <= 1) return; // Keep at least one column
    const newData = spreadsheetData.map(row => row.slice(0, -1));
    handleChange(newData);
  }, [spreadsheetData, handleChange]);

  const handleSaveToComputer = useCallback(() => {
    const csvLines = spreadsheetData.map((row: any[]) =>
      row.map((cell: any) => cell?.value || '').join(',')
    );
    const csvContent = csvLines.join('\n');

    const link = document.createElement('a');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }, [spreadsheetData, fileName]);

  const rowCount = spreadsheetData.length - 1; // Subtract header row
  const columnCount = spreadsheetData[0]?.length || 0;

  return (
    <div className="csv-editor-container">
      <div className="csv-header">
        <div className="csv-info">
          <h3>{fileName}</h3>
          <span className="row-count">{rowCount} rows, {columnCount} columns</span>
        </div>
        <div className="csv-actions">
          <button
            className="csv-save-btn"
            onClick={handleSaveToComputer}
            disabled={isUploading}
            title="Save to computer"
          >
            <Download size={14} />
            <span>Save</span>
          </button>
          <div className="csv-upload-btn-wrapper">
            <button
              className={`csv-upload-btn ${!hasUnsavedChanges ? 'no-changes' : ''}`}
              onClick={onUpload}
              disabled={isUploading}
            >
              <Upload size={14} />
              <span>{isUploading ? 'Uploading...' : hasUnsavedChanges ? 'Upload to AWS' : 'Uploaded'}</span>
            </button>
            {!hasUnsavedChanges && !isUploading && (
              <div className="csv-tooltip">
                No changes since last upload. Click to upload anyway.
              </div>
            )}
          </div>
          <button className="csv-cancel-btn" onClick={onCancel} disabled={isUploading}>
            <X size={14} />
            <span>Cancel</span>
          </button>
        </div>
      </div>

      <div className="csv-toolbar">
        <div className="toolbar-group">
          <span className="toolbar-label">Rows:</span>
          <button
            className="toolbar-btn"
            onClick={handleAddRow}
            disabled={isUploading}
            title="Add row"
          >
            <Plus size={14} />
            <Rows size={14} />
          </button>
          <button
            className="toolbar-btn"
            onClick={handleDeleteRow}
            disabled={isUploading || spreadsheetData.length <= 1}
            title="Delete last row"
          >
            <Minus size={14} />
            <Rows size={14} />
          </button>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Columns:</span>
          <button
            className="toolbar-btn"
            onClick={handleAddColumn}
            disabled={isUploading}
            title="Add column"
          >
            <Plus size={14} />
            <Columns size={14} />
          </button>
          <button
            className="toolbar-btn"
            onClick={handleDeleteColumn}
            disabled={isUploading || columnCount <= 1}
            title="Delete last column"
          >
            <Minus size={14} />
            <Columns size={14} />
          </button>
        </div>
      </div>

      <div className="csv-spreadsheet-wrapper">
        <Spreadsheet
          data={spreadsheetData}
          onChange={handleChange}
        />
      </div>
    </div>
  );
}
