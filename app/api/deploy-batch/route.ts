import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { HPCGraph } from '@/app/store/hpc-store';
import { createExecutableScript } from '@/app/utils/code-wrapper';
import { createStateMachineDefinition } from '@/app/utils/state-machine-generator';

// AWS Configuration
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'hpc-pipeline-bucket';
const BATCH_JOB_DEFINITION_ARN = process.env.BATCH_JOB_DEFINITION_ARN || 'arn:aws:batch:us-east-1:123456789012:job-definition/hpc-compute-job';
const BATCH_QUEUE_NAME = process.env.BATCH_QUEUE_NAME || 'default';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN || 'arn:aws:states:us-east-1:123456789012:stateMachine:hpc-pipeline';

// Initialize AWS clients
const s3Client = new S3Client({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  } : undefined
});

const sfnClient = new SFNClient({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  } : undefined
});

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

    // 2. Create Step Functions state machine definition
    console.log(`[${deploymentId}] Creating state machine definition...`);
    const stateMachineDefinition = createStateMachineDefinition(
      graph,
      BATCH_JOB_DEFINITION_ARN,
      BATCH_QUEUE_NAME,
      BUCKET_NAME
    );

    // 3. Submit to Step Functions
    console.log(`[${deploymentId}] Submitting execution to Step Functions...`);
    const execution = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: `deployment-${deploymentId.slice(0, 8)}`,
        input: JSON.stringify({
          graph,
          bucket: BUCKET_NAME,
          deploymentId
        })
      })
    );

    console.log(`[${deploymentId}] ✓ Execution submitted:`, execution.executionArn);

    return NextResponse.json(
      {
        deploymentId,
        executionArn: execution.executionArn,
        status: 'submitted',
        message: 'Deployment submitted to AWS Step Functions',
        stateMachineDefinition: stateMachineDefinition,
        nodeScripts: Array.from(nodeScripts.entries()).map(([nodeId, scriptKey]) => ({
          nodeId,
          scriptKey
        })),
        timestamp: new Date().toISOString()
      },
      { status: 202 }
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
