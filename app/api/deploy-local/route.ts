import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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

// Stream event helper
function createSSEMessage(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

        // Filter only compute nodes
        const computeNodes = graph.nodes.filter((n: any) => n.type === 'compute');

        if (computeNodes.length === 0) {
          sendEvent('error', { message: 'No compute nodes to execute' });
          controller.close();
          return;
        }

        const deploymentId = crypto.randomUUID();
        const tempDir = getTempDir();
        const deployDir = join(tempDir, deploymentId);
        mkdirSync(deployDir, { recursive: true });

        const nodeMap = new Map(graph.nodes.map((n: any) => [n.id, n]));
        const nodeResults = new Map();
        const consoleLogs: Array<{type: string, message: string, nodeId?: string, nodeName?: string}> = [];

        sendEvent('start', { deploymentId, totalNodes: computeNodes.length });

        // 1. Lint Python code for all compute nodes
        sendEvent('log', { type: 'info', message: `Linting code for ${computeNodes.length} compute nodes...` });

        for (const node of computeNodes) {
          if (!node.code || !node.code.trim()) {
            continue;
          }

          try {
            const completeScript = createExecutableScript(node, graph);
            const lintResponse = await fetch(`${request.nextUrl.origin}/api/lint`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: completeScript })
            });

            const lintResult = await lintResponse.json();

            if (!lintResult.valid) {
              const errorMsg = `Syntax errors in ${node.name}: ${lintResult.errors?.join(', ') || 'Unknown error'}`;
              sendEvent('node-status', { nodeId: node.id, status: 'failed' });
              sendEvent('error', { message: errorMsg });
              controller.close();
              return;
            }
          } catch (error) {
            sendEvent('node-status', { nodeId: node.id, status: 'failed' });
            sendEvent('error', { message: `Lint failed for ${node.name}: ${error instanceof Error ? error.message : 'Unknown error'}` });
            controller.close();
            return;
          }
        }

        // 2. Generate executable scripts for each compute node
        for (const node of computeNodes) {
          try {
            const script = createExecutableScript(node, graph);
            const scriptPath = join(deployDir, `${node.id}-task.py`);
            writeFileSync(scriptPath, script);
          } catch (error) {
            sendEvent('error', { message: `Failed to create script for ${node.name}` });
            controller.close();
            return;
          }
        }

        // 3. Download input files from S3
        const inputFileNodes = graph.nodes.filter((n: any) => n.type === 'input-file');

        for (const inputNode of inputFileNodes) {
          if (inputNode.files && inputNode.files.length > 0) {
            try {
              const inputDir = join(deployDir, 'inputs');
              mkdirSync(inputDir, { recursive: true });

              for (const file of inputNode.files) {
                const localInputPath = join(inputDir, file.id);
                await downloadFromS3(file.id, localInputPath);
              }
            } catch (error) {
              sendEvent('error', { message: `Failed to download input files` });
              controller.close();
              return;
            }
          }
        }

        // 4. Get execution levels (topological sort)
        const levels = getExecutionLevels(graph);
        const computeLevels = levels
          .map(level => level.filter(nodeId => {
            const node = nodeMap.get(nodeId) as any;
            return node && node.type === 'compute';
          }))
          .filter(level => level.length > 0);

        // 5. Execute scripts level by level with real-time status updates
        for (const level of computeLevels) {
          // Set all nodes in this level to "running"
          for (const nodeId of level) {
            const node = nodeMap.get(nodeId) as any;
            if (!node) continue;

            // Check for fan-out
            const upstreamInputNodes = graph.nodes.filter((n: any) =>
              node.in.includes(n.id) && n.type === 'input-file' && n.files && n.files.length > 0
            );

            sendEvent('node-status', { nodeId, status: 'running' });
          }

          // Execute all jobs in this level
          const levelPromises = level.flatMap((nodeId) => {
            const node = nodeMap.get(nodeId) as any;
            if (!node) return [];

            const upstreamNodes = graph.nodes.filter((n: any) => node.in.includes(n.id));
            const inputFileNode = upstreamNodes.find((n: any) =>
              n.type === 'input-file' && n.files && n.files.length > 0
            );

            const executeTask = async (fileIndex: number, specificFile: any | null) => {
              try {
                const scriptPath = join(deployDir, `${nodeId}-task.py`);
                const outputDir = join(deployDir, nodeId, `file-${fileIndex}`);
                mkdirSync(outputDir, { recursive: true });

                const outputPath = join(outputDir, 'output.csv');
                const env: Record<string, string> = {
                  ...process.env as Record<string, string>,
                  BUCKET_NAME: deployDir,
                  OUTPUT_PATH: outputPath,
                };

                upstreamNodes.forEach((upstream: any) => {
                  let inputPath: string;
                  if (upstream.type === 'input-file' && upstream.files && upstream.files.length > 0) {
                    const file = specificFile || upstream.files[0];
                    inputPath = join(deployDir, 'inputs', file.id);
                  } else {
                    inputPath = join(deployDir, upstream.id, 'file-0', 'output.csv');
                  }
                  env[`INPUT_${upstream.id}`] = inputPath;
                });

                const { stdout, stderr } = await execFileAsync(PYTHON_VERSION, [scriptPath], {
                  env: env as NodeJS.ProcessEnv,
                  maxBuffer: 10 * 1024 * 1024,
                });

                if (stdout) {
                  sendEvent('log', { type: 'info', message: stdout.trim(), nodeId, nodeName: node.name });
                }
                if (stderr) {
                  sendEvent('log', { type: 'warning', message: `stderr: ${stderr.trim()}`, nodeId, nodeName: node.name });
                }

                // Upload output to S3
                const s3OutputKey = `${nodeId}/file-${fileIndex}/output.csv`;
                await uploadToS3(s3OutputKey, outputPath);

                const resultKey = `${nodeId}-${fileIndex}`;
                nodeResults.set(resultKey, { status: 'completed', fileIndex });

                return { nodeId, fileIndex, status: 'completed' };
              } catch (error: any) {
                const resultKey = `${nodeId}-${fileIndex}`;
                const errorMessage = error?.message || String(error);
                nodeResults.set(resultKey, { status: 'failed', error: errorMessage, fileIndex });

                // Log stdout/stderr from failed execution (available on exec errors)
                if (error?.stdout) {
                  sendEvent('log', { type: 'info', message: error.stdout.trim(), nodeId, nodeName: node.name });
                }
                if (error?.stderr) {
                  sendEvent('log', { type: 'error', message: error.stderr.trim(), nodeId, nodeName: node.name });
                }

                // Send the error message
                sendEvent('log', { type: 'error', message: `Task failed: ${errorMessage}`, nodeId, nodeName: node.name });

                throw error;
              }
            };

            if (inputFileNode && inputFileNode.files && inputFileNode.files.length > 1) {
              return inputFileNode.files.map((file: any, fileIndex: number) =>
                executeTask(fileIndex, file)
              );
            } else {
              return [executeTask(0, null)];
            }
          });

          // Wait for all jobs in this level and update statuses
          try {
            const results = await Promise.all(levelPromises);
            // Mark completed nodes
            const completedNodeIds = new Set(results.map(r => r.nodeId));
            for (const nodeId of completedNodeIds) {
              sendEvent('node-status', { nodeId, status: 'completed' });
            }
          } catch (error) {
            // Find the actual failed node from results
            let actualFailedNodeId: string | null = null;
            let actualFailedNodeName: string | null = null;
            
            for (const nodeId of level) {
              const resultKey = `${nodeId}-0`;
              const result = nodeResults.get(resultKey);
              if (result && result.status === 'failed') {
                actualFailedNodeId = nodeId;
                actualFailedNodeName = (nodeMap.get(nodeId) as any)?.name || nodeId;
                sendEvent('node-status', { nodeId, status: 'failed' });
                break; // Take the first failed node
              }
            }
            
            // If no specific failure found, mark all incomplete as failed
            if (!actualFailedNodeId) {
              for (const nodeId of level) {
                const resultKey = `${nodeId}-0`;
                const result = nodeResults.get(resultKey);
                if (!result || result.status !== 'completed') {
                  actualFailedNodeId = nodeId;
                  actualFailedNodeName = (nodeMap.get(nodeId) as any)?.name || nodeId;
                  sendEvent('node-status', { nodeId, status: 'failed' });
                  break;
                }
              }
            }
            
            const errorMsg = error instanceof Error ? error.message : 'Execution failed';
            // Send error with the actual failed nodeId so autopilot can fix it
            sendEvent('error', { 
              message: errorMsg,
              nodeId: actualFailedNodeId,
              nodeName: actualFailedNodeName
            });
            controller.close();
            return;
          }
        }

        // 6. Prepare output files
        const outputNodeUpdates: Array<{ nodeId: string; csvContent: string; fileName: string }> = [];

        for (const [resultKey, result] of nodeResults) {
          const fileIndex = result.fileIndex;
          const lastDashIndex = resultKey.lastIndexOf('-');
          const nodeId = resultKey.substring(0, lastDashIndex);

          const outputPath = join(deployDir, nodeId, `file-${fileIndex}`, 'output.csv');
          if (existsSync(outputPath)) {
            try {
              const content = readFileSync(outputPath, 'utf-8');
              const outputNodes = graph.nodes.filter((n: any) =>
                n.type === 'output-file' && n.in.includes(nodeId)
              );

              outputNodes.forEach((outputNode: any) => {
                outputNodeUpdates.push({
                  nodeId: outputNode.id,
                  csvContent: content,
                  fileName: `output-${fileIndex}.csv`
                });
              });
            } catch (error) {
              console.error(`Failed to read output for ${resultKey}:`, error);
            }
          }
        }

        // Send final completion event
        sendEvent('complete', {
          deploymentId,
          status: 'completed',
          outputNodeUpdates,
          consoleLogs
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
