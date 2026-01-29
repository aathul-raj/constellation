import { NextRequest, NextResponse } from 'next/server';
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
import { canAcceptDeployment, getDeploymentStats } from '@/app/lib/concurrency';

const execFileAsync = promisify(execFile);

// Size limits
const MAX_S3_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB - skip S3 upload for larger files
const MAX_INPUT_FILE_SIZE = 100 * 1024 * 1024; // 100MB - reject files larger than this
const MAX_OUTPUT_FILE_SIZE = 200 * 1024 * 1024; // 200MB - warn if output exceeds this
const MIN_AVAILABLE_MEMORY_MB = 256; // Minimum free memory required to start

// Get available system memory in MB
const getAvailableMemory = (): number => {
  try {
    const result = execSync('node -e "console.log(Math.round(require(\'os\').freemem() / 1024 / 1024))"').toString().trim();
    return parseInt(result) || 0;
  } catch {
    return 1024; // Assume 1GB if we can't determine
  }
};

// Get estimated memory requirement based on input file sizes
const estimateMemoryRequirement = (inputSizeBytes: number): number => {
  // Pandas DataFrames typically use 3-5x the CSV file size in memory
  // Plus overhead for processing copies
  const estimatedDfSize = inputSizeBytes * 4;
  // Add 200MB base overhead for Python, pandas, numpy
  return Math.round((estimatedDfSize / 1024 / 1024) + 200);
};

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

