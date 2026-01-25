import { HPCNode, HPCGraph } from '@/app/store/hpc-store';

/**
 * Create a complete executable Python script from a compute node
 *
 * For AWS Batch deployment (production):
 * - Reads inputs from S3 using environment variables
 * - Writes output to S3
 * - Uses boto3 for file I/O
 */
export function createExecutableScript(node: HPCNode, graph: HPCGraph): string {
  const upstreamNodes = graph.nodes.filter((n) => node.in.includes(n.id));

  let script = `#!/usr/bin/env python3
"""
Auto-generated task script for: ${node.name}
"""

import pandas as pd
import numpy as np
import json
import sys
import os
import boto3
from io import StringIO

# AWS configuration from environment variables
BUCKET_NAME = os.environ.get('BUCKET_NAME', 'hpc-bucket')
OUTPUT_PATH = os.environ.get('OUTPUT_PATH', '${node.id}/output.csv')

s3_client = boto3.client('s3')

${node.code}

if __name__ == "__main__":
    try:
`;

  // Load inputs from S3
  if (upstreamNodes.length === 0) {
    script += `        # No inputs, call function directly
        result = task()
`;
  } else {
    upstreamNodes.forEach((upstream) => {
      const paramName = upstream.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const envVarName = `INPUT_${upstream.id}`;
      script += `        # Load ${upstream.name} from S3
        input_path_${upstream.id} = os.environ.get('${envVarName}', '${upstream.id}/output.csv')
        obj = s3_client.get_object(Bucket=BUCKET_NAME, Key=input_path_${upstream.id})
        ${paramName} = pd.read_csv(StringIO(obj['Body'].read().decode('utf-8')))
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
        # Write output to S3
        csv_buffer = StringIO()
        result.to_csv(csv_buffer, index=False)
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=OUTPUT_PATH,
            Body=csv_buffer.getvalue().encode('utf-8')
        )
        print("Task completed successfully")

    except Exception as e:
        print(f"Task failed: {str(e)}")
        sys.exit(1)
`;

  return script;
}
