import { NextRequest, NextResponse } from 'next/server';
import { generatePresignedUploadUrl } from '@/app/lib/s3';

export async function POST(request: NextRequest) {
  try {
    const { fileName, contentType } = await request.json();

    if (!fileName) {
      return NextResponse.json(
        { error: 'fileName is required' },
        { status: 400 }
      );
    }

    const result = await generatePresignedUploadUrl(fileName, contentType || 'text/csv');

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('Presigned URL generation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate presigned URL' },
      { status: 500 }
    );
  }
}
