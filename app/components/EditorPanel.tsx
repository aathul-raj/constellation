'use client';

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { Play, RotateCcw, Terminal, Cpu, HardDrive, Upload, Download, ChevronUp, ChevronDown, FileText, X, Sparkles, Loader2, StopCircle, Zap } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import type { HPCGraph } from '../store/hpc-store';
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
    setGraph,
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
    clearConsoleLogs,
    addChatMessage,
    consoleLogs
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
  const [outputAnalysis, setOutputAnalysis] = useState<string | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisExpanded, setAnalysisExpanded] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Autopilot state - AI automatically fixes errors (after user confirmation)
  const [isAutopilotActive, setIsAutopilotActive] = useState(false);
  const [autopilotRetryCount, setAutopilotRetryCount] = useState(0);
  const [autopilotMaxRetries] = useState(10);
  const [currentFixingNode, setCurrentFixingNode] = useState<string | null>(null);
  const [showAutopilotPrompt, setShowAutopilotPrompt] = useState(false);
  const [pendingAutopilotError, setPendingAutopilotError] = useState<{
    failedNodeId: string;
    nodeName: string;
    errorMessage: string;
  } | null>(null);
  const stopAutopilotRef = useRef(false);
  const autopilotRetryCountRef = useRef(0); // Ref for closure access
  const autopilotAbortController = useRef<AbortController | null>(null);
  const autopilotEndpointRef = useRef<string>('');
  const autopilotTitleRef = useRef<string>('');

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

  // Helper to run with timeout
  const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Operation timed out')), timeoutMs)
      )
    ]);
  };

  // Pre-deployment lint check - validates Python syntax before running
  // IMPORTANT: Gets fresh graph from store to avoid stale state after autopilot fixes
  const lintComputeNodes = useCallback(async () => {
    // Get fresh graph directly from store - the closure's `graph` may be stale after updateNodeCode
    const freshGraph = useHPCStore.getState().graph;
    const computeNodes = freshGraph.nodes.filter(n => n.type === 'compute');
    const errors: Array<{ nodeName: string; errors: string[] }> = [];

    for (const node of computeNodes) {
      if (!node.code || !node.code.trim()) {
        continue;
      }

      try {
        // Import createExecutableScript dynamically
        const { createExecutableScript } = await import('../utils/code-wrapper');
        const completeScript = createExecutableScript(node, freshGraph);

        const lintResponse = await withTimeout(
          fetch('/api/lint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: completeScript })
          }),
          10000 // 10 second timeout for linter
        );

        const lintResult = await lintResponse.json();

        if (!lintResult.valid && lintResult.errors) {
          errors.push({
            nodeName: node.name,
            errors: lintResult.errors
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const isTimeout = errorMessage.includes('timed out') || errorMessage.includes('timeout');

        errors.push({
          nodeName: node.name,
          errors: [isTimeout ? 'Linter timeout - check for infinite loops or complex code' : errorMessage]
        });

        // Mark node as failed if linter times out
        if (isTimeout) {
          updateNodeStatus(node.id, 'failed');
          addConsoleLog({
            type: 'error',
            message: `Linter error: ${node.name} - Linter timed out after 10 seconds`,
            nodeId: node.id,
            nodeName: node.name
          });
        }
      }
    }

    return errors;
  }, [graph, updateNodeStatus, addConsoleLog]);

  // Function to fix a failed node using AI
  const fixFailedNode = useCallback(async (
    failedNodeId: string,
    errorMessage: string,
    currentGraph: HPCGraph
  ): Promise<{ success: boolean; fixedCode?: string; analysis?: string; fixDescription?: string }> => {
    try {
      const response = await fetch('/api/fix-pipeline-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graph: currentGraph,
          failedNodeId,
          errorMessage,
          consoleLogs: consoleLogs.filter(log => log.nodeId === failedNodeId || log.type === 'error'),
          userGoal: currentGraph.description
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, analysis: errorData.error || 'Failed to get fix from AI' };
      }

      const data = await response.json();
      return {
        success: true,
        fixedCode: data.fixedCode,
        analysis: data.analysis,
        fixDescription: data.fixDescription
      };
    } catch (error) {
      return {
        success: false,
        analysis: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }, [consoleLogs]);

  // Function to run deployment with Autopilot - AI automatically fixes errors
  const runWithAutopilot = useCallback(async (endpoint: string, title: string, isRetry: boolean = false, deployType?: 'local' | 'cloud') => {
    if (isRunning && !isRetry) return;
    
    // Check if stop was requested
    if (stopAutopilotRef.current) {
      stopAutopilotRef.current = false;
      setIsAutopilotActive(false);
      setAutopilotRetryCount(0);
      setCurrentFixingNode(null);
      addChatMessage({
        role: 'assistant',
        content: 'Autopilot stopped.'
      });
      return;
    }

    // Abort controller for cancellation
    autopilotAbortController.current = new AbortController();
    
    // Store endpoint/title for retries
    if (!isRetry) {
      autopilotEndpointRef.current = endpoint;
      autopilotTitleRef.current = title;
    }

    if (!isRetry) {
      // Run pre-deployment lint check
      const lintErrors = await lintComputeNodes();

      if (lintErrors.length > 0) {
        const errorMessages = lintErrors.map(({ nodeName, errors }) =>
          `**${nodeName}**: ${errors.join('; ')}`
        ).join('\n\n');

        clearConsoleLogs();
        lintErrors.forEach(({ nodeName, errors }) => {
          errors.forEach(error => {
            addConsoleLog({ type: 'error', message: error, nodeName });
          });
        });

        // Find the first node with lint errors and trigger autopilot to fix it
        const firstErrorNode = lintErrors[0];
        const failedNode = graph.nodes.find(n => n.name === firstErrorNode.nodeName);
        
        if (failedNode) {
          const lintErrorMessage = `Lint/Syntax Error: ${firstErrorNode.errors.join('; ')}`;
          
          // If this is the first lint failure (not already in autopilot mode), ask the user
          if (autopilotRetryCountRef.current === 0) {
            // Store the error info and show the prompt
            setPendingAutopilotError({
              failedNodeId: failedNode.id,
              nodeName: failedNode.name,
              errorMessage: lintErrorMessage
            });
            setShowAutopilotPrompt(true);
            setCurrentDeploymentType(null);
            return;
          }
          
          // If user already approved autopilot, fix the lint error
          setIsAutopilotActive(true);
          setCurrentFixingNode(failedNode.name);
          autopilotRetryCountRef.current += 1;
          const currentAttempt = autopilotRetryCountRef.current;
          setAutopilotRetryCount(currentAttempt);

          addChatMessage({
            role: 'assistant',
            content: `**Autopilot** fixing lint errors in \`${failedNode.name}\`\n\n\`\`\`\n${lintErrorMessage}\n\`\`\`\n\n(Attempt ${currentAttempt}/${autopilotMaxRetries})`
          });

          // Call the fix API
          const freshGraph = useHPCStore.getState().graph;
          const fixResult = await fixFailedNode(failedNode.id, lintErrorMessage, freshGraph);

          if (stopAutopilotRef.current) {
            stopAutopilotRef.current = false;
            setIsAutopilotActive(false);
            setAutopilotRetryCount(0);
            autopilotRetryCountRef.current = 0;
            setCurrentFixingNode(null);
            addChatMessage({
              role: 'assistant',
              content: 'Autopilot stopped.'
            });
            setCurrentDeploymentType(null);
            return;
          }

          if (fixResult.success && fixResult.fixedCode) {
            console.log('[Autopilot] Applying lint fix to node:', failedNode.id);
            console.log('[Autopilot] Fixed code (first 150 chars):', fixResult.fixedCode.substring(0, 150));
            updateNodeCode(failedNode.id, fixResult.fixedCode);
            
            // Wait for store to update
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Verify the fix was stored - this is critical for debugging
            const verifyGraph = useHPCStore.getState().graph;
            const verifyNode = verifyGraph.nodes.find(n => n.id === failedNode.id);
            // Note: store normalizes code (tabs→spaces), so compare normalized versions
            const normalizeCode = (c: string) => c.split('\n').map(l => l.replace(/\t/g, '    ').trimEnd()).join('\n');
            const codeMatches = verifyNode?.code === normalizeCode(fixResult.fixedCode);
            console.log('[Autopilot] Code stored correctly:', codeMatches);
            if (!codeMatches) {
              console.warn('[Autopilot] CODE MISMATCH! Expected:', normalizeCode(fixResult.fixedCode).substring(0, 100));
              console.warn('[Autopilot] CODE MISMATCH! Got:', verifyNode?.code?.substring(0, 100));
            }

            addChatMessage({
              role: 'assistant',
              content: `**Fixed** lint errors in \`${failedNode.name}\`\n\n${fixResult.analysis}${fixResult.fixDescription ? `\n\n${fixResult.fixDescription}` : ''}\n\nRechecking...`
            });

            setCurrentFixingNode(null);
            await new Promise(resolve => setTimeout(resolve, 300));

            // Retry with autopilot to check for more lint errors or run deployment
            await runWithAutopilot(endpoint, title, true, deployType);
            return;
          } else {
            addChatMessage({
              role: 'assistant',
              content: `Could not fix lint errors in \`${failedNode.name}\` automatically.\n\n${fixResult.analysis || 'Unable to determine fix.'}\n\nPlease fix manually.`
            });
            setIsAutopilotActive(false);
            setAutopilotRetryCount(0);
            autopilotRetryCountRef.current = 0;
            setCurrentFixingNode(null);
            setCurrentDeploymentType(null);
            return;
          }
        }

        addNotification({
          type: 'error',
          title: 'Syntax Errors Detected',
          message: `Please fix the following errors before running:\n\n${errorMessages}`
        });
        setCurrentDeploymentType(null);
        return;
      }

      setAutopilotRetryCount(0);
      autopilotRetryCountRef.current = 0;
      stopAutopilotRef.current = false;
      if (deployType) {
        setCurrentDeploymentType(deployType);
      }
    } else {
      // On retry, also check for lint errors (in case autopilot fix introduced new ones)
      const lintErrors = await lintComputeNodes();
      
      if (lintErrors.length > 0) {
        // Check max retries
        if (autopilotRetryCountRef.current >= autopilotMaxRetries) {
          const errorMessages = lintErrors.map(({ nodeName, errors }) =>
            `**${nodeName}**: ${errors.join('; ')}`
          ).join('\n\n');
          
          addChatMessage({
            role: 'assistant',
            content: `Autopilot reached max attempts (${autopilotMaxRetries}). Manual fix required.\n\nRemaining lint errors:\n${errorMessages}`
          });
          addNotification({
            type: 'error',
            title: 'Autopilot Stopped',
            message: `Could not fix after ${autopilotMaxRetries} attempts`
          });
          setIsRunning(false);
          setCurrentDeploymentType(null);
          setIsAutopilotActive(false);
          setAutopilotRetryCount(0);
          autopilotRetryCountRef.current = 0;
          setCurrentFixingNode(null);
          return;
        }

        // Fix the first lint error
        const firstErrorNode = lintErrors[0];
        const failedNode = graph.nodes.find(n => n.name === firstErrorNode.nodeName);
        
        if (failedNode) {
          const lintErrorMessage = `Lint/Syntax Error: ${firstErrorNode.errors.join('; ')}`;
          
          setIsAutopilotActive(true);
          setCurrentFixingNode(failedNode.name);
          autopilotRetryCountRef.current += 1;
          const currentAttempt = autopilotRetryCountRef.current;
          setAutopilotRetryCount(currentAttempt);

          addChatMessage({
            role: 'assistant',
            content: `**Autopilot** fixing lint errors in \`${failedNode.name}\`\n\n\`\`\`\n${lintErrorMessage}\n\`\`\`\n\n(Attempt ${currentAttempt}/${autopilotMaxRetries})`
          });

          const freshGraph = useHPCStore.getState().graph;
          const fixResult = await fixFailedNode(failedNode.id, lintErrorMessage, freshGraph);

          if (stopAutopilotRef.current) {
            stopAutopilotRef.current = false;
            setIsAutopilotActive(false);
            setAutopilotRetryCount(0);
            autopilotRetryCountRef.current = 0;
            setCurrentFixingNode(null);
            addChatMessage({
              role: 'assistant',
              content: 'Autopilot stopped.'
            });
            setCurrentDeploymentType(null);
            return;
          }

          if (fixResult.success && fixResult.fixedCode) {
            console.log('[Autopilot] Applying lint fix to node:', failedNode.id);
            console.log('[Autopilot] Fixed code (first 150 chars):', fixResult.fixedCode.substring(0, 150));
            updateNodeCode(failedNode.id, fixResult.fixedCode);
            
            // Wait for store to update
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Verify the fix was stored
            const verifyGraph = useHPCStore.getState().graph;
            const verifyNode = verifyGraph.nodes.find(n => n.id === failedNode.id);
            // Note: store normalizes code (tabs→spaces), so compare normalized versions
            const normalizeCode = (c: string) => c.split('\n').map(l => l.replace(/\t/g, '    ').trimEnd()).join('\n');
            const codeMatches = verifyNode?.code === normalizeCode(fixResult.fixedCode);
            console.log('[Autopilot] Code stored correctly:', codeMatches);
            if (!codeMatches) {
              console.warn('[Autopilot] CODE MISMATCH! Expected:', normalizeCode(fixResult.fixedCode).substring(0, 100));
              console.warn('[Autopilot] CODE MISMATCH! Got:', verifyNode?.code?.substring(0, 100));
            }

            addChatMessage({
              role: 'assistant',
              content: `**Fixed** lint errors in \`${failedNode.name}\`\n\n${fixResult.analysis}${fixResult.fixDescription ? `\n\n${fixResult.fixDescription}` : ''}\n\nRechecking...`
            });

            setCurrentFixingNode(null);
            await new Promise(resolve => setTimeout(resolve, 300));

            // Retry to check for more lint errors or run deployment
            await runWithAutopilot(autopilotEndpointRef.current, autopilotTitleRef.current, true);
            return;
          } else {
            addChatMessage({
              role: 'assistant',
              content: `Could not fix lint errors in \`${failedNode.name}\` automatically.\n\n${fixResult.analysis || 'Unable to determine fix.'}\n\nPlease fix manually.`
            });
            setIsAutopilotActive(false);
            setAutopilotRetryCount(0);
            autopilotRetryCountRef.current = 0;
            setCurrentFixingNode(null);
            setCurrentDeploymentType(null);
            return;
          }
        }
      }
    }

    setIsRunning(true);
    setRunProgress(0);
    if (!isRetry) {
      resetAllStatuses();
      clearConsoleLogs();
    }

    // IMPORTANT: Get fresh graph from store to include any fixes applied
    const currentGraph = useHPCStore.getState().graph;
    const computeNodeIds = currentGraph.nodes.filter(n => n.type === 'compute').map(n => n.id);
    let completedNodes = 0;
    let failedNodeId: string | null = null;
    let errorMessage: string | null = null;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph: currentGraph }),
        signal: autopilotAbortController.current?.signal
      });

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let deploymentSucceeded = false;

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
                    } else if (data.status === 'failed') {
                      failedNodeId = data.nodeId;
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
                    errorMessage = data.message;
                    if (data.nodeId) {
                      failedNodeId = data.nodeId;
                      console.log('[Autopilot] Error event received - nodeId:', data.nodeId, 'nodeName:', data.nodeName);
                    } else {
                      console.log('[Autopilot] Error event received WITHOUT nodeId - message:', data.message);
                    }
                    addConsoleLog({
                      type: 'error',
                      message: data.message,
                      nodeId: data.nodeId,
                      nodeName: data.nodeName
                    });
                    break;

                  case 'complete':
                    deploymentSucceeded = true;
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
                      message: `Deployment completed successfully`
                    });

                    // Reset autopilot state on success
                    if (autopilotRetryCountRef.current > 0) {
                      addChatMessage({
                        role: 'assistant',
                        content: `Pipeline completed after ${autopilotRetryCountRef.current} fix${autopilotRetryCountRef.current === 1 ? '' : 'es'}.`
                      });
                    }
                    setIsAutopilotActive(false);
                    setAutopilotRetryCount(0);
                    autopilotRetryCountRef.current = 0;
                    setCurrentFixingNode(null);
                    setIsRunning(false);
                    setCurrentDeploymentType(null);
                    break;
                }
              } catch (e) {
                console.error('Failed to parse SSE data:', e);
              }
              eventType = '';
              eventData = '';
            }
          }
        }
      }

      // Autopilot: If deployment failed, ask user if they want AI to fix
      if (!deploymentSucceeded && failedNodeId && errorMessage) {
        // Check stop flag
        if (stopAutopilotRef.current) {
          stopAutopilotRef.current = false;
          setIsAutopilotActive(false);
          setAutopilotRetryCount(0);
          setCurrentFixingNode(null);
          addChatMessage({
            role: 'assistant',
            content: 'Autopilot stopped.'
          });
          setIsRunning(false);
          setCurrentDeploymentType(null);
          return;
        }

        // Use ref for accurate count in recursive calls
        if (autopilotRetryCountRef.current >= autopilotMaxRetries) {
          addChatMessage({
            role: 'assistant',
            content: `Autopilot reached max attempts (${autopilotMaxRetries}). Manual fix required.`
          });
          addNotification({
            type: 'error',
            title: 'Autopilot Stopped',
            message: `Could not fix after ${autopilotMaxRetries} attempts`
          });
          setIsRunning(false);
          setCurrentDeploymentType(null);
          setIsAutopilotActive(false);
          setAutopilotRetryCount(0);
          autopilotRetryCountRef.current = 0;
          setCurrentFixingNode(null);
          return;
        }

        const failedNode = currentGraph.nodes.find(n => n.id === failedNodeId);
        const nodeName = failedNode?.name || failedNodeId;

        // If this is the first failure (not already in autopilot mode), ask the user
        if (!isRetry && autopilotRetryCountRef.current === 0) {
          // Store the error info and show the prompt
          setPendingAutopilotError({
            failedNodeId,
            nodeName,
            errorMessage
          });
          setShowAutopilotPrompt(true);
          setIsRunning(false);
          setCurrentDeploymentType(null);
          return;
        }

        // If user already approved autopilot (isRetry), continue with the fix cycle
        setIsAutopilotActive(true);
        setCurrentFixingNode(nodeName);
        // Increment ref first, then update state for UI
        autopilotRetryCountRef.current += 1;
        const currentAttempt = autopilotRetryCountRef.current;
        setAutopilotRetryCount(currentAttempt);

        addChatMessage({
          role: 'assistant',
          content: `**Autopilot** fixing \`${nodeName}\`\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\n(Attempt ${currentAttempt}/${autopilotMaxRetries})`
        });

        // Call the fix API - use fresh graph from store in case code was already updated
        const freshGraph = useHPCStore.getState().graph;
        const fixResult = await fixFailedNode(failedNodeId, errorMessage, freshGraph);

        // Check stop flag again after API call
        if (stopAutopilotRef.current) {
          stopAutopilotRef.current = false;
          setIsAutopilotActive(false);
          setAutopilotRetryCount(0);
          autopilotRetryCountRef.current = 0;
          setCurrentFixingNode(null);
          addChatMessage({
            role: 'assistant',
            content: 'Autopilot stopped.'
          });
          setIsRunning(false);
          setCurrentDeploymentType(null);
          return;
        }

        if (fixResult.success && fixResult.fixedCode) {
          console.log('[Autopilot] Applying fix to node:', failedNodeId, 'nodeName:', nodeName);
          console.log('[Autopilot] Fixed code (first 200 chars):', fixResult.fixedCode.substring(0, 200));
          
          // Apply the fix to the store
          updateNodeCode(failedNodeId, fixResult.fixedCode);
          
          // Wait a tick to ensure Zustand store has updated
          await new Promise(resolve => setTimeout(resolve, 50));
          
          // Verify the fix was applied
          const verifyGraph = useHPCStore.getState().graph;
          const verifyNode = verifyGraph.nodes.find(n => n.id === failedNodeId);
          console.log('[Autopilot] Verified node code after update (first 200 chars):', verifyNode?.code?.substring(0, 200));
          
          // Check if the code actually changed
          if (verifyNode?.code === fixResult.fixedCode) {
            console.log('[Autopilot] ✓ Code successfully updated in store');
          } else {
            console.error('[Autopilot] ✗ Code update FAILED - store has different code!');
            console.error('[Autopilot] Expected:', fixResult.fixedCode.substring(0, 100));
            console.error('[Autopilot] Got:', verifyNode?.code?.substring(0, 100));
          }

          addChatMessage({
            role: 'assistant',
            content: `**Fixed** \`${nodeName}\`\n\n${fixResult.analysis}${fixResult.fixDescription ? `\n\n${fixResult.fixDescription}` : ''}\n\nRetrying deployment...`
          });

          setCurrentFixingNode(null);
          setIsRunning(false);

          // Small delay before retry to let React update
          await new Promise(resolve => setTimeout(resolve, 500));

          // Always retry locally for faster iteration (even if original was cloud deployment)
          await runWithAutopilot('/api/deploy-local', 'Deploy Locally', true);
        } else {
          addChatMessage({
            role: 'assistant',
            content: `Could not fix \`${nodeName}\` automatically.\n\n${fixResult.analysis || 'Unable to determine fix.'}\n\nPlease fix manually.`
          });
          setIsAutopilotActive(false);
          setAutopilotRetryCount(0);
          autopilotRetryCountRef.current = 0;
          setCurrentFixingNode(null);
          setIsRunning(false);
          setCurrentDeploymentType(null);
        }
        return;
      }

    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        addChatMessage({
          role: 'assistant',
          content: 'Deployment cancelled.'
        });
        setIsAutopilotActive(false);
        setAutopilotRetryCount(0);
        autopilotRetryCountRef.current = 0;
        setCurrentFixingNode(null);
      } else {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        computeNodeIds.forEach(nodeId => updateNodeStatus(nodeId, 'failed'));
        addConsoleLog({
          type: 'error',
          message: `Execution error: ${errMsg}`
        });
        addNotification({
          type: 'error',
          title: 'Execution Error',
          message: errMsg
        });
      }
      setIsRunning(false);
      setCurrentDeploymentType(null);
    }
  }, [
    isRunning, autopilotMaxRetries,
    setIsRunning, setRunProgress, resetAllStatuses, updateNodeStatus,
    updateNodeCode, addNotification, updateNodeCsvData, clearNodeCsvData, removeNodeFile,
    addConsoleLog, clearConsoleLogs, addChatMessage, lintComputeNodes, fixFailedNode
  ]);

  // Stop Autopilot handler
  const handleStopAutopilot = useCallback(() => {
    stopAutopilotRef.current = true;
    setIsAutopilotActive(false);
    setAutopilotRetryCount(0);
    autopilotRetryCountRef.current = 0;
    setCurrentFixingNode(null);
    if (autopilotAbortController.current) {
      autopilotAbortController.current.abort();
    }
    addChatMessage({
      role: 'assistant',
      content: 'Autopilot stopped by user.'
    });
  }, [addChatMessage]);

  // Accept Autopilot prompt - user wants AI to fix the error
  const handleAcceptAutopilot = useCallback(async () => {
    if (!pendingAutopilotError) return;

    const { failedNodeId, nodeName, errorMessage } = pendingAutopilotError;

    // Hide the prompt
    setShowAutopilotPrompt(false);
    setPendingAutopilotError(null);

    // Start the autopilot cycle
    setIsAutopilotActive(true);
    setCurrentFixingNode(nodeName);
    autopilotRetryCountRef.current = 1;
    setAutopilotRetryCount(1);

    addChatMessage({
      role: 'assistant',
      content: `**Autopilot** fixing \`${nodeName}\`\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\n(Attempt 1/${autopilotMaxRetries})`
    });

    // Call the fix API
    const freshGraph = useHPCStore.getState().graph;
    const fixResult = await fixFailedNode(failedNodeId, errorMessage, freshGraph);

    if (fixResult.success && fixResult.fixedCode) {
      console.log('[Autopilot] Applying fix to node:', failedNodeId, 'nodeName:', nodeName);
      updateNodeCode(failedNodeId, fixResult.fixedCode);

      await new Promise(resolve => setTimeout(resolve, 50));

      addChatMessage({
        role: 'assistant',
        content: `**Fixed** \`${nodeName}\`\n\n${fixResult.analysis}${fixResult.fixDescription ? `\n\n${fixResult.fixDescription}` : ''}\n\nRetrying deployment...`
      });

      setCurrentFixingNode(null);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Continue with autopilot cycle
      await runWithAutopilot('/api/deploy-local', 'Deploy Locally', true);
    } else {
      addChatMessage({
        role: 'assistant',
        content: `Could not fix \`${nodeName}\` automatically.\n\n${fixResult.analysis || 'Unable to determine fix.'}\n\nPlease fix manually.`
      });
      setIsAutopilotActive(false);
      setAutopilotRetryCount(0);
      autopilotRetryCountRef.current = 0;
      setCurrentFixingNode(null);
    }
  }, [pendingAutopilotError, autopilotMaxRetries, addChatMessage, updateNodeCode, fixFailedNode, runWithAutopilot]);

  // Decline Autopilot prompt - user wants to fix manually
  const handleDeclineAutopilot = useCallback(() => {
    setShowAutopilotPrompt(false);
    setPendingAutopilotError(null);
    addChatMessage({
      role: 'assistant',
      content: 'Autopilot declined. You can fix the error manually in the code editor.'
    });
  }, [addChatMessage]);

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
    await runWithAutopilot('/api/deploy-batch', 'Pipeline Executed (AWS)', false, 'cloud');
  }, [runWithAutopilot]);

  const handleRunLocal = useCallback(async () => {
    await runWithAutopilot('/api/deploy-local', 'Local Test Complete', false, 'local');
  }, [runWithAutopilot]);

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
    setUploadProgress(0);

    try {
      for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
        const file = files[fileIdx];
        
        // Only accept CSV and ZIP files
        if (!file.name.endsWith('.csv') && !file.name.endsWith('.zip')) {
          addNotification({
            type: 'error',
            title: 'Invalid File Type',
            message: `${file.name} - Only CSV and ZIP files are supported`
          });
          continue;
        }

        // Upload to AWS using XMLHttpRequest for progress tracking
        const uploadStartTime = Date.now();
        const uploadCompleteProgress = .7; // Cap upload at 70%

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const uploadFormData = new FormData();
          uploadFormData.append('file', file);

          // Track upload progress (0-70%)
          xhr.upload.addEventListener('progress', (e: ProgressEvent) => {
            if (e.lengthComputable) {
              const uploadPercent = (e.loaded / e.total) * 100;
              // Scale to 0-70% and account for file index
              const scaledProgress = (uploadPercent / files.length) * uploadCompleteProgress;
              const fileOffsetProgress = (fileIdx / files.length) * uploadCompleteProgress;
              setUploadProgress(Math.round(fileOffsetProgress + scaledProgress));
            }
          });

          xhr.addEventListener('load', async () => {
            if (xhr.status === 200) {
              try {
                const uploadData = JSON.parse(xhr.responseText);
                
                // Mark upload as complete, set to 70%
                setUploadProgress(uploadCompleteProgress);

                // Check if this is a ZIP file response (multiple files) or single file
                if (uploadData.files && Array.isArray(uploadData.files)) {
                  // ZIP file - multiple CSVs extracted
                  const analysisStartTime = Date.now();
                  
                  for (let idx = 0; idx < uploadData.files.length; idx++) {
                    const uploadedFile = uploadData.files[idx];
                    
                    // Estimate analysis progress (70-100%)
                    const analysisFraction = (idx / uploadData.files.length) * 30;
                    setUploadProgress(Math.round(uploadCompleteProgress + analysisFraction));

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
                  setUploadProgress(Math.round(uploadCompleteProgress + 15)); // 85% during analysis
                  
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

                // Complete this file's upload
                setUploadProgress(Math.round(((fileIdx + 1) / files.length) * 100));
                resolve();
              } catch (error) {
                reject(error);
              }
            } else {
              try {
                const uploadData = JSON.parse(xhr.responseText);
                reject(new Error(uploadData.error || 'Failed to upload file'));
              } catch {
                reject(new Error('Upload failed'));
              }
            }
          });

          xhr.addEventListener('error', () => {
            reject(new Error('Upload failed'));
          });

          xhr.open('POST', '/api/upload');
          xhr.send(uploadFormData);
        });
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'File Error',
        message: error instanceof Error ? error.message : 'Failed to process file'
      });
    } finally {
      setUploadingNodeId(null);
      setUploadProgress(0);
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

  // Simple hash function for caching analysis
  const hashString = useCallback((str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }, []);

  // Generate a cache key based on output node data and graph structure
  const getAnalysisCacheKey = useCallback((nodeId: string, csvData: string, graphNodes: any[]) => {
    // Include node ID, csv data hash, and relevant graph structure
    const graphHash = hashString(JSON.stringify(graphNodes.map(n => ({
      id: n.id,
      name: n.name,
      type: n.type,
      in: n.in,
      out: n.out,
      code: n.code
    }))));
    const dataHash = hashString(csvData || '');
    return `analysis-${nodeId}-${graphHash}-${dataHash}`;
  }, [hashString]);

  // Analyze output when output node is selected
  const analyzeOutput = useCallback(async (forceRefresh = false) => {
    if (!selectedNode || selectedNode.type !== 'output-file') return;

    const outputData = selectedNode.csvData || '';
    const cacheKey = getAnalysisCacheKey(selectedNode.id, outputData, graph.nodes);

    // Check localStorage cache first (unless forcing refresh)
    if (!forceRefresh) {
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const { analysis, timestamp } = JSON.parse(cached);
          // Use cache if it exists (no expiration for now)
          setOutputAnalysis(analysis);
          return;
        }
      } catch (e) {
        // Ignore cache errors
      }
    }

    setAnalysisLoading(true);
    setOutputAnalysis(null);

    try {
      const response = await fetch('/api/analyze-output', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graph,
          outputNodeId: selectedNode.id,
          outputData
        })
      });

      if (response.ok) {
        const data = await response.json();
        setOutputAnalysis(data.analysis);
        
        // Cache the result
        try {
          localStorage.setItem(cacheKey, JSON.stringify({
            analysis: data.analysis,
            timestamp: Date.now()
          }));
        } catch (e) {
          // Ignore storage errors (quota exceeded, etc.)
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setOutputAnalysis(null);
        addNotification({
          type: 'error',
          title: 'Analysis Failed',
          message: errorData.message || 'Could not analyze output'
        });
      }
    } catch (error) {
      setOutputAnalysis(null);
      addNotification({
        type: 'error',
        title: 'Analysis Error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setAnalysisLoading(false);
    }
  }, [selectedNode, graph, addNotification, getAnalysisCacheKey]);

  // Auto-analyze when output node is selected and has data
  useEffect(() => {
    if (selectedNode?.type === 'output-file' && (selectedNode.csvData || (selectedNode.files && selectedNode.files.length > 0))) {
      // Auto-analyze on first load of new output node (will use cache if available)
      analyzeOutput();
    } else {
      setOutputAnalysis(null);
    }
  }, [selectedNode?.id, selectedNode?.csvData]);

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
                    {uploadingNodeId === selectedNodeId ? (
                      <div className="file-upload-progress">
                        <div className="progress-bar-wrapper">
                          <div className="progress-bar-background">
                            <div 
                              className="progress-bar-fill"
                              style={{ width: `${uploadProgress}%` }}
                            />
                          </div>
                          <span className="progress-text">Uploading...</span>
                        </div>
                      </div>
                    ) : (
                      <>
                        <label className="file-upload-btn">
                          <Upload size={14} />
                          <span>Upload Files</span>
                          <input
                            type="file"
                            accept=".csv,.zip"
                            multiple
                            onChange={handleFileUpload}
                            disabled={uploadingNodeId !== null}
                            style={{ display: 'none' }}
                          />
                        </label>
                        <span className="file-upload-hint">CSV or ZIP files</span>
                      </>
                    )}
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

                {/* AI Output Analysis - Full width section below CSV */}
                {(outputAnalysis || analysisLoading) && (
                  <div className={`output-analysis-inline ${analysisExpanded ? 'expanded' : 'collapsed'}`}>
                    <button 
                      className="analysis-inline-header"
                      onClick={() => setAnalysisExpanded(!analysisExpanded)}
                    >
                      <Sparkles size={16} className="sparkle-icon" />
                      <span>AI Analysis</span>
                      {analysisLoading && <Loader2 size={14} className="loading-spinner" />}
                      <ChevronDown size={16} className={`toggle-icon ${analysisExpanded ? 'expanded' : ''}`} />
                    </button>
                    {analysisExpanded && (
                      <div className="analysis-inline-content">
                        {analysisLoading ? (
                          <div className="analysis-loading">
                            <Loader2 size={18} className="loading-spinner" />
                            <span>Analyzing pipeline and results...</span>
                          </div>
                        ) : (
                          <div className="analysis-text">
                            {outputAnalysis?.split('\n').map((line, idx) => {
                              if (line.startsWith('**') && line.includes('**', 2)) {
                                const headerText = line.match(/\*\*(.*?)\*\*/)?.[1] || line;
                                return (
                                  <div key={idx} className="analysis-section-header">
                                    {headerText}
                                  </div>
                                );
                              }
                              if (line.trim()) {
                                return (
                                  <p key={idx} className="analysis-paragraph">
                                    {line}
                                  </p>
                                );
                              }
                              return null;
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
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
            className={`btn btn-secondary ${isRunning && currentDeploymentType === 'local' ? 'running' : ''}`}
            onClick={handleRunLocal}
            disabled={isRunning}
            title="Test your scripts locally before deploying to cloud"
          >
            <Play size={16} />
            {isRunning && currentDeploymentType === 'local' && !isAutopilotActive ? 'Testing...' : 'Test Pipeline'}
          </button>
          <button
            className={`btn btn-primary ${isRunning && currentDeploymentType === 'cloud' ? 'running' : ''}`}
            onClick={handleRun}
            disabled={isRunning}
            title="Deploy and run on distributed cloud compute clusters"
          >
            <Play size={16} />
            {isRunning && currentDeploymentType === 'cloud' && !isAutopilotActive ? 'Deploying...' : 'Deploy'}
          </button>
        </div>
      </div>

      {/* Autopilot Prompt - ask user if they want AI to fix */}
      {showAutopilotPrompt && pendingAutopilotError && (
        <div className="autopilot-prompt">
          <div className="autopilot-prompt-content">
            <div className="autopilot-prompt-header">
              <Zap size={18} className="autopilot-icon" />
              <span className="autopilot-prompt-title">Pipeline Error</span>
            </div>
            <div className="autopilot-prompt-body">
              <p className="autopilot-prompt-node">
                <strong>{pendingAutopilotError.nodeName}</strong> failed:
              </p>
              <pre className="autopilot-prompt-error">{pendingAutopilotError.errorMessage}</pre>
              <p className="autopilot-prompt-question">Would you like Autopilot to fix this?</p>
            </div>
            <div className="autopilot-prompt-actions">
              <button
                className="autopilot-prompt-btn autopilot-prompt-btn-yes"
                onClick={handleAcceptAutopilot}
              >
                <Zap size={14} />
                Yes, fix it
              </button>
              <button
                className="autopilot-prompt-btn autopilot-prompt-btn-no"
                onClick={handleDeclineAutopilot}
              >
                No, I'll fix it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Autopilot Toast - floating notification */}
      {isAutopilotActive && (
        <div className="autopilot-toast">
          <div className="autopilot-toast-content">
            <div className="autopilot-toast-header">
              <Zap size={16} className="autopilot-icon" />
              <span className="autopilot-toast-title">Autopilot Active</span>
              <span className="autopilot-toast-count">Attempt {autopilotRetryCount}/{autopilotMaxRetries}</span>
            </div>
            {currentFixingNode && (
              <div className="autopilot-toast-status">
                <Loader2 size={14} className="loading-spinner" />
                <span>Fixing {currentFixingNode}...</span>
              </div>
            )}
            <button
              className="autopilot-toast-stop"
              onClick={handleStopAutopilot}
            >
              <StopCircle size={14} />
              Stop
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
