'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';

interface AIResponse {
  action?: 'update_code' | 'update_name' | 'chat';
  nodeId?: string;
  code?: string;
  name?: string;
  parallelization?: {
    strategy: 'map' | 'reduce' | 'map-reduce' | 'vectorized' | 'sequential';
    estimatedCores?: number;
    chunkSize?: number;
  };
  message?: string;
  error?: string;
}

export default function AIChatPanel() {
  const {
    chatMessages,
    addChatMessage,
    graph,
    selectedNodeId,
    updateNodeCode,
    updateNodeName,
    updateNodeParallelization,
    selectNode
  } = useHPCStore();
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages]);

  const generateResponse = useCallback(async (userMessage: string) => {
    setIsTyping(true);

    // Check if selected node is a compute node without input metadata
    const node = selectedNodeId ? graph.nodes.find(n => n.id === selectedNodeId) : null;
    if (node?.type === 'compute') {
      const inputNodes = graph.nodes.filter(n => node.in.includes(n.id));
      const hasInputMetadata = inputNodes.some(n => n.fileMetadata);

      if (!hasInputMetadata && inputNodes.length > 0) {
        setIsTyping(false);
        addChatMessage({
          role: 'assistant',
          content: 'Please upload a file to the input node first. I need to know your data structure to generate code.'
        });
        return;
      } else if (inputNodes.length === 0) {
        setIsTyping(false);
        addChatMessage({
          role: 'assistant',
          content: 'This compute node has no input connected. Connect an input-file node to it first.'
        });
        return;
      }
    }

    try {
      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMessage,
          graph,
          selectedNodeId
        }),
      });

      const data: AIResponse = await res.json();

      if (data.error) {
        addChatMessage({
          role: 'assistant',
          content: `Error: ${data.error}`
        });
        return;
      }

      // Handle different actions
      switch (data.action) {
        case 'update_code': {
          const targetNodeId = data.nodeId || selectedNodeId;
          if (targetNodeId && data.code) {
            updateNodeCode(targetNodeId, data.code);

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

            addChatMessage({
              role: 'assistant',
              content: data.message || `Updated code for node.${parallelInfo}\n\n\`\`\`python\n${data.code}\n\`\`\``
            });
          } else {
            addChatMessage({
              role: 'assistant',
              content: data.message || 'Please select a compute node first.'
            });
          }
          break;
        }

        case 'update_name': {
          const targetNodeId = data.nodeId || selectedNodeId;
          if (targetNodeId && data.name) {
            updateNodeName(targetNodeId, data.name);
            addChatMessage({
              role: 'assistant',
              content: data.message || `Renamed node to "${data.name}".`
            });
          }
          break;
        }

        case 'chat':
        default:
          addChatMessage({
            role: 'assistant',
            content: data.message || 'I understood your request but have no specific action to take.'
          });
          break;
      }
    } catch (error) {
      addChatMessage({
        role: 'assistant',
        content: 'Failed to connect to AI service. Please try again.'
      });
    } finally {
      setIsTyping(false);
    }
  }, [graph, selectedNodeId, addChatMessage, updateNodeCode, updateNodeName, updateNodeParallelization, selectNode]);

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

  // Check if selected compute node has input metadata
  const canGenerateCode = selectedNode?.type === 'compute'
    ? (() => {
        const inputNodes = graph.nodes.filter(n => selectedNode.in.includes(n.id));
        return inputNodes.some(n => n.fileMetadata);
      })()
    : true;

  return (
    <div className="chat-panel">
      <div className="panel-header">
        <h2>AI Assistant</h2>
        <span className="status-indicator online">Online</span>
      </div>

      {selectedNode && (
        <div className="selected-node-indicator">
          Selected: <strong>{selectedNode.name}</strong> ({selectedNode.type})
          {selectedNode.type === 'compute' && !canGenerateCode && (
            <span className="warning-badge">⚠ No input data</span>
          )}
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
        {isTyping && (
          <div className="chat-message assistant typing">
            <div className="message-icon">
              <Bot size={16} />
            </div>
            <div className="message-content">
              <Loader2 size={16} className="typing-indicator" />
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
              ? canGenerateCode
                ? "Describe the task (e.g., 'sort by date', 'filter rows where x > 10')"
                : "Upload input file first to generate code"
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