// Complete wipe of tmp directory - runs at start of EVERY deployment
// This prevents memory/disk issues from accumulated files
const wipeTmpDirectory = () => {
  try {
    const tempDir = getTempDir();
    if (existsSync(tempDir)) {
      // Get total size before wiping
      let totalSize = 0;
      const countSize = (dir: string) => {
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              countSize(fullPath);
            } else {
              try {
                totalSize += statSync(fullPath).size;
              } catch {}
            }
          }
        } catch {}
      };
      countSize(tempDir);

      // Wipe everything
      rmSync(tempDir, { recursive: true, force: true });
      mkdirSync(tempDir, { recursive: true });

      if (totalSize > 0) {
        console.log(`Wiped tmp directory: freed ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
      }
      return totalSize;
    }
    return 0;
  } catch (error) {
    console.warn('Wipe tmp error:', error);
    // Ensure dir exists even if wipe failed
    try {
      mkdirSync(getTempDir(), { recursive: true });
    } catch {}
    return 0;
  }
};

// Validate input file size before processing
const validateInputFileSize = (filePath: string, fileName: string): { valid: boolean; error?: string; size: number } => {
  try {
    const stats = statSync(filePath);
    if (stats.size > MAX_INPUT_FILE_SIZE) {
      return {
        valid: false,
        error: `Input file "${fileName}" (${(stats.size / 1024 / 1024).toFixed(1)}MB) exceeds ${MAX_INPUT_FILE_SIZE / 1024 / 1024}MB limit. Please use a smaller file.`,
        size: stats.size
      };
    }
    return { valid: true, size: stats.size };
  } catch {
    return { valid: true, size: 0 }; // File doesn't exist yet, allow
  }
};

// Helper to download file from S3 using streaming (memory efficient)
async function downloadFromS3(key: string, destinationPath: string): Promise<void> {
  const { createWriteStream } = await import('fs');
  const { pipeline } = await import('stream/promises');

  try {
    console.log(`Downloading from S3: bucket=${BUCKET_NAME}, key=${key}`);

    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      })
    );

    if (!response.Body) {
      throw new Error(`S3 response has no body for key: ${key}`);
    }

    console.log(`S3 response received, ContentLength: ${response.ContentLength || 'unknown'}`);

    const readable = response.Body as any;
    const writable = createWriteStream(destinationPath);

    // Stream directly to disk - never buffer entire file in memory
    await pipeline(readable, writable);

    console.log(`Successfully wrote ${key} to ${destinationPath}`);
  } catch (error) {
    console.error(`Failed to download ${key} from S3:`, error);
    throw new Error(`S3 download failed for ${key}: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  // Check concurrent deployment limit first
  if (!canAcceptDeployment()) {
    const stats = getDeploymentStats();
    return NextResponse.json(
      {
        error: 'Server busy',
        message: `Too many concurrent deployments (${stats.active}/${stats.max}). Please try again in a moment.`
      },
      { status: 503 }
    );
  }

  const encoder = new TextEncoder();

  // Track all intervals for cleanup on abort
  const activeIntervals: NodeJS.Timeout[] = [];
  let isAborted = false;

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: any) => {
        if (isAborted) return; // Don't send if aborted
        try {
          controller.enqueue(encoder.encode(createSSEMessage(event, data)));
        } catch {
          // Controller may be closed
          isAborted = true;
        }
      };

      // Cleanup function
      const cleanup = () => {
        isAborted = true;
        activeIntervals.forEach(interval => clearInterval(interval));
        activeIntervals.length = 0;
      };

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        console.log('[Deploy] Client disconnected, cleaning up...');
        cleanup();
        try { controller.close(); } catch {}
      });

      try {
        const { graph } = await request.json();

        // CRITICAL: Wipe entire tmp directory on EVERY run to prevent memory issues
        // This ensures we start fresh and don't accumulate files
        const wipedBytes = wipeTmpDirectory();
        if (wipedBytes > 0) {
          sendEvent('log', {
            type: 'info',
            message: `Cleared ${(wipedBytes / 1024 / 1024).toFixed(1)}MB from previous runs`
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

        // Check for large files (> 50MB) that should use AWS Batch instead
        const MAX_LOCAL_FILE_SIZE = 50 * 1024 * 1024; // 50MB
        const allInputFileNodes = graph.nodes.filter((n: any) => n.type === 'input-file');
        const largeFiles: string[] = [];

        for (const inputNode of allInputFileNodes) {
          if (inputNode.files && Array.isArray(inputNode.files)) {
            for (const file of inputNode.files) {
              // Check file metadata for size
              if (file.metadata?.size && file.metadata.size > MAX_LOCAL_FILE_SIZE) {
                const sizeMB = (file.metadata.size / 1024 / 1024).toFixed(1);
                largeFiles.push(`${file.name} (${sizeMB}MB)`);
              }
            }
          }
        }

        if (largeFiles.length > 0) {
          sendEvent('error', {
            message: `Files too large for local deployment: ${largeFiles.join(', ')}. Please use AWS Batch deployment for files > 50MB.`
          });
          controller.close();
          return;
        }

        // Check available disk space (need at least 500MB for safety)
        const availableSpace = getAvailableDiskSpace();
        const minRequiredSpace = 500 * 1024 * 1024; // 500MB (reduced since we wipe tmp each run)

        if (availableSpace < minRequiredSpace && availableSpace !== Infinity) {
          sendEvent('error', { message: `Insufficient disk space. Available: ${(availableSpace / 1024 / 1024).toFixed(0)}MB. Required: 500MB.` });
          controller.close();
          return;
        }

        // Check available memory
        const availableMemory = getAvailableMemory();
        if (availableMemory < MIN_AVAILABLE_MEMORY_MB) {
          sendEvent('error', {
            message: `Insufficient memory. Available: ${availableMemory}MB. Required: ${MIN_AVAILABLE_MEMORY_MB}MB. Please close other applications or try again later.`
          });
          controller.close();
          return;
        }
        sendEvent('log', { type: 'info', message: `System memory: ${availableMemory}MB available` });

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

        // 3. Download input files from S3 and validate sizes
        const inputFileNodes = graph.nodes.filter((n: any) => n.type === 'input-file');
        let totalInputSize = 0;

        for (const inputNode of inputFileNodes) {
          if (inputNode.files && inputNode.files.length > 0) {
            try {
              const inputDir = join(deployDir, 'inputs');
              mkdirSync(inputDir, { recursive: true });

              for (const file of inputNode.files) {
                sendEvent('log', {
                  type: 'info',
                  message: `Downloading ${file.name || file.id} from S3...`
                });

                const localInputPath = join(inputDir, file.id);

                try {
                  await downloadFromS3(file.id, localInputPath);

                  // Check if file was downloaded successfully
                  if (!existsSync(localInputPath)) {
                    throw new Error(`File was not created at ${localInputPath}`);
                  }

                  const fileStats = statSync(localInputPath);
                  sendEvent('log', {
                    type: 'info',
                    message: `Downloaded ${file.name || file.id} (${(fileStats.size / 1024).toFixed(1)}KB)`
                  });

                  // Validate file size after download
                  const validation = validateInputFileSize(localInputPath, file.name || file.id);
                  if (!validation.valid) {
                    sendEvent('error', { message: validation.error });
                    // Clean up downloaded file
                    try { unlinkSync(localInputPath); } catch {}
                    controller.close();
                    return;
                  }
                  totalInputSize += validation.size;
                } catch (downloadError) {
                  sendEvent('error', {
                    message: `Failed to download ${file.name || file.id} from S3: ${downloadError instanceof Error ? downloadError.message : 'Unknown error'}`
                  });
                  controller.close();
                  return;
                }
              }
            } catch (error) {
              sendEvent('error', { message: `Failed to prepare input files: ${error instanceof Error ? error.message : 'Unknown error'}` });
              controller.close();
              return;
            }
          }
        }

        if (totalInputSize > 0) {
          const inputSizeMB = totalInputSize / 1024 / 1024;
          const estimatedMemory = estimateMemoryRequirement(totalInputSize);
          const currentAvailableMemory = getAvailableMemory();

          sendEvent('log', {
            type: 'info',
            message: `Input files: ${inputSizeMB.toFixed(1)}MB (estimated memory: ${estimatedMemory}MB, available: ${currentAvailableMemory}MB)`
          });

          if (estimatedMemory > currentAvailableMemory) {
            sendEvent('log', {
              type: 'warning',
              message: `Warning: Estimated memory (${estimatedMemory}MB) exceeds available (${currentAvailableMemory}MB). Processing may be slow or fail.`
            });
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
            if (isAborted) {
              clearInterval(elapsedInterval);
              return;
            }
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
          activeIntervals.push(elapsedInterval); // Track for cleanup on abort

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

                // Execute with memory optimization env vars and timeout
                const execEnv: Record<string, string> = {
                  ...env,
                  // Memory optimization environment variables
                  PYTHONMALLOC: 'malloc',  // Use system malloc for better memory release
                  MALLOC_TRIM_THRESHOLD_: '65536',  // More aggressive memory trimming
                  PYTHONHASHSEED: '0',  // Deterministic hash for reproducibility
                };
                const { stdout, stderr } = await execFileAsync(PYTHON_VERSION, [scriptPath], {
                  env: execEnv as NodeJS.ProcessEnv,
                  maxBuffer: 10 * 1024 * 1024,
                  timeout: 5 * 60 * 1000, // 5 minute timeout per node
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

        // Note: tmp is wiped at start of each run, no cleanup needed here

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
