import crypto from 'node:crypto';
import { publicRoute } from '@/lib/route';
import { getPool, jobs } from '@rppc/db';
import { Unauthorized, NotFound } from '@rppc/core';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Vercel Cron calls this with "Authorization: Bearer $CRON_SECRET". No user session: the secret is the credential.
export const GET = publicRoute('scheduled jobs, called by Vercel Cron with the CRON_SECRET bearer token', async (req, ctx) => {
  const secret = process.env.CRON_SECRET ?? '';
  const got = req.headers.get('authorization') ?? '';
  const want = `Bearer ${secret}`;
  if (!secret || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new Unauthorized();
  const job = ctx.params.job;
  if (job === 'daily') return jobs.runDaily(getPool());
  const j = jobs.JOBS[job]; if (!j) throw new NotFound();
  return { [job]: await j.run(getPool()) };
});
