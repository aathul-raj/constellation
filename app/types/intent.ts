export type NodeType = 'input-file' | 'compute' | 'output-file';

export type IntentType = 'create_node' | 'update_code' | 'update_name' | 'chat';

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

export interface ChatIntent {
  intent: 'chat';
  message?: string;
}

export interface ErrorResponse {
  error: string;
}

export type AIResponse =
  | NodeCreationIntent
  | UpdateCodeIntent
  | UpdateNameIntent
  | ChatIntent
  | ErrorResponse;
