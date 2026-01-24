import { NextRequest, NextResponse } from 'next/server';
import { getFile, deleteFile, getFileMetadata } from '@/app/lib/s3';

export async function GET(
  request: NextRequest,
  { params }: { params: { fileId: string } }
) {
  try {
    const fileId = decodeURIComponent(params.fileId);
    const download = request.nextUrl.searchParams.get('download') === 'true';

    // Get file from S3
    const fileBuffer = await getFile(fileId);

    // If download query param is true, force download
    if (download) {
      const headers = new Headers();
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename="${fileId}"`);
      headers.set('Content-Length', fileBuffer.length.toString());

      return new NextResponse(fileBuffer, {
        status: 200,
        headers,
      });
    }

    // Otherwise return as JSON (for text files) or as blob
    const headers = new Headers();
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Length', fileBuffer.length.toString());

    return new NextResponse(fileBuffer, {
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
  { params }: { params: { fileId: string } }
) {
  try {
    const fileId = decodeURIComponent(params.fileId);

    // Delete file from S3
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

/**
 * Optional: Get file metadata without downloading
 */
export async function HEAD(
  request: NextRequest,
  { params }: { params: { fileId: string } }
) {
  try {
    const fileId = decodeURIComponent(params.fileId);

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
