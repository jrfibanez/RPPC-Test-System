// Strict CSP with a per-request nonce (§8.5: no inline scripts), frame-ancestors 'none'.
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    `worker-src 'self'`, `manifest-src 'self'`,
    `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`,
  ].join('; ');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);   // Next.js reads the nonce from here and applies it to its own scripts
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}
export const config = { matcher: [{ source: '/((?!api|_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest).*)' }] };
