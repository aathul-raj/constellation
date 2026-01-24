'use client';

import { Sun, Moon, Server, Activity } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';

export default function Header() {
  const { theme, toggleTheme, graph, isRunning } = useHPCStore();

  const completedCount = graph.nodes.filter(n => n.status === 'completed').length;
  const runningCount = graph.nodes.filter(n => n.status === 'running').length;

  return (
    <header className="app-header">
      <div className="header-left">
        <div className="logo">
          <Server size={24} />
          <span>Constellation</span>
        </div>
        <div className="pipeline-name">
          <span className="separator">/</span>
          <span>{graph.name}</span>
        </div>
      </div>

      <div className="header-center">
        {isRunning && (
          <div className="running-indicator">
            <Activity size={16} className="pulse" />
            <span>Pipeline Running</span>
          </div>
        )}
      </div>

      <div className="header-right">
        <div className="stats">
          <div className="stat">
            <span className="stat-value">{completedCount}/{graph.nodes.length}</span>
            <span className="stat-label">Completed</span>
          </div>
          <div className="stat">
            <span className="stat-value">{runningCount}</span>
            <span className="stat-label">Running</span>
          </div>
        </div>

        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}
