import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const metadata: Metadata = { title: 'RPPC Operations', description: 'Red Pallet Provider Co. one-stop operations system', manifest: '/manifest.webmanifest' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#b3121b' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <body data-nonce={nonce ? 'set' : 'none'}>{children}</body>
    </html>
  );
}
