'use client';

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { Play, RotateCcw, Terminal, Cpu, HardDrive, Upload, Download, ChevronUp } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import { getExecutionLevels } from '../utils/graph-transform';
import { generateFunctionSignature } from '../utils/signature-generator';
import CSVEditor from './CSVEditor';
import CSVViewer from './CSVViewer';
import DebugConsole from './DebugConsole';

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
    updateNodeCsvData,
    clearNodeCsvData,
    markCsvAsUploaded,
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
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(250); // Default ~1/3 of typical screen
  const [isResizing, setIsResizing] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);

  const selectedNode = useMemo(() => {
    const node = graph.nodes.find(n => n.id === selectedNodeId);
    if (node && !editingName) {
      setNameInput(node.name);
    }
    return node;
  }, [graph.nodes, selectedNodeId, editingName]);

  // Auto-fix the signature when the graph connections change
  const codeWithUpdatedSignature = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'compute') {
      return selectedNode?.code || '';
    }

    const currentSignature = generateFunctionSignature(selectedNode, graph);
    const code = selectedNode.code;

    // Find the existing def line
    const lines = code.split('\n');
    let defLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('def task')) {
        defLineIndex = i;
        break;
      }
    }

    // If signature matches or no def line found yet, return as-is
    if (defLineIndex === -1 || lines[defLineIndex].trim() === currentSignature) {
      return code;
    }

    // Replace the signature line with the new one
    const updatedLines = [...lines];
    updatedLines[defLineIndex] = currentSignature;
    return updatedLines.join('\n');
  }, [selectedNode, graph]);

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
      const response = await fetch('/api/deploy-batch', {
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

    try {
      // For CSV files, load them locally first
      if (file.name.endsWith('.csv') || file.type === 'text/csv') {
        const storageKey = `csv-edit-${selectedNodeId}`;

        // Check if there's a saved version in localStorage
        const savedData = localStorage.getItem(storageKey);
        const fileContent = savedData || await file.text();

        updateNodeCsvData(selectedNodeId, fileContent, file.name);

        if (savedData) {
          addNotification({
            type: 'info',
            title: 'Restored From Cache',
            message: `${file.name} restored with your previous edits.`
          });
        } else {
          addNotification({
            type: 'info',
            title: 'File Loaded',
            message: `${file.name} loaded. Edit and review before uploading to AWS.`
          });
        }
      } else {
        // For non-CSV files, upload directly
        setUploadingNodeId(selectedNodeId);

        const analyzeFormData = new FormData();
        analyzeFormData.append('file', file);

        const analyzeResponse = await fetch('/api/analyze-file', {
          method: 'POST',
          body: analyzeFormData
        });

        const metadata = await analyzeResponse.json();

        const uploadFormData = new FormData();
        uploadFormData.append('file', file);

        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: uploadFormData
        });

        const uploadData = await uploadResponse.json();

        if (uploadResponse.ok) {
          updateNodeFile(selectedNodeId, uploadData.key, metadata);
          addNotification({
            type: 'success',
            title: 'File Uploaded',
            message: `${file.name} uploaded successfully`
          });
        } else {
          addNotification({
            type: 'error',
            title: 'Upload Failed',
            message: uploadData.error
          });
        }
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'File Error',
        message: error instanceof Error ? error.message : 'Failed to process file'
      });
    } finally {
      setUploadingNodeId(null);
      e.target.value = '';
    }
  }, [selectedNodeId, updateNodeCsvData, updateNodeFile, addNotification]);

  const handleUploadToAWS = useCallback(async () => {
    if (!selectedNodeId || !selectedNode?.csvData || !selectedNode?.fileName) return;

    setUploadingNodeId(selectedNodeId);

    try {
      const blob = new Blob([selectedNode.csvData], { type: 'text/csv' });
      const uploadFormData = new FormData();
      uploadFormData.append('file', blob, selectedNode.fileName);

      const uploadResponse = await fetch('/api/upload', {
        method: 'POST',
        body: uploadFormData
      });

      const uploadData = await uploadResponse.json();

      if (uploadResponse.ok) {
        // Analyze the file
        const analyzeFormData = new FormData();
        analyzeFormData.append('file', blob, selectedNode.fileName);

        const analyzeResponse = await fetch('/api/analyze-file', {
          method: 'POST',
          body: analyzeFormData
        });

        const metadata = await analyzeResponse.json();

        updateNodeFile(selectedNodeId, uploadData.key, metadata);

        // Mark CSV as uploaded (don't clear csvData, just mark it)
        markCsvAsUploaded(selectedNodeId);

        addNotification({
          type: 'success',
          title: 'File Uploaded',
          message: `${selectedNode.fileName} uploaded to AWS`
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
        message: error instanceof Error ? error.message : 'Failed to upload file to AWS'
      });
    } finally {
      setUploadingNodeId(null);
    }
  }, [selectedNodeId, selectedNode, updateNodeFile, markCsvAsUploaded, addNotification]);

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

  const handleDownloadCSV = useCallback(() => {
    if (!selectedNode?.csvData || !selectedNode?.fileName) return;

    const link = document.createElement('a');
    const blob = new Blob([selectedNode.csvData], { type: 'text/csv' });
    link.href = URL.createObjectURL(blob);
    link.download = selectedNode.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
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

  const handleConsoleResize = useCallback((e: MouseEvent) => {
    if (!isResizing) return;

    e.preventDefault();
    e.stopPropagation();

    const editorPanel = document.querySelector('.editor-panel');
    if (!editorPanel) return;

    const panelRect = editorPanel.getBoundingClientRect();
    const newHeight = panelRect.bottom - e.clientY - 80; // Account for footer height
    const minHeight = 100;
    const maxHeight = panelRect.height - 300; // Leave room for editor content

    setConsoleHeight(Math.max(minHeight, Math.min(newHeight, maxHeight)));
  }, [isResizing]);

  const handleConsoleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';
      document.addEventListener('mousemove', handleConsoleResize);
      document.addEventListener('mouseup', handleConsoleResizeEnd);
      return () => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', handleConsoleResize);
        document.removeEventListener('mouseup', handleConsoleResizeEnd);
      };
    }
  }, [isResizing, handleConsoleResize, handleConsoleResizeEnd]);

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
                  {!selectedNode.csvData && (
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
                  )}
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
                  value={codeWithUpdatedSignature}
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
            {selectedNode.type === 'input-file' && selectedNode.csvData && (
              <CSVEditor
                data={selectedNode.csvData}
                fileName={selectedNode.fileName || 'Untitled'}
                nodeId={selectedNodeId!}
                hasUnsavedChanges={selectedNode.csvData !== selectedNode.lastUploadedCsvData}
                onDataChange={(data) => updateNodeCsvData(selectedNodeId!, data, selectedNode.fileName)}
                onUpload={handleUploadToAWS}
                onCancel={() => {
                  clearNodeCsvData(selectedNodeId!);
                  const storageKey = `csv-edit-${selectedNodeId}`;
                  localStorage.removeItem(storageKey);
                }}
                isUploading={uploadingNodeId === selectedNodeId}
              />
            )}
            {selectedNode.type === 'output-file' && selectedNode.csvData && (
              <CSVViewer
                data={selectedNode.csvData}
                fileName={selectedNode.fileName || 'Output'}
                onDownload={handleDownloadCSV}
              />
            )}
            {selectedNode.type !== 'compute' && !selectedNode.csvData && (
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

      {consoleOpen && (
        <>
          <div
            className="console-resize-handle"
            onMouseDown={() => setIsResizing(true)}
          />
          <div
            ref={consoleRef}
            className="debug-console-wrapper"
            style={{ height: `${consoleHeight}px` }}
          >
            <DebugConsole
              isOpen={consoleOpen}
              onClose={() => setConsoleOpen(false)}
            />
          </div>
        </>
      )}

      <div className="editor-footer">
        <div className="progress-bar-container">
          <div
            className="progress-bar"
            style={{ width: `${runProgress}%` }}
          />
        </div>
        <div className="footer-actions">
          {!consoleOpen && (
            <button
              className="btn btn-console"
              onClick={() => setConsoleOpen(true)}
            >
              <ChevronUp size={16} />
              Debug Console
            </button>
          )}
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
