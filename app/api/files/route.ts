import { NextRequest, NextResponse } from 'next/server';
import { listFiles } from '@/app/lib/s3';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const prefix = searchParams.get('prefix') || undefined;

    const files = await listFiles(prefix || undefined);

    return NextResponse.json(
      { files, count: files.length },
      { status: 200 }
    );
  } catch (error) {
    console.error('List files error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list files' },
      { status: 500 }
    );
  }
}
