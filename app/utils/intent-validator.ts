import { NodeCreationIntent, NodeType } from '@/app/types/intent';

export interface NodeContextInfo {
  nodeCount: number;
  computeNodeNames: string[];
  allNodeNames: string[];
  unconnectedNodes: string[];
  outputNodeExists: boolean;
  inputNodeExists: boolean;
  nodeNameMap: Record<string, string>;
  edgeMap: Record<string, string[]>;
}

/**
 * Validates a node creation intent and returns what's missing
 * Returns the validated intent with completeness status and clarifying questions if needed
 */
export function validateNodeCreationIntent(
  intent: Partial<NodeCreationIntent>,
  context: NodeContextInfo
): NodeCreationIntent {
  const missingFields: string[] = [];
  const clarifyingQuestions: string[] = [];

  // Check node type
  if (!intent.nodeType) {
    missingFields.push('nodeType');
    clarifyingQuestions.push(
      'What type of node do you want to create? (input-file, compute, or output-file)'
    );
  }

  // Check parent node for compute and output nodes
  const nodeType = intent.nodeType as NodeType;
  if (nodeType && nodeType !== 'input-file') {
    if (!intent.parentNodeId && !intent.parentNodeName) {
      if (context.unconnectedNodes.length > 0) {
        // Automatically suggest isolated nodes if they exist (heuristically often better)
        // Check if user mentioned them? If not, we might need clarification.
        // For now, let's trigger clarification but mention them specifically.
        missingFields.push('parentNodeId');
        clarifyingQuestions.push(
          `Which node should this connect from? I see isolated nodes: ${context.unconnectedNodes.join(', ')}`
        );
      } else {
        missingFields.push('parentNodeId');
        if (context.computeNodeNames.length > 0) {
          clarifyingQuestions.push(
            `Which node should this connect from? (Available: ${context.computeNodeNames.join(', ')})`
          );
        } else if (context.inputNodeExists) {
          clarifyingQuestions.push(
            'Which node should this connect from? (You have input nodes available)'
          );
        } else {
          clarifyingQuestions.push('Which node should this connect from?');
        }
      }
    }
  }

  // Check child/destination node for compute nodes
  // NOTE: We only mark childNodeId as missing if the user EXPLICITLY asked about connecting somewhere
  // If they didn't mention destination at all, it's OK for compute nodes to be terminal/unconnected
  // The validator should NOT force this question during clarification responses
  // (Gemini handles asking about destination based on context)

  // Check node name
  if (!intent.nodeName) {
    missingFields.push('nodeName');
    clarifyingQuestions.push(
      `What should this ${nodeType || 'node'} be named?`
    );
  }

  // Check python code for compute nodes
  if (nodeType === 'compute' && !intent.pythonCode) {
    missingFields.push('pythonCode');
    clarifyingQuestions.push(
      `What should this ${intent.nodeName || 'compute'} node do? (Describe the transformation)`
    );
  }

  // Check for existing connection conflict
  if (nodeType === 'compute') {
    // Resolve Parent
    let parentId = intent.parentNodeId;
    if (!parentId && intent.parentNodeName && context.nodeNameMap) {
      parentId = context.nodeNameMap[intent.parentNodeName.toLowerCase()];
    }

    // Resolve Child
    let childId = intent.childNodeId;
    if (!childId && intent.childNodeName && context.nodeNameMap) {
      childId = context.nodeNameMap[intent.childNodeName.toLowerCase()];
    }

    if (parentId && childId && context.edgeMap) {
      const existingEdges = context.edgeMap[parentId] || [];
      if (existingEdges.includes(childId)) {
        // Connection exists!
        if (intent.replaceExistingConnection === undefined) {
           missingFields.push('replaceExistingConnection');
           const pName = intent.parentNodeName || 'Source';
           const cName = intent.childNodeName || 'Destination';
           clarifyingQuestions.push(
             `I see a direct connection between ${pName} and ${cName}. Do you want to calculate this NEW path instead (replace existing) or keep both (parallel path)?`
           );
        }
      }
    }
  }

  const completeness =
    missingFields.length === 0 ? 'complete' : 'needs_clarification';

  return {
    intent: 'create_node',
    nodeType: intent.nodeType,
    nodeName: intent.nodeName,
    parentNodeId: intent.parentNodeId,
    parentNodeName: intent.parentNodeName,
    pythonCode: intent.pythonCode,
    childNodeId: intent.childNodeId,     // Pass through
    childNodeName: intent.childNodeName, // Pass through
    replaceExistingConnection: intent.replaceExistingConnection, // Pass through
    completeness,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
    clarifyingQuestions: clarifyingQuestions.length > 0 ? clarifyingQuestions : undefined,
    explanation: intent.explanation,
    message: intent.message
  };
}

/**
 * Extracts node context from graph for validation
 */
export function extractNodeContext(graph: any): NodeContextInfo {
  const nodes = graph?.nodes || [];

  const computeNodeNames = nodes
    .filter((n: any) => n.type === 'compute')
    .map((n: any) => n.name);
    
  // Also get list of all available node names for more accurate graph awareness
  const allNodeNames = nodes.map((n: any) => n.name);
  const unconnectedNodes = nodes.filter((n: any) => n.in.length === 0 && n.out.length === 0);

  const inputNodeExists = nodes.some((n: any) => n.type === 'input-file');
  const outputNodeExists = nodes.some((n: any) => n.type === 'output-file');

  const nodeNameMap: Record<string, string> = {};
  const edgeMap: Record<string, string[]> = {};

  nodes.forEach((n: any) => {
    nodeNameMap[n.name.toLowerCase()] = n.id;
    edgeMap[n.id] = n.out || [];
  });

  return {
    nodeCount: nodes.length,
    computeNodeNames,
    allNodeNames, // New: full list of nodes
    unconnectedNodes: unconnectedNodes.map((n: any) => n.name), // New: isolated nodes
    inputNodeExists,
    outputNodeExists,
    nodeNameMap,
    edgeMap
  };
}

/**
 * Determines if the intent is ready for node creation
 */
export function isReadyForNodeCreation(intent: NodeCreationIntent): boolean {
  return intent.completeness === 'complete';
}
