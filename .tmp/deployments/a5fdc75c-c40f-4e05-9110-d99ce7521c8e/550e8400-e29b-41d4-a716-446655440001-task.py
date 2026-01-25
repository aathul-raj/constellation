#!/usr/bin/env python3
"""
Auto-generated task script for: Process Data
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
OUTPUT_PATH = os.environ.get('OUTPUT_PATH', '550e8400-e29b-41d4-a716-446655440001/output.csv')

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
    Tries local filesystem first, then S3.
    """
    # Try local filesystem first
    if os.path.exists(path):
        try:
            return pd.read_csv(path)
        except Exception as e:
            print(f"Warning: Could not read {path} locally: {e}")

    # Try S3
    if HAS_S3:
        try:
            print(f"Reading from S3: s3://{BUCKET_NAME}/{path}")
            obj = s3_client.get_object(Bucket=BUCKET_NAME, Key=path)
            return pd.read_csv(StringIO(obj['Body'].read().decode('utf-8')))
        except Exception as e:
            raise Exception(f"Could not read {path} from local filesystem or S3: {e}")

    raise Exception(f"Could not read {path} - file not found locally and S3 access not available")

def task(input_data):  # do not edit this method header
    import numpy as np
    import pandas as pd

    # Your code here

    
    
    

    # return the output df
    return input_data

if __name__ == "__main__":
    try:
        # Load Input Data from local file or S3
        input_path_550e8400_e29b_41d4_a716_446655440000 = os.environ.get('INPUT_550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000/output.csv')
        input_data = read_csv_smart(input_path_550e8400_e29b_41d4_a716_446655440000)

        # Call task function with inputs
        result = task(input_data)

        # Write output to local file or S3
        if os.path.dirname(OUTPUT_PATH):
            os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)

        print(f"Writing output to {OUTPUT_PATH}")

        # Try local filesystem first
        try:
            result.to_csv(OUTPUT_PATH, index=False)
            print("Output written to local filesystem")
        except Exception as e:
            # Fall back to S3 if local write fails
            if HAS_S3:
                try:
                    print("Attempting to write to S3...")
                    csv_buffer = StringIO()
                    result.to_csv(csv_buffer, index=False)
                    s3_client.put_object(
                        Bucket=BUCKET_NAME,
                        Key=OUTPUT_PATH,
                        Body=csv_buffer.getvalue().encode('utf-8')
                    )
                    print("Output written to S3")
                except Exception as s3_error:
                    raise Exception(f"Could not write output to local filesystem or S3: {e} / {s3_error}")
            else:
                raise e

        print("Task completed successfully")

    except Exception as e:
        print(f"Task failed: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
