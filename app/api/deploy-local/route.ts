import { NextRequest } from 'next/server';
import { execFile, spawn } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync, createReadStream, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createExecutableScript } from '@/app/utils/code-wrapper';
import { getExecutionLevels } from '@/app/utils/graph-transform';
import { promisify } from 'util';
import { execSync } from 'child_process';

const execFileAsync = promisify(execFile);

// Size limits
const MAX_S3_UPLOAD_SIZE = 500 * 1024 * 1024; // 500MB - skip S3 upload for larger files
const CLEANUP_THRESHOLD_SIZE = 50 * 1024 * 1024; // 50MB - clean up files above this on new run

// Configuration
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'hpc-pipeline-bucket';
const PYTHON_VERSION = process.env.PYTHON_VERSION || 'python3';

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

// Get available disk space in bytes
const getAvailableDiskSpace = (): number => {
  try {
    // Using `df` command to get available space in the directory
    const result = execSync(`df -b "${process.cwd()}" | tail -1`).toString().split(/\s+/);
    return parseInt(result[3]) * 1024; // Convert blocks to bytes
  } catch {
    return Infinity; // If we can't determine, assume unlimited
  }
};

// Clean up old deployment directories, keeping recent ones
const cleanupOldDeployments = async (keepCount: number = 3) => {
  try {
    const tempDir = getTempDir();
    const deployments = readdirSync(tempDir)
      .map(dir => ({
        name: dir,
        path: join(tempDir, dir),
        time: statSync(join(tempDir, dir)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time);

    // Remove all but the most recent `keepCount` deployments
    for (let i = keepCount; i < deployments.length; i++) {
      try {
        rmSync(deployments[i].path, { recursive: true, force: true });
        console.log(`Cleaned up deployment: ${deployments[i].name}`);
      } catch (error) {
        console.warn(`Failed to cleanup ${deployments[i].name}:`, error);
      }
    }
  } catch (error) {
    console.warn('Cleanup error:', error);
  }
};

// Safely remove a deployment directory
const removeDeployment = (deployDir: string) => {
  try {
    if (existsSync(deployDir)) {
      rmSync(deployDir, { recursive: true, force: true });
      console.log(`Removed deployment: ${deployDir}`);
    }
  } catch (error) {
    console.warn(`Failed to remove deployment ${deployDir}:`, error);
  }
};

// Aggressive cleanup: remove all files > 50MB from deployments directory
// This runs at the start of each new deployment to prevent disk space issues
const aggressiveCleanup = () => {
  try {
    const tempDir = getTempDir();
    let totalCleaned = 0;
    let filesRemoved = 0;

    const cleanDirectory = (dir: string) => {
      if (!existsSync(dir)) return;

      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          cleanDirectory(fullPath);
          // Remove empty directories
          try {
            const remaining = readdirSync(fullPath);
            if (remaining.length === 0) {
              rmSync(fullPath, { recursive: true });
            }
          } catch {}
        } else {
          try {
            const stats = statSync(fullPath);
            if (stats.size > CLEANUP_THRESHOLD_SIZE) {
              rmSync(fullPath);
              totalCleaned += stats.size;
              filesRemoved++;
            }
          } catch {}
        }
      }
    };

    cleanDirectory(tempDir);

    if (filesRemoved > 0) {
      console.log(`Aggressive cleanup: removed ${filesRemoved} files (${(totalCleaned / 1024 / 1024).toFixed(1)}MB)`);
    }
    return totalCleaned;
  } catch (error) {
    console.warn('Aggressive cleanup error:', error);
    return 0;
  }
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

// Helper to upload file to S3 using streaming multipart upload
async function uploadToS3(key: string, filePath: string): Promise<boolean> {
  try {
    const stats = statSync(filePath);

    // Skip S3 upload for very large files (local deployment doesn't need S3)
    if (stats.size > MAX_S3_UPLOAD_SIZE) {
      console.log(`Skipping S3 upload for ${key} (${(stats.size / 1024 / 1024).toFixed(1)}MB > ${MAX_S3_UPLOAD_SIZE / 1024 / 1024}MB limit)`);
      return false; // Return false to indicate upload was skipped
    }

    // Use streaming multipart upload for efficient large file handling
    const fileStream = createReadStream(filePath);
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: BUCKET_NAME,
        Key: key,
        Body: fileStream
      },
      // Multipart upload config
      queueSize: 4,
      partSize: 10 * 1024 * 1024, // 10MB parts
    });

    await upload.done();
    return true;
  } catch (error) {
    console.error(`Failed to upload ${key} to S3:`, error);
    // Don't throw - S3 upload failure shouldn't fail the whole deployment for local runs
    return false;
  }
}

