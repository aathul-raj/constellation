import { NextRequest, NextResponse } from 'next/server';
import { uploadFile } from '@/app/lib/s3';
import AdmZip from 'adm-zip';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` },
        { status: 400 }
      );
    }

    // Convert file to buffer
    const buffer = Buffer.from(await file.arrayBuffer());

    // Check if file is a ZIP
    if (file.name.endsWith('.zip')) {
      try {
        const zip = new AdmZip(buffer);
        const zipEntries = zip.getEntries();

        // Filter for CSV files only
        const csvEntries = zipEntries.filter(entry =>
          !entry.isDirectory && entry.entryName.toLowerCase().endsWith('.csv')
        );

        if (csvEntries.length === 0) {
          return NextResponse.json(
            { error: 'No CSV files found in ZIP archive' },
            { status: 400 }
          );
        }

        // Upload each CSV file
        const uploadedFiles = [];
        for (const entry of csvEntries) {
          const csvBuffer = entry.getData();
          const originalName = entry.entryName.split('/').pop() || entry.entryName;
          const fileName = `${Date.now()}-${originalName}`;

          const result = await uploadFile(csvBuffer, fileName);
          uploadedFiles.push({
            ...result,
            originalName
          });
        }

        return NextResponse.json({
          files: uploadedFiles,
          count: uploadedFiles.length,
          message: `Extracted and uploaded ${uploadedFiles.length} CSV file(s) from ZIP`
        }, { status: 200 });
      } catch (zipError) {
        console.error('ZIP extraction error:', zipError);
        return NextResponse.json(
          { error: 'Failed to extract ZIP file. Make sure it\'s a valid ZIP archive.' },
          { status: 400 }
        );
      }
    } else {
      // Single file upload (CSV)
      const fileName = `${Date.now()}-${file.name}`;
      const result = await uploadFile(buffer, fileName);

      return NextResponse.json(result, { status: 200 });
    }
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upload file' },
      { status: 500 }
    );
  }
}
