#!/usr/bin/env python3
"""
Auto-generated task script for: Process Data
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
OUTPUT_PATH = os.environ.get('OUTPUT_PATH', '550e8400-e29b-41d4-a716-446655440001/output.csv')

s3_client = boto3.client('s3')

def task(input_data):  # do not edit this method header
    import numpy as np
    import pandas as pd

    # Your code here

    
    
    

    # return the output df
    return input_data

if __name__ == "__main__":
    try:
        # Load Input Data from S3
        input_path_550e8400_e29b_41d4_a716_446655440000 = os.environ.get('INPUT_550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000/output.csv')
        obj = s3_client.get_object(Bucket=BUCKET_NAME, Key=input_path_550e8400_e29b_41d4_a716_446655440000)
        input_data = pd.read_csv(StringIO(obj['Body'].read().decode('utf-8')))

        # Call task function with inputs
        result = task(input_data)

        # Write output to S3
        print(f"Writing output to s3://{BUCKET_NAME}/{OUTPUT_PATH}")
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
        import traceback
        traceback.print_exc()
        sys.exit(1)
