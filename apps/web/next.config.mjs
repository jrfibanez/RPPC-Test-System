/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@rppc/core', '@rppc/db', '@rppc/pdf'],
  serverExternalPackages: ['qrcode', '@node-rs/argon2', 'pg', 'playwright', 'playwright-core'],
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
