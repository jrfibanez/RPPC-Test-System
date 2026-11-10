import { NextResponse } from 'next/server';
import { z } from 'zod';
import { publicRoute, body, setSessionCookies } from '@/lib/route';
import { getPool, auth } from '@rppc/db';
const In = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) });
export const POST = publicRoute('sign-in (no session yet)', async (req, ctx) => {
  const b = In.parse(await body(req));
  const s = await auth.txCommitOnFailure(getPool(), (tx) => auth.passwordLogin(tx, b.username, b.password, ctx));
  return setSessionCookies(NextResponse.json({ mfaRequired: s.mfaRequired, mfaEnrolled: s.mfaEnrolled, csrf: s.csrf }), s.token, s.csrf, s.expiresAt);
});
