'use client';

import { ChevronDown, Terminal, Trash2 } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import { useEffect, useRef } from 'react';

interface DebugConsoleProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DebugConsole({ isOpen, onClose }: DebugConsoleProps) {
  const { consoleLogs, clearConsoleLogs } = useHPCStore();
  const consoleContentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs appear
  useEffect(() => {
    if (consoleContentRef.current) {
      consoleContentRef.current.scrollTop = consoleContentRef.current.scrollHeight;
    }
  }, [consoleLogs]);

  const formatTimestamp = (date: Date) => {
    return new Date(date).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const getLogClass = (type: string) => {
    switch (type) {
      case 'error': return 'log-error';
      case 'success': return 'log-success';
      case 'warning': return 'log-warning';
      default: return 'log-info';
    }
  };

  return (
    <div className={`debug-console ${isOpen ? 'open' : ''}`}>
      <div className="console-header">
        <div className="console-title">
          <Terminal size={14} />
          <span>Debug Console</span>
          <span className="console-count">({consoleLogs.length})</span>
        </div>
        <div className="console-controls">
          <button
            className="console-clear-btn"
            onClick={clearConsoleLogs}
            title="Clear console"
          >
            <Trash2 size={14} />
          </button>
          <button className="console-close-btn" onClick={onClose}>
            <ChevronDown size={14} />
            <span>Close</span>
          </button>
        </div>
      </div>
      <div className="console-content" ref={consoleContentRef}>
        {consoleLogs.length === 0 ? (
          <div className="console-log log-info">
            <span className="log-timestamp">[{formatTimestamp(new Date())}]</span>
            <span className="log-message">Console ready</span>
          </div>
        ) : (
          consoleLogs.map((log) => (
            <div key={log.id} className={`console-log ${getLogClass(log.type)}`}>
              <span className="log-timestamp">[{formatTimestamp(log.timestamp)}]</span>
              {log.nodeName && (
                <span className="log-node">[{log.nodeName}]</span>
              )}
              <span className="log-message">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
