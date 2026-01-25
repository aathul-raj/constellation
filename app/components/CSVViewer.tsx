'use client';

import { useMemo, useCallback } from 'react';
import Spreadsheet from 'react-spreadsheet';
import { Download } from 'lucide-react';

interface CSVViewerProps {
  data: string;
  fileName: string;
  onDownload: () => void;
}

export default function CSVViewer({ data, fileName, onDownload }: CSVViewerProps) {
  const spreadsheetData = useMemo(() => {
    const lines = data.trim().split('\n');
    if (lines.length === 0) return [];

    return lines.map(line => {
      // Simple CSV parsing (doesn't handle quoted commas properly)
      const cells = line.split(',').map(cell => cell.trim());
      return cells.map(value => ({ value }));
    });
  }, [data]);

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
          <h3 className="csv-filename">{fileName}</h3>
          <span className="row-count">{rowCount} rows, {columnCount} columns</span>
        </div>
        <div className="csv-actions">
          <button className="csv-save-btn" onClick={handleSaveToComputer}>
            <Download size={14} />
            <span>Save</span>
          </button>
        </div>
      </div>

      <div className="csv-spreadsheet-wrapper">
        <Spreadsheet
          data={spreadsheetData}
          onChange={() => {}} // Read-only, ignore changes
        />
      </div>
    </div>
  );
}
