'use client';

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { Download } from 'lucide-react';

interface CSVViewerProps {
  data: string;
  fileName: string;
  onDownload: () => void;
}

const ROW_HEIGHT = 32;
const COLUMN_WIDTH = 150;
const VISIBLE_ROWS_BUFFER = 5; // Extra rows to render above/below viewport
const VISIBLE_COLS_BUFFER = 2; // Extra columns to render left/right of viewport

export default function CSVViewer({ data, fileName, onDownload }: CSVViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  const [containerWidth, setContainerWidth] = useState(800);

  // Parse CSV data once
  const parsedData = useMemo(() => {
    const lines = data.trim().split('\n');
    if (lines.length === 0) return { headers: [], rows: [] };

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
  }, [data]);

  const headers = parsedData[0] || [];
  const rows = parsedData.slice(1);
  const totalRows = rows.length;
  const totalCols = headers.length;

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

  const handleSaveToComputer = useCallback(() => {
    const link = document.createElement('a');
    const blob = new Blob([data], { type: 'text/csv' });
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }, [data, fileName]);

  return (
    <div className="csv-editor-container">
      <div className="csv-header">
        <div className="csv-info">
          <h3 className="csv-filename">{fileName}</h3>
          <span className="row-count">{totalRows.toLocaleString()} rows, {totalCols} columns</span>
        </div>
        <div className="csv-actions">
          <button className="csv-save-btn" onClick={handleSaveToComputer}>
            <Download size={14} />
            <span>Save</span>
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
