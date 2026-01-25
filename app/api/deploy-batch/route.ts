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
    const nodeMap = new Map(graph.nodes.map((n: any) => [n.id, n] as [string, any]));
    const consoleLogs: Array<{type: string, message: string, nodeId?: string, nodeName?: string}> = [];

    // 0.5 Upload requirements.txt to S3
    console.log(`[${deploymentId}] Uploading dependencies...`);
    consoleLogs.push({
      type: 'info',
      message: 'Uploading dependencies to S3...'
    });
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
      console.log(`[${deploymentId}] ✓ Uploaded requirements to s3://${BUCKET_NAME}/${requirementsKey}`);
      consoleLogs.push({
        type: 'success',
        message: 'Dependencies uploaded successfully'
      });
    } catch (error) {
      console.error(`[${deploymentId}] ✗ Failed to upload requirements:`, error);
      consoleLogs.push({
        type: 'error',
        message: `Failed to upload requirements: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
      throw error;
    }

    // 1. Generate executable scripts for each compute node and upload to S3
    console.log(`[${deploymentId}] Generating scripts for ${computeNodes.length} compute nodes...`);
    consoleLogs.push({
      type: 'info',
      message: `Generating scripts for ${computeNodes.length} compute nodes...`
    });

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
        consoleLogs.push({
          type: 'success',
          message: `Uploaded script for ${node.name}`,
          nodeId: node.id,
          nodeName: node.name
        });
      } catch (error) {
        console.error(`[${deploymentId}] ✗ Failed to upload script for ${node.name}:`, error);
        consoleLogs.push({
          type: 'error',
          message: `Failed to upload script for ${node.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          nodeId: node.id,
          nodeName: node.name
        });
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
          const node = nodeMap.get(nodeId) as any;
          return node && node.type === 'compute';
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
        const node = nodeMap.get(nodeId) as any;
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

          const scriptKey = nodeScripts.get(node.id);

          // Create a Python bootstrap script that installs dependencies, downloads, and executes the task
          const bootstrapScript = `
import subprocess
import sys
import os

try:
    bucket = os.environ.get('BUCKET_NAME', '${BUCKET_NAME}')
    region = os.environ.get('AWS_REGION', '${REGION}')

    # First, install boto3 to access private S3 bucket
    print("Installing boto3...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "boto3"], check=True)

    import boto3
    s3 = boto3.client('s3', region_name=region)

    # Download and install requirements.txt from S3
    print("Downloading requirements from S3...")
    reqs_key = "${requirementsKey}"
    reqs_file = "/tmp/requirements.txt"
    s3.download_file(bucket, reqs_key, reqs_file)

    print("Installing dependencies...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", reqs_file], check=True)
    print("Dependencies installed successfully")

    # Download task script from S3
    print("Downloading task script from S3...")
    script_key = "${scriptKey}"
    task_file = "/tmp/task.py"
    s3.download_file(bucket, script_key, task_file)

    print("Executing task")
    print(f"Environment variables: BUCKET_NAME={bucket}, OUTPUT_PATH={os.environ.get('OUTPUT_PATH')}")
    result = subprocess.run([sys.executable, task_file], check=False)

    print(f"Task exited with code: {result.returncode}")

    if result.returncode != 0:
        print("Task failed!", file=sys.stderr)
        sys.exit(result.returncode)

    # Check if output file exists locally
    output_path = os.environ.get('OUTPUT_PATH', '550e8400-e29b-41d4-a716-446655440001/output.csv')
    if os.path.exists(output_path):
        print(f"Output file found at {output_path}")
        size = os.path.getsize(output_path)
        print(f"Output file size: {size} bytes")
    else:
        print(f"Warning: Output file not found at {output_path}")

    print("Bootstrap completed successfully")
    sys.exit(0)

except Exception as e:
    print(f"Bootstrap error: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc()
    sys.exit(1)
`;

          const command = [
            'python3',
            '-c',
            bootstrapScript
          ];

          const response = await batchClient.send(
            new SubmitJobCommand({
              jobName: `${node.id.slice(0, 8)}-${node.name.toLowerCase().replace(/\s+/g, '-')}`,
              jobQueue: BATCH_QUEUE_NAME,
              jobDefinition: BATCH_JOB_DEFINITION_ARN,
              containerOverrides: {
                environment: environment,
                command: command
              }
            })
          );

          const jobId = response.jobId;
          if (jobId) {
            jobIds.push({ nodeId, jobId });
            console.log(`[${deploymentId}] ✓ Submitted job for ${node.name}: ${jobId}`);
            consoleLogs.push({
              type: 'info',
              message: `Submitted AWS Batch job: ${jobId.slice(0, 8)}...`,
              nodeId: node.id,
              nodeName: node.name
            });
          }
        } catch (error) {
          console.error(`[${deploymentId}] ✗ Failed to submit job for ${node.name}:`, error);
          consoleLogs.push({
            type: 'error',
            message: `Failed to submit job for ${node.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            nodeId: node.id,
            nodeName: node.name
          });
          throw error;
        }
      }

      // Wait for all jobs in this level to complete
      console.log(`[${deploymentId}] Waiting for ${jobIds.length} jobs to complete...`);
      consoleLogs.push({
        type: 'info',
        message: `Waiting for ${jobIds.length} jobs to complete...`
      });

      for (const { nodeId, jobId } of jobIds) {
        try {
          const status = await waitForJobCompletion(jobId);
          nodeResults.set(nodeId, { status });
          const node = nodeMap.get(nodeId) as any;
          console.log(`[${deploymentId}] ✓ Job completed for node ${nodeId}`);
          consoleLogs.push({
            type: 'success',
            message: `Job completed successfully`,
            nodeId: node?.id,
            nodeName: node?.name
          });
        } catch (error) {
          const node = nodeMap.get(nodeId) as any;
          console.error(`[${deploymentId}] ✗ Job failed for node ${nodeId}:`, error);
          consoleLogs.push({
            type: 'error',
            message: `Job failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            nodeId: node?.id,
            nodeName: node?.name
          });
          throw error;
        }
      }

      console.log(`[${deploymentId}] Level ${levelIndex} completed`);
      consoleLogs.push({
        type: 'success',
        message: `Execution level ${levelIndex + 1} completed`
      });
    }

    // 4. Map compute node outputs to output-file nodes
    const outputNodeUpdates: Array<{ nodeId: string; s3Key: string }> = [];

    for (const [nodeId] of nodeResults) {
      const computeNode = nodeMap.get(nodeId) as any;
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
          name: (nodeMap.get(nodeId) as any)?.name || nodeId,
          type: 'compute',
          status: result.status
        })),
        nodeScripts: Array.from(nodeScripts.entries()).map(([nodeId, scriptKey]) => ({
          nodeId,
          scriptKey
        })),
        outputNodeUpdates,
        consoleLogs,
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
