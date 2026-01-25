export type NodeType = 'input-file' | 'compute' | 'output-file';

export type IntentType = 'create_node' | 'update_code' | 'update_name' | 'edit_node' | 'generate_pipeline' | 'chat';

export type CompletionStatus = 'complete' | 'needs_clarification' | 'error';

export interface NodeCreationIntent {
  intent: 'create_node';
  nodeType?: NodeType;
  nodeName?: string;
  parentNodeId?: string;
  parentNodeName?: string;
  childNodeId?: string;      // Existing node to connect TO (optional)
  childNodeName?: string;    // Name of existing node to connect TO (optional)
  replaceExistingConnection?: boolean; // Whether to replace the direct connection between parent and child
  pythonCode?: string;
  completeness: CompletionStatus;
  missingFields?: string[]; // ['nodeType', 'parentNodeId', 'pythonCode']
  clarifyingQuestions?: string[];
  explanation?: string;
  message?: string;
}

export interface UpdateCodeIntent {
  intent: 'update_code';
  nodeId?: string;
  code?: string;
  parallelization?: {
    strategy: 'map' | 'reduce' | 'map-reduce' | 'vectorized' | 'sequential';
    estimatedCores?: number;
    chunkSize?: number;
  };
  message?: string;
}

export interface UpdateNameIntent {
  intent: 'update_name';
  nodeId?: string;
  name?: string;
  message?: string;
}

export interface EditNodeIntent {
  intent: 'edit_node';
  nodeId?: string;
  nodeName?: string;
  // For compute/input/output: which nodes to connect to/from
  newInConnections?: string[]; // Node IDs to connect FROM
  newOutConnections?: string[]; // Node IDs to connect TO
  addInConnections?: string[]; // Node IDs to add as inputs
  addOutConnections?: string[]; // Node IDs to add as outputs
  removeInConnections?: string[]; // Node IDs to remove from inputs
  removeOutConnections?: string[]; // Node IDs to remove from outputs
  // For compute nodes: new code
  newCode?: string;
  parallelization?: {
    strategy: 'map' | 'reduce' | 'map-reduce' | 'vectorized' | 'sequential';
    estimatedCores?: number;
    chunkSize?: number;
  };
  message?: string;
}

export interface ChatIntent {
  intent: 'chat';
  message?: string;
}

// Pipeline generation types for HPC-optimized workflows
export interface PipelineNode {
  tempId: string; // Temporary ID for referencing during generation
  name: string;
  type: NodeType;
  pythonCode?: string;
  parallelization?: {
    strategy: 'map' | 'reduce' | 'map-reduce' | 'vectorized' | 'sequential';
    estimatedCores?: number;
    chunkSize?: number;
  };
  // For parallel executor nodes that share the same script
  scriptGroupId?: string; // Nodes with same scriptGroupId share identical code
}

export interface PipelineEdge {
  from: string; // tempId of source node
  to: string;   // tempId of target node
}

export interface ParallelizationPlan {
  pattern: 'split-execute-reduce' | 'parallel-columns' | 'map-reduce' | 'sequential';
  splitStrategy?: 'row-chunks' | 'column-groups' | 'file-based';
  numPartitions?: number;
  reduceStrategy?: 'concat' | 'merge' | 'aggregate' | 'custom';
  description: string;
}

export interface GeneratePipelineIntent {
  intent: 'generate_pipeline';
  completeness: 'needs_clarification' | 'ready_to_generate';
  // When asking clarifying questions
  clarifyingQuestions?: string[];
  understoodSoFar?: string; // Summary of what the AI understood
  // When ready to generate
  pipelineName?: string;
  pipelineDescription?: string;
  nodes?: PipelineNode[];
  edges?: PipelineEdge[];
  // Optional: integrate with existing graph
  editNodes?: EditNodeIntent[];
  deleteNodeIds?: string[]; // Existing node IDs to delete
  deleteNodeNames?: string[]; // Existing node names to delete
  parallelizationPlan?: ParallelizationPlan;
  estimatedPerformance?: string;
  message?: string;
}

export interface ErrorResponse {
  error: string;
}

export type AIResponse =
  | NodeCreationIntent
  | UpdateCodeIntent
  | UpdateNameIntent
  | EditNodeIntent
  | GeneratePipelineIntent
  | ChatIntent
  | ErrorResponse;
