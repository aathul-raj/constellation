'use client';

import { useMemo, useCallback, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Play, RotateCcw, Terminal, Cpu, HardDrive, Upload, Download } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import { getExecutionLevels } from '../utils/graph-transform';

interface DeploymentResult {
  deploymentId: string;
  status: 'completed' | 'failed';
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    status: 'completed' | 'failed';
    outputFileId?: string;
    error?: string;
  }>;
  timestamp: string;
}

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
    addNotification
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

  const handleRun = useCallback(async () => {
    if (isRunning) return;

    setIsRunning(true);
    setRunProgress(0);
    resetAllStatuses();

    try {
      // Deploy to backend
      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph })
      });

      const deployResult: DeploymentResult = await response.json();

      if (!response.ok) {
        addNotification({
          type: 'error',
          title: 'Deployment Failed',
          message: 'Failed to deploy pipeline'
        });
        setIsRunning(false);
        return;
      }

      // Update node statuses based on deployment result
      const levels = getExecutionLevels(graph);
      const totalNodes = graph.nodes.length;
      let completedNodes = 0;

      for (const level of levels) {
        // Set all nodes in this level to running
        for (const nodeId of level) {
          updateNodeStatus(nodeId, 'running');
        }

        // Simulate execution time (500ms per level)
        await sleep(500);

        // Complete all nodes in this level
        for (const nodeId of level) {
          const nodeResult = deployResult.nodes.find(n => n.id === nodeId);
          if (nodeResult?.outputFileId) {
            updateNodeFile(nodeId, nodeResult.outputFileId);
          }
          updateNodeStatus(nodeId, 'completed');
          completedNodes++;
          setRunProgress((completedNodes / totalNodes) * 100);
        }
      }

      addNotification({
        type: 'success',
        title: 'Pipeline Executed',
        message: `Deployment ${deployResult.deploymentId.slice(0, 8)} completed successfully`
      });
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Execution Error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setIsRunning(false);
    }
  }, [isRunning, graph, setIsRunning, setRunProgress, resetAllStatuses, updateNodeStatus, updateNodeFile, addNotification]);

  const handleReset = useCallback(() => {
    resetAllStatuses();
    setRunProgress(0);
    addNotification({
      type: 'info',
      title: 'Pipeline Reset',
      message: 'All nodes returned to queued state'
    });
  }, [resetAllStatuses, setRunProgress, addNotification]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId || !e.target.files?.[0]) return;

    const file = e.target.files[0];
    setUploadingNodeId(selectedNodeId);

    try {
      // First, analyze the file
      const analyzeFormData = new FormData();
      analyzeFormData.append('file', file);

      const analyzeResponse = await fetch('/api/analyze-file', {
        method: 'POST',
        body: analyzeFormData
      });

      const metadata = await analyzeResponse.json();

      // Then upload it
      const uploadFormData = new FormData();
      uploadFormData.append('file', file);

      const uploadResponse = await fetch('/api/upload', {
        method: 'POST',
        body: uploadFormData
      });

      const uploadData = await uploadResponse.json();

      if (uploadResponse.ok) {
        updateNodeFile(selectedNodeId, uploadData.key, metadata);

        // Create a nice summary message
        let summary = `File "${file.name}" uploaded`;
        if (metadata.fileType === 'csv' && metadata.columns) {
          summary += `\n\nColumns: ${metadata.columns.join(', ')}`;
          summary += `\nRows: ${metadata.rowCount}`;
        } else if (metadata.fileType === 'json' && metadata.schema) {
          summary += `\n\nSchema: ${Object.keys(metadata.schema).join(', ')}`;
        }

        addChatMessage({
          role: 'assistant',
          content: summary
        });
      } else {
        addNotification({
          type: 'error',
          title: 'Upload Failed',
          message: uploadData.error
        });
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Upload Error',
        message: error instanceof Error ? error.message : 'Failed to upload file'
      });
    } finally {
      setUploadingNodeId(null);
      e.target.value = '';
    }
  }, [selectedNodeId, updateNodeFile, addNotification]);

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
              <>
                {/* Show input data schema */}
                {(() => {
                  const inputNodes = graph.nodes.filter(n => selectedNode.in.includes(n.id));
                  const inputsWithMetadata = inputNodes.filter(n => n.fileMetadata);

                  if (inputsWithMetadata.length > 0) {
                    return (
                      <div className="input-data-schema">
                        <div className="schema-header">
                          <HardDrive size={14} />
                          <span>Input Data</span>
                        </div>
                        {inputsWithMetadata.map((node, idx) => (
                          <div key={node.id} className="schema-item">
                            <strong>{node.name}:</strong>
                            {node.fileMetadata?.columns && (
                              <span className="schema-columns">
                                {node.fileMetadata.columns.slice(0, 5).join(', ')}
                                {node.fileMetadata.columns.length > 5 && ` +${node.fileMetadata.columns.length - 5} more`}
                              </span>
                            )}
                            {node.fileMetadata?.rowCount && (
                              <span className="schema-meta">({node.fileMetadata.rowCount} rows)</span>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Show parallelization info */}
                {selectedNode.parallelization && (
                  <div className="parallelization-info">
                    <div className="parallel-strategy">
                      <Cpu size={14} />
                      <span className="strategy-label">{selectedNode.parallelization.strategy.toUpperCase()}</span>
                      {selectedNode.parallelization.estimatedCores && (
                        <span className="cores-badge">{selectedNode.parallelization.estimatedCores} cores</span>
                      )}
                    </div>
                    {selectedNode.parallelization.chunkSize && (
                      <span className="chunk-info">Chunk size: {selectedNode.parallelization.chunkSize}</span>
                    )}
                  </div>
                )}
              </>
            )}
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
            onClick={handleRun}
            disabled={isRunning}
          >
            <Play size={16} />
            {isRunning ? 'Running...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
