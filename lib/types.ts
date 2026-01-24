export interface ClusterMetric {
  cpu?: number;
  memory?: number;
  gpu?: number;
}

export interface ClusterNode {
  id: string;
  label: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  type: 'simulation' | 'storage' | 'gpu' | 'compute' | 'network' | string;
  metrics?: ClusterMetric;
}

export interface ClusterViewProps {
  nodes: ClusterNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}