import { HPCGraph, HPCNode, NodeStatus } from '../store/hpc-store';

export interface ReagraphNode {
  id: string;
  label: string;
  data?: {
    type: string;
    status: NodeStatus;
  };
}

export interface ReagraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface ReagraphData {
  nodes: ReagraphNode[];
  edges: ReagraphEdge[];
}

export function transformToReagraph(graph: HPCGraph): ReagraphData {
  const nodes: ReagraphNode[] = graph.nodes.map((node) => ({
    id: node.id,
    label: node.name,
    data: {
      type: node.type,
      status: node.status
    }
  }));

  const edges: ReagraphEdge[] = [];

  graph.nodes.forEach((node) => {
    node.out.forEach((targetId) => {
      edges.push({
        id: `${node.id}->${targetId}`,
        source: node.id,
        target: targetId
      });
    });
  });

  return { nodes, edges };
}

export function getStatusColor(status: NodeStatus): string {
  switch (status) {
    case 'queued':
      return '#9ca3af'; // Light Gray
    case 'running':
      return '#3b82f6'; // Blue
    case 'completed':
      return '#22c55e'; // Green
    case 'failed':
      return '#ef4444'; // Red
    default:
      return '#9ca3af';
  }
}

export function getNodeTypeIcon(type: HPCNode['type']): string {
  switch (type) {
    case 'input-file':
      return '📥';
    case 'compute':
      return '⚡';
    case 'output-file':
      return '📤';
    default:
      return '●';
  }
}

// Get execution order respecting dependencies (topological sort with levels)
export function getExecutionLevels(graph: HPCGraph): string[][] {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const inDegree = new Map<string, number>();
  const levels: string[][] = [];

  // Initialize in-degrees
  graph.nodes.forEach(node => {
    inDegree.set(node.id, node.in.length);
  });

  // Process nodes level by level
  let remaining = new Set(graph.nodes.map(n => n.id));

  while (remaining.size > 0) {
    const currentLevel: string[] = [];

    remaining.forEach(nodeId => {
      const node = nodeMap.get(nodeId)!;
      const allDepsCompleted = node.in.every(depId => !remaining.has(depId));

      if (allDepsCompleted) {
        currentLevel.push(nodeId);
      }
    });

    if (currentLevel.length === 0 && remaining.size > 0) {
      // Circular dependency detected, break to avoid infinite loop
      console.warn('Circular dependency detected in graph');
      break;
    }

    currentLevel.forEach(id => remaining.delete(id));
    levels.push(currentLevel);
  }

  return levels;
}
