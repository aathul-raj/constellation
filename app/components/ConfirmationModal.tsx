'use client';

import styles from './ConfirmationModal.module.css';

interface ConfirmationModalProps {
  message: string;
  type: 'edge' | 'node';
  onConfirm: () => void;
  onCancel: () => void;
  onEdgeOnly?: () => void; // For edge deletion with stranded node
}

export function ConfirmationModal({
  message,
  type,
  onConfirm,
  onCancel,
  onEdgeOnly
}: ConfirmationModalProps) {
  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.icon}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>

        <h3 className={styles.title}>Confirm Deletion</h3>
        <p className={styles.message}>{message}</p>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </button>
          {onEdgeOnly && (
            <button className={styles.secondaryBtn} onClick={onEdgeOnly}>
              Keep Node
            </button>
          )}
          <button className={styles.deleteBtn} onClick={onConfirm}>
            {onEdgeOnly ? 'Delete Both' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
