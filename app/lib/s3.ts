import { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';

// Initialize S3 Client
const s3Client = new S3Client({
  region: process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const bucketName = process.env.S3_BUCKET_NAME || '';

export interface UploadResponse {
  key: string;
  bucket: string;
  url: string;
}

export interface FileMetadata {
  key: string;
  size?: number;
  lastModified?: Date;
  url: string;
}

/**
 * Upload a file to S3 bucket
 */
export async function uploadFile(file: Buffer, fileName: string): Promise<UploadResponse> {
  if (!bucketName) {
    throw new Error('S3_BUCKET_NAME not configured');
  }

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucketName,
      Key: fileName,
      Body: file,
    },
  });

  await upload.done();

  const getCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: fileName,
  });

  const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });

  return {
    key: fileName,
    bucket: bucketName,
    url,
  };
}

/**
 * Get/Download a file from S3
 */
export async function getFile(fileKey: string): Promise<Buffer> {
  if (!bucketName) {
    throw new Error('S3_BUCKET_NAME not configured');
  }

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: fileKey,
  });

  const response = await s3Client.send(command);

  if (!response.Body) {
    throw new Error('File not found');
  }

  // Convert stream to buffer
  const chunks: Uint8Array[] = [];
  const body = response.Body as any;

  for await (const chunk of body) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Get file metadata without downloading full content
 */
export async function getFileMetadata(fileKey: string) {
  if (!bucketName) {
    throw new Error('S3_BUCKET_NAME not configured');
  }

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: fileKey,
  });

  const response = await s3Client.send(command);

  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

  return {
    key: fileKey,
    size: response.ContentLength,
    lastModified: response.LastModified,
    url,
    contentType: response.ContentType,
  };
}

/**
 * List all files in S3 bucket
 */
export async function listFiles(prefix?: string): Promise<FileMetadata[]> {
  if (!bucketName) {
    throw new Error('S3_BUCKET_NAME not configured');
  }

  const command = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
  });

  const response = await s3Client.send(command);

  if (!response.Contents) {
    return [];
  }

  return Promise.all(
    response.Contents.map(async (obj) => {
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: obj.Key || '',
      });

      const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });

      return {
        key: obj.Key || '',
        size: obj.Size,
        lastModified: obj.LastModified,
        url,
      };
    })
  );
}

/**
 * Delete a file from S3
 */
export async function deleteFile(fileKey: string): Promise<void> {
  if (!bucketName) {
    throw new Error('S3_BUCKET_NAME not configured');
  }

  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: fileKey,
  });

  await s3Client.send(command);
}
