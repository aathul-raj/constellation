import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { HPCGraph } from '@/app/store/hpc-store';
import { createExecutableScript } from '@/app/utils/code-wrapper';
import { getExecutionLevels } from '@/app/utils/graph-transform';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Configuration
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'hpc-pipeline-bucket';
const PYTHON_VERSION = process.env.PYTHON_VERSION || 'python3.11';

const s3Client = new S3Client({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  } : undefined
});

// Create a temporary directory for outputs
const getTempDir = () => {
  const tempDir = join(process.cwd(), '.tmp', 'deployments');
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to download file from S3
async function downloadFromS3(key: string, destinationPath: string): Promise<void> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      })
    );

    const chunks: Uint8Array[] = [];
    const readable = response.Body as any;

    for await (const chunk of readable) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    writeFileSync(destinationPath, buffer);
  } catch (error) {
    console.error(`Failed to download ${key} from S3:`, error);
    throw error;
  }
}

// Helper to upload file to S3
async function uploadToS3(key: string, filePath: string): Promise<void> {
  try {
    const fileContent = readFileSync(filePath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: fileContent
      })
    );
  } catch (error) {
    console.error(`Failed to upload ${key} to S3:`, error);
    throw error;
  }
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
    const tempDir = getTempDir();
    const deployDir = join(tempDir, deploymentId);
    mkdirSync(deployDir, { recursive: true });

    const nodeMap = new Map(graph.nodes.map((n: any) => [n.id, n]));

    // 1. Generate executable scripts for each compute node
    console.log(`[${deploymentId}] Generating scripts for ${computeNodes.length} compute nodes...`);

    for (const node of computeNodes) {
      try {
        const script = createExecutableScript(node, graph);
        const scriptPath = join(deployDir, `${node.id}-task.py`);
        writeFileSync(scriptPath, script);
        console.log(`[${deploymentId}] ✓ Created script for ${node.name}`);
      } catch (error) {
        console.error(`[${deploymentId}] ✗ Failed to create script for ${node.name}:`, error);
        throw error;
      }
    }

    // 1.5 Download input files from S3
    console.log(`[${deploymentId}] Setting up input files...`);
    const inputFileNodes = graph.nodes.filter((n: any) => n.type === 'input-file');

    for (const inputNode of inputFileNodes) {
      if (inputNode.fileId) {
        try {
          const inputDir = join(deployDir, 'inputs');
          mkdirSync(inputDir, { recursive: true });
          const localInputPath = join(inputDir, inputNode.fileId);

          // Download from S3
          await downloadFromS3(inputNode.fileId, localInputPath);
          console.log(`[${deploymentId}] ✓ Downloaded input file: ${inputNode.fileId}`);
        } catch (error) {
          console.error(`[${deploymentId}] ✗ Failed to download input file ${inputNode.fileId}:`, error);
          throw error;
        }
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

    // 3. Execute scripts locally level by level
    const nodeResults = new Map();
    let levelIndex = 0;

    for (const level of computeLevels) {
      levelIndex++;
      console.log(`[${deploymentId}] Executing level ${levelIndex}/${computeLevels.length} (${level.length} jobs in parallel)...`);

      // Execute all jobs in this level in parallel
      const levelPromises = level.map(async (nodeId) => {
        const node = nodeMap.get(nodeId);
        if (!node) return;

        try {
          const scriptPath = join(deployDir, `${nodeId}-task.py`);
          const outputDir = join(deployDir, nodeId);
          mkdirSync(outputDir, { recursive: true });

          // Set up environment variables
          const upstreamNodes = graph.nodes.filter((n: any) => node.in.includes(n.id));
          const outputPath = join(outputDir, 'output.csv');

          const env = {
            ...process.env,
            BUCKET_NAME: deployDir,
            OUTPUT_PATH: outputPath,
          };

          // Add input paths (absolute paths for local execution)
          upstreamNodes.forEach((upstream: any) => {
            const inputPath = upstream.type === 'input-file' && upstream.fileId
              ? join(deployDir, 'inputs', upstream.fileId)
              : join(deployDir, upstream.id, 'output.csv');
            env[`INPUT_${upstream.id}`] = inputPath;
          });

          // Execute the Python script
          console.log(`[${deploymentId}] Running task for ${node.name}...`);
          const { stdout, stderr } = await execFileAsync(PYTHON_VERSION, [scriptPath], {
            env,
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          });

          if (stdout) console.log(`[${deploymentId}] [${node.name}] ${stdout}`);
          if (stderr) console.log(`[${deploymentId}] [${node.name}] stderr: ${stderr}`);

          // Upload output to S3
          const s3OutputKey = `${node.id}/output.csv`;
          await uploadToS3(s3OutputKey, outputPath);
          console.log(`[${deploymentId}] ✓ Uploaded output to S3: s3://${BUCKET_NAME}/${s3OutputKey}`);

          nodeResults.set(nodeId, { status: 'completed' });
          console.log(`[${deploymentId}] ✓ Completed task for ${node.name}`);

          return { nodeId, status: 'completed' };
        } catch (error) {
          console.error(`[${deploymentId}] ✗ Failed to execute ${node.name}:`, error);
          nodeResults.set(nodeId, { status: 'failed', error: String(error) });
          throw error;
        }
      });

      // Wait for all jobs in this level to complete
      try {
        await Promise.all(levelPromises);
      } catch (error) {
        console.error(`[${deploymentId}] Level ${levelIndex} failed:`, error);
        throw error;
      }

      console.log(`[${deploymentId}] Level ${levelIndex} completed`);
    }

    // 4. Prepare output files and map to output-file nodes
    const outputFiles: { [key: string]: string } = {};
    const outputNodeUpdates: Array<{ nodeId: string; outputFileNodeId: string; csvContent: string }> = [];

    for (const [nodeId, result] of nodeResults) {
      const outputPath = join(deployDir, nodeId, 'output.csv');
      if (existsSync(outputPath)) {
        try {
          const content = readFileSync(outputPath, 'utf-8');
          outputFiles[nodeId] = content;

          // Find output-file nodes that are connected to this compute node
          const outputNodes = graph.nodes.filter((n: any) =>
            n.type === 'output-file' && n.in.includes(nodeId)
          );

          outputNodes.forEach((outputNode: any) => {
            outputNodeUpdates.push({
              nodeId: outputNode.id,
              outputFileNodeId: outputNode.id,
              csvContent: content
            });
          });
        } catch (error) {
          console.error(`[${deploymentId}] Failed to read output for ${nodeId}:`, error);
        }
      }
    }

    console.log(`[${deploymentId}] ✓ Deployment completed successfully`);

    return NextResponse.json(
      {
        deploymentId,
        status: 'completed',
        message: 'Deployment completed successfully (local execution)',
        nodes: Array.from(nodeResults.entries()).map(([nodeId, result]) => ({
          id: nodeId,
          name: nodeMap.get(nodeId)?.name || nodeId,
          type: 'compute',
          status: result.status
        })),
        outputFiles,
        outputNodeUpdates,
        tempDir: deployDir,
        timestamp: new Date().toISOString()
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Local deployment error:', error);
    return NextResponse.json(
      {
        error: 'Deployment failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
