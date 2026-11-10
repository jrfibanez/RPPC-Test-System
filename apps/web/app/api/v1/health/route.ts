import { publicRoute } from '@/lib/route';
import { getPool } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = publicRoute('health check for the load balancer', async () => {
  await getPool().query('SELECT 1');
  return { ok: true };
});
