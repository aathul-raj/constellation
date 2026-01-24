'use client';

import { useMemo, useCallback, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Play, RotateCcw, Terminal, Cpu, HardDrive, Upload, Download } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import { getExecutionLevels } from '../utils/graph-transform';

export default function EditorPanel() {
  const {
    graph,
    selectedNodeId,
    updateNodeName,
    updateNodeCode,
    updateNodeStatus,
    updateNodeFile,
    resetAllStatuses,
    isRunning,
    setIsRunning,
    runProgress,
    setRunProgress,
    theme,
    addChatMessage
  } = useHPCStore();

  const [uploadingNodeId, setUploadingNodeId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');

  const selectedNode = useMemo(() => {
    const node = graph.nodes.find(n => n.id === selectedNodeId);
    if (node && !editingName) {
      setNameInput(node.name);
    }
    return node;
  }, [graph.nodes, selectedNodeId, editingName]);

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
        content: `Running: ${level.map(id => graph.nodes.find(n => n.id === id)?.id).join(', ')}`
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

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId || !e.target.files?.[0]) return;

    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('file', file);

    setUploadingNodeId(selectedNodeId);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (response.ok) {
        updateNodeFile(selectedNodeId, data.key);
        addChatMessage({
          role: 'assistant',
          content: `File "${file.name}" uploaded for input node`
        });
      } else {
        addChatMessage({
          role: 'assistant',
          content: `Failed to upload file: ${data.error}`
        });
      }
    } catch (error) {
      addChatMessage({
        role: 'assistant',
        content: 'Failed to upload file'
      });
    } finally {
      setUploadingNodeId(null);
      e.target.value = '';
    }
  }, [selectedNodeId, updateNodeFile, addChatMessage]);

  const handleFileDownload = useCallback(() => {
    if (!selectedNode?.fileId) return;

    const url = `/api/files/${encodeURIComponent(selectedNode.fileId)}?download=true`;
    const link = document.createElement('a');
    link.href = url;
    link.download = selectedNode.fileId;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [selectedNode]);

  const handleSaveName = useCallback(() => {
    if (selectedNodeId && nameInput.trim()) {
      updateNodeName(selectedNodeId, nameInput.trim());
      setEditingName(false);
    }
  }, [selectedNodeId, nameInput, updateNodeName]);

  const handleNameKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveName();
    } else if (e.key === 'Escape') {
      setEditingName(false);
    }
  }, [handleSaveName]);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'input-file':
        return <HardDrive size={14} />;
      case 'compute':
        return <Cpu size={14} />;
      case 'output-file':
        return <HardDrive size={14} />;
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
                {editingName ? (
                  <input
                    type="text"
                    className="name-input"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={handleNameKeyPress}
                    onBlur={handleSaveName}
                    autoFocus
                  />
                ) : (
                  <h3 onClick={() => setEditingName(true)} className="editable-name">
                    {selectedNode.name}
                  </h3>
                )}
                <span className={`status-badge ${selectedNode.status}`}>
                  {selectedNode.status}
                </span>
              </div>
              {selectedNode.type === 'input-file' && (
                <div className="file-actions">
                  <label className="file-upload-btn">
                    <Upload size={14} />
                    <span>Upload File</span>
                    <input
                      type="file"
                      onChange={handleFileUpload}
                      disabled={uploadingNodeId === selectedNodeId}
                      style={{ display: 'none' }}
                    />
                  </label>
                  {selectedNode.fileId && (
                    <span className="file-indicator">{selectedNode.fileId}</span>
                  )}
                </div>
              )}
              {selectedNode.type === 'output-file' && (
                <div className="file-actions">
                  {selectedNode.fileId ? (
                    <>
                      <button
                        className="file-download-btn"
                        onClick={handleFileDownload}
                      >
                        <Download size={14} />
                        <span>Download</span>
                      </button>
                      <span className="file-indicator">{selectedNode.fileId}</span>
                    </>
                  ) : (
                    <span className="file-placeholder">No output file yet</span>
                  )}
                </div>
              )}
            </div>
            {selectedNode.type === 'compute' && (
              <div className="monaco-wrapper">
                <Editor
                  height="100%"
                  language="python"
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
            )}
            {selectedNode.type !== 'compute' && (
              <div className="empty-state">
                <HardDrive size={48} strokeWidth={1} />
                <h3>{selectedNode.type === 'input-file' ? 'Input File' : 'Output File'}</h3>
                <p>
                  {selectedNode.type === 'input-file'
                    ? 'Upload a file to use as input for the compute task'
                    : 'Output file will be available after the pipeline runs'}
                </p>
              </div>
            )}
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
