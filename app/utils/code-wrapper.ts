import { HPCNode, HPCGraph } from '@/app/store/hpc-store';

/**
 * Sanitize a node ID to be a valid Python variable name
 */
function sanitizeNodeId(nodeId: string): string {
  return nodeId.replace(/-/g, '_');
}

/**
 * Get the line offset where user code starts in the wrapped script.
 * This is needed to translate linter error line numbers back to user code.
 */
export function getCodeLineOffset(): number {
  // Count lines in the boilerplate before ${node.code}
  // The boilerplate includes: shebang, docstring, imports, memory settings,
  // resource limits, config vars, boto3 try/except, optimize_dtypes function,
  // read_csv_smart function, and a blank line
  return 98; // Lines 1-98 are boilerplate, user code starts at line 99
}

/**
 * Translate a line number from the wrapped script to the user's code.
 * Returns null if the line is in the boilerplate (not user code).
 */
export function translateLineNumber(wrappedLineNum: number): number | null {
  const offset = getCodeLineOffset();
  if (wrappedLineNum <= offset) {
    return null; // Error is in boilerplate, not user code
  }
  return wrappedLineNum - offset;
}

/**
 * Normalize Python code whitespace:
 * - Convert tabs to 4 spaces
 * - Remove trailing whitespace from each line
 * - Preserve indentation structure
 */
function normalizeCodeWhitespace(code: string): string {
  if (!code) return '';
  return code
    .split('\n')
    .map(line => line.replace(/\t/g, '    ').trimEnd())
    .join('\n');
}

/**
 * Create a complete executable Python script from a compute node
 *
 * Generates a universal script that:
 * - Tries to read from local filesystem first
 * - Falls back to S3 if local files don't exist
 * - Works for both local and AWS Batch execution
 * - Memory-efficient: uses chunked reading, explicit gc, optimized dtypes
 */
