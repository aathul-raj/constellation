import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type NodeStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface FileMetadata {
  fileName: string;
  fileType: string;
  columns?: string[];
  columnTypes?: Record<string, string>;
  rowCount?: number;
  sampleRows?: Record<string, string>[];
  preview?: string;
  schema?: Record<string, string>;
}

export interface UploadedFile {
  id: string; // S3 file ID
  name: string; // Original file name
  metadata?: FileMetadata; // Analysis of uploaded file
}

export interface HPCNode {
  id: string;
  name: string;
  type: 'input-file' | 'compute' | 'output-file';
  status: NodeStatus;
  code: string;
  in: string[];
  out: string[];
  files?: UploadedFile[]; // Multiple uploaded files (for input-file nodes)
  csvData?: string; // Local CSV data for editing before upload
  fileName?: string; // Original file name
  lastUploadedCsvData?: string; // CSV data that was last uploaded to AWS
  parallelization?: {
    strategy: 'map' | 'reduce' | 'map-reduce' | 'vectorized' | 'sequential';
    estimatedCores?: number; // Suggested number of cores to use
    chunkSize?: number; // For data chunking strategies
  };
}

export interface HPCGraph {
  name: string;
  description: string;
  nodes: HPCNode[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message?: string;
  timestamp: Date;
}

export interface ConsoleLog {
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
  message: string;
  timestamp: Date;
  nodeId?: string;
  nodeName?: string;
  isElapsedUpdate?: boolean; // Flag for elapsed time updates (can be replaced in UI)
}

interface HPCStore {
  graph: HPCGraph;
  selectedNodeId: string | null;
  isRunning: boolean;
  runProgress: number;
  theme: 'dark' | 'light';
  chatMessages: ChatMessage[];
  notifications: Notification[];
  consoleLogs: ConsoleLog[];
  hasConsoleError: boolean;
  currentProjectId: string | null;
  currentProjectName: string | null;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';

  // Actions
  setGraph: (graph: HPCGraph) => void;
  selectNode: (nodeId: string | null) => void;
  updateNodeName: (nodeId: string, name: string) => void;
  updateNodeCode: (nodeId: string, code: string) => void;
  updateNodeStatus: (nodeId: string, status: NodeStatus) => void;
  addNodeFile: (nodeId: string, file: UploadedFile) => void;
  removeNodeFile: (nodeId: string, fileId: string) => void;
  updateNodeCsvData: (nodeId: string, csvData: string, fileName?: string) => void;
  clearNodeCsvData: (nodeId: string) => void;
  markCsvAsUploaded: (nodeId: string) => void;
  updateNodeParallelization: (nodeId: string, parallelization: HPCNode['parallelization']) => void;
  createNode: (nodeType: 'input-file' | 'compute' | 'output-file', nodeName: string, parentNodeId?: string, pythonCode?: string) => string;
  connectNodes: (sourceId: string, targetId: string) => void;
  disconnectNodes: (sourceId: string, targetId: string) => void;
  updateNodeConnections: (nodeId: string, newInConnections?: string[], newOutConnections?: string[]) => void;
  resetAllStatuses: () => void;
  setIsRunning: (running: boolean) => void;
  setRunProgress: (progress: number) => void;
  toggleTheme: () => void;
  addChatMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  setChatMessages: (messages: ChatMessage[]) => void;
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => void;
  removeNotification: (id: string) => void;
  addConsoleLog: (log: Omit<ConsoleLog, 'id' | 'timestamp'>) => void;
  clearConsoleLogs: () => void;
  setHasConsoleError: (hasError: boolean) => void;
  clearStore: () => void;
  setCurrentProject: (projectId: string | null, projectName: string | null) => void;
  setSaveStatus: (status: 'idle' | 'saving' | 'saved' | 'error') => void;
}

// Default input node for new projects
const createDefaultInputNode = (): HPCNode => ({
  id: `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  name: 'Input Data',
  type: 'input-file',
  status: 'queued',
  code: '',
  in: [],
  out: []
});

export const initialGraph: HPCGraph = {
  name: "Data Processing Pipeline",
  description: "Simple data processing workflow with input file, compute task, and output file",
  nodes: [createDefaultInputNode()]
};

export const useHPCStore = create<HPCStore>()(
  persist(
    (set, get) => ({
  graph: initialGraph,
  selectedNodeId: null,
  isRunning: false,
  runProgress: 0,
  theme: 'dark',
  chatMessages: [
    {
      id: '1',
      role: 'assistant',
      content: 'Constellation ready. Select a node to view its job script, modify the graph, or click "Run" to execute the pipeline.',
      timestamp: new Date()
    }
  ],
  notifications: [],
  consoleLogs: [],
  hasConsoleError: false,
  currentProjectId: null,
  currentProjectName: null,
  saveStatus: 'idle',

  setGraph: (graph) => set({ graph }),

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  updateNodeName: (nodeId, name) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, name } : node
      )
    }
  })),

  updateNodeCode: (nodeId, code) => set((state) => {
    // Normalize whitespace: convert tabs to 4 spaces, remove trailing whitespace
    const normalizedCode = code
      .split('\n')
      .map(line => line.replace(/\t/g, '    ').trimEnd())
      .join('\n');
    
    return {
      graph: {
        ...state.graph,
        nodes: state.graph.nodes.map((node) =>
          node.id === nodeId ? { ...node, code: normalizedCode } : node
        )
      }
    };
  }),

  updateNodeStatus: (nodeId, status) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, status } : node
      )
    }
  })),

  addNodeFile: (nodeId, file) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? {
          ...node,
          files: [...(node.files || []), file]
        } : node
      )
    }
  })),

  removeNodeFile: (nodeId, fileId) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? {
          ...node,
          files: (node.files || []).filter(f => f.id !== fileId)
        } : node
      )
    }
  })),

  updateNodeCsvData: (nodeId, csvData, fileName) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, csvData, fileName } : node
      )
    }
  })),

  clearNodeCsvData: (nodeId) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, csvData: undefined, fileName: undefined, lastUploadedCsvData: undefined } : node
      )
    }
  })),

  markCsvAsUploaded: (nodeId) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, lastUploadedCsvData: node.csvData } : node
      )
    }
  })),

  updateNodeParallelization: (nodeId, parallelization) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, parallelization } : node
      )
    }
  })),

  createNode: (nodeType, nodeName, parentNodeId, pythonCode) => {
    const newNodeId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const newNode: HPCNode = {
      id: newNodeId,
      name: nodeName,
      type: nodeType,
      status: 'queued',
      code: pythonCode || (nodeType === 'compute'
        ? `def task(in_df):\n    import numpy as np\n    import pandas as pd\n\n    # Your code here\n    # Example: out_df = in_df.copy()\n    \n    return in_df`
        : ''
      ),
      in: parentNodeId ? [parentNodeId] : [],
      out: []
    };

