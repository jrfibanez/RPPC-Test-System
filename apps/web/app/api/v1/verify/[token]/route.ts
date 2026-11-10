import { publicRoute } from '@/lib/route';
import { getPool } from '@rppc/db';
import { parseVerifyToken } from '@/lib/documents';
import { NotFound } from '@rppc/core';
export const dynamic = 'force-dynamic';
// QR verify (§5 M5): confirms a document is genuine and shows only number, status, quantity and plate. Token is an HMAC.
export const GET = publicRoute('QR code verification of a DR / gate pass', async (_req, ctx) => {
  const { kind, id } = parseVerifyToken(ctx.params.token);
  const sql = kind === 'dr'
    ? `SELECT d.dr_no AS no, d.status, d.qty, t.trip_no, tr.plate_no FROM delivery_receipts d JOIN trips t ON t.id=d.trip_id LEFT JOIN trucks tr ON tr.id=t.truck_id WHERE d.id=$1`
    : `SELECT g.gp_no AS no, g.status, g.qty, t.trip_no, tr.plate_no FROM gate_passes g JOIN trips t ON t.id=g.trip_id LEFT JOIN trucks tr ON tr.id=t.truck_id WHERE g.id=$1`;
  const r = (await getPool().query(sql, [id])).rows[0];
  if (!r) throw new NotFound();
  return { genuine: true, kind, tripId: undefined, ...r };
});
