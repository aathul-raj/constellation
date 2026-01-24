'use client';

import { useMemo, useCallback, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Play, RotateCcw, Terminal, Cpu, HardDrive, Zap } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import { getExecutionLevels } from '../utils/graph-transform';

export default function EditorPanel() {
  const {
    graph,
    selectedNodeId,
    updateNodeCode,
    updateNodeStatus,
    resetAllStatuses,
    isRunning,
    setIsRunning,
    runProgress,
    setRunProgress,
    theme,
    addChatMessage
  } = useHPCStore();

  const selectedNode = useMemo(() =>
    graph.nodes.find(n => n.id === selectedNodeId),
    [graph.nodes, selectedNodeId]
  );

  const handleCodeChange = useCallback((value: string | undefined) => {
    if (selectedNodeId && value !== undefined) {
      updateNodeCode(selectedNodeId, value);
    }
  }, [selectedNodeId, updateNodeCode]);

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const runBatch = useCallback(async () => {
    if (isRunning) return;

    setIsRunning(true);
    setRunProgress(0);
    resetAllStatuses();

    addChatMessage({
      role: 'assistant',
      content: `Starting batch execution for "${graph.name}"...`
    });

    const levels = getExecutionLevels(graph);
    const totalNodes = graph.nodes.length;
    let completedNodes = 0;

    for (const level of levels) {
      // Set all nodes in this level to running (parallel execution within level)
      for (const nodeId of level) {
        updateNodeStatus(nodeId, 'running');
      }

      addChatMessage({
        role: 'assistant',
        content: `Running: ${level.map(id => graph.nodes.find(n => n.id === id)?.label).join(', ')}`
      });

      // Simulate execution time (1-2 seconds per level)
      await sleep(1000 + Math.random() * 1000);

      // Complete all nodes in this level
      for (const nodeId of level) {
        updateNodeStatus(nodeId, 'completed');
        completedNodes++;
        setRunProgress((completedNodes / totalNodes) * 100);
      }
    }

    addChatMessage({
      role: 'assistant',
      content: `Batch execution completed. All ${totalNodes} jobs finished successfully.`
    });

    setIsRunning(false);
  }, [isRunning, graph, setIsRunning, setRunProgress, resetAllStatuses, updateNodeStatus, addChatMessage]);

  const handleReset = useCallback(() => {
    resetAllStatuses();
    setRunProgress(0);
    addChatMessage({
      role: 'assistant',
      content: 'Pipeline reset. All nodes returned to queued state.'
    });
  }, [resetAllStatuses, setRunProgress, addChatMessage]);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'compute':
        return <Cpu size={14} />;
      case 'io':
        return <HardDrive size={14} />;
      case 'aggregate':
        return <Zap size={14} />;
      default:
        return <Terminal size={14} />;
    }
  };

  return (
    <div className="editor-panel">
      <div className="panel-header">
        <h2>Job Editor</h2>
        {selectedNode && (
          <div className="node-badge">
            {getTypeIcon(selectedNode.type)}
            <span>{selectedNode.type}</span>
          </div>
        )}
      </div>

      <div className="editor-container">
        {selectedNode ? (
          <>
            <div className="editor-header">
              <div className="node-info">
                <h3>{selectedNode.label}</h3>
                <span className={`status-badge ${selectedNode.status}`}>
                  {selectedNode.status}
                </span>
              </div>
              {selectedNode.resources && (
                <div className="resources">
                  {selectedNode.resources.cores && (
                    <span className="resource-item">
                      <Cpu size={12} /> {selectedNode.resources.cores} cores
                    </span>
                  )}
                  {selectedNode.resources.memory && (
                    <span className="resource-item">
                      <HardDrive size={12} /> {selectedNode.resources.memory}
                    </span>
                  )}
                  {selectedNode.resources.gpu && (
                    <span className="resource-item">
                      <Zap size={12} /> {selectedNode.resources.gpu} GPU
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="monaco-wrapper">
              <Editor
                height="100%"
                defaultLanguage="shell"
                value={selectedNode.code}
                onChange={handleCodeChange}
                theme={theme === 'dark' ? 'vs-dark' : 'light'}
                options={{
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  fontSize: 13,
                  lineNumbers: 'on',
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  padding: { top: 12 }
                }}
              />
            </div>
          </>
        ) : (
          <div className="empty-state">
            <Terminal size={48} strokeWidth={1} />
            <h3>No Node Selected</h3>
            <p>Click a node in the graph to view and edit its job script</p>
          </div>
        )}
      </div>

      <div className="editor-footer">
        <div className="progress-bar-container">
          <div
            className="progress-bar"
            style={{ width: `${runProgress}%` }}
          />
        </div>
        <div className="footer-actions">
          <button
            className="btn btn-secondary"
            onClick={handleReset}
            disabled={isRunning}
          >
            <RotateCcw size={16} />
            Reset
          </button>
          <button
            className={`btn btn-primary ${isRunning ? 'running' : ''}`}
            onClick={runBatch}
            disabled={isRunning}
          >
            <Play size={16} />
            {isRunning ? 'Running...' : 'Run Batch'}
          </button>
        </div>
      </div>
    </div>
  );
}
