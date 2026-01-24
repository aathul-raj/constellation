import { create } from 'zustand';

export type NodeStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface HPCNode {
  id: string;
  name: string;
  type: 'input-file' | 'compute' | 'output-file';
  status: NodeStatus;
  code: string;
  in: string[];
  out: string[];
  fileId?: string; // S3 file ID for input/output file nodes
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

interface HPCStore {
  graph: HPCGraph;
  selectedNodeId: string | null;
  isRunning: boolean;
  runProgress: number;
  theme: 'dark' | 'light';
  chatMessages: ChatMessage[];
  notifications: Notification[];

  // Actions
  setGraph: (graph: HPCGraph) => void;
  selectNode: (nodeId: string | null) => void;
  updateNodeName: (nodeId: string, name: string) => void;
  updateNodeCode: (nodeId: string, code: string) => void;
  updateNodeStatus: (nodeId: string, status: NodeStatus) => void;
  updateNodeFile: (nodeId: string, fileId: string) => void;
  resetAllStatuses: () => void;
  setIsRunning: (running: boolean) => void;
  setRunProgress: (progress: number) => void;
  toggleTheme: () => void;
  addChatMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => void;
  removeNotification: (id: string) => void;
}

const initialGraph: HPCGraph = {
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
      code: `def task(input_file, output_file):
    pass`,
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

export const useHPCStore = create<HPCStore>((set, get) => ({
  graph: initialGraph,
  selectedNodeId: null,
  isRunning: false,
  runProgress: 0,
  theme: 'dark',
  chatMessages: [
    {
      id: '1',
      role: 'assistant',
      content: 'HPC Orchestrator ready. Select a node to view its job script, or click "Run" to execute the pipeline.',
      timestamp: new Date()
    }
  ],
  notifications: [],

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

  updateNodeFile: (nodeId, fileId) => set((state) => ({
    graph: {
      ...state.graph,
      nodes: state.graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, fileId } : node
      )
    }
  })),

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
  }))
}));
