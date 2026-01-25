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

// Helper function to execute a task (handles fan-out for multiple files)
async function executeTaskForFile(
  node: any,
  nodeId: string,
  fileIndex: number,
  specificFile: any | null,
  upstreamNodes: any[],
  deployDir: string,
  deploymentId: string,
  nodeResults: Map<string, any>,
  consoleLogs: Array<{type: string, message: string, nodeId?: string, nodeName?: string}>
) {
  try {
    const scriptPath = join(deployDir, `${nodeId}-task.py`);
    const outputDir = join(deployDir, nodeId, `file-${fileIndex}`);
    mkdirSync(outputDir, { recursive: true });

    // Set up environment variables
    const outputPath = join(outputDir, 'output.csv');

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      BUCKET_NAME: deployDir,
      OUTPUT_PATH: outputPath,
    };

    // Add input paths (absolute paths for local execution)
    upstreamNodes.forEach((upstream: any) => {
      let inputPath: string;

      if (upstream.type === 'input-file' && upstream.files && upstream.files.length > 0) {
        // If specific file is provided, use it; otherwise use first file
        const file = specificFile || upstream.files[0];
        inputPath = join(deployDir, 'inputs', file.id);
      } else {
        // Compute node output
        inputPath = join(deployDir, upstream.id, 'file-0', 'output.csv');
      }

      env[`INPUT_${upstream.id}`] = inputPath;
    });

    // Execute the Python script
    const fileName = specificFile ? specificFile.name : 'default';
    console.log(`[${deploymentId}] Running task for ${node.name} (file: ${fileName})...`);
    consoleLogs.push({
      type: 'info',
      message: `Executing ${node.name}${specificFile ? ` (file: ${fileName})` : ''}...`,
      nodeId: node.id,
      nodeName: node.name
    });

    const { stdout, stderr } = await execFileAsync(PYTHON_VERSION, [scriptPath], {
      env: env as NodeJS.ProcessEnv,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    if (stdout) {
      console.log(`[${deploymentId}] [${node.name}:${fileIndex}] ${stdout}`);
      consoleLogs.push({
        type: 'info',
        message: stdout.trim(),
        nodeId: node.id,
        nodeName: node.name
      });
    }
    if (stderr) {
      console.log(`[${deploymentId}] [${node.name}:${fileIndex}] stderr: ${stderr}`);
      consoleLogs.push({
        type: 'warning',
        message: `stderr: ${stderr.trim()}`,
        nodeId: node.id,
        nodeName: node.name
      });
    }

    // Upload output to S3
    const s3OutputKey = `${nodeId}/file-${fileIndex}/output.csv`;
    await uploadToS3(s3OutputKey, outputPath);
    console.log(`[${deploymentId}] ✓ Uploaded output to S3: s3://${BUCKET_NAME}/${s3OutputKey}`);

    // Store result
    const resultKey = `${nodeId}-${fileIndex}`;
    nodeResults.set(resultKey, { status: 'completed', fileIndex });
    console.log(`[${deploymentId}] ✓ Completed task for ${node.name} (file ${fileIndex})`);
    consoleLogs.push({
      type: 'success',
      message: `Completed successfully`,
      nodeId: node.id,
      nodeName: node.name
    });

    return { nodeId, fileIndex, status: 'completed' };
  } catch (error) {
    console.error(`[${deploymentId}] ✗ Failed to execute ${node.name} (file ${fileIndex}):`, error);
    const resultKey = `${nodeId}-${fileIndex}`;
    nodeResults.set(resultKey, { status: 'failed', error: String(error), fileIndex });
    consoleLogs.push({
      type: 'error',
      message: `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      nodeId: node.id,
      nodeName: node.name
    });
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
    const consoleLogs: Array<{type: string, message: string, nodeId?: string, nodeName?: string}> = [];

    // 1. Generate executable scripts for each compute node
    console.log(`[${deploymentId}] Generating scripts for ${computeNodes.length} compute nodes...`);
    consoleLogs.push({
      type: 'info',
      message: `Generating scripts for ${computeNodes.length} compute nodes...`
    });

    for (const node of computeNodes) {
      try {
        const script = createExecutableScript(node, graph);
        const scriptPath = join(deployDir, `${node.id}-task.py`);
        writeFileSync(scriptPath, script);
        console.log(`[${deploymentId}] ✓ Created script for ${node.name}`);
        consoleLogs.push({
          type: 'success',
          message: `Created script for ${node.name}`,
          nodeId: node.id,
          nodeName: node.name
        });
      } catch (error) {
        console.error(`[${deploymentId}] ✗ Failed to create script for ${node.name}:`, error);
        consoleLogs.push({
          type: 'error',
          message: `Failed to create script for ${node.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          nodeId: node.id,
          nodeName: node.name
        });
        throw error;
      }
    }

    // 1.5 Download input files from S3
    console.log(`[${deploymentId}] Setting up input files...`);
    const inputFileNodes = graph.nodes.filter((n: any) => n.type === 'input-file');

    for (const inputNode of inputFileNodes) {
      if (inputNode.files && inputNode.files.length > 0) {
        try {
          const inputDir = join(deployDir, 'inputs');
          mkdirSync(inputDir, { recursive: true });

          // Download all files for this input node
          for (const file of inputNode.files) {
            const localInputPath = join(inputDir, file.id);

            // Download from S3
            await downloadFromS3(file.id, localInputPath);
            console.log(`[${deploymentId}] ✓ Downloaded input file: ${file.name}`);
          }
        } catch (error) {
          console.error(`[${deploymentId}] ✗ Failed to download input files:`, error);
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
          const node = nodeMap.get(nodeId) as any;
          return node && node.type === 'compute';
        })
      )
      .filter(level => level.length > 0);

    console.log(`[${deploymentId}] Execution plan: ${computeLevels.length} levels, ${computeLevels.map(l => l.length).join(' + ')} jobs per level`);

    // 3. Execute scripts locally level by level
    const nodeResults = new Map();
    let levelIndex = 0;

    for (const level of computeLevels) {
      levelIndex++;

      // Calculate total number of parallel jobs (fan out for multiple input files)
      let totalJobs = 0;
      for (const nodeId of level) {
        const node = nodeMap.get(nodeId) as any;
        if (!node) continue;

        // Check if this node has upstream input-file nodes with multiple files
        const upstreamInputNodes = graph.nodes.filter((n: any) =>
          node.in.includes(n.id) && n.type === 'input-file' && n.files && n.files.length > 0
        );

        if (upstreamInputNodes.length > 0 && upstreamInputNodes[0].files) {
          totalJobs += upstreamInputNodes[0].files.length; // Fan out per file
        } else {
          totalJobs += 1; // Single execution
        }
      }

      console.log(`[${deploymentId}] Executing level ${levelIndex}/${computeLevels.length} (${totalJobs} jobs in parallel)...`);

      // Execute all jobs in this level in parallel (with fan-out for multiple files)
      const levelPromises = level.flatMap((nodeId) => {
        const node = nodeMap.get(nodeId) as any;
        if (!node) return [];

        const upstreamNodes = graph.nodes.filter((n: any) => node.in.includes(n.id));

        // Check if we need to fan out (multiple input files)
        const inputFileNode = upstreamNodes.find((n: any) =>
          n.type === 'input-file' && n.files && n.files.length > 0
        );

        if (inputFileNode && inputFileNode.files && inputFileNode.files.length > 1) {
          // Fan out: create one execution per input file
          return inputFileNode.files.map((file: any, fileIndex: number) =>
            executeTaskForFile(node, nodeId, fileIndex, file, upstreamNodes, deployDir, deploymentId, nodeResults, consoleLogs)
          );
        } else {
          // Single execution
          return [executeTaskForFile(node, nodeId, 0, null, upstreamNodes, deployDir, deploymentId, nodeResults, consoleLogs)];
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
    const outputNodeUpdates: Array<{ nodeId: string; outputFileNodeId: string; csvContent: string; fileName: string }> = [];

    for (const [resultKey, result] of nodeResults) {
      // resultKey format: "${nodeId}-${fileIndex}" but nodeId contains dashes
      // So we use the fileIndex from the result object instead
      const fileIndex = result.fileIndex;
      
      // Extract nodeId by removing the last dash and number
      const lastDashIndex = resultKey.lastIndexOf('-');
      const nodeId = resultKey.substring(0, lastDashIndex);

      const outputPath = join(deployDir, nodeId, `file-${fileIndex}`, 'output.csv');
      if (existsSync(outputPath)) {
        try {
          const content = readFileSync(outputPath, 'utf-8');
          outputFiles[resultKey] = content;

          // The S3 key was already set during upload in executeTaskForFile
          const s3OutputKey = `${nodeId}/file-${fileIndex}/output.csv`;

          // Find output-file nodes that are connected to this compute node
          const outputNodes = graph.nodes.filter((n: any) =>
            n.type === 'output-file' && n.in.includes(nodeId)
          );

          outputNodes.forEach((outputNode: any) => {
            outputNodeUpdates.push({
              nodeId: outputNode.id,
              outputFileNodeId: outputNode.id,
              csvContent: content,
              fileName: `output-${fileIndex}.csv`
            });
          });
        } catch (error) {
          console.error(`[${deploymentId}] Failed to read output for ${resultKey}:`, error);
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
          name: (nodeMap.get(nodeId) as any)?.name || nodeId,
          type: 'compute',
          status: result.status
        })),
        outputFiles,
        outputNodeUpdates,
        consoleLogs,
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
