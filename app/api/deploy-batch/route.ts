import { NextRequest } from 'next/server';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { BatchClient, SubmitJobCommand, DescribeJobsCommand } from '@aws-sdk/client-batch';
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

// Stream event helper
function createSSEMessage(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Poll job status until completion
async function waitForJobCompletion(
  jobId: string,
  maxWaitMs: number = 3600000
): Promise<{ status: string; error?: string }> {
  const startTime = Date.now();
  const pollInterval = 5000; // 5 seconds

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await batchClient.send(
        new DescribeJobsCommand({ jobs: [jobId] })
      );

      const job = response.jobs?.[0];
      if (!job) {
        return { status: 'failed', error: `Job ${jobId} not found` };
      }

      const status = job.status;

      if (status === 'SUCCEEDED') {
        return { status: 'completed' };
      } else if (status === 'FAILED') {
        return { status: 'failed', error: job.statusReason || 'Unknown error' };
      } else if (['RUNNING', 'RUNNABLE', 'SUBMITTED', 'PENDING', 'STARTING'].includes(status || '')) {
        await sleep(pollInterval);
        continue;
      } else {
        return { status: 'failed', error: `Unexpected status: ${status}` };
      }
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  return { status: 'failed', error: 'Job timed out' };
}

// Fetch file content from S3
async function fetchFromS3(key: string): Promise<string | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
    );
    const chunks: Uint8Array[] = [];
    const readable = response.Body as any;
    for await (const chunk of readable) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch (error) {
    console.error(`Failed to fetch ${key} from S3:`, error);
    return null;
  }
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: any) => {
        controller.enqueue(encoder.encode(createSSEMessage(event, data)));
      };

      try {
        const { graph } = await request.json();

        // Validate graph structure
        if (!graph || !graph.nodes || !Array.isArray(graph.nodes)) {
          sendEvent('error', { message: 'Invalid graph structure' });
          controller.close();
          return;
        }

        const computeNodes = graph.nodes.filter((n: any) => n.type === 'compute');

        if (computeNodes.length === 0) {
          sendEvent('error', { message: 'No compute nodes to execute' });
          controller.close();
          return;
        }

        const deploymentId = crypto.randomUUID();
        const nodeScripts = new Map();
        const nodeMap = new Map(graph.nodes.map((n: any) => [n.id, n] as [string, any]));
        const nodeResults = new Map();

        sendEvent('start', { deploymentId, totalNodes: computeNodes.length });

        // Upload requirements.txt to S3
        sendEvent('log', { type: 'info', message: 'Uploading dependencies to S3...' });
        const requirementsKey = `deployments/${deploymentId}/requirements.txt`;
        const requirementsContent = `pandas>=2.0.0
numpy>=1.24.0
boto3>=1.28.0
pyarrow>=12.0.0`;

        try {
          await s3Client.send(
            new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: requirementsKey,
              Body: requirementsContent,
              ContentType: 'text/plain'
            })
          );
        } catch (error) {
          sendEvent('error', { message: `Failed to upload requirements: ${error instanceof Error ? error.message : 'Unknown error'}` });
          controller.close();
          return;
        }

        // Generate and upload scripts for each compute node
        sendEvent('log', { type: 'info', message: `Generating scripts for ${computeNodes.length} compute nodes...` });

        for (const node of computeNodes) {
          try {
            const script = createExecutableScript(node, graph);
            const scriptKey = `scripts/${node.id}/task.py`;

            await s3Client.send(
              new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: scriptKey,
                Body: script,
                ContentType: 'text/plain'
              })
            );

            nodeScripts.set(node.id, scriptKey);
          } catch (error) {
            sendEvent('node-status', { nodeId: node.id, status: 'failed' });
            sendEvent('error', { message: `Failed to upload script for ${node.name}` });
            controller.close();
            return;
          }
        }

        // Get execution levels
        const levels = getExecutionLevels(graph);
        const computeLevels = levels
          .map(level => level.filter(nodeId => {
            const node = nodeMap.get(nodeId) as any;
            return node && node.type === 'compute';
          }))
          .filter(level => level.length > 0);

        // Execute jobs level by level with real-time status updates
        for (const level of computeLevels) {
          // Mark all nodes in this level as "running"
          for (const nodeId of level) {
            sendEvent('node-status', { nodeId, status: 'running' });
          }

          // Submit all jobs in this level
          const jobSubmissions: Array<{
            nodeId: string;
            fileIndex: number;
            jobId: string;
            promise: Promise<{ status: string; error?: string }>;
          }> = [];

          for (const nodeId of level) {
            const node = nodeMap.get(nodeId) as any;
            if (!node) continue;

            const upstreamNodes = graph.nodes.filter((n: any) => node.in.includes(n.id));
            const scriptKey = nodeScripts.get(node.id);
            if (!scriptKey) continue;

            const inputFileNode = upstreamNodes.find((n: any) =>
              n.type === 'input-file' && n.files && n.files.length > 0
            );

            const fileCount = (inputFileNode?.files?.length > 1) ? inputFileNode.files.length : 1;

            for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
              const environment: Array<{ name: string; value: string }> = [
                { name: 'BUCKET_NAME', value: BUCKET_NAME },
                { name: 'OUTPUT_PATH', value: `${nodeId}/file-${fileIndex}/output.csv` }
              ];

              upstreamNodes.forEach((upstream: any) => {
                let inputPath: string;
                if (upstream.type === 'input-file' && upstream.files && upstream.files.length > 0) {
                  const file = upstream.files[fileIndex] || upstream.files[0];
                  inputPath = file.id;
                } else {
                  inputPath = `${upstream.id}/file-0/output.csv`;
                }
                environment.push({ name: `INPUT_${upstream.id}`, value: inputPath });
              });

              const bootstrapScript = `
import subprocess
import sys
import os

try:
    bucket = os.environ.get('BUCKET_NAME', '${BUCKET_NAME}')
    region = os.environ.get('AWS_REGION', '${REGION}')

    print("Installing boto3...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "boto3"], check=True)

    import boto3
    s3 = boto3.client('s3', region_name=region)

    print("Downloading requirements from S3...")
    reqs_key = "${requirementsKey}"
    reqs_file = "/tmp/requirements.txt"
    s3.download_file(bucket, reqs_key, reqs_file)

    print("Installing dependencies...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", reqs_file], check=True)

    print("Downloading task script from S3...")
    script_key = "${scriptKey}"
    task_file = "/tmp/task.py"
    s3.download_file(bucket, script_key, task_file)

    print("Executing task")
    result = subprocess.run([sys.executable, task_file], check=False)

    if result.returncode != 0:
        sys.exit(result.returncode)

    sys.exit(0)

except Exception as e:
    print(f"Bootstrap error: {e}", file=sys.stderr)
    sys.exit(1)
`;

              try {
                const response = await batchClient.send(
                  new SubmitJobCommand({
                    jobName: `${nodeId.slice(0, 8)}-${node.name.toLowerCase().replace(/\s+/g, '-')}-f${fileIndex}`,
                    jobQueue: BATCH_QUEUE_NAME,
                    jobDefinition: BATCH_JOB_DEFINITION_ARN,
                    containerOverrides: {
                      environment,
                      command: ['python3', '-c', bootstrapScript]
                    }
                  })
                );

                const jobId = response.jobId;
                if (jobId) {
                  jobSubmissions.push({
                    nodeId,
                    fileIndex,
                    jobId,
                    promise: waitForJobCompletion(jobId)
                  });
                  sendEvent('log', { type: 'info', message: `Submitted job for ${node.name}`, nodeId, nodeName: node.name });
                }
              } catch (error) {
                sendEvent('log', { type: 'error', message: `Failed to submit job for ${node.name}: ${error instanceof Error ? error.message : 'Unknown'}`, nodeId, nodeName: node.name });
              }
            }
          }

          // Wait for all jobs in this level to complete
          let levelFailed = false;
          for (const submission of jobSubmissions) {
            const result = await submission.promise;
            const resultKey = `${submission.nodeId}-${submission.fileIndex}`;
            nodeResults.set(resultKey, { status: result.status, fileIndex: submission.fileIndex, jobId: submission.jobId });

            if (result.status === 'failed') {
              levelFailed = true;
              const nodeName = (nodeMap.get(submission.nodeId) as any)?.name || submission.nodeId;
              sendEvent('node-status', { nodeId: submission.nodeId, status: 'failed' });
              sendEvent('log', { type: 'error', message: result.error || 'Job failed', nodeId: submission.nodeId, nodeName });
            }
          }

          // Mark completed nodes
          if (!levelFailed) {
            const completedNodeIds = new Set(jobSubmissions.map(s => s.nodeId));
            for (const nodeId of completedNodeIds) {
              sendEvent('node-status', { nodeId, status: 'completed' });
            }
          } else {
            // Mark remaining nodes as failed and collect names
            const failedNodes: string[] = [];
            for (const nodeId of level) {
              const anyResult = Array.from(nodeResults.entries()).find(([k]) => k.startsWith(nodeId));
              if (!anyResult || anyResult[1].status !== 'completed') {
                sendEvent('node-status', { nodeId, status: 'failed' });
                const nodeName = (nodeMap.get(nodeId) as any)?.name || nodeId;
                failedNodes.push(nodeName);
              }
            }
            const failedNodesMsg = failedNodes.length > 0 ? `: ${failedNodes.join(', ')}` : '';
            sendEvent('error', { message: `One or more jobs failed${failedNodesMsg}` });
            controller.close();
            return;
          }
        }

        // Prepare output files
        const outputNodeUpdates: Array<{ nodeId: string; s3Key: string; fileName: string; csvContent?: string }> = [];

        for (const [resultKey, result] of nodeResults) {
          const fileIndex = result.fileIndex;
          const lastDashIndex = resultKey.lastIndexOf('-');
          const nodeId = resultKey.substring(0, lastDashIndex);

          const computeNode = nodeMap.get(nodeId) as any;
          if (computeNode) {
            const s3OutputKey = `${nodeId}/file-${fileIndex}/output.csv`;
            const outputNodes = graph.nodes.filter((n: any) =>
              n.type === 'output-file' && n.in.includes(nodeId)
            );

            // Fetch the output content from S3
            const csvContent = await fetchFromS3(s3OutputKey);

            outputNodes.forEach((outputNode: any) => {
              outputNodeUpdates.push({
                nodeId: outputNode.id,
                s3Key: s3OutputKey,
                fileName: `output-${fileIndex}.csv`,
                csvContent: csvContent || undefined
              });
            });
          }
        }

        // Send final completion event
        sendEvent('complete', {
          deploymentId,
          status: 'completed',
          outputNodeUpdates
        });

        controller.close();
      } catch (error) {
        sendEvent('error', { message: error instanceof Error ? error.message : 'Unknown error' });
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
