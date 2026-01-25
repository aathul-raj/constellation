'use client';

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { Play, RotateCcw, Terminal, Cpu, HardDrive, Upload, Download, ChevronUp, FileText, X } from 'lucide-react';
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
    addNodeFile,
    removeNodeFile,
    updateNodeCsvData,
    clearNodeCsvData,
    markCsvAsUploaded,
    resetAllStatuses,
    isRunning,
    setIsRunning,
    runProgress,
    setRunProgress,
    theme,
    addNotification,
    addConsoleLog,
    clearConsoleLogs
  } = useHPCStore();

  const [uploadingNodeId, setUploadingNodeId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(250); // Default ~1/3 of typical screen
  const [isResizing, setIsResizing] = useState(false);
  const [selectedOutputFileIndex, setSelectedOutputFileIndex] = useState(0);
  const [selectedInputFileIndex, setSelectedInputFileIndex] = useState(0);
  const [inputFileContent, setInputFileContent] = useState<string | null>(null);
  const [loadingInputFile, setLoadingInputFile] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [currentDeploymentType, setCurrentDeploymentType] = useState<'local' | 'cloud' | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  // Pre-deployment lint check
  const lintComputeNodes = useCallback(async () => {
    const computeNodes = graph.nodes.filter(n => n.type === 'compute');
    const errors: Array<{ nodeName: string; errors: string[] }> = [];

    for (const node of computeNodes) {
      if (!node.code || !node.code.trim()) {
        continue;
      }

      try {
        // Import createExecutableScript dynamically
        const { createExecutableScript } = await import('../utils/code-wrapper');
        const completeScript = createExecutableScript(node, graph);

        const lintResponse = await fetch('/api/lint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: completeScript })
        });

        const lintResult = await lintResponse.json();

        if (!lintResult.valid && lintResult.errors) {
          errors.push({
            nodeName: node.name,
            errors: lintResult.errors
          });
        }
      } catch (error) {
        errors.push({
          nodeName: node.name,
          errors: [error instanceof Error ? error.message : 'Unknown error']
        });
      }
    }

    return errors;
  }, [graph]);

  const runStreamingDeployment = useCallback(async (endpoint: string, title: string, deploymentType: 'local' | 'cloud') => {
    if (isRunning) return;

    // Run pre-deployment lint check
    const lintErrors = await lintComputeNodes();

    if (lintErrors.length > 0) {
      const errorMessages = lintErrors.map(({ nodeName, errors }) =>
        `**${nodeName}**: ${errors.join('; ')}`
      ).join('\n\n');

      addNotification({
        type: 'error',
        title: 'Syntax Errors Detected',
        message: `Please fix the following errors before running:\n\n${errorMessages}`
      });

      clearConsoleLogs();
      lintErrors.forEach(({ nodeName, errors }) => {
        errors.forEach(error => {
          addConsoleLog({ type: 'error', message: error, nodeName });
        });
      });
      return;
    }

    setIsRunning(true);
    setCurrentDeploymentType(deploymentType);
    setRunProgress(0);
    resetAllStatuses();
    clearConsoleLogs();

    const computeNodeIds = graph.nodes.filter(n => n.type === 'compute').map(n => n.id);
    let completedNodes = 0;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph })
      });

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6);

            if (eventType && eventData) {
              try {
                const data = JSON.parse(eventData);

                switch (eventType) {
                  case 'node-status':
                    updateNodeStatus(data.nodeId, data.status);
                    if (data.status === 'completed') {
                      completedNodes++;
                      setRunProgress((completedNodes / computeNodeIds.length) * 100);
                    }
                    break;

                  case 'log':
                    addConsoleLog({
                      type: data.type || 'info',
                      message: data.message,
                      nodeId: data.nodeId,
                      nodeName: data.nodeName
                    });
                    break;

                  case 'error':
                    addConsoleLog({
                      type: 'error',
                      message: data.message,
                      nodeId: data.nodeId,
                      nodeName: data.nodeName
                    });
                    addNotification({
                      type: 'error',
                      title: 'Deployment Failed',
                      message: data.message
                    });
                    break;

                  case 'complete':
                    // Handle output file updates
                    const outputNodeUpdates = data.outputNodeUpdates || [];
                    const updatesByNode = new Map<string, typeof outputNodeUpdates>();

                    for (const update of outputNodeUpdates) {
                      if (!updatesByNode.has(update.nodeId)) {
                        updatesByNode.set(update.nodeId, []);
                      }
                      updatesByNode.get(update.nodeId)!.push(update);
                    }

                    for (const [nodeId, updates] of updatesByNode) {
                      clearNodeCsvData(nodeId);
                      const outputNode = graph.nodes.find(n => n.id === nodeId);
                      const existingFileIds = outputNode?.files?.map(f => f.id) || [];
                      existingFileIds.forEach(fileId => removeNodeFile(nodeId, fileId));

                      if ((window as any).__outputFiles?.[nodeId]) {
                        delete (window as any).__outputFiles[nodeId];
                        localStorage.setItem('outputFiles', JSON.stringify((window as any).__outputFiles));
                      }
                      setSelectedOutputFileIndex(0);

                      const csvContent = updates[0].csvContent;
                      if (csvContent) {
                        updateNodeCsvData(nodeId, csvContent, updates[0].fileName || 'output.csv');

                        if (updates.length > 1) {
                          (window as any).__outputFiles = (window as any).__outputFiles || {};
                          (window as any).__outputFiles[nodeId] = updates.map((u: any) => ({
                            fileName: u.fileName,
                            content: u.csvContent
                          }));
                          localStorage.setItem('outputFiles', JSON.stringify((window as any).__outputFiles));
                        }
                      }
                    }

                    addNotification({
                      type: 'success',
                      title: title,
                      message: `Deployment ${data.deploymentId.slice(0, 8)} completed successfully`
                    });
                    break;
                }
              } catch (e) {
                console.error('Failed to parse SSE data:', e);
                addConsoleLog({
                  type: 'error',
                  message: `Failed to parse server response: ${e instanceof Error ? e.message : 'Unknown error'}`
                });
              }
              eventType = '';
              eventData = '';
            }
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      computeNodeIds.forEach(nodeId => updateNodeStatus(nodeId, 'failed'));
      addConsoleLog({
        type: 'error',
        message: `Execution error: ${errorMessage}`
      });
      addNotification({
        type: 'error',
        title: 'Execution Error',
        message: errorMessage
      });
    } finally {
      setIsRunning(false);
      setCurrentDeploymentType(null);
    }
  }, [isRunning, graph, setIsRunning, setRunProgress, resetAllStatuses, updateNodeStatus, addNotification, updateNodeCsvData, clearNodeCsvData, removeNodeFile, addConsoleLog, clearConsoleLogs, lintComputeNodes]);

  const handleRun = useCallback(async () => {
    await runStreamingDeployment('/api/deploy-batch', 'Pipeline Executed (AWS)', 'cloud');
  }, [runStreamingDeployment]);

  const handleRunLocal = useCallback(async () => {
    await runStreamingDeployment('/api/deploy-local', 'Local Test Complete', 'local');
  }, [runStreamingDeployment]);

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
    if (!selectedNodeId || !e.target.files) return;

    const files = Array.from(e.target.files);
    setUploadingNodeId(selectedNodeId);

    try {
      for (const file of files) {
        // Only accept CSV and ZIP files
        if (!file.name.endsWith('.csv') && !file.name.endsWith('.zip')) {
          addNotification({
            type: 'error',
            title: 'Invalid File Type',
            message: `${file.name} - Only CSV and ZIP files are supported`
          });
          continue;
        }

        // Upload to AWS
        const uploadFormData = new FormData();
        uploadFormData.append('file', file);

        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: uploadFormData
        });

        const uploadData = await uploadResponse.json();

        if (uploadResponse.ok) {
          // Check if this is a ZIP file response (multiple files) or single file
          if (uploadData.files && Array.isArray(uploadData.files)) {
            // ZIP file - multiple CSVs extracted
            for (const uploadedFile of uploadData.files) {
              // Analyze each CSV
              const analyzeFormData = new FormData();

              // Fetch the file from S3 to analyze it
              const fileResponse = await fetch(`/api/files/${encodeURIComponent(uploadedFile.key)}`);
              const fileBlob = await fileResponse.blob();
              const csvFile = new File([fileBlob], uploadedFile.originalName, { type: 'text/csv' });

              analyzeFormData.append('file', csvFile);

              const analyzeResponse = await fetch('/api/analyze-file', {
                method: 'POST',
                body: analyzeFormData
              });

              const metadata = await analyzeResponse.json();

              // Add file to the node's files array
              addNodeFile(selectedNodeId, {
                id: uploadedFile.key,
                name: uploadedFile.originalName,
                metadata: metadata
              });
            }

            addNotification({
              type: 'success',
              title: 'ZIP Extracted',
              message: `${uploadData.count} CSV file(s) uploaded from ${file.name}`
            });
          } else {
            // Single CSV file
            const analyzeFormData = new FormData();
            analyzeFormData.append('file', file);

            const analyzeResponse = await fetch('/api/analyze-file', {
              method: 'POST',
              body: analyzeFormData
            });

            const metadata = await analyzeResponse.json();

            // Add file to the node's files array
            addNodeFile(selectedNodeId, {
              id: uploadData.key,
              name: file.name,
              metadata: metadata
            });

            addNotification({
              type: 'success',
              title: 'File Uploaded',
              message: `${file.name} uploaded to AWS successfully`
            });
          }
        } else {
          addNotification({
            type: 'error',
            title: 'Upload Failed',
            message: uploadData.error || 'Failed to upload file'
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
  }, [selectedNodeId, addNodeFile, addNotification]);

  const handleFileDownload = useCallback(() => {
    if (!selectedNode?.files || selectedNode.files.length === 0) return;

    // Download the first file
    const file = selectedNode.files[0];
    const url = `/api/files/${encodeURIComponent(file.id)}?download=true`;
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
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

  const handleDownloadAllAsZip = useCallback(async () => {
    if (!selectedNode) return;

    // Get all output files for this node
    const outputFiles = (window as any).__outputFiles?.[selectedNode.id];
    if (!outputFiles || outputFiles.length === 0) return;

    try {
      // Dynamically import JSZip
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      // Add all files to the zip
      outputFiles.forEach((file: any) => {
        zip.file(file.fileName, file.content);
      });

      // Generate the zip file
      const blob = await zip.generateAsync({ type: 'blob' });

      // Download the zip
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${selectedNode.name}-outputs.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      addNotification({
        type: 'success',
        title: 'Download Complete',
        message: `Downloaded ${outputFiles.length} files as ${selectedNode.name}-outputs.zip`
      });
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Download Failed',
        message: error instanceof Error ? error.message : 'Failed to create zip file'
      });
    }
  }, [selectedNode, addNotification]);

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

  const handleInputFileSelect = useCallback(async (fileIndex: number) => {
    setSelectedInputFileIndex(fileIndex);
    if (!selectedNode || selectedNode.type !== 'input-file' || !selectedNode.files) return;

    const file = selectedNode.files[fileIndex];
    if (!file) return;

    // Clear previous content immediately to avoid showing stale data
    setInputFileContent(null);
    setLoadingInputFile(true);
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}`);
      if (response.ok) {
        const text = await response.text();
        setInputFileContent(text);
      } else {
        addNotification({
          type: 'error',
          title: 'Failed to Load File',
          message: 'Could not fetch file from S3'
        });
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Error Loading File',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setLoadingInputFile(false);
    }
  }, [selectedNode, addNotification]);

  // Auto-load first input file when node is selected
  useEffect(() => {
    if (selectedNode?.type === 'input-file' && selectedNode.files && selectedNode.files.length > 0 && !selectedNode.csvData) {
      setSelectedInputFileIndex(0);
      handleInputFileSelect(0);
    } else if (selectedNode?.type === 'input-file' && (!selectedNode.files || selectedNode.files.length === 0)) {
      setInputFileContent(null);
      setSelectedInputFileIndex(0);
    } else if (selectedNode?.type !== 'input-file') {
      setInputFileContent(null);
      setSelectedInputFileIndex(0);
    }
  }, [selectedNode, handleInputFileSelect]);

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

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isDropdownOpen]);

  // Load output files from localStorage on mount
  useEffect(() => {
    const savedOutputFiles = localStorage.getItem('outputFiles');
    if (savedOutputFiles) {
      try {
        (window as any).__outputFiles = JSON.parse(savedOutputFiles);
      } catch (error) {
        console.error('Failed to load output files from localStorage:', error);
      }
    }
  }, []);

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
                <>
                  <div className="file-upload-section">
                    <label className="file-upload-btn">
                      <Upload size={14} />
                      <span>Upload Files</span>
                      <input
                        type="file"
                        accept=".csv,.zip"
                        multiple
                        onChange={handleFileUpload}
                        disabled={uploadingNodeId === selectedNodeId}
                        style={{ display: 'none' }}
                      />
                    </label>
                    <span className="file-upload-hint">CSV or ZIP files</span>
                  </div>
                  {selectedNode.files && selectedNode.files.length > 0 && (
                    <div className="input-files-dropdown" ref={dropdownRef}>
                      <label className="dropdown-label">
                        Uploaded Files ({selectedNode.files.length})
                      </label>
                      <div className="dropdown-row">
                        <div className="custom-dropdown">
                          <button
                            className="dropdown-trigger"
                            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                            type="button"
                          >
                            <FileText size={14} />
                            <span className="dropdown-text">
                              {selectedNode.files[selectedInputFileIndex]?.name}
                            </span>
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              className={`dropdown-arrow ${isDropdownOpen ? 'open' : ''}`}
                            >
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>
                          {isDropdownOpen && (
                            <div className="dropdown-menu">
                              {selectedNode.files.map((file, index) => (
                                <div
                                  key={file.id}
                                  className={`dropdown-item ${index === selectedInputFileIndex ? 'active' : ''}`}
                                  onClick={() => {
                                    handleInputFileSelect(index);
                                    setIsDropdownOpen(false);
                                  }}
                                >
                                  <FileText size={14} />
                                  <span className="dropdown-item-text">
                                    {file.name}
                                  </span>
                                  {file.metadata?.rowCount && (
                                    <span className="dropdown-item-meta">
                                      {file.metadata.rowCount} rows
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          className="file-remove-btn-compact"
                          onClick={() => removeNodeFile(selectedNode.id, selectedNode.files![selectedInputFileIndex].id)}
                          title="Remove selected file"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {selectedNode.type === 'output-file' && (
                <div className="file-actions">
                  {selectedNode.csvData || (selectedNode.files && selectedNode.files.length > 0) ? (
                    <>
                      {(window as any).__outputFiles?.[selectedNode.id]?.length > 1 ? (
                        <button
                          className="file-download-btn"
                          onClick={handleDownloadAllAsZip}
                        >
                          <Download size={14} />
                          <span>Download All ({(window as any).__outputFiles[selectedNode.id].length} files)</span>
                        </button>
                      ) : selectedNode.csvData ? (
                        <button
                          className="file-download-btn"
                          onClick={handleDownloadCSV}
                        >
                          <Download size={14} />
                          <span>Download CSV</span>
                        </button>
                      ) : null}
                      {selectedNode.files && selectedNode.files.length > 0 && (
                        <>
                          <button
                            className="file-download-btn"
                            onClick={handleFileDownload}
                          >
                            <Download size={14} />
                            <span>Download from S3</span>
                          </button>
                          <div className="uploaded-files-list">
                            {selectedNode.files.map((file) => (
                              <div key={file.id} className="file-item">
                                <div className="file-item-info">
                                  <FileText size={14} />
                                  <span className="file-name">{file.name}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
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
                  const inputsWithMetadata = inputNodes.filter(n =>
                    n.files && n.files.length > 0 && n.files[0].metadata
                  );

                  if (inputsWithMetadata.length > 0) {
                    return (
                      <div className="input-data-schema">
                        <div className="schema-header">
                          <HardDrive size={14} />
                          <span>Input Data</span>
                        </div>
                        {inputsWithMetadata.map((node) => {
                          const metadata = node.files?.[0]?.metadata;
                          return (
                            <div key={node.id} className="schema-item">
                              <strong>{node.name}:</strong>
                              {metadata?.columns && (
                                <span className="schema-columns">
                                  {metadata.columns.slice(0, 5).join(', ')}
                                  {metadata.columns.length > 5 && ` +${metadata.columns.length - 5} more`}
                                </span>
                              )}
                              {metadata?.rowCount && (
                                <span className="schema-meta">({metadata.rowCount} rows)</span>
                              )}
                            </div>
                          );
                        })}
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
                onDataChange={(data) => updateNodeCsvData(selectedNodeId!, data, selectedNode.fileName)}
                onCancel={() => {
                  clearNodeCsvData(selectedNodeId!);
                  const storageKey = `csv-edit-${selectedNodeId}`;
                  localStorage.removeItem(storageKey);
                }}
                isUploading={uploadingNodeId === selectedNodeId}
              />
            )}
            {selectedNode.type === 'input-file' && !selectedNode.csvData && inputFileContent && (
              <CSVViewer
                data={inputFileContent}
                fileName={selectedNode.files?.[selectedInputFileIndex]?.name || 'file.csv'}
                onDownload={() => {
                  if (!selectedNode.files?.[selectedInputFileIndex]) return;
                  const file = selectedNode.files[selectedInputFileIndex];
                  const link = document.createElement('a');
                  const blob = new Blob([inputFileContent], { type: 'text/csv' });
                  link.href = URL.createObjectURL(blob);
                  link.download = file.name;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  URL.revokeObjectURL(link.href);
                }}
              />
            )}
            {selectedNode.type === 'output-file' && selectedNode.csvData && (
              <>
                {(window as any).__outputFiles?.[selectedNode.id]?.length > 1 ? (
                  <div className="multi-file-viewer">
                    <div className="file-list-panel">
                      <div className="file-list-header">
                        <span>Output Files ({(window as any).__outputFiles[selectedNode.id].length})</span>
                      </div>
                      <div className="file-list">
                        {(window as any).__outputFiles[selectedNode.id].map((file: any, index: number) => (
                          <div
                            key={index}
                            className={`file-list-item ${selectedOutputFileIndex === index ? 'active' : ''}`}
                            onClick={() => setSelectedOutputFileIndex(index)}
                          >
                            <FileText size={14} />
                            <span className="file-list-name">{file.fileName}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="file-viewer-panel">
                      <CSVViewer
                        data={(window as any).__outputFiles[selectedNode.id][selectedOutputFileIndex].content}
                        fileName={(window as any).__outputFiles[selectedNode.id][selectedOutputFileIndex].fileName}
                        onDownload={() => {
                          const file = (window as any).__outputFiles[selectedNode.id][selectedOutputFileIndex];
                          const link = document.createElement('a');
                          const blob = new Blob([file.content], { type: 'text/csv' });
                          link.href = URL.createObjectURL(blob);
                          link.download = file.fileName;
                          document.body.appendChild(link);
                          link.click();
                          document.body.removeChild(link);
                          URL.revokeObjectURL(link.href);
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <CSVViewer
                    data={selectedNode.csvData}
                    fileName={selectedNode.fileName || 'Output'}
                    onDownload={handleDownloadCSV}
                  />
                )}
              </>
            )}
            {selectedNode.type === 'input-file' && !selectedNode.csvData && !inputFileContent && loadingInputFile && (
              <div className="empty-state">
                <HardDrive size={48} strokeWidth={1} />
                <h3>Loading File...</h3>
                <p>Fetching file content from storage</p>
              </div>
            )}
            {selectedNode.type !== 'compute' && !selectedNode.csvData && !inputFileContent && !loadingInputFile && (
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
            className={`btn btn-secondary ${currentDeploymentType === 'local' ? 'running' : ''}`}
            onClick={handleRunLocal}
            disabled={isRunning}
            title="Test your scripts locally before deploying to cloud"
          >
            <Play size={16} />
            {currentDeploymentType === 'local' ? 'Testing...' : 'Test Pipeline'}
          </button>
          <button
            className={`btn btn-primary ${currentDeploymentType === 'cloud' ? 'running' : ''}`}
            onClick={handleRun}
            disabled={isRunning}
            title="Deploy and run on distributed cloud compute clusters"
          >
            <Play size={16} />
            {currentDeploymentType === 'cloud' ? 'Deploying...' : 'Deploy to Cloud'}
          </button>
        </div>
      </div>

    </div>
  );
}
