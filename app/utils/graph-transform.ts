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

export function getStatusColor(status: NodeStatus, is3D: boolean = false, isDark: boolean = true): string {
  if (is3D) {
    if (isDark) {
      // Dark mode 3D: High-vibrancy tints to combat 3D shadows
      switch (status) {
        case 'queued': return '#e5e7eb';    // Gray 200
        case 'running': return '#93c5fd';   // Blue 300
        case 'completed': return '#86efac'; // Green 300
        case 'failed': return '#fca5a5';    // Red 300
        default: return '#e5e7eb';
      }
    } else {
      // Light mode 3D: Deeper shades to maintain contrast against white
      switch (status) {
        case 'queued': return '#6b7280';    // Gray 500
        case 'running': return '#2563eb';   // Blue 600
        case 'completed': return '#16a34a'; // Green 600
        case 'failed': return '#dc2626';    // Red 600
        default: return '#6b7280';
      }
    }
  }

  // 2D mode: Adjusted to match the "perceived" brightness of 3D
  if (isDark) {
    switch (status) {
      case 'queued': return '#d1d5db';    // Gray 300 (Lighter than your original)
      case 'running': return '#60a5fa';   // Blue 400 (Softer, glowing feel)
      case 'completed': return '#4ade80'; // Green 400 (Vibrant, matching 3D "lit" green)
      case 'failed': return '#f87171';    // Red 400 (Less "heavy" than original red)
      default: return '#d1d5db';
    }
  } else {
    // 2D Light Mode: Generally matches the 3D Light Mode shades
    switch (status) {
      case 'queued': return '#6b7280';
      case 'running': return '#3b82f6';
      case 'completed': return '#22c55e';
      case 'failed': return '#ef4444';
      default: return '#6b7280';
    }
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
