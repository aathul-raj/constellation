'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useHPCStore } from '../store/hpc-store';
import Header from './Header';
import EditorPanel from './EditorPanel';
import AIChatPanel from './AIChatPanel';
import NotificationCenter from './NotificationCenter';

// Dynamic import for GraphPanel to avoid SSR issues with reagraph
const GraphPanel = dynamic(() => import('./GraphPanel'), {
  ssr: false,
  loading: () => (
    <div className="graph-panel">
      <div className="panel-header">
        <h2>Pipeline Graph</h2>
      </div>
      <div className="graph-container loading">
        <div className="loading-spinner" />
        <span>Loading graph...</span>
      </div>
    </div>
  )
});

export default function Dashboard() {
  const { theme } = useHPCStore();
  const [leftWidth, setLeftWidth] = useState(33.33); // percentage
  const [middleWidth, setMiddleWidth] = useState(40); // percentage
  const [isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const handleMouseDown = useCallback((divider: 'left' | 'right') => {
    if (divider === 'left') {
      setIsDraggingLeft(true);
    } else {
      setIsDraggingRight(true);
    }
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const mouseX = e.clientX - containerRect.left;
    const percentage = (mouseX / containerWidth) * 100;

    if (isDraggingLeft) {
      // Constrain left pane between 20% and 50%
      const newLeftWidth = Math.min(Math.max(percentage, 20), 50);
      setLeftWidth(newLeftWidth);
    } else if (isDraggingRight) {
      // Constrain middle pane
      const newMiddleWidth = Math.min(Math.max(percentage - leftWidth, 20), 60);
      setMiddleWidth(newMiddleWidth);
    }
  }, [isDraggingLeft, isDraggingRight, leftWidth]);

  const handleMouseUp = useCallback(() => {
    setIsDraggingLeft(false);
    setIsDraggingRight(false);
  }, []);

  useEffect(() => {
    if (isDraggingLeft || isDraggingRight) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isDraggingLeft, isDraggingRight, handleMouseMove, handleMouseUp]);

  const rightWidth = 100 - leftWidth - middleWidth;

  return (
    <div className={`dashboard ${theme}`}>
      <Header />
      <main className="dashboard-main" ref={containerRef}>
        <div style={{ width: `${leftWidth}%` }}>
          <GraphPanel />
        </div>
        <div
          className="resize-handle"
          onMouseDown={() => handleMouseDown('left')}
        />
        <div style={{ width: `${middleWidth}%` }}>
          <EditorPanel />
        </div>
        <div
          className="resize-handle"
          onMouseDown={() => handleMouseDown('right')}
        />
        <div style={{ width: `${rightWidth}%` }}>
          <AIChatPanel />
        </div>
      </main>
      <NotificationCenter />
    </div>
  );
}