export function createExecutableScript(node: HPCNode, graph: HPCGraph): string {
  const upstreamNodes = graph.nodes.filter((n) => node.in.includes(n.id));

  let script = `#!/usr/bin/env python3
"""
Auto-generated task script for: ${node.name}
Universal script - works for both local and AWS execution
Memory-optimized for large datasets
"""

import pandas as pd
import numpy as np
import json
import sys
import os
import gc
from io import StringIO

# Memory optimization settings
pd.options.mode.chained_assignment = None  # Disable copy warnings
os.environ['MALLOC_TRIM_THRESHOLD_'] = '65536'  # More aggressive memory release

# Set memory limit (512MB soft limit for safety)
try:
    import resource
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    # Set 2GB limit to prevent runaway memory usage
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024 * 1024 * 1024, hard))
except:
    pass  # resource module not available on all platforms

# Configuration from environment variables
BUCKET_NAME = os.environ.get('BUCKET_NAME', 'hpc-bucket')
OUTPUT_PATH = os.environ.get('OUTPUT_PATH', '${node.id}/output.csv')

# Lazy-load boto3 only when needed (saves ~100MB RAM for local execution)
s3_client = None
HAS_S3 = False

def get_s3_client():
    """Lazy-load boto3 and S3 client only when actually needed for S3 operations"""
    global s3_client, HAS_S3
    if s3_client is None and not HAS_S3:
        try:
            import boto3
            s3_client = boto3.client('s3')
            HAS_S3 = True
        except ImportError:
            HAS_S3 = False
    return s3_client

def optimize_dtypes(df):
    """Optimize DataFrame memory usage by downcasting numeric types."""
    for col in df.columns:
        col_type = df[col].dtype
        if col_type == 'float64':
            df[col] = pd.to_numeric(df[col], downcast='float')
        elif col_type == 'int64':
            df[col] = pd.to_numeric(df[col], downcast='integer')
        elif col_type == 'object':
            # Convert low-cardinality string columns to category
            num_unique = df[col].nunique()
            if num_unique / len(df) < 0.5:  # Less than 50% unique values
                df[col] = df[col].astype('category')
    return df

def read_csv_smart(path, optimize_memory=True):
    """
    Read CSV from either local filesystem or S3.
    Memory-optimized: uses chunked reading for large files, dtype optimization.
    """
    gc.collect()  # Free memory before reading

    # Try local filesystem first (works for both absolute and relative paths)
    if os.path.exists(path):
        try:
            # Check file size to decide reading strategy
            file_size = os.path.getsize(path)
            file_size_mb = file_size / (1024 * 1024)

            if file_size_mb > 100:
                # Large file: read in chunks and concatenate
                print(f"Large file detected ({file_size_mb:.1f}MB), using chunked reading...")
                chunks = []
                for chunk in pd.read_csv(path, chunksize=50000, low_memory=True):
                    if optimize_memory:
                        chunk = optimize_dtypes(chunk)
                    chunks.append(chunk)
                    gc.collect()
                df = pd.concat(chunks, ignore_index=True)
                del chunks
                gc.collect()
            else:
                # Normal file: read directly with memory optimization
                df = pd.read_csv(path, low_memory=True)
                if optimize_memory:
                    df = optimize_dtypes(df)

            gc.collect()
            return df
        except Exception as e:
            print(f"Warning: Could not read {path} locally: {e}")

    # If path is absolute, don't try S3 (user is running locally)
    if os.path.isabs(path):
        raise Exception(f"Could not read {path} - file not found locally")

    # Try S3 only if BUCKET_NAME looks like a real bucket (not a filesystem path)
    if not os.path.isabs(BUCKET_NAME):
        client = get_s3_client()
        if client:
            try:
                print(f"Reading from S3: s3://{BUCKET_NAME}/{path}")
                obj = client.get_object(Bucket=BUCKET_NAME, Key=path)
                df = pd.read_csv(StringIO(obj['Body'].read().decode('utf-8')), low_memory=True)
                if optimize_memory:
                    df = optimize_dtypes(df)
                gc.collect()
                return df
            except Exception as e:
                raise Exception(f"Could not read {path} from S3: {e}")

    raise Exception(f"Could not read {path} - file not found locally and S3 not available")

${normalizeCodeWhitespace(node.code)}

if __name__ == "__main__":
    try:
`;

  // Load inputs
  if (upstreamNodes.length === 0) {
    script += `        # No inputs, call function directly
        result = task()
`;
  } else {
    upstreamNodes.forEach((upstream) => {
      const paramName = upstream.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const envVarName = `INPUT_${upstream.id}`;
      const sanitizedId = sanitizeNodeId(upstream.id);
      script += `        # Load ${upstream.name} from local file or S3
        input_path_${sanitizedId} = os.environ.get('${envVarName}', '${upstream.id}/output.csv')
        ${paramName} = read_csv_smart(input_path_${sanitizedId})
`;
    });

    const params = upstreamNodes
      .map((n) => n.name.toLowerCase().replace(/[^a-z0-9]/g, '_'))
      .join(', ');
    script += `
        # Call task function with inputs
        result = task(${params})
`;
  }

  script += `
        # Free memory from inputs before writing output
        gc.collect()

        # Verify result is a DataFrame
        if not isinstance(result, pd.DataFrame):
            raise Exception(f"Task must return a pandas DataFrame, got {type(result).__name__}")

        print(f"Output DataFrame: {len(result)} rows, {len(result.columns)} columns")
        print(f"Memory usage: {result.memory_usage(deep=True).sum() / 1024 / 1024:.1f} MB")

        # Write output (to local file or S3 depending on BUCKET_NAME)
        if os.path.isabs(BUCKET_NAME):
            # Local execution - BUCKET_NAME is a filesystem path
            print(f"Writing output locally to: {OUTPUT_PATH}")
            try:
                # Ensure output directory exists
                output_dir = os.path.dirname(OUTPUT_PATH)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)

                # Write in chunks for large dataframes to avoid memory spike
                if len(result) > 100000:
                    print("Large output, writing in chunks...")
                    result.to_csv(OUTPUT_PATH, index=False, chunksize=50000)
                else:
                    result.to_csv(OUTPUT_PATH, index=False)
                print(f"Output written locally to {OUTPUT_PATH}")
            except Exception as e:
                print(f"Error writing output locally: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc()
                raise Exception(f"Could not write output locally: {e}")
        else:
            # AWS execution - BUCKET_NAME is an S3 bucket
            print(f"Writing output to S3: s3://{BUCKET_NAME}/{OUTPUT_PATH}")
            try:
                client = get_s3_client()
                if not client:
                    raise Exception("boto3 not available for S3 upload")
                csv_buffer = StringIO()
                result.to_csv(csv_buffer, index=False)
                client.put_object(
                    Bucket=BUCKET_NAME,
                    Key=OUTPUT_PATH,
                    Body=csv_buffer.getvalue().encode('utf-8')
                )
                del csv_buffer
                gc.collect()
                print("Output written to S3 successfully")
            except Exception as e:
                print(f"Error writing to S3: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc()
                raise Exception(f"Could not write output to S3: {e}")

        # Final cleanup
        del result
        gc.collect()
        print("Task completed successfully")

    except Exception as e:
        print(f"Task failed: {str(e)}")
        import traceback
        traceback.print_exc()
        gc.collect()
        sys.exit(1)
`;

  return script;
}
