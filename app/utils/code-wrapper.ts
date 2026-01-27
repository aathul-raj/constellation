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
  // The boilerplate is: shebang, docstring, imports, BUCKET_NAME, OUTPUT_PATH, 
  // boto3 try/except, read_csv_smart function, and a blank line
  return 56; // Lines 1-56 are boilerplate, user code starts at line 57
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
 */
export function createExecutableScript(node: HPCNode, graph: HPCGraph): string {
  const upstreamNodes = graph.nodes.filter((n) => node.in.includes(n.id));

  let script = `#!/usr/bin/env python3
"""
Auto-generated task script for: ${node.name}
Universal script - works for both local and AWS execution
"""

import pandas as pd
import numpy as np
import json
import sys
import os
from io import StringIO

# Configuration from environment variables
BUCKET_NAME = os.environ.get('BUCKET_NAME', 'hpc-bucket')
OUTPUT_PATH = os.environ.get('OUTPUT_PATH', '${node.id}/output.csv')

# Try to import boto3 for S3 access (optional for local execution)
try:
    import boto3
    s3_client = boto3.client('s3')
    HAS_S3 = True
except ImportError:
    HAS_S3 = False

def read_csv_smart(path):
    """
    Read CSV from either local filesystem or S3.
    Tries local filesystem first, then S3 (only if BUCKET_NAME is a valid S3 bucket).
    """
    # Try local filesystem first (works for both absolute and relative paths)
    if os.path.exists(path):
        try:
            return pd.read_csv(path)
        except Exception as e:
            print(f"Warning: Could not read {path} locally: {e}")

    # If path is absolute, don't try S3 (user is running locally)
    if os.path.isabs(path):
        raise Exception(f"Could not read {path} - file not found locally")

    # Try S3 only if BUCKET_NAME looks like a real bucket (not a filesystem path)
    if HAS_S3 and not os.path.isabs(BUCKET_NAME):
        try:
            print(f"Reading from S3: s3://{BUCKET_NAME}/{path}")
            obj = s3_client.get_object(Bucket=BUCKET_NAME, Key=path)
            return pd.read_csv(StringIO(obj['Body'].read().decode('utf-8')))
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
        # Write output (to local file or S3 depending on BUCKET_NAME)
        if os.path.isabs(BUCKET_NAME):
            # Local execution - BUCKET_NAME is a filesystem path
            print(f"Writing output locally to: {OUTPUT_PATH}")
            try:
                # Ensure output directory exists
                output_dir = os.path.dirname(OUTPUT_PATH)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                
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
                csv_buffer = StringIO()
                result.to_csv(csv_buffer, index=False)
                s3_client.put_object(
                    Bucket=BUCKET_NAME,
                    Key=OUTPUT_PATH,
                    Body=csv_buffer.getvalue().encode('utf-8')
                )
                print("Output written to S3 successfully")
            except Exception as e:
                print(f"Error writing to S3: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc()
                raise Exception(f"Could not write output to S3: {e}")

        print("Task completed successfully")

    except Exception as e:
        print(f"Task failed: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
`;

  return script;
}
