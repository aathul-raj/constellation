'use client';

import { Sun, Moon, Server, Activity, FolderOpen, LogOut } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import { useSession, signOut } from 'next-auth/react';
import { useState } from 'react';
import ProjectsModal from './ProjectsModal';

export default function Header() {
  const { theme, toggleTheme, graph, isRunning, currentProjectName, saveStatus } = useHPCStore();
  const { data: session } = useSession();
  const [showProjects, setShowProjects] = useState(false);

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
          <span>{currentProjectName || graph.name}</span>
          {session && saveStatus !== 'idle' && (
            <span className={`save-status ${saveStatus}`}>
              {saveStatus === 'saving' && '● Saving...'}
              {saveStatus === 'saved' && '✓ Saved'}
              {saveStatus === 'error' && '⚠ Error'}
            </span>
          )}
        </div>
      </div>

      <div className="header-right">
        {isRunning && (
          <div className="running-indicator">
            <Activity size={16} className="pulse" />
            <span>Pipeline Running</span>
          </div>
        )}
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

        {session && (
          <button
            className="projects-btn"
            onClick={() => setShowProjects(true)}
            aria-label="Open projects"
          >
            <FolderOpen size={18} />
            <span>Projects</span>
          </button>
        )}

        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        {session && (
          <div className="user-menu">
            {session.user.image && (
              <img src={session.user.image} alt={session.user.name || 'User'} className="user-avatar" />
            )}
            <button
              className="logout-btn"
              onClick={() => signOut({ callbackUrl: '/login' })}
              aria-label="Sign out"
            >
              <LogOut size={18} />
            </button>
          </div>
        )}
      </div>

      {showProjects && <ProjectsModal onClose={() => setShowProjects(false)} />}
    </header>
  );
}
