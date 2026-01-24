import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export async function POST(request: NextRequest) {
  try {
    const { code } = await request.json();

    if (!code) {
      return NextResponse.json(
        { error: "Missing code" },
        { status: 400 }
      );
    }

    const result = await checkPythonSyntax(code);
    return NextResponse.json(result);
  } catch (error) {
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

async function checkPythonSyntax(code: string): Promise<{ valid: boolean; errors?: string[] }> {
  // Write code to a temporary file to avoid escaping issues
  const tmpFile = join(tmpdir(), `lint-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);

  try {
    await writeFile(tmpFile, code, 'utf-8');

    return new Promise((resolve) => {
      const python = spawn("python3", ["-m", "py_compile", tmpFile]);

      let errorOutput = "";

      python.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      python.on("close", async (exitCode) => {
        // Clean up temp file
        try {
          await unlink(tmpFile);
        } catch (e) {
          // Ignore cleanup errors
        }

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
        // Clean up temp file
        try {
          await unlink(tmpFile);
        } catch (e) {
          // Ignore cleanup errors
        }

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
    // Clean up temp file if it exists
    try {
      await unlink(tmpFile);
    } catch (e) {
      // Ignore cleanup errors
    }

    throw error;
  }
}
