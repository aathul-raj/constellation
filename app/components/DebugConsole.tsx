'use client';

import { ChevronDown, Terminal } from 'lucide-react';

interface DebugConsoleProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DebugConsole({ isOpen, onClose }: DebugConsoleProps) {
  return (
    <div className={`debug-console ${isOpen ? 'open' : ''}`}>
      <div className="console-header">
        <div className="console-title">
          <Terminal size={14} />
          <span>Debug Console</span>
        </div>
        <div className="console-controls">
          <button className="console-close-btn" onClick={onClose}>
            <ChevronDown size={14} />
            <span>Close</span>
          </button>
        </div>
      </div>
      <div className="console-content">
        <div className="console-log">
          <span className="log-timestamp">[12:34:56]</span>
          <span className="log-message">Console ready</span>
        </div>
      </div>
    </div>
  );
}
