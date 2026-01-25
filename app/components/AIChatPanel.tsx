'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';
import type { AIResponse, NodeCreationIntent, EditNodeIntent, GeneratePipelineIntent } from '../types/intent';
import { validateNodeCreationIntent, extractNodeContext, isReadyForNodeCreation } from '../utils/intent-validator';
import { fixGeneratedCode, extractInputParamName } from '../utils/code-fixer';
import { nodeNameToParamName } from '../utils/signature-generator';

export default function AIChatPanel() {
  const {
    chatMessages,
    addChatMessage,
    graph,
    selectedNodeId,
    setGraph,
    updateNodeCode,
    updateNodeName,
    updateNodeParallelization,
    selectNode,
    createNode,
    connectNodes,
    disconnectNodes,
    updateNodeConnections
  } = useHPCStore();
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingNodeCreation, setPendingNodeCreation] = useState<NodeCreationIntent | null>(null);
  const [pendingPipelineGeneration, setPendingPipelineGeneration] = useState<GeneratePipelineIntent | null>(null);
  const [lastCreatedNodeId, setLastCreatedNodeId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages, streamingMessage]);

  useEffect(() => {
    return () => {
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
      }
    };
  }, []);

  const streamText = useCallback((text: string, callback: () => void) => {
    console.log('[streamText] Text to display:', text);
    setIsStreaming(true);
    setStreamingMessage('');

    const words = text.split(' ');
    let currentIndex = 0;

    const typeNextWord = () => {
      if (currentIndex < words.length) {
        setStreamingMessage(prev => {
          const newText = prev + (prev.length > 0 ? ' ' : '') + words[currentIndex];
          return newText;
        });
        currentIndex++;
      } else {
        if (streamingIntervalRef.current) {
          clearInterval(streamingIntervalRef.current);
          streamingIntervalRef.current = null;
        }
        setIsStreaming(false);
        setStreamingMessage('');
        callback();
      }
    };

    // Type at ~150 words per minute (400ms per word average, randomized)
    streamingIntervalRef.current = setInterval(() => {
      typeNextWord();
    }, 80 + Math.random() * 40);

    return () => {
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
    };
  }, []);

  const generateResponse = useCallback(async (userMessage: string) => {
    setIsTyping(true);

    try {
      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMessage,
          graph,
          selectedNodeId,
          lastCreatedNodeId,
          history: chatMessages.slice(-6).map(m => ({ role: m.role, content: m.content })),
          pendingIntent: pendingNodeCreation || pendingPipelineGeneration
        }),
      });

      const data = await res.json();

      // Check for error response
      if (data.error) {
        const errorMsg = `Error: ${data.error}`;
        streamText(errorMsg, () => {
          addChatMessage({
            role: 'assistant',
            content: errorMsg
          });
        });
        return;
      }

      // Handle different intents
      switch (data.intent) {
        case 'create_node': {
          const nodeData = data as unknown as NodeCreationIntent;

          // If Gemini has already determined completeness, trust it; don't re-validate
          // Re-validation only happens if completeness is undefined (shouldn't happen)
          let validatedIntent = nodeData;
          if (validatedIntent.completeness === undefined) {
            const nodeContext = extractNodeContext(graph);
            validatedIntent = validateNodeCreationIntent(nodeData, nodeContext);
          }

          if (isReadyForNodeCreation(validatedIntent)) {
            // All info available - create the node
            setPendingNodeCreation(null);

            // Resolve parent node ID if only name is provided
            let resolvedParentId = validatedIntent.parentNodeId;
            const parentNode = validatedIntent.parentNodeName && !resolvedParentId
              ? graph.nodes.find(n =>
                  n.name.toLowerCase() === validatedIntent.parentNodeName!.toLowerCase()
                )
              : graph.nodes.find(n => n.id === resolvedParentId);

            if (validatedIntent.parentNodeName && !resolvedParentId && parentNode) {
              resolvedParentId = parentNode.id;
            }

            // Fix generated code if it's a compute node
            let fixedCode = validatedIntent.pythonCode;
            if (validatedIntent.nodeType === 'compute' && fixedCode && parentNode) {
              // Use the same function that generates signatures to ensure consistency
              const inputParamName = nodeNameToParamName(parentNode.name);
              fixedCode = fixGeneratedCode(fixedCode, inputParamName);
            }

            // Create the node (automatically connects to parent)
            const newNodeId = createNode(
              validatedIntent.nodeType!,
              validatedIntent.nodeName!,
              resolvedParentId,
              fixedCode
            );

            // Track the last created node for context in future requests
            setLastCreatedNodeId(newNodeId);

            // Handle connection to child/destination node if specified
            if (validatedIntent.childNodeId || validatedIntent.childNodeName) {
              let targetId = validatedIntent.childNodeId;
              if (!targetId && validatedIntent.childNodeName) {
                 const targetNode = graph.nodes.find(n =>
                   n.name.toLowerCase() === validatedIntent.childNodeName!.toLowerCase()
                 );
                 targetId = targetNode?.id;
              }

              if (targetId) {
                // Logic to handle replacement of existing connection
                if (validatedIntent.replaceExistingConnection && resolvedParentId) {
                   // Remove Direct Connection: Parent -> Target
                   disconnectNodes(resolvedParentId, targetId);
                }
                
                // Connect New Node -> Target
                connectNodes(newNodeId, targetId);
              }
            }

            selectNode(newNodeId);

            const msg = validatedIntent.message ||
              `Created new ${validatedIntent.nodeType} node "${validatedIntent.nodeName}". ${validatedIntent.pythonCode ? 'Code has been generated.' : ''}`;

            streamText(msg, () => {
              addChatMessage({
                role: 'assistant',
                content: msg
              });
            });
          } else {
            // Missing information - ask clarifying questions
            setPendingNodeCreation(validatedIntent);

            const questionsText = validatedIntent.clarifyingQuestions?.join('\n- ') || '';
            const msg = `I can help you create this node. I need a bit more information:\n\n- ${questionsText}`;

            streamText(msg, () => {
              addChatMessage({
                role: 'assistant',
                content: msg
              });
            });
          }
          break;
        }

        case 'update_code': {
          const targetNodeId = data.nodeId || selectedNodeId;
          if (targetNodeId && data.code) {
            // Get the target node to determine input parameter name
            const targetNode = graph.nodes.find(n => n.id === targetNodeId);

            // Fix the generated code to use correct variable references
            let fixedCode = data.code;
            if (targetNode && targetNode.type === 'compute') {
              // Determine the expected input parameter name
              // This comes from the parent node name converted to a valid Python identifier
              const parentNode = targetNode.in.length > 0
                ? graph.nodes.find(n => n.id === targetNode.in[0])
                : null;

              // Use the same function that generates signatures to ensure consistency
              const inputParamName = parentNode
                ? nodeNameToParamName(parentNode.name)
                : 'input';

              // Apply code fixes
              fixedCode = fixGeneratedCode(data.code, inputParamName);
            }

            updateNodeCode(targetNodeId, fixedCode);

            // Update parallelization metadata if provided
            if (data.parallelization) {
              updateNodeParallelization(targetNodeId, data.parallelization);
            }

            // Select the node so user can see the change
            if (targetNodeId !== selectedNodeId) {
              selectNode(targetNodeId);
            }

            // Format message with parallelization info
            const parallelInfo = data.parallelization
              ? `\n\n**Parallelization**: ${data.parallelization.strategy} (${data.parallelization.estimatedCores || 'auto'} cores)`
              : '';

            const fullMessage = data.message || `Updated code for node.${parallelInfo}\n\n\`\`\`python\n${fixedCode}\n\`\`\``;

            streamText(fullMessage, () => {
              addChatMessage({
                role: 'assistant',
                content: fullMessage
              });
            });
          } else {
            const msg = data.message || 'Please select a compute node first.';
            streamText(msg, () => {
              addChatMessage({
                role: 'assistant',
                content: msg
              });
            });
          }
          break;
        }

        case 'update_name': {
          const targetNodeId = data.nodeId || selectedNodeId;
          if (targetNodeId && data.name) {
            updateNodeName(targetNodeId, data.name);
            const msg = data.message || `Renamed node to "${data.name}".`;
            streamText(msg, () => {
              addChatMessage({
                role: 'assistant',
                content: msg
              });
            });
          }
          break;
        }

        case 'edit_node': {
          const targetNodeId = data.nodeId || selectedNodeId;
          const targetNode = targetNodeId ? graph.nodes.find(n => n.id === targetNodeId) : null;

          if (!targetNode) {
            const msg = 'Please select a node to edit or specify which node you want to modify.';
            streamText(msg, () => {
              addChatMessage({
                role: 'assistant',
                content: msg
              });
            });
            break;
          }

          // Handle connection changes if specified
          const resolveConnectionIds = (connections?: string[]) =>
            connections
              ?.map((connId) => {
                const connNode = graph.nodes.find(
                  n => n.id === connId || n.name.toLowerCase() === connId.toLowerCase()
                );
                return connNode?.id;
              })
              .filter((id): id is string => id !== undefined);

          const resolvedNewIn = resolveConnectionIds(data.newInConnections);
          const resolvedNewOut = resolveConnectionIds(data.newOutConnections);
          const resolvedAddIn = resolveConnectionIds(data.addInConnections);
          const resolvedAddOut = resolveConnectionIds(data.addOutConnections);
          const resolvedRemoveIn = resolveConnectionIds(data.removeInConnections);
          const resolvedRemoveOut = resolveConnectionIds(data.removeOutConnections);

          if (resolvedNewIn !== undefined || resolvedNewOut !== undefined) {
            // Replace connections only when explicitly provided
            updateNodeConnections(targetNodeId, resolvedNewIn, resolvedNewOut);
          }

          if (resolvedAddIn?.length) {
            resolvedAddIn.forEach((sourceId) => connectNodes(sourceId, targetNodeId));
          }

          if (resolvedAddOut?.length) {
            resolvedAddOut.forEach((targetId) => connectNodes(targetNodeId, targetId));
          }

          if (resolvedRemoveIn?.length) {
            resolvedRemoveIn.forEach((sourceId) => disconnectNodes(sourceId, targetNodeId));
          }

          if (resolvedRemoveOut?.length) {
            resolvedRemoveOut.forEach((targetId) => disconnectNodes(targetNodeId, targetId));
          }

          // Handle code changes if specified
          if (data.newCode && targetNode.type === 'compute') {
            // Determine the input parameter name from parent nodes
            const parentNode = targetNode.in.length > 0
              ? graph.nodes.find(n => n.id === targetNode.in[0])
              : null;

            const inputParamName = parentNode
              ? nodeNameToParamName(parentNode.name)
              : 'input';

            // Fix the generated code to use correct variable references
            const fixedCode = fixGeneratedCode(data.newCode, inputParamName);
            updateNodeCode(targetNodeId, fixedCode);
          }

          // Update parallelization if provided
          if (data.parallelization) {
            updateNodeParallelization(targetNodeId, data.parallelization);
          }

          const msg = data.message || `Updated node "${targetNode.name}".`;
          streamText(msg, () => {
            addChatMessage({
              role: 'assistant',
              content: msg
            });
          });

          // Select the edited node so user can see the changes
          if (targetNodeId !== selectedNodeId) {
            selectNode(targetNodeId);
          }
          break;
        }

        case 'generate_pipeline': {
          const pipelineData = data as GeneratePipelineIntent;

          if (pipelineData.completeness === 'needs_clarification') {
            // Store pending pipeline for follow-up
            setPendingPipelineGeneration(pipelineData);
            setPendingNodeCreation(null);

            // Build clarification message
            let clarifyMsg = pipelineData.understoodSoFar
              ? `**Understood so far:** ${pipelineData.understoodSoFar}\n\n`
              : '';

            if (pipelineData.clarifyingQuestions?.length) {
              clarifyMsg += `**I need a bit more information:**\n\n`;
              clarifyMsg += pipelineData.clarifyingQuestions.map(q => `- ${q}`).join('\n');
            }

            const msg = clarifyMsg || pipelineData.message || 'I need more information to build your pipeline.';

            streamText(msg, () => {
              addChatMessage({
                role: 'assistant',
                content: msg
              });
            });
          } else if ((pipelineData.completeness === 'ready_to_generate' || pipelineData.completeness === 'complete') && pipelineData.nodes && pipelineData.edges) {
            // Debug: Log what the AI returned
            console.log('[Pipeline Generation] Received from AI:', {
              nodes: pipelineData.nodes.map(n => ({ tempId: n.tempId, name: n.name, type: n.type })),
              edges: pipelineData.edges
            });

            // Clear pending state
            setPendingPipelineGeneration(null);
            setPendingNodeCreation(null);

            // Build everything in a single atomic operation to avoid stale state
            let workingNodes: typeof graph.nodes = [...graph.nodes];

            // Step 1: Apply deletions first
            if (pipelineData.deleteNodeIds?.length || pipelineData.deleteNodeNames?.length) {
              const deleteIds = new Set<string>(pipelineData.deleteNodeIds || []);
              (pipelineData.deleteNodeNames || []).forEach((name) => {
                const match = workingNodes.find(n => n.name.toLowerCase() === name.toLowerCase());
                if (match) deleteIds.add(match.id);
              });

              if (deleteIds.size > 0) {
                workingNodes = workingNodes
                  .filter(n => !deleteIds.has(n.id))
                  .map(n => ({
                    ...n,
                    in: n.in.filter(id => !deleteIds.has(id)),
                    out: n.out.filter(id => !deleteIds.has(id))
                  }));
              }
            }

            // Create a mapping from tempId to actual nodeId
            const tempIdToActualId = new Map<string, string>();
            const nodeIdMap = new Map<string, string>();

            const selectedInputNode = selectedNodeId
              ? workingNodes.find(n => n.id === selectedNodeId && n.type === 'input-file')
              : undefined;
            const singleInputNode = workingNodes.filter(n => n.type === 'input-file');
            const defaultInputNode = !selectedInputNode && singleInputNode.length === 1
              ? singleInputNode[0]
              : undefined;

            // Pre-map common input tempIds to existing input nodes
            const fallbackInputNode = selectedInputNode || defaultInputNode;
            if (fallbackInputNode) {
              ['input_1', 'input', 'existing_input', 'data_input'].forEach(tempId => {
                tempIdToActualId.set(tempId, fallbackInputNode.id);
                nodeIdMap.set(tempId, fallbackInputNode.id);
              });
            }

            // Pre-map all existing nodes by their ID and name for easy lookup
            workingNodes.forEach(n => {
              nodeIdMap.set(n.id, n.id);
              nodeIdMap.set(n.name.toLowerCase(), n.id);
            });

            // Helper to resolve any reference (tempId, actual ID, or name) to actual ID
            const resolveNodeRef = (ref?: string): string | undefined => {
              if (!ref) return undefined;
              // Check our maps first
              if (nodeIdMap.has(ref)) return nodeIdMap.get(ref);
              if (tempIdToActualId.has(ref)) return tempIdToActualId.get(ref);
              // Direct ID match
              const directMatch = workingNodes.find(n => n.id === ref);
              if (directMatch) return directMatch.id;
              // Case-insensitive name match
              const nameMatch = workingNodes.find(n => n.name.toLowerCase() === ref.toLowerCase());
              if (nameMatch) return nameMatch.id;
              // Partial name match
              const partialMatch = workingNodes.find(n => 
                n.name.toLowerCase().includes(ref.toLowerCase()) ||
                ref.toLowerCase().includes(n.name.toLowerCase())
              );
              if (partialMatch) return partialMatch.id;
              return undefined;
            };

            // Step 2: Create all new nodes
            for (const nodeSpec of pipelineData.nodes) {
              if (nodeSpec.type === 'input-file') {
                const existingInput = resolveNodeRef(nodeSpec.name) || selectedInputNode?.id || defaultInputNode?.id;
                if (existingInput) {
                  tempIdToActualId.set(nodeSpec.tempId, existingInput);
                  nodeIdMap.set(nodeSpec.tempId, existingInput);
                  continue;
                }
              }

              // Check if this node already exists (by name)
              const existingByName = workingNodes.find(n => n.name.toLowerCase() === nodeSpec.name.toLowerCase());
              if (existingByName) {
                tempIdToActualId.set(nodeSpec.tempId, existingByName.id);
                nodeIdMap.set(nodeSpec.tempId, existingByName.id);
                continue;
              }

              // Generate a new node ID
              const actualId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
              tempIdToActualId.set(nodeSpec.tempId, actualId);
              nodeIdMap.set(nodeSpec.tempId, actualId);

              // Create the node object
              workingNodes.push({
                id: actualId,
                name: nodeSpec.name,
                type: nodeSpec.type,
                status: 'queued',
                code: nodeSpec.pythonCode || (nodeSpec.type === 'compute'
                  ? `def task(in_df):\n    import numpy as np\n    import pandas as pd\n\n    # Your code here\n    \n    return in_df`
                  : ''
                ),
                in: [],
                out: [],
                parallelization: nodeSpec.parallelization
              });
            }

            // Step 3: Apply editNodes (now that new nodes exist and are mapped)
            if (pipelineData.editNodes?.length) {
              for (const edit of pipelineData.editNodes) {
                const targetId = edit.nodeId 
                  ? resolveNodeRef(edit.nodeId)
                  : resolveNodeRef(edit.nodeName);
                if (!targetId) {
                  console.warn('[Pipeline Edit] Could not find target node:', edit.nodeId || edit.nodeName);
                  continue;
                }

                const targetNode = workingNodes.find(n => n.id === targetId);
                if (!targetNode) continue;

                // Handle connection replacements
                if (edit.newInConnections !== undefined) {
                  const newIn = edit.newInConnections
                    .map(ref => resolveNodeRef(ref))
                    .filter((id): id is string => id !== undefined);
                  // Update source nodes' out arrays
                  workingNodes.forEach(n => {
                    if (n.out.includes(targetId) && !newIn.includes(n.id)) {
                      n.out = n.out.filter(id => id !== targetId);
                    }
                  });
                  newIn.forEach(sourceId => {
                    const sourceNode = workingNodes.find(n => n.id === sourceId);
                    if (sourceNode && !sourceNode.out.includes(targetId)) {
                      sourceNode.out = [...sourceNode.out, targetId];
                    }
                  });
                  targetNode.in = newIn;
                }

                if (edit.newOutConnections !== undefined) {
                  const newOut = edit.newOutConnections
                    .map(ref => resolveNodeRef(ref))
                    .filter((id): id is string => id !== undefined);
                  // Update target nodes' in arrays
                  workingNodes.forEach(n => {
                    if (n.in.includes(targetId) && !newOut.includes(n.id)) {
                      n.in = n.in.filter(id => id !== targetId);
                    }
                  });
                  newOut.forEach(destId => {
                    const destNode = workingNodes.find(n => n.id === destId);
                    if (destNode && !destNode.in.includes(targetId)) {
                      destNode.in = [...destNode.in, targetId];
                    }
                  });
                  targetNode.out = newOut;
                }

                // Handle connection additions
                if (edit.addInConnections?.length) {
                  for (const ref of edit.addInConnections) {
                    const sourceId = resolveNodeRef(ref);
                    if (sourceId && !targetNode.in.includes(sourceId)) {
                      targetNode.in = [...targetNode.in, sourceId];
                      const sourceNode = workingNodes.find(n => n.id === sourceId);
                      if (sourceNode && !sourceNode.out.includes(targetId)) {
                        sourceNode.out = [...sourceNode.out, targetId];
                      }
                    }
                  }
                }

                if (edit.addOutConnections?.length) {
                  for (const ref of edit.addOutConnections) {
                    const destId = resolveNodeRef(ref);
                    if (destId && !targetNode.out.includes(destId)) {
                      targetNode.out = [...targetNode.out, destId];
                      const destNode = workingNodes.find(n => n.id === destId);
                      if (destNode && !destNode.in.includes(targetId)) {
                        destNode.in = [...destNode.in, targetId];
                      }
                    }
                  }
                }

                // Handle connection removals
                if (edit.removeInConnections?.length) {
                  for (const ref of edit.removeInConnections) {
                    const sourceId = resolveNodeRef(ref);
                    if (sourceId) {
                      targetNode.in = targetNode.in.filter(id => id !== sourceId);
                      const sourceNode = workingNodes.find(n => n.id === sourceId);
                      if (sourceNode) {
                        sourceNode.out = sourceNode.out.filter(id => id !== targetId);
                      }
                    }
                  }
                }

                if (edit.removeOutConnections?.length) {
                  for (const ref of edit.removeOutConnections) {
                    const destId = resolveNodeRef(ref);
                    if (destId) {
                      targetNode.out = targetNode.out.filter(id => id !== destId);
                      const destNode = workingNodes.find(n => n.id === destId);
                      if (destNode) {
                        destNode.in = destNode.in.filter(id => id !== targetId);
                      }
                    }
                  }
                }

                // Handle code update
                if (edit.newCode && targetNode.type === 'compute') {
                  const parentNode = targetNode.in.length > 0
                    ? workingNodes.find(n => n.id === targetNode.in[0])
                    : null;
                  const inputParamName = parentNode
                    ? nodeNameToParamName(parentNode.name)
                    : 'input';
                  targetNode.code = fixGeneratedCode(edit.newCode, inputParamName);
                }

                if (edit.parallelization) {
                  targetNode.parallelization = edit.parallelization;
                }
              }
            }

            // Step 4: Create all edges
            console.log('[Pipeline Generation] Creating edges:', {
              edges: pipelineData.edges,
              nodeIdMap: Object.fromEntries(nodeIdMap),
              tempIdToActualId: Object.fromEntries(tempIdToActualId)
            });

            for (const edge of pipelineData.edges) {
              const sourceId = resolveNodeRef(edge.from);
              const targetId = resolveNodeRef(edge.to);

              console.log(`[Pipeline Generation] Edge ${edge.from} -> ${edge.to}:`, {
                sourceId,
                targetId
              });

              if (sourceId && targetId) {
                const sourceNode = workingNodes.find(n => n.id === sourceId);
                const targetNode = workingNodes.find(n => n.id === targetId);

                if (sourceNode && !sourceNode.out.includes(targetId)) {
                  sourceNode.out = [...sourceNode.out, targetId];
                }
                if (targetNode && !targetNode.in.includes(sourceId)) {
                  targetNode.in = [...targetNode.in, sourceId];
                }
              } else {
                console.error(`[Pipeline Generation] FAILED to resolve edge: ${edge.from} -> ${edge.to}`, {
                  sourceId,
                  targetId,
                  availableNodes: workingNodes.map(n => ({ id: n.id, name: n.name }))
                });
              }
            }

            // Step 5: Fix code references
            for (const nodeSpec of pipelineData.nodes) {
              if (nodeSpec.type === 'compute' && nodeSpec.pythonCode) {
                const actualId = nodeIdMap.get(nodeSpec.tempId);
                const nodeToUpdate = actualId ? workingNodes.find(n => n.id === actualId) : undefined;

                if (nodeToUpdate) {
                  const incomingEdges = pipelineData.edges.filter(e => e.to === nodeSpec.tempId);
                  if (incomingEdges.length > 0) {
                    const parentRef = incomingEdges[0].from;
                    const parentSpec = pipelineData.nodes.find(n => n.tempId === parentRef);

                    let inputParamName = 'input';
                    if (parentSpec) {
                      inputParamName = nodeNameToParamName(parentSpec.name);
                    } else {
                      const existingParentId = resolveNodeRef(parentRef);
                      const existingParent = existingParentId
                        ? workingNodes.find(n => n.id === existingParentId)
                        : undefined;

                      if (existingParent) {
                        inputParamName = nodeNameToParamName(existingParent.name);
                      }
                    }

                    nodeToUpdate.code = fixGeneratedCode(nodeSpec.pythonCode, inputParamName);
                  }
                }
              }
            }

            // Step 6: Apply the complete graph update atomically
            console.log('[Pipeline Generation] Final graph state:', {
              totalNodes: workingNodes.length,
              nodesWithConnections: workingNodes.filter(n => n.in.length > 0 || n.out.length > 0).length,
              nodeDetails: workingNodes.map(n => ({ id: n.id, name: n.name, in: n.in, out: n.out }))
            });

            setGraph({
              ...graph,
              nodes: workingNodes
            });

            // Build success message
            let successMsg = pipelineData.message || `**Pipeline Created: ${pipelineData.pipelineName}**\n\n`;

            if (pipelineData.pipelineDescription) {
              successMsg += `${pipelineData.pipelineDescription}\n\n`;
            }

            if (pipelineData.parallelizationPlan) {
              successMsg += `**Parallelization:** ${pipelineData.parallelizationPlan.description}\n`;
              successMsg += `- Pattern: ${pipelineData.parallelizationPlan.pattern}\n`;
              if (pipelineData.parallelizationPlan.numPartitions) {
                successMsg += `- Partitions: ${pipelineData.parallelizationPlan.numPartitions}\n`;
              }
            }

            if (pipelineData.estimatedPerformance) {
              successMsg += `\n**Estimated Performance:** ${pipelineData.estimatedPerformance}`;
            }

            streamText(successMsg, () => {
              addChatMessage({
                role: 'assistant',
                content: successMsg
              });
            });

            // Select the first compute node for visibility (more useful than input)
            const firstComputeNode = pipelineData.nodes.find(n => n.type === 'compute');
            const firstInputNode = pipelineData.nodes.find(n => n.type === 'input-file');
            const nodeToSelect = firstComputeNode || firstInputNode;
            if (nodeToSelect) {
              const actualId = tempIdToActualId.get(nodeToSelect.tempId);
              if (actualId) {
                selectNode(actualId);
              }
            }
          } else {
            const msg = pipelineData.message || 'I need a bit more information to build your pipeline.';
            streamText(msg, () => {
              addChatMessage({
                role: 'assistant',
                content: msg
              });
            });
          }
          break;
        }

        case 'chat':
        default:
          const msg = data.message || 'I understood your request but have no specific action to take.';
          streamText(msg, () => {
            addChatMessage({
              role: 'assistant',
              content: msg
            });
          });
          break;
      }
    } catch (error) {
      const errorMsg = 'Failed to connect to AI service. Please try again.';
      streamText(errorMsg, () => {
        addChatMessage({
          role: 'assistant',
          content: errorMsg
        });
      });
    } finally {
      setIsTyping(false);
    }
  }, [
    graph,
    selectedNodeId,
    lastCreatedNodeId,
    chatMessages,
    pendingNodeCreation,
    pendingPipelineGeneration,
    addChatMessage,
    setGraph,
    updateNodeCode,
    updateNodeName,
    updateNodeParallelization,
    selectNode,
    createNode,
    connectNodes,
    disconnectNodes,
    updateNodeConnections,
    streamText
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMessage = input.trim();
    setInput('');

    addChatMessage({
      role: 'user',
      content: userMessage
    });

    await generateResponse(userMessage);
  };

  const selectedNode = selectedNodeId
    ? graph.nodes.find(n => n.id === selectedNodeId)
    : null;

  return (
    <div className="chat-panel">
      <div className="ai-assistant-panel-header">
        <h2>AI Assistant</h2>
        <span className="status-indicator online">Online</span>
      </div>

      {selectedNode && (
        <div className="selected-node-indicator">
          Selected: <strong>{selectedNode.name}</strong> ({selectedNode.type})
        </div>
      )}

      <div className="chat-messages">
        {chatMessages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            <div className="message-icon">
              {message.role === 'assistant' ? (
                <Bot size={16} />
              ) : (
                <User size={16} />
              )}
            </div>
            <div className="message-content">
              <pre>{message.content}</pre>
              <span className="message-time">
                {message.timestamp.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            </div>
          </div>
        ))}
        {isTyping && !isStreaming && (
          <div className="chat-message assistant typing">
            <div className="message-icon">
              <Bot size={16} />
            </div>
            <div className="message-content">
              <Loader2 size={16} className="typing-indicator" />
            </div>
          </div>
        )}
        {isStreaming && streamingMessage && (
          <div className="chat-message assistant">
            <div className="message-icon">
              <Bot size={16} />
            </div>
            <div className="message-content">
              <pre>{streamingMessage}<span className="cursor-blink">▊</span></pre>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            selectedNode?.type === 'compute'
              ? "Describe the task (e.g., 'sort by date', 'filter rows where x > 10')"
              : "Select a compute node to write code, or ask a question..."
          }
          disabled={isTyping}
        />
        <button type="submit" disabled={!input.trim() || isTyping}>
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
