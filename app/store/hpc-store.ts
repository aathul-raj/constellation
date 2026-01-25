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

export const initialGraph: HPCGraph = {
  name: "Data Processing Pipeline",
  description: "Simple data processing workflow with input file, compute task, and output file",
  nodes: [
    {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Input Data",
      type: "input-file",
      status: "queued",
      code: "",
      in: [],
      out: ["550e8400-e29b-41d4-a716-446655440001"]
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Process Data",
      type: "compute",
      status: "queued",
      code: `def task(in_df):
    import numpy as np
    import pandas as pd

    # Your code here
    out_df = in_df.copy()
    
    # Example transformation
    # out_df['processed'] = True

    return out_df`,
      in: ["550e8400-e29b-41d4-a716-446655440000"],
      out: ["550e8400-e29b-41d4-a716-446655440002"]
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Output Data",
      type: "output-file",
      status: "queued",
      code: "",
      in: ["550e8400-e29b-41d4-a716-446655440001"],
      out: []
    }
  ]
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

  updateNodeCode: (nodeId, code) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, code } : node
      )
    }
  })),

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

  addConsoleLog: (log) => set((state) => ({
    consoleLogs: [
      ...state.consoleLogs,
      {
        ...log,
        id: crypto.randomUUID(),
        timestamp: new Date()
      }
    ]
  })),

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
