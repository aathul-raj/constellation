import { HPCNode, HPCGraph } from '@/app/store/hpc-store';


/**
 * Create a complete executable Python script from a compute node
 *
 * Generates:
 * - Imports (pandas, numpy)
 * - The task function
 * - Optional S3 I/O wrapper for AWS deployment
 *
 * For local testing: set includeS3Wrapper to false
 * For AWS Batch: set includeS3Wrapper to true
 */
export function createExecutableScript(
  node: HPCNode,
  graph: HPCGraph,
  options: { includeS3Wrapper?: boolean; inputPaths?: Record<string, string>; outputPath?: string } = {}
): string {
  const { includeS3Wrapper = false, inputPaths = {}, outputPath = '/tmp/output' } = options;

  // Get upstream and downstream nodes
  const upstreamNodes = graph.nodes.filter((n) => node.in.includes(n.id));
  const downstreamNodes = graph.nodes.filter((n) => node.out.includes(n.id));

  let script = `#!/usr/bin/env python3
"""
Auto-generated task script for: ${node.name}
"""

import pandas as pd
import numpy as np
import json
import sys
import os

${node.code}

`;

  if (includeS3Wrapper) {
    script += createS3Wrapper(node, upstreamNodes, downstreamNodes, inputPaths, outputPath);
  } else {
    script += createLocalWrapper(node, upstreamNodes, downstreamNodes);
  }

  return script;
}

/**
 * Create a wrapper for local execution (testing)
 * Assumes input files are available locally
 */
function createLocalWrapper(
  node: HPCNode,
  upstreamNodes: HPCNode[],
  downstreamNodes: HPCNode[]
): string {
  if (upstreamNodes.length === 0) {
    return `if __name__ == "__main__":
    # No inputs, call function directly
    result = task()
    print("Task completed successfully")
`;
  }

  // Generate input loading code
  const inputLoads = upstreamNodes
    .map((upstream) => {
      const paramName = upstream.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      return `    ${paramName} = pd.read_csv('/tmp/${upstream.id}.csv')  # Load from ${upstream.name}`;
    })
    .join('\n');

  const inputParams = upstreamNodes.map((n) => n.name.toLowerCase().replace(/[^a-z0-9]/g, '_')).join(', ');

  let wrapper = `if __name__ == "__main__":
${inputLoads}

    # Call task function
    result = task(${inputParams})

    # Save result
    if isinstance(result, pd.DataFrame):
        result.to_csv('/tmp/${node.id}.csv', index=False)
    else:
        json.dump(result, open('/tmp/${node.id}.json', 'w'))
    print("Task completed successfully")
`;

  return wrapper;
}

/**
 * Create a wrapper for AWS S3 execution
 * Handles reading from and writing to S3
 */
function createS3Wrapper(
  node: HPCNode,
  upstreamNodes: HPCNode[],
  downstreamNodes: HPCNode[],
  inputPaths: Record<string, string>,
  outputPath: string
): string {
  return `if __name__ == "__main__":
    import boto3
    from io import StringIO

    s3_client = boto3.client('s3')

    # Load inputs from S3
${upstreamNodes
  .map((upstream) => {
    const paramName = upstream.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const path = inputPaths[upstream.id] || `/tmp/${upstream.id}.csv`;
    return `    # Load ${upstream.name}
    with open('${path}', 'r') as f:
        ${paramName} = pd.read_csv(f)`;
  })
  .join('\n\n')}

    # Call task function
    try:
        ${upstreamNodes.length > 0 ? `result = task(${upstreamNodes.map((n) => n.name.toLowerCase().replace(/[^a-z0-9]/g, '_')).join(', ')})` : 'result = task()'}
    except Exception as e:
        print(f"Task failed: {e}")
        sys.exit(1)

    # Save result
    if isinstance(result, pd.DataFrame):
        result.to_csv('${outputPath}/${node.id}.csv', index=False)
    else:
        json.dump(result, open('${outputPath}/${node.id}.json', 'w'))

    print("Task completed successfully")
`;
}
