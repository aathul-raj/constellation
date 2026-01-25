import { NextRequest, NextResponse } from 'next/server';
import { HPCGraph, HPCNode } from '@/app/store/hpc-store';

export interface NodeResult {
  id: string;
  name: string;
  type: HPCNode['type'];
  status: 'completed' | 'failed';
  outputFileId?: string;
  error?: string;
}

export interface DeploymentResult {
  deploymentId: string;
  status: 'completed' | 'failed';
  nodes: NodeResult[];
  timestamp: string;
}

// Calculate execution levels (topological sort)
function getExecutionLevels(graph: HPCGraph): string[][] {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const levels: string[][] = [];

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
      console.warn('Circular dependency detected in graph');
      break;
    }

    currentLevel.forEach(id => remaining.delete(id));
    levels.push(currentLevel);
  }

  return levels;
}

export async function POST(request: NextRequest) {
  try {
    const { graph } = await request.json();

    // Validate graph structure
    if (!graph || !graph.nodes || !Array.isArray(graph.nodes)) {
      return NextResponse.json(
        { error: 'Invalid graph structure' },
        { status: 400 }
      );
    }

    const deploymentId = crypto.randomUUID();
    const nodeMap = new Map(graph.nodes.map((n: HPCNode) => [n.id, n]));
    const nodeResults = new Map<string, NodeResult>();
    const executionLevels = getExecutionLevels(graph);

    // Initialize all nodes as pending
    graph.nodes.forEach((node: HPCNode) => {
      nodeResults.set(node.id, {
        id: node.id,
        name: node.name,
        type: node.type,
        status: 'completed' as const,
        outputFileId: undefined,
        error: undefined
      });
    });

    // Execute nodes level by level
    for (const level of executionLevels) {
      for (const nodeId of level) {
        const node = nodeMap.get(nodeId) as HPCNode | undefined;
        if (!node) continue;

        const result = nodeResults.get(nodeId)!;

        try {
          if (node.type === 'input-file') {
            // Input file node - use the provided fileId
            result.outputFileId = node.fileId || undefined;
            result.status = 'completed';
          } else if (node.type === 'output-file') {
            // Output file node - use the input file from dependencies
            if (node.in.length > 0) {
              const inputNodeId = node.in[0];
              const inputResult = nodeResults.get(inputNodeId);
              if (inputResult?.outputFileId) {
                result.outputFileId = inputResult.outputFileId;
              }
            }
            result.status = 'completed';
          } else if (node.type === 'compute') {
            // Compute node - placeholder for now (just mark as completed)
            // In the future, this will execute the Python code or task
            result.status = 'completed';
            // For now, we'll use the input file as output
            if (node.in.length > 0) {
              const inputNodeId = node.in[0];
              const inputResult = nodeResults.get(inputNodeId);
              if (inputResult?.outputFileId) {
                result.outputFileId = inputResult.outputFileId;
              }
            }
          }
        } catch (error) {
          result.status = 'failed';
          result.error = error instanceof Error ? error.message : 'Unknown error';
        }
      }
    }

    const allNodeResults = Array.from(nodeResults.values());
    const overallStatus =
      allNodeResults.every(n => n.status === 'completed') ? 'completed' : 'failed';

    const response: DeploymentResult = {
      deploymentId,
      status: overallStatus,
      nodes: allNodeResults,
      timestamp: new Date().toISOString()
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error('Deployment error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to deploy pipeline' },
      { status: 500 }
    );
  }
}
