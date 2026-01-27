import { NextRequest, NextResponse } from 'next/server';
import { existsSync, statSync, createReadStream } from 'fs';
import { createInterface } from 'readline';

/**
 * Fetch output file content by file path with optional row limiting
 * Uses streaming for memory efficiency with large files
 *
 * Body parameters:
 * - filePath: (required) path to the file
 * - limit: (optional) maximum number of data rows to return (default: unlimited)
 * - download: (optional) if true, returns raw file for download instead of JSON
 */
export async function POST(request: NextRequest) {
  try {
    const { filePath, limit, download } = await request.json();

    if (!filePath) {
      return NextResponse.json(
        { error: 'Missing filePath parameter' },
        { status: 400 }
      );
    }

    // Security: Prevent directory traversal
    if (filePath.includes('..') || filePath.includes('~')) {
      return NextResponse.json(
        { error: 'Invalid file path' },
        { status: 403 }
      );
    }

    // Only allow reading from .tmp/deployments directory
    if (!filePath.includes('.tmp/deployments')) {
      return NextResponse.json(
        { error: 'Files can only be read from deployment directory' },
        { status: 403 }
      );
    }

    if (!existsSync(filePath)) {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }

    // Get file stats for size info
    const stats = statSync(filePath);
    const fileSize = stats.size;

    // For download mode, stream the entire file without loading into memory
    if (download) {
      const stream = createReadStream(filePath);
      const fileName = filePath.split('/').pop() || 'output.csv';

      // Convert Node stream to Web ReadableStream
      const webStream = new ReadableStream({
        start(controller) {
          stream.on('data', (chunk) => {
            controller.enqueue(chunk);
          });
          stream.on('end', () => {
            controller.close();
          });
          stream.on('error', (err) => {
            controller.error(err);
          });
        },
        cancel() {
          stream.destroy();
        }
      });

      return new Response(webStream, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Content-Length': fileSize.toString(),
        },
      });
    }

    // For preview mode with limit, use streaming to read only needed lines
    if (limit && typeof limit === 'number' && limit > 0) {
      const result = await readLimitedLines(filePath, limit);
      return NextResponse.json({
        success: true,
        content: result.content,
        size: result.content.length,
        totalSize: fileSize,
        truncated: result.truncated,
        totalRows: result.totalRows
      });
    }

    // For full file without download mode, still use streaming for row count
    // but return the content (for smaller files or explicit full fetch)
    const result = await readFullFileWithStats(filePath);
    return NextResponse.json({
      success: true,
      content: result.content,
      size: result.content.length,
      totalSize: fileSize,
      truncated: false,
      totalRows: result.totalRows
    });

  } catch (error) {
    console.error('Error fetching output file:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch file' },
      { status: 500 }
    );
  }
}

/**
 * Read only the first N data lines from a CSV file using streaming
 * This is memory efficient for large files
 */
async function readLimitedLines(
  filePath: string,
  limit: number
): Promise<{ content: string; truncated: boolean; totalRows: number }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let totalRows = 0;
    let headerRead = false;

    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headerRead) {
        // First line is header
        lines.push(line);
        headerRead = true;
      } else if (line.trim()) {
        totalRows++;
        if (lines.length <= limit) {
          // Only keep lines up to limit + 1 (header)
          lines.push(line);
        }
      }
    });

    rl.on('close', () => {
      resolve({
        content: lines.join('\n'),
        truncated: totalRows > limit,
        totalRows
      });
    });

    rl.on('error', reject);
  });
}

/**
 * Read full file with streaming to get accurate row count
 * For files under 50MB, returns content; for larger files, suggests download
 */
async function readFullFileWithStats(
  filePath: string
): Promise<{ content: string; totalRows: number }> {
  const MAX_CONTENT_SIZE = 50 * 1024 * 1024; // 50MB limit for JSON response
  const stats = statSync(filePath);

  if (stats.size > MAX_CONTENT_SIZE) {
    // For very large files, return a message instead of content
    const rowCount = await countRows(filePath);
    return {
      content: `File too large for preview (${(stats.size / 1024 / 1024).toFixed(1)}MB). Use download button to get full file.`,
      totalRows: rowCount
    };
  }

  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let totalRows = 0;

    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length > 1 && line.trim()) {
        totalRows++;
      }
    });

    rl.on('close', () => {
      resolve({
        content: lines.join('\n'),
        totalRows
      });
    });

    rl.on('error', reject);
  });
}

/**
 * Count rows in a file without loading content into memory
 */
async function countRows(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    let headerSkipped = false;

    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headerSkipped) {
        headerSkipped = true;
      } else if (line.trim()) {
        count++;
      }
    });

    rl.on('close', () => resolve(count));
    rl.on('error', reject);
  });
}
