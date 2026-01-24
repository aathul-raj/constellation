import { NextRequest, NextResponse } from 'next/server';
import { getFile, deleteFile, getFileMetadata } from '@/app/lib/s3';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> } 
) {
  try {
    const { fileId: rawFileId } = await params; 
    const fileId = decodeURIComponent(rawFileId);
    
    const download = request.nextUrl.searchParams.get('download') === 'true';

    const fileBuffer = await getFile(fileId);

    if (download) {
      const headers = new Headers();
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename="${fileId}"`);
      headers.set('Content-Length', fileBuffer.length.toString());

      return new NextResponse(new Uint8Array(fileBuffer), {
        status: 200,
        headers,
      });
    }

    const headers = new Headers();
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Length', fileBuffer.length.toString());

    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('Get file error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get file' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const { fileId: rawFileId } = await params;
    const fileId = decodeURIComponent(rawFileId);

    await deleteFile(fileId);

    return NextResponse.json(
      { message: 'File deleted successfully', fileId },
      { status: 200 }
    );
  } catch (error) {
    console.error('Delete file error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete file' },
      { status: 500 }
    );
  }
}

export async function HEAD(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const { fileId: rawFileId } = await params;
    const fileId = decodeURIComponent(rawFileId);

    const metadata = await getFileMetadata(fileId);

    const headers = new Headers();
    headers.set('Content-Type', metadata.contentType || 'application/octet-stream');
    headers.set('Content-Length', metadata.size?.toString() || '0');

    return new NextResponse(null, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('Head file error:', error);
    return new NextResponse(null, { status: 404 });
  }
}