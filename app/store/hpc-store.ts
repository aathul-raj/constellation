import { create } from 'zustand';

export type NodeStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface HPCNode {
  id: string;
  label: string;
  type: 'compute' | 'data' | 'io' | 'aggregate';
  status: NodeStatus;
  code: string;
  in: string[];
  out: string[];
  resources?: {
    cores?: number;
    memory?: string;
    gpu?: number;
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

interface HPCStore {
  graph: HPCGraph;
  selectedNodeId: string | null;
  isRunning: boolean;
  runProgress: number;
  theme: 'dark' | 'light';
  chatMessages: ChatMessage[];

  // Actions
  setGraph: (graph: HPCGraph) => void;
  selectNode: (nodeId: string | null) => void;
  updateNodeCode: (nodeId: string, code: string) => void;
  updateNodeStatus: (nodeId: string, status: NodeStatus) => void;
  resetAllStatuses: () => void;
  setIsRunning: (running: boolean) => void;
  setRunProgress: (progress: number) => void;
  toggleTheme: () => void;
  addChatMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
}

const initialGraph: HPCGraph = {
  name: "ML Training Pipeline",
  description: "Distributed machine learning training workflow with data preprocessing and model aggregation",
  nodes: [
    {
      id: "data-ingest",
      label: "Data Ingestion",
      type: "io",
      status: "queued",
      code: `#!/bin/bash
#SBATCH --job-name=data-ingest
#SBATCH --nodes=1
#SBATCH --time=00:30:00

module load python/3.11
python scripts/ingest_data.py --source /data/raw --output /scratch/processed`,
      in: [],
      out: ["preprocess-1", "preprocess-2"],
      resources: { cores: 4, memory: "16GB" }
    },
    {
      id: "preprocess-1",
      label: "Preprocess Shard 1",
      type: "compute",
      status: "queued",
      code: `#!/bin/bash
#SBATCH --job-name=preprocess-1
#SBATCH --nodes=2
#SBATCH --time=01:00:00

module load python/3.11
srun python scripts/preprocess.py --shard 1 --input /scratch/processed`,
      in: ["data-ingest"],
      out: ["train-1"],
      resources: { cores: 32, memory: "64GB" }
    },
    {
      id: "preprocess-2",
      label: "Preprocess Shard 2",
      type: "compute",
      status: "queued",
      code: `#!/bin/bash
#SBATCH --job-name=preprocess-2
#SBATCH --nodes=2
#SBATCH --time=01:00:00

module load python/3.11
srun python scripts/preprocess.py --shard 2 --input /scratch/processed`,
      in: ["data-ingest"],
      out: ["train-2"],
      resources: { cores: 32, memory: "64GB" }
    },
    {
      id: "train-1",
      label: "Train Model A",
      type: "compute",
      status: "queued",
      code: `#!/bin/bash
#SBATCH --job-name=train-1
#SBATCH --nodes=4
#SBATCH --gres=gpu:4
#SBATCH --time=04:00:00

module load cuda/12.0 python/3.11
srun python scripts/train.py --model resnet50 --data /scratch/shard1`,
      in: ["preprocess-1"],
      out: ["aggregate"],
      resources: { cores: 64, memory: "256GB", gpu: 4 }
    },
    {
      id: "train-2",
      label: "Train Model B",
      type: "compute",
      status: "queued",
      code: `#!/bin/bash
#SBATCH --job-name=train-2
#SBATCH --nodes=4
#SBATCH --gres=gpu:4
#SBATCH --time=04:00:00

module load cuda/12.0 python/3.11
srun python scripts/train.py --model transformer --data /scratch/shard2`,
      in: ["preprocess-2"],
      out: ["aggregate"],
      resources: { cores: 64, memory: "256GB", gpu: 4 }
    },
    {
      id: "aggregate",
      label: "Model Aggregation",
      type: "aggregate",
      status: "queued",
      code: `#!/bin/bash
#SBATCH --job-name=aggregate
#SBATCH --nodes=1
#SBATCH --time=00:30:00

module load python/3.11
python scripts/aggregate.py --models /results/model_a,/results/model_b`,
      in: ["train-1", "train-2"],
      out: ["export"],
      resources: { cores: 8, memory: "32GB" }
    },
    {
      id: "export",
      label: "Export Results",
      type: "io",
      status: "queued",
      code: `#!/bin/bash
#SBATCH --job-name=export
#SBATCH --nodes=1
#SBATCH --time=00:15:00

module load python/3.11
python scripts/export.py --model /results/final --dest s3://ml-models/`,
      in: ["aggregate"],
      out: [],
      resources: { cores: 2, memory: "8GB" }
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
      content: 'HPC Orchestrator ready. Select a node to view its job script, or click "Run Batch" to simulate the pipeline execution.',
      timestamp: new Date()
    }
  ],

  setGraph: (graph) => set({ graph }),

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

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
  }))
}));
