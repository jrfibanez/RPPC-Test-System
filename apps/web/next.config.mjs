import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  // Monorepo: trace server files from the repository root, and ship the serverless Chromium binary with the PDF route.
  outputFileTracingRoot: path.join(here, '../..'),
  outputFileTracingIncludes: { '/api/v1/trips/[id]/documents/[doc]': ['../../node_modules/.pnpm/@sparticuz+chromium@*/node_modules/@sparticuz/chromium/bin/**'] },
  transpilePackages: ['@rppc/core', '@rppc/db', '@rppc/pdf'],
  serverExternalPackages: ['qrcode', '@sparticuz/chromium', 'playwright-core', '@node-rs/argon2', 'pg', 'playwright'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self), microphone=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    ] }];
  },
};
