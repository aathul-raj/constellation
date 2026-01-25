import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { BatchClient, SubmitJobCommand, DescribeJobsCommand } from '@aws-sdk/client-batch';
import { HPCGraph } from '@/app/store/hpc-store';
import { createExecutableScript } from '@/app/utils/code-wrapper';
import { getExecutionLevels } from '@/app/utils/graph-transform';

// AWS Configuration
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'hpc-pipeline-bucket';
const BATCH_JOB_DEFINITION_ARN = process.env.BATCH_JOB_DEFINITION_ARN || 'arn:aws:batch:us-east-1:123456789012:job-definition/hpc-compute-job';
const BATCH_QUEUE_NAME = process.env.BATCH_QUEUE_NAME || 'default';

// Initialize AWS clients
const s3Client = new S3Client({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  } : undefined
});

const batchClient = new BatchClient({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  } : undefined
});

// Helper to sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Poll job status until completion
async function waitForJobCompletion(jobId: string, maxWaitMs: number = 3600000): Promise<string> {
  const startTime = Date.now();
  const pollInterval = 5000; // 5 seconds

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await batchClient.send(
        new DescribeJobsCommand({
          jobs: [jobId]
        })
      );

      const job = response.jobs?.[0];
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      const status = job.status;

      if (status === 'SUCCEEDED') {
        return 'completed';
      } else if (status === 'FAILED') {
        throw new Error(`Job ${jobId} failed: ${job.statusReason || 'Unknown error'}`);
      } else if (status === 'RUNNING' || status === 'RUNNABLE' || status === 'SUBMITTED' || status === 'PENDING' || status === 'STARTING') {
        // Still running, wait and retry
        await sleep(pollInterval);
        continue;
      } else {
        throw new Error(`Job ${jobId} reached unexpected status: ${status}`);
      }
    } catch (error) {
      throw error;
    }
  }

  throw new Error(`Job ${jobId} did not complete within timeout`);
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

    // Filter only compute nodes
    const computeNodes = graph.nodes.filter((n: any) => n.type === 'compute');

    if (computeNodes.length === 0) {
      return NextResponse.json(
        { error: 'No compute nodes to execute' },
        { status: 400 }
      );
    }

    const deploymentId = crypto.randomUUID();
    const nodeScripts = new Map();
    const nodeMap = new Map(graph.nodes.map((n: any) => [n.id, n]));

    // 1. Generate executable scripts for each compute node and upload to S3
    console.log(`[${deploymentId}] Generating scripts for ${computeNodes.length} compute nodes...`);

    for (const node of computeNodes) {
      try {
        const script = createExecutableScript(node, graph);
        const scriptKey = `scripts/${node.id}/task.py`;

        // Upload to S3
        await s3Client.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: scriptKey,
            Body: script,
            ContentType: 'text/plain'
          })
        );

        nodeScripts.set(node.id, scriptKey);
        console.log(`[${deploymentId}] ✓ Uploaded script for ${node.name} to s3://${BUCKET_NAME}/${scriptKey}`);
      } catch (error) {
        console.error(`[${deploymentId}] ✗ Failed to upload script for ${node.name}:`, error);
        throw error;
      }
    }

    // 2. Get execution levels (topological sort)
    console.log(`[${deploymentId}] Computing execution levels...`);
    const levels = getExecutionLevels(graph);

    // Filter to only compute nodes
    const computeLevels = levels
      .map(level =>
        level.filter(nodeId => {
          const node = nodeMap.get(nodeId);
          return node?.type === 'compute';
        })
      )
      .filter(level => level.length > 0);

    console.log(`[${deploymentId}] Execution plan: ${computeLevels.length} levels, ${computeLevels.map(l => l.length).join(' + ')} jobs per level`);

    // 3. Execute jobs level by level
    const nodeResults = new Map();
    let levelIndex = 0;

    for (const level of computeLevels) {
      levelIndex++;
      console.log(`[${deploymentId}] Executing level ${levelIndex}/${computeLevels.length} (${level.length} jobs in parallel)...`);

      const jobIds: Array<{ nodeId: string; jobId: string }> = [];

      // Submit all jobs in this level in parallel
      for (const nodeId of level) {
        const node = nodeMap.get(nodeId);
        if (!node) continue;

        try {
          const upstreamNodes = graph.nodes.filter((n: any) => node.in.includes(n.id));
          const environment: Array<{ name: string; value: string }> = [
            { name: 'BUCKET_NAME', value: BUCKET_NAME },
            { name: 'OUTPUT_PATH', value: `${node.id}/output.csv` }
          ];

          // Add input paths for each upstream node
          upstreamNodes.forEach((upstream: any) => {
            // Input-file nodes store their data at fileId, compute nodes at {id}/output.csv
            const inputPath = upstream.type === 'input-file' && upstream.fileId
              ? upstream.fileId
              : `${upstream.id}/output.csv`;

            environment.push({
              name: `INPUT_${upstream.id}`,
              value: inputPath
            });
          });

          const response = await batchClient.send(
            new SubmitJobCommand({
              jobName: `${node.id.slice(0, 8)}-${node.name.toLowerCase().replace(/\s+/g, '-')}`,
              jobQueue: BATCH_QUEUE_NAME,
              jobDefinition: BATCH_JOB_DEFINITION_ARN,
              containerOverrides: {
                environment: environment
              }
            })
          );

          const jobId = response.jobId;
          if (jobId) {
            jobIds.push({ nodeId, jobId });
            console.log(`[${deploymentId}] ✓ Submitted job for ${node.name}: ${jobId}`);
          }
        } catch (error) {
          console.error(`[${deploymentId}] ✗ Failed to submit job for ${node.name}:`, error);
          throw error;
        }
      }

      // Wait for all jobs in this level to complete
      console.log(`[${deploymentId}] Waiting for ${jobIds.length} jobs to complete...`);

      for (const { nodeId, jobId } of jobIds) {
        try {
          const status = await waitForJobCompletion(jobId);
          nodeResults.set(nodeId, { status });
          console.log(`[${deploymentId}] ✓ Job completed for node ${nodeId}`);
        } catch (error) {
          console.error(`[${deploymentId}] ✗ Job failed for node ${nodeId}:`, error);
          throw error;
        }
      }

      console.log(`[${deploymentId}] Level ${levelIndex} completed`);
    }

    // 4. Map compute node outputs to output-file nodes
    const outputNodeUpdates: Array<{ nodeId: string; s3Key: string }> = [];

    for (const [nodeId] of nodeResults) {
      const computeNode = nodeMap.get(nodeId);
      if (computeNode) {
        // Find output-file nodes that are connected to this compute node
        const outputNodes = graph.nodes.filter((n: any) =>
          n.type === 'output-file' && n.in.includes(nodeId)
        );

        outputNodes.forEach((outputNode: any) => {
          outputNodeUpdates.push({
            nodeId: outputNode.id,
            s3Key: `${nodeId}/output.csv`
          });
        });
      }
    }

    // 4. Return success response
    console.log(`[${deploymentId}] ✓ Deployment completed successfully`);

    return NextResponse.json(
      {
        deploymentId,
        status: 'completed',
        message: 'Deployment completed successfully',
        nodes: Array.from(nodeResults.entries()).map(([nodeId, result]) => ({
          id: nodeId,
          name: nodeMap.get(nodeId)?.name || nodeId,
          type: 'compute',
          status: result.status
        })),
        nodeScripts: Array.from(nodeScripts.entries()).map(([nodeId, scriptKey]) => ({
          nodeId,
          scriptKey
        })),
        outputNodeUpdates,
        timestamp: new Date().toISOString()
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Deployment error:', error);
    return NextResponse.json(
      {
        error: 'Deployment failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
