import { NextResponse } from 'next/server';
import { sessionRoute, SESSION_COOKIE } from '@/lib/route';
import { auth } from '@rppc/db';
export const POST = sessionRoute('end own session', async (_req, actor, tx, ctx) => {
  await auth.logout(tx, actor, ctx);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE); res.cookies.delete('rppc_csrf');
  return res;
});