    set((state) => {
      const updatedNodes = [...state.graph.nodes];

      // Add the new node
      updatedNodes.push(newNode);

      // Update parent node's out array if parent exists
      if (parentNodeId) {
        updatedNodes.forEach((node) => {
          if (node.id === parentNodeId && !node.out.includes(newNodeId)) {
            node.out.push(newNodeId);
          }
        });
      }

      return {
        graph: {
          ...state.graph,
          nodes: updatedNodes
        }
      };
    });

    return newNodeId;
  },

  connectNodes: (sourceId, targetId) => set((state) => {
    const nodes = state.graph.nodes;
    const sourceExists = nodes.some(n => n.id === sourceId);
    const targetExists = nodes.some(n => n.id === targetId);

    if (!sourceExists || !targetExists) return {};

    const updatedNodes = nodes.map(node => {
      if (node.id === sourceId) {
        if (!node.out.includes(targetId)) {
          return { ...node, out: [...node.out, targetId] };
        }
      }
      if (node.id === targetId) {
        if (!node.in.includes(sourceId)) {
          return { ...node, in: [...node.in, sourceId] };
        }
      }
      return node;
    });

    return {
      graph: { ...state.graph, nodes: updatedNodes }
    };
  }),

  disconnectNodes: (sourceId, targetId) => set((state) => {
    const updatedNodes = state.graph.nodes.map(node => {
      if (node.id === sourceId) {
        return { ...node, out: node.out.filter(id => id !== targetId) };
      }
      if (node.id === targetId) {
        return { ...node, in: node.in.filter(id => id !== sourceId) };
      }
      return node;
    });

    return {
      graph: { ...state.graph, nodes: updatedNodes }
    };
  }),

  updateNodeConnections: (nodeId, newInConnections, newOutConnections) => set((state) => {
    const targetNode = state.graph.nodes.find(n => n.id === nodeId);
    if (!targetNode) return {};

    // Validate that all connection IDs exist in the graph
    const validNodeIds = new Set(state.graph.nodes.map(n => n.id));

    let validInConnections = newInConnections;
    let validOutConnections = newOutConnections;

    // Filter out any non-existent node references
    if (newInConnections !== undefined) {
      validInConnections = newInConnections.filter(id => validNodeIds.has(id));
    }
    if (newOutConnections !== undefined) {
      validOutConnections = newOutConnections.filter(id => validNodeIds.has(id));
    }

    // Get old connections to remove them from both sides
    const oldInConnections = targetNode.in || [];
    const oldOutConnections = targetNode.out || [];

    let updatedNodes = [...state.graph.nodes];

    // Update the target node with new connections
    updatedNodes = updatedNodes.map(node => {
      if (node.id === nodeId) {
        const updates: any = { ...node };
        if (validInConnections !== undefined) {
          updates.in = validInConnections;
        }
        if (validOutConnections !== undefined) {
          updates.out = validOutConnections;
        }
        return updates;
      }
      return node;
    });

    // Clean up old outgoing connections (remove nodeId from their 'in' arrays)
    if (validOutConnections !== undefined) {
      updatedNodes = updatedNodes.map(node => {
        if (oldOutConnections.includes(node.id) && !validOutConnections.includes(node.id)) {
          return { ...node, in: node.in.filter(id => id !== nodeId) };
        }
        return node;
      });

      // Add new outgoing connections (add nodeId to their 'in' arrays)
      updatedNodes = updatedNodes.map(node => {
        if (validOutConnections.includes(node.id) && !oldOutConnections.includes(node.id)) {
          return { ...node, in: [...node.in, nodeId] };
        }
        return node;
      });
    }

    // Clean up old incoming connections (remove nodeId from their 'out' arrays)
    if (validInConnections !== undefined) {
      updatedNodes = updatedNodes.map(node => {
        if (oldInConnections.includes(node.id) && !validInConnections.includes(node.id)) {
          return { ...node, out: node.out.filter(id => id !== nodeId) };
        }
        return node;
      });

      // Add new incoming connections (add nodeId to their 'out' arrays)
      updatedNodes = updatedNodes.map(node => {
        if (validInConnections.includes(node.id) && !oldInConnections.includes(node.id)) {
          return { ...node, out: [...node.out, nodeId] };
        }
        return node;
      });
    }

    return {
      graph: { ...state.graph, nodes: updatedNodes }
    };
  }),

  resetAllStatuses: () => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) => ({ ...node, status: 'queued' as NodeStatus }))
    }
  })),

  setIsRunning: (running) => set({ isRunning: running }),

  setRunProgress: (progress) => set({ runProgress: progress }),

  toggleTheme: () => set((state) => ({
    theme: state.theme === 'dark' ? 'light' : 'dark'
  })),

  addChatMessage: (message) => set((state) => ({
    chatMessages: [
      ...state.chatMessages,
      {
        ...message,
        id: crypto.randomUUID(),
        timestamp: new Date()
      }
    ]
  })),

  setChatMessages: (messages) => set({
    chatMessages: messages
  }),

  addNotification: (notification) => set((state) => ({
    notifications: [
      ...state.notifications,
      {
        ...notification,
        id: crypto.randomUUID(),
        timestamp: new Date()
      }
    ]
  })),

  removeNotification: (id) => set((state) => ({
    notifications: state.notifications.filter(n => n.id !== id)
  })),

  addConsoleLog: (log) => set((state) => {
    // For elapsed time updates, replace the previous elapsed update for the same node
    // instead of stacking multiple "Running... (Xs)" messages
    if (log.isElapsedUpdate && log.nodeId) {
      const filteredLogs = state.consoleLogs.filter(
        l => !(l.isElapsedUpdate && l.nodeId === log.nodeId)
      );
      return {
        consoleLogs: [
          ...filteredLogs,
          {
            ...log,
            id: crypto.randomUUID(),
            timestamp: new Date()
          }
        ]
      };
    }

    // Regular log - just append
    return {
      consoleLogs: [
        ...state.consoleLogs,
        {
          ...log,
          id: crypto.randomUUID(),
          timestamp: new Date()
        }
      ]
    };
  }),

  clearConsoleLogs: () => set({
    consoleLogs: []
  }),

  setHasConsoleError: (hasError) => set({
    hasConsoleError: hasError
  }),

  clearStore: () => set({
    graph: initialGraph,
    selectedNodeId: null,
    isRunning: false,
    runProgress: 0,
    chatMessages: [
      {
        id: '1',
        role: 'assistant',
        content: 'Constellation ready. Select a node to view its job script, modify the graph, or click "Run" to execute the pipeline.',
        timestamp: new Date()
      }
    ],
    notifications: [],
    consoleLogs: [],
    hasConsoleError: false,
    currentProjectId: null,
    currentProjectName: null,
    saveStatus: 'idle'
  }),

  setCurrentProject: (projectId, projectName) => set({
    currentProjectId: projectId,
    currentProjectName: projectName,
    saveStatus: 'idle'
  }),

  setSaveStatus: (status) => set({ saveStatus: status })
}),
    {
      name: 'hpc-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        graph: state.graph,
        selectedNodeId: state.selectedNodeId,
        theme: state.theme,
        chatMessages: state.chatMessages,
        currentProjectId: state.currentProjectId,
        currentProjectName: state.currentProjectName,
      }),
      version: 1,
      // Custom merge to handle Date deserialization
      merge: (persistedState: any, currentState: HPCStore) => {
        const mergedState = {
          ...currentState,
          ...persistedState,
        };

        // Convert timestamp strings back to Date objects
        if (mergedState.chatMessages) {
          mergedState.chatMessages = mergedState.chatMessages.map((msg: any) => ({
            ...msg,
            timestamp: typeof msg.timestamp === 'string' ? new Date(msg.timestamp) : msg.timestamp,
          }));
        }

        if (mergedState.notifications) {
          mergedState.notifications = mergedState.notifications.map((notif: any) => ({
            ...notif,
            timestamp: typeof notif.timestamp === 'string' ? new Date(notif.timestamp) : notif.timestamp,
          }));
        }

        return mergedState;
      },
    }
  )
);
