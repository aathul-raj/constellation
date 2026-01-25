'use client';

import styles from './DeleteEdgeToolbar.module.css';

interface DeleteEdgeToolbarProps {
  sourceNode?: string;
  targetNode?: string;
  onDelete: () => void;
  onCancel: () => void;
}

export function DeleteEdgeToolbar({
  sourceNode,
  targetNode,
  onDelete,
  onCancel,
}: DeleteEdgeToolbarProps) {
  if (!sourceNode || !targetNode) return null;

  return (
    <div className={styles.toolbar}>
      <div className={styles.content}>
        <div className={styles.statusRow}>
          <div className={styles.statusDot} />
          <span className={styles.label}>Delete this connection?</span>
        </div>

        <div className={styles.nodeChain}>
          <div className={styles.nodePill}>
            <span>{sourceNode}</span>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
          <div className={styles.nodePill}>
            <span>{targetNode}</span>
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button className={styles.deleteBtn} onClick={onDelete}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          Delete
        </button>
      </div>
    </div>
  );
}
