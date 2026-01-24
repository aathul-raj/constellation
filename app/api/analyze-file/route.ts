import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Read file content
    const buffer = await file.arrayBuffer();
    const content = Buffer.from(buffer).toString('utf-8');

    // Analyze based on file type
    const fileType = file.name.split('.').pop()?.toLowerCase();
    let analysis;

    if (fileType === 'csv') {
      analysis = analyzeCSV(content, file.name);
    } else if (fileType === 'json') {
      analysis = analyzeJSON(content, file.name);
    } else if (fileType === 'txt') {
      analysis = analyzeText(content, file.name);
    } else {
      analysis = {
        fileName: file.name,
        fileType: fileType || 'unknown',
        size: file.size,
        preview: content.substring(0, 500)
      };
    }

    return NextResponse.json(analysis);
  } catch (error) {
    console.error("File analysis error:", error);
    return NextResponse.json(
      {
        error: "Failed to analyze file",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

function analyzeCSV(content: string, fileName: string) {
  const lines = content.split('\n').filter(line => line.trim());

  if (lines.length === 0) {
    return { fileName, fileType: 'csv', error: 'Empty file' };
  }

  // Parse header
  const header = lines[0].split(',').map(col => col.trim().replace(/^"|"$/g, ''));

  // Get sample rows (up to 5)
  const sampleRows = lines.slice(1, 6).map(line => {
    const values = line.split(',').map(val => val.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string> = {};
    header.forEach((col, idx) => {
      row[col] = values[idx] || '';
    });
    return row;
  });

  // Infer column types
  const columnTypes: Record<string, string> = {};
  header.forEach((col, idx) => {
    const sampleValues = sampleRows.map(row => row[col]).filter(v => v);
    columnTypes[col] = inferType(sampleValues);
  });

  return {
    fileName,
    fileType: 'csv',
    rowCount: lines.length - 1, // excluding header
    columns: header,
    columnTypes,
    sampleRows,
    preview: lines.slice(0, 6).join('\n')
  };
}

function analyzeJSON(content: string, fileName: string) {
  try {
    const data = JSON.parse(content);
    const isArray = Array.isArray(data);

    let schema = {};
    let sampleRows = [];

    if (isArray && data.length > 0) {
      // Array of objects
      schema = Object.keys(data[0]).reduce((acc, key) => {
        acc[key] = typeof data[0][key];
        return acc;
      }, {} as Record<string, string>);
      sampleRows = data.slice(0, 5);
    } else {
      // Single object
      schema = Object.keys(data).reduce((acc, key) => {
        acc[key] = typeof data[key];
        return acc;
      }, {} as Record<string, string>);
    }

    return {
      fileName,
      fileType: 'json',
      isArray,
      itemCount: isArray ? data.length : 1,
      schema,
      sampleRows,
      preview: JSON.stringify(data, null, 2).substring(0, 500)
    };
  } catch (error) {
    return {
      fileName,
      fileType: 'json',
      error: 'Invalid JSON',
      preview: content.substring(0, 500)
    };
  }
}

function analyzeText(content: string, fileName: string) {
  const lines = content.split('\n');

  return {
    fileName,
    fileType: 'txt',
    lineCount: lines.length,
    preview: lines.slice(0, 10).join('\n')
  };
}

function inferType(values: string[]): string {
  if (values.length === 0) return 'unknown';

  const allNumbers = values.every(v => !isNaN(Number(v)));
  if (allNumbers) return 'number';

  const allDates = values.every(v => !isNaN(Date.parse(v)));
  if (allDates) return 'date';

  return 'string';
}
