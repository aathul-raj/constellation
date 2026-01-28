import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Track active processes for cleanup
const activeProcesses = new Set<ChildProcess>();

// Cleanup stale processes periodically (every 60 seconds)
const PROCESS_TIMEOUT_MS = 30000; // 30 second timeout per lint operation

export async function POST(request: NextRequest) {
  try {
    const { code } = await request.json();

    if (!code) {
      return NextResponse.json(
        { error: "Missing code" },
        { status: 400 }
      );
    }

    // Handle client disconnect
    const abortController = new AbortController();
    request.signal.addEventListener('abort', () => {
      abortController.abort();
    });

    const result = await checkPythonSyntax(code, abortController.signal);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Aborted') {
      return NextResponse.json({ valid: true }, { status: 499 }); // Client closed request
    }
    console.error("Lint error:", error);
    return NextResponse.json(
      {
        valid: false,
        errors: ["Linting service error: " + (error instanceof Error ? error.message : String(error))]
      },
      { status: 500 }
    );
  }
}

async function checkPythonSyntax(
  code: string,
  signal?: AbortSignal
): Promise<{ valid: boolean; errors?: string[] }> {
  // Write code to a temporary file to avoid escaping issues
  const tmpFile = join(tmpdir(), `lint-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  let python: ChildProcess | null = null;
  let timeoutId: NodeJS.Timeout | null = null;

  // Cleanup function
  const cleanup = async () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (python) {
      activeProcesses.delete(python);
      try {
        python.kill('SIGTERM');
      } catch {}
      python = null;
    }
    try {
      await unlink(tmpFile);
    } catch {}
  };

  try {
    await writeFile(tmpFile, code, 'utf-8');

    return new Promise((resolve, reject) => {
      // Check if already aborted
      if (signal?.aborted) {
        cleanup();
        reject(new Error('Aborted'));
        return;
      }

      python = spawn("python3", ["-m", "py_compile", tmpFile]);
      activeProcesses.add(python);

      let errorOutput = "";

      // Set timeout to prevent hanging
      timeoutId = setTimeout(() => {
        cleanup();
        resolve({ valid: false, errors: ["Lint timeout - code may be too complex"] });
      }, PROCESS_TIMEOUT_MS);

      // Handle abort
      signal?.addEventListener('abort', () => {
        cleanup();
        reject(new Error('Aborted'));
      });

      python.stderr?.on("data", (data) => {
        errorOutput += data.toString();
      });

      python.on("close", async (exitCode) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (python) {
          activeProcesses.delete(python);
          python = null;
        }

        // Clean up temp file
        try {
          await unlink(tmpFile);
        } catch {}

        if (exitCode === 0) {
          resolve({ valid: true });
        } else {
          const errors: string[] = [];

          // Parse Python error output
          const lines = errorOutput.split('\n').filter(l => l.trim());

          for (const line of lines) {
            // Extract relevant error information
            if (line.includes('SyntaxError:') || line.includes('IndentationError:') || line.includes('TabError:')) {
              const match = line.match(/line (\d+)/i);
              if (match) {
                const lineNum = match[1];
                const errorType = line.match(/(SyntaxError|IndentationError|TabError)/)?.[0] || 'Error';
                errors.push(`Line ${lineNum}: ${errorType}`);
              } else {
                errors.push(line.trim());
              }
            } else if (line.trim() && !line.includes(tmpFile)) {
              // Include other error messages, but filter out temp file path
              errors.push(line.trim());
            }
          }

          if (errors.length === 0) {
            errors.push("Syntax validation failed");
          }

          resolve({ valid: false, errors });
        }
      });

      python.on("error", async (err) => {
        await cleanup();

        console.warn("Python not available:", err);

        // Fallback to basic validation
        const errors: string[] = [];
        if (!code.includes("def task(")) {
          errors.push("Missing required function signature: def task(input, output):");
        }

        resolve({ valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined });
      });
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
