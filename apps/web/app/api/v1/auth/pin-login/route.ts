import { NextResponse } from 'next/server';
import { z } from 'zod';
import { publicRoute, body, setSessionCookies } from '@/lib/route';
import { getPool, auth } from '@rppc/db';
const In = z.object({ username: z.string().min(1).max(200), pin: z.string().regex(/^\d{6}$/), deviceId: z.string().uuid() });
export const POST = publicRoute('field sign-in with PIN + enrolled device (no session yet)', async (req, ctx) => {
  const b = In.parse(await body(req));
  const s = await auth.txCommitOnFailure(getPool(), (tx) => auth.pinLogin(tx, b.username, b.pin, b.deviceId, ctx));
  return setSessionCookies(NextResponse.json({ ok: true, csrf: s.csrf }), s.token, s.csrf, s.expiresAt);
});
