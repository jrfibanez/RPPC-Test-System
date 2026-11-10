import { route } from '@/lib/route';
import { P } from '@rppc/core';
export const dynamic = 'force-dynamic';
// §13 dashboards (operations + owner basics).
export const GET = route(P.INV_READ, async (_req, _a, tx) => {
  const q = async (sql: string, p: unknown[] = []) => (await tx.query(sql, p)).rows;
  const [byLoc, today, noPod, pendingVouchers, billing] = await Promise.all([
    q(`SELECT l.type, COALESCE(sum(b.qty),0)::int AS qty FROM v_pallet_balance b JOIN inventory_locations l ON l.id=b.location_id WHERE l.type <> 'external' GROUP BY l.type`),
    q(`SELECT status, count(*)::int AS n FROM trips WHERE planned_date = (now() AT TIME ZONE 'Asia/Manila')::date GROUP BY status`),
    q(`SELECT count(*)::int AS n FROM delivery_receipts WHERE status IN ('issued','delivered') AND created_at < now() - interval '1 day'`),
    q(`SELECT count(*)::int AS n FROM vouchers WHERE status IN ('requested','approved')`),
    q(`SELECT status, count(*)::int AS n, COALESCE(sum(total_vat_ex),0)::text AS total FROM billing_summaries WHERE status <> 'void' GROUP BY status`),
  ]);
  return { byLocation: byLoc, tripsToday: today, drWithoutPod: noPod[0].n, pendingVouchers: pendingVouchers[0].n, billing };
});
