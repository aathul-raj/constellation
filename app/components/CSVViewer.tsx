'use client';

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { Download, Loader2 } from 'lucide-react';

interface CSVViewerProps {
  data: string;
  fileName: string;
  onDownload: () => void;
  filePath?: string; // Optional: for streaming full file downloads
  totalRows?: number; // Optional: total rows in file (may differ from data if truncated)
  onLoadMore?: () => Promise<string>; // Optional: callback to load full data
}

const ROW_HEIGHT = 32;
const COLUMN_WIDTH = 150;
const VISIBLE_ROWS_BUFFER = 5; // Extra rows to render above/below viewport
const VISIBLE_COLS_BUFFER = 2; // Extra columns to render left/right of viewport
const DEFAULT_ROW_PREVIEW_LIMIT = 50; // Default to showing first 50 rows

export default function CSVViewer({ data, fileName, onDownload, filePath, totalRows: externalTotalRows, onLoadMore }: CSVViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  const [containerWidth, setContainerWidth] = useState(800);
  const [showAllRows, setShowAllRows] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [fullData, setFullData] = useState<string | null>(null);

  // Use fullData if loaded, otherwise use the provided data
  const activeData = fullData || data;

  // Parse CSV data once
  const parsedData = useMemo(() => {
    const lines = activeData.trim().split('\n');
    if (lines.length === 0) return [];

    return lines.map(line => {
      // Handle quoted CSV fields properly
      const cells: string[] = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          cells.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      cells.push(current.trim());
      return cells;
    });
  }, [activeData]);

  const headers = parsedData[0] || [];
  const allRows = parsedData.slice(1);
  const rowsInCurrentData = allRows.length;

  // Use external total if provided (for truncated data), otherwise use parsed rows
  const totalRowsInFile = externalTotalRows ?? rowsInCurrentData;

  // Limit rows to preview by default (unless user clicks "Show All" or full data is loaded)
  const rows = (showAllRows || fullData) ? allRows : allRows.slice(0, DEFAULT_ROW_PREVIEW_LIMIT);
  const totalRows = rows.length;
  const totalCols = headers.length;

  // Show "Load All" button if we have more rows in file than currently displayed
  const isPreviewLimited = !fullData && totalRowsInFile > rowsInCurrentData;

  // Calculate virtual dimensions
  const totalHeight = totalRows * ROW_HEIGHT;
  const totalWidth = totalCols * COLUMN_WIDTH;

  // Calculate visible range
  const visibleRowStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_ROWS_BUFFER);
  const visibleRowEnd = Math.min(totalRows, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + VISIBLE_ROWS_BUFFER);
  const visibleColStart = Math.max(0, Math.floor(scrollLeft / COLUMN_WIDTH) - VISIBLE_COLS_BUFFER);
  const visibleColEnd = Math.min(totalCols, Math.ceil((scrollLeft + containerWidth) / COLUMN_WIDTH) + VISIBLE_COLS_BUFFER);

  // Get visible data slice
  const visibleRows = rows.slice(visibleRowStart, visibleRowEnd);
  const visibleHeaders = headers.slice(visibleColStart, visibleColEnd);

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    setScrollTop(target.scrollTop);
    setScrollLeft(target.scrollLeft);
  }, []);

  // Measure container on mount and resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      setContainerHeight(container.clientHeight);
      setContainerWidth(container.clientWidth);
    };

    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // Download full file using streaming (if filePath available) or current data
  const handleSaveToComputer = useCallback(async () => {
    // If we have a file path, use the streaming download endpoint for full file
    if (filePath) {
      setIsDownloading(true);
      try {
        const response = await fetch('/api/output-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, download: true })
        });

        if (!response.ok) {
          throw new Error('Download failed');
        }

        // Stream the response as a download
        const blob = await response.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
      } catch (error) {
        console.error('Download error:', error);
        // Fallback to current data if streaming fails
        const blob = new Blob([activeData], { type: 'text/csv' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
      } finally {
        setIsDownloading(false);
      }
    } else {
      // No file path, download current data
      const link = document.createElement('a');
      const blob = new Blob([activeData], { type: 'text/csv' });
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }
  }, [activeData, fileName, filePath]);

  // Load all rows from the server
  const handleLoadMore = useCallback(async () => {
    if (onLoadMore) {
      setIsLoadingMore(true);
      try {
        const content = await onLoadMore();
        setFullData(content);
        setShowAllRows(true);
      } catch (error) {
        console.error('Failed to load more rows:', error);
      } finally {
        setIsLoadingMore(false);
      }
    } else {
      // No callback, just show all available rows
      setShowAllRows(true);
    }
  }, [onLoadMore]);

  return (
    <div className="csv-editor-container">
      <div className="csv-header">
        <div className="csv-info">
          <h3 className="csv-filename">{fileName}</h3>
          <span className="row-count">
            {isPreviewLimited
              ? `${totalRows} of ${totalRowsInFile.toLocaleString()} rows (preview), ${totalCols} columns`
              : `${totalRows.toLocaleString()} rows, ${totalCols} columns`
            }
          </span>
        </div>
        <div className="csv-actions">
          {isPreviewLimited && (
            <button
              className="csv-load-more-btn"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Loading...
                </>
              ) : (
                <>Load All {totalRowsInFile.toLocaleString()} Rows</>
              )}
            </button>
          )}
          <button
            className="csv-save-btn"
            onClick={handleSaveToComputer}
            disabled={isDownloading}
            style={{ opacity: isDownloading ? 0.7 : 1, cursor: isDownloading ? 'wait' : 'pointer' }}
          >
            {isDownloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            <span>{isDownloading ? 'Downloading...' : 'Save'}</span>
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="csv-virtual-container"
        onScroll={handleScroll}
      >
        <div
          className="csv-virtual-content"
          style={{
            height: totalHeight + ROW_HEIGHT, // +header row
            width: totalWidth,
            position: 'relative'
          }}
        >
          {/* Header row - sticky */}
          <div
            className="csv-virtual-header"
            style={{
              position: 'sticky',
              top: 0,
              left: 0,
              zIndex: 2,
              display: 'flex',
              height: ROW_HEIGHT,
              background: 'var(--bg-tertiary)',
              borderBottom: '2px solid var(--border-color)',
            }}
          >
            {/* Row number header */}
            <div
              className="csv-virtual-cell csv-row-number-header"
              style={{
                position: 'sticky',
                left: 0,
                zIndex: 3,
                width: 60,
                minWidth: 60,
              }}
            >
              #
            </div>
            {/* Column headers */}
            {headers.map((header, colIndex) => (
              <div
                key={colIndex}
                className="csv-virtual-cell csv-header-cell"
                style={{
                  position: 'absolute',
                  left: 60 + colIndex * COLUMN_WIDTH,
                  width: COLUMN_WIDTH,
                  height: ROW_HEIGHT,
                }}
                title={header}
              >
                {header}
              </div>
            ))}
          </div>

          {/* Virtual rows */}
          {visibleRows.map((row, idx) => {
            const actualRowIndex = visibleRowStart + idx;
            return (
              <div
                key={actualRowIndex}
                className="csv-virtual-row"
                style={{
                  position: 'absolute',
                  top: ROW_HEIGHT + actualRowIndex * ROW_HEIGHT, // +header offset
                  left: 0,
                  height: ROW_HEIGHT,
                  display: 'flex',
                }}
              >
                {/* Row number */}
                <div
                  className="csv-virtual-cell csv-row-number"
                  style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 1,
                    width: 60,
                    minWidth: 60,
                  }}
                >
                  {actualRowIndex + 1}
                </div>
                {/* Only render visible columns */}
                {row.slice(visibleColStart, visibleColEnd).map((cell, colIdx) => {
                  const actualColIndex = visibleColStart + colIdx;
                  return (
                    <div
                      key={actualColIndex}
                      className="csv-virtual-cell"
                      style={{
                        position: 'absolute',
                        left: 60 + actualColIndex * COLUMN_WIDTH,
                        width: COLUMN_WIDTH,
                        height: ROW_HEIGHT,
                      }}
                      title={cell}
                    >
                      {cell}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
