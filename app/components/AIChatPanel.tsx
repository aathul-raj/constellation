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
  const [streamingMessage, setStreamingMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
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
    setIsStreaming(true);
    setStreamingMessage('');

    const words = text.split(' ');
    let currentIndex = 0;

    const typeNextWord = () => {
      if (currentIndex < words.length) {
        setStreamingMessage(prev => {
          const newText = prev + (currentIndex > 0 ? ' ' : '') + words[currentIndex];
          currentIndex++;
          return newText;
        });
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
          selectedNodeId
        }),
      });

      const data: AIResponse = await res.json();

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

            const fullMessage = data.message || `Updated code for node.${parallelInfo}\n\n\`\`\`python\n${data.code}\n\`\`\``;

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
  }, [graph, selectedNodeId, addChatMessage, updateNodeCode, updateNodeName, updateNodeParallelization, selectNode, streamText]);

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
      <div className="panel-header">
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
