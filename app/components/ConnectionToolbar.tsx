'use client';

import styles from './ConnectionToolbar.module.css';

interface ConnectionToolbarProps {
  sourceNode: string | null;
  targetNode: string | null;
  sourceNodeName?: string;
  targetNodeName?: string;
  onAddConnection: () => void;
  onCancel: () => void;
}

export function ConnectionToolbar({
  sourceNode,
  targetNode,
  sourceNodeName,
  targetNodeName,
  onAddConnection,
  onCancel,
}: ConnectionToolbarProps) {
  if (!sourceNode && !targetNode) return null;

  const isComplete = sourceNode && targetNode;

  return (
    <div className={styles.toolbar}>
      <div className={styles.content}>
        <div className={styles.statusRow}>
          <div className={styles.statusDot} />
          <span className={styles.label}>
            {isComplete ? 'Connection ready' : 'Select nodes to connect'}
          </span>
        </div>

        {sourceNode && (
          <div className={styles.nodeChain}>
            <div className={styles.nodePill}>
              <span>{sourceNodeName}</span>
            </div>
            {targetNode && (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                <div className={styles.nodePill}>
                  <span>{targetNodeName}</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className={styles.actions}>
        {isComplete && (
          <button className={styles.addBtn} onClick={onAddConnection}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5v14" />
            </svg>
            Add Connection
          </button>
        )}
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
