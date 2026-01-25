import { HPCNode, HPCGraph } from '@/app/store/hpc-store';
import { getExecutionLevels } from './graph-transform';

/**
 * Generates an AWS Step Functions state machine definition from an HPC graph
 *
 * Creates a DAG where:
 * - Nodes with no inter-dependencies run in parallel
 * - Levels are chained sequentially
 * - Only compute nodes generate Batch tasks
 */
export function createStateMachineDefinition(
  graph: HPCGraph,
  batchJobDefinitionArn: string,
  batchQueue: string,
  bucketName: string
): Record<string, any> {
  const levels = getExecutionLevels(graph);
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  // Filter levels to only include compute nodes (input/output files don't run as tasks)
  const computeLevels = levels
    .map(level =>
      level.filter(nodeId => {
        const node = nodeMap.get(nodeId);
        return node?.type === 'compute';
      })
    )
    .filter(level => level.length > 0);

  if (computeLevels.length === 0) {
    return {
      Comment: 'No compute nodes to execute',
      StartAt: 'NoOp',
      States: {
        NoOp: {
          Type: 'Pass',
          Result: 'No compute nodes in graph',
          End: true
        }
      }
    };
  }

  const states: Record<string, any> = {};

  // Generate states for each level
  for (let i = 0; i < computeLevels.length; i++) {
    const level = computeLevels[i];
    const levelName = `Level${i}`;
    const nextLevel = i < computeLevels.length - 1 ? `Level${i + 1}` : undefined;

    if (level.length === 1) {
      // Single node - use Task state directly
      const nodeId = level[0];
      const node = nodeMap.get(nodeId)!;
      states[levelName] = createTaskState(
        node,
        graph,
        batchJobDefinitionArn,
        batchQueue,
        bucketName,
        nextLevel
      );
    } else {
      // Multiple nodes - use Parallel state
      states[levelName] = createParallelState(
        level,
        graph,
        batchJobDefinitionArn,
        batchQueue,
        bucketName,
        nextLevel
      );
    }
  }

  // Add failure handler state
  states['FailureHandler'] = {
    Type: 'Fail',
    Error: 'ExecutionFailed',
    Cause: 'One or more jobs failed'
  };

  return {
    Comment: `HPC Pipeline DAG: ${graph.name}`,
    StartAt: 'Level0',
    States: states
  };
}

/**
 * Create a Task state for a single compute node
 */
function createTaskState(
  node: HPCNode,
  graph: HPCGraph,
  jobDefinitionArn: string,
  jobQueue: string,
  bucketName: string,
  nextStateName?: string
): Record<string, any> {
  const upstreamNodes = graph.nodes.filter(n => node.in.includes(n.id));
  const environment = buildEnvironmentVariables(node, upstreamNodes, bucketName);

  return {
    Type: 'Task',
    Resource: 'arn:aws:states:::batch:submitJob.sync',
    Parameters: {
      JobName: `${node.id.slice(0, 8)}-${node.name.toLowerCase().replace(/\s+/g, '-')}`,
      JobQueue: jobQueue,
      JobDefinition: jobDefinitionArn,
      ContainerOverrides: {
        Environment: environment
      }
    },
    ...(nextStateName ? { Next: nextStateName } : { End: true }),
    Retry: [
      {
        ErrorEquals: ['States.TaskFailed'],
        IntervalSeconds: 2,
        MaxAttempts: 3,
        BackoffRate: 2.0
      }
    ],
    Catch: [
      {
        ErrorEquals: ['States.ALL'],
        ResultPath: '$.error',
        Next: 'FailureHandler'
      }
    ]
  };
}

/**
 * Create a Parallel state for multiple nodes in the same level
 */
function createParallelState(
  nodeIds: string[],
  graph: HPCGraph,
  jobDefinitionArn: string,
  jobQueue: string,
  bucketName: string,
  nextStateName?: string
): Record<string, any> {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  const branches = nodeIds.map(nodeId => {
    const node = nodeMap.get(nodeId)!;
    const taskName = `Task_${nodeId.slice(0, 8)}`;
    const upstreamNodes = graph.nodes.filter(n => node.in.includes(n.id));
    const environment = buildEnvironmentVariables(node, upstreamNodes, bucketName);

    return {
      StartAt: taskName,
      States: {
        [taskName]: {
          Type: 'Task',
          Resource: 'arn:aws:states:::batch:submitJob.sync',
          Parameters: {
            JobName: `${node.id.slice(0, 8)}-${node.name.toLowerCase().replace(/\s+/g, '-')}`,
            JobQueue: jobQueue,
            JobDefinition: jobDefinitionArn,
            ContainerOverrides: {
              Environment: environment
            }
          },
          End: true,
          Retry: [
            {
              ErrorEquals: ['States.TaskFailed'],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ],
          Catch: [
            {
              ErrorEquals: ['States.ALL'],
              ResultPath: '$.error',
              Next: 'FailureHandler'
            }
          ]
        }
      }
    };
  });

  return {
    Type: 'Parallel',
    Branches: branches,
    ...(nextStateName ? { Next: nextStateName } : { End: true })
  };
}

/**
 * Build environment variables to pass to the Batch job
 *
 * Includes:
 * - BUCKET_NAME: S3 bucket
 * - OUTPUT_PATH: Where this node saves its output
 * - INPUT_{upstream_id}: Where to read each input
 */
function buildEnvironmentVariables(
  node: HPCNode,
  upstreamNodes: HPCNode[],
  bucketName: string
): Array<{ Name: string; Value: string }> {
  const env: Array<{ Name: string; Value: string }> = [
    { Name: 'BUCKET_NAME', Value: bucketName },
    { Name: 'OUTPUT_PATH', Value: `${node.id}/output.csv` }
  ];

  // Add input paths for each upstream node
  upstreamNodes.forEach((upstream) => {
    const envVarName = `INPUT_${upstream.id}`;
    env.push({
      Name: envVarName,
      Value: `${upstream.id}/output.csv`
    });
  });

  return env;
}
