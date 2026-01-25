'use client';

import { useState, useEffect } from 'react';
import { useHPCStore, HPCNode } from '../store/hpc-store';
import styles from './AddNodeModal.module.css';

interface AddNodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  parentNodeId?: string | null;
}

export function AddNodeModal({ isOpen, onClose, parentNodeId }: AddNodeModalProps) {
  const { graph, setGraph } = useHPCStore();
  const [name, setName] = useState('');
  const [type, setType] = useState<HPCNode['type']>('compute');

  const parentNode = parentNodeId ? graph.nodes.find(n => n.id === parentNodeId) : null;
  const hasParent = !!parentNode;

  // If no parent, only allow input-file
  useEffect(() => {
    if (!hasParent) {
      setType('input-file');
    } else {
      setType('compute');
    }
  }, [hasParent, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const newNode: HPCNode = {
      id: crypto.randomUUID(),
      name: name.trim(),
      type,
      status: 'queued',
      code: type === 'compute' ? 'def task():  # do not edit this method header\n    # Your code here\n    pass\n\n    # return the output df\n    return None' : '',
      in: hasParent ? [parentNodeId!] : [],
      out: [],
    };

    // Update graph
    const updatedNodes = [...graph.nodes, newNode];

    // If there's a parent, add this node to parent's out array
    if (hasParent) {
      const nodeIndex = updatedNodes.findIndex(n => n.id === parentNodeId);
      if (nodeIndex !== -1) {
        updatedNodes[nodeIndex] = {
          ...updatedNodes[nodeIndex],
          out: [...updatedNodes[nodeIndex].out, newNode.id]
        };
      }
    }

    setGraph({
      ...graph,
      nodes: updatedNodes,
    });

    // Reset and close
    setName('');
    setType(hasParent ? 'compute' : 'input-file');
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2>Add New Node</h2>
          <button className={styles.closeBtn} onClick={onClose} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {hasParent && (
            <div className={styles.parentInfo}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
              <span>Branching from: <strong>{parentNode?.name}</strong></span>
            </div>
          )}

          <div className={styles.field}>
            <label htmlFor="node-name">Node Name</label>
            <input
              id="node-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Process Data"
              autoFocus
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="node-type">Node Type</label>
            <div className={styles.typeSelector}>
              <button
                type="button"
                className={`${styles.typeBtn} ${type === 'input-file' ? styles.active : ''}`}
                onClick={() => setType('input-file')}
                disabled={hasParent}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Input File</span>
              </button>
              <button
                type="button"
                className={`${styles.typeBtn} ${type === 'compute' ? styles.active : ''}`}
                onClick={() => setType('compute')}
                disabled={!hasParent}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span>Compute</span>
              </button>
              <button
                type="button"
                className={`${styles.typeBtn} ${type === 'output-file' ? styles.active : ''}`}
                onClick={() => setType('output-file')}
                disabled={!hasParent}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>Output File</span>
              </button>
            </div>
            {!hasParent && (
              <p className={styles.hint}>
                Select a node first to add compute or output nodes
              </p>
            )}
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={styles.submitBtn} disabled={!name.trim()}>
              Add Node
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
