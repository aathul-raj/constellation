'use client';

import { useEffect } from 'react';
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

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className={`dashboard ${theme}`}>
      <Header />
      <main className="dashboard-main">
        <GraphPanel />
        <EditorPanel />
        <AIChatPanel />
      </main>
      <NotificationCenter />
    </div>
  );
}
