'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { useHPCStore } from '../store/hpc-store';

export default function AIChatPanel() {
  const { chatMessages, addChatMessage, graph, selectedNodeId } = useHPCStore();
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

    // Simulate AI thinking time
    await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700));

    const lowerMessage = userMessage.toLowerCase();
    let response = '';

    // Simple rule-based responses for demonstration
    if (lowerMessage.includes('status') || lowerMessage.includes('progress')) {
      const completed = graph.nodes.filter(n => n.status === 'completed').length;
      const running = graph.nodes.filter(n => n.status === 'running').length;
      const queued = graph.nodes.filter(n => n.status === 'queued').length;
      response = `Pipeline Status:\n- Completed: ${completed}/${graph.nodes.length}\n- Running: ${running}\n- Queued: ${queued}`;
    } else if (lowerMessage.includes('node') || lowerMessage.includes('selected')) {
      if (selectedNodeId) {
        const node = graph.nodes.find(n => n.id === selectedNodeId);
        if (node) {
          response = `Selected: ${node.label}\nType: ${node.type}\nStatus: ${node.status}\nDependencies: ${node.in.length > 0 ? node.in.join(', ') : 'None'}\nOutputs to: ${node.out.length > 0 ? node.out.join(', ') : 'None'}`;
        }
      } else {
        response = 'No node currently selected. Click a node in the graph to inspect it.';
      }
    } else if (lowerMessage.includes('help')) {
      response = `Available commands:\n- Ask about "status" to see pipeline progress\n- Ask about "selected node" for node details\n- Ask about "resources" for cluster info\n- Click "Run Batch" to execute the pipeline`;
    } else if (lowerMessage.includes('resource') || lowerMessage.includes('cluster')) {
      const totalCores = graph.nodes.reduce((sum, n) => sum + (n.resources?.cores || 0), 0);
      const totalGPU = graph.nodes.reduce((sum, n) => sum + (n.resources?.gpu || 0), 0);
      response = `Cluster Resources Required:\n- Total CPU Cores: ${totalCores}\n- Total GPUs: ${totalGPU}\n- Nodes: ${graph.nodes.length}`;
    } else if (lowerMessage.includes('optimize') || lowerMessage.includes('suggest')) {
      response = `Optimization suggestions:\n1. Preprocess nodes can run in parallel\n2. Consider increasing GPU allocation for training\n3. Data ingestion could benefit from parallel I/O`;
    } else {
      response = `I can help you monitor and understand your HPC pipeline. Try asking about:\n- Pipeline status\n- Selected node details\n- Cluster resources\n- Optimization suggestions`;
    }

    addChatMessage({
      role: 'assistant',
      content: response
    });

    setIsTyping(false);
  }, [graph, selectedNodeId, addChatMessage]);

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

  return (
    <div className="chat-panel">
      <div className="panel-header">
        <h2>AI Assistant</h2>
        <span className="status-indicator online">Online</span>
      </div>

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
          placeholder="Ask about the pipeline..."
          disabled={isTyping}
        />
        <button type="submit" disabled={!input.trim() || isTyping}>
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