// Stream event helper
function createSSEMessage(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Format elapsed time as human-readable string
function formatElapsedTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
}

// Direct Python syntax check (no HTTP request needed)
async function checkPythonSyntax(code: string): Promise<{ valid: boolean; errors?: string[] }> {
  const tmpFile = join(tmpdir(), `lint-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);

  try {
    writeFileSync(tmpFile, code, 'utf-8');

    return new Promise((resolve) => {
      const python = spawn(PYTHON_VERSION, ['-m', 'py_compile', tmpFile]);

      let errorOutput = '';

      python.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      python.on('close', (exitCode) => {
        // Clean up temp file
        try { unlinkSync(tmpFile); } catch {}

        if (exitCode === 0) {
          resolve({ valid: true });
        } else {
          const errors: string[] = [];
          const lines = errorOutput.split('\n').filter(l => l.trim());

          for (const line of lines) {
            if (line.includes('SyntaxError:') || line.includes('IndentationError:') || line.includes('TabError:')) {
              const match = line.match(/line (\d+)/i);
              if (match) {
                const lineNum = match[1];
                const errorType = line.match(/(SyntaxError|IndentationError|TabError)/)?.[0] || 'Error';
                errors.push(`Line ${lineNum}: ${errorType}`);
              } else {
                errors.push(line.trim());
              }
            }
          }

          if (errors.length === 0) {
            errors.push('Syntax validation failed');
          }

          resolve({ valid: false, errors });
        }
      });

      python.on('error', (err) => {
        try { unlinkSync(tmpFile); } catch {}
        console.warn('Python not available for linting:', err.message);
        // If Python isn't available, skip linting and let execution catch errors
        resolve({ valid: true });
      });
    });
  } catch (error) {
    try { unlinkSync(tmpFile); } catch {}
    // If we can't write temp file, skip linting
    return { valid: true };
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

        // Aggressive cleanup: remove large files from previous deployments
        // This prevents disk space issues from accumulated intermediate files
        const cleanedBytes = aggressiveCleanup();
        if (cleanedBytes > 0) {
          sendEvent('log', {
            type: 'info',
            message: `Cleaned up ${(cleanedBytes / 1024 / 1024).toFixed(1)}MB from previous deployments`
          });
        }

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

        // Check available disk space (need at least 2GB for safety)
        const availableSpace = getAvailableDiskSpace();
        const minRequiredSpace = 2 * 1024 * 1024 * 1024; // 2GB

        if (availableSpace < minRequiredSpace && availableSpace !== Infinity) {
          sendEvent('warning', { message: `Low disk space: ${(availableSpace / 1024 / 1024 / 1024).toFixed(1)}GB available. Minimum 2GB required.` });
          // Attempt cleanup to free space
          await cleanupOldDeployments(1);

          const newAvailableSpace = getAvailableDiskSpace();
          if (newAvailableSpace < minRequiredSpace && newAvailableSpace !== Infinity) {
            sendEvent('error', { message: `Insufficient disk space. Available: ${(newAvailableSpace / 1024 / 1024 / 1024).toFixed(1)}GB. Required: 2GB.` });
            controller.close();
            return;
          }
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
            // Direct Python syntax check - no HTTP request needed
            const lintResult = await checkPythonSyntax(completeScript);

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
          // Track start times for elapsed time reporting
          const nodeStartTimes = new Map<string, number>();

          // Set all nodes in this level to "running"
          for (const nodeId of level) {
            const node = nodeMap.get(nodeId) as any;
            if (!node) continue;

            // Check for fan-out
            const upstreamInputNodes = graph.nodes.filter((n: any) =>
              node.in.includes(n.id) && n.type === 'input-file' && n.files && n.files.length > 0
            );

            nodeStartTimes.set(nodeId, Date.now());
            sendEvent('node-status', { nodeId, status: 'running', startTime: Date.now() });
          }

          // Send periodic elapsed time updates for running nodes
          const elapsedInterval = setInterval(() => {
            for (const [nodeId, startTime] of nodeStartTimes) {
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              const node = nodeMap.get(nodeId) as any;
              sendEvent('node-elapsed', {
                nodeId,
                nodeName: node?.name || nodeId,
                elapsed,
                elapsedFormatted: formatElapsedTime(elapsed)
              });
            }
          }, 5000); // Update every 5 seconds

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
            clearInterval(elapsedInterval); // Stop elapsed time updates

            // Mark completed nodes with elapsed time
            const completedNodeIds = new Set(results.map(r => r.nodeId));
            for (const nodeId of completedNodeIds) {
              const startTime = nodeStartTimes.get(nodeId);
              const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
              const node = nodeMap.get(nodeId) as any;
              sendEvent('node-status', {
                nodeId,
                status: 'completed',
                elapsed,
                elapsedFormatted: formatElapsedTime(elapsed)
              });
              sendEvent('log', {
                type: 'info',
                message: `Completed in ${formatElapsedTime(elapsed)}`,
                nodeId,
                nodeName: node?.name || nodeId
              });
            }
          } catch (error) {
            clearInterval(elapsedInterval); // Stop elapsed time updates on error too
            // Find the actual failed node from results
            let actualFailedNodeId: string | null = null;
            let actualFailedNodeName: string | null = null;
            
            for (const nodeId of level) {
              const resultKey = `${nodeId}-0`;
              const result = nodeResults.get(resultKey);
              if (result && result.status === 'failed') {
                actualFailedNodeId = nodeId;
                actualFailedNodeName = (nodeMap.get(nodeId) as any)?.name || nodeId;
                const startTime = nodeStartTimes.get(nodeId);
                const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
                sendEvent('node-status', {
                  nodeId,
                  status: 'failed',
                  elapsed,
                  elapsedFormatted: formatElapsedTime(elapsed)
                });
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
                  const startTime = nodeStartTimes.get(nodeId);
                  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
                  sendEvent('node-status', {
                    nodeId,
                    status: 'failed',
                    elapsed,
                    elapsedFormatted: formatElapsedTime(elapsed)
                  });
                  break;
                }
              }
            }
            
            const errorMsg = error instanceof Error ? error.message : 'Execution failed';
            // Send error with the actual failed nodeId so autopilot can fix it
            sendEvent('error', {
              message: errorMsg,
              nodeId: actualFailedNodeId,
              nodeName: actualFailedNodeName,
              deploymentId
            });
            // Don't cleanup immediately - let autopilot retry or user decide
            // Cleanup will happen when new successful deployment completes
            controller.close();
            return;
          }
        }

        // 6. Prepare output files - send as file references, not inline content
        const outputNodeUpdates: Array<{ nodeId: string; filePath: string; fileName: string; fileSize?: number }> = [];

        for (const [resultKey, result] of nodeResults) {
          const fileIndex = result.fileIndex;
          const lastDashIndex = resultKey.lastIndexOf('-');
          const nodeId = resultKey.substring(0, lastDashIndex);

          const outputPath = join(deployDir, nodeId, `file-${fileIndex}`, 'output.csv');
          if (existsSync(outputPath)) {
            try {
              // Don't read the file content - just get metadata
              // The frontend will request the file data separately if needed
              const stats = require('fs').statSync(outputPath);
              const outputNodes = graph.nodes.filter((n: any) =>
                n.type === 'output-file' && n.in.includes(nodeId)
              );

              outputNodes.forEach((outputNode: any) => {
                outputNodeUpdates.push({
                  nodeId: outputNode.id,
                  filePath: outputPath,
                  fileName: `output-${fileIndex}.csv`,
                  fileSize: stats.size
                });
              });
            } catch (error) {
              console.error(`Failed to get metadata for ${resultKey}:`, error);
            }
          }
        }

        // Send final completion event with file references (not content)
        sendEvent('complete', {
          deploymentId,
          status: 'completed',
          outputNodeUpdates,
          consoleLogs
        });

        // Clean up old deployments after successful completion
        // Keep only the 3 most recent deployments
        await cleanupOldDeployments(3);

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
