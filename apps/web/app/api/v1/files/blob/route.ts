import { NextResponse, type NextRequest } from 'next/server';
import { publicRoute, reqCtx } from '@/lib/route';
import { files, getPool, withTx } from '@rppc/db';
import { AppError } from '@rppc/core';
// The HMAC-signed, 5-minute URL is the capability (S3 presigned-URL equivalent); no cookie needed.
export const PUT = publicRoute('presigned upload (signature in the URL is the capability)', async (req: NextRequest) => {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > 15 * 1024 * 1024) throw new AppError('too large', 413);
  const buf = Buffer.from(await req.arrayBuffer());
  return withTx(getPool(), (tx) => files.storeUpload(tx, req.nextUrl.searchParams, buf, reqCtx(req)));
});
export const GET = publicRoute('presigned download (signature in the URL is the capability)', async (req: NextRequest) => {
  const { body } = await files.readBlob(req.nextUrl.searchParams);
  return new NextResponse(new Uint8Array(body), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store', 'content-disposition': 'attachment' } });
});
