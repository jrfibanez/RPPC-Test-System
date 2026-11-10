import { getPool } from '@rppc/db';
import { parseVerifyToken } from '@/lib/documents';
export const dynamic = 'force-dynamic';
// Public page behind the QR code on a DR / gate pass: proves the document is genuine and shows its status.
export default async function Verify({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let r: any = null;
  try {
    const { kind, id } = parseVerifyToken(token);
    const sql = kind === 'dr' ? `SELECT 'Delivery receipt' AS kind, dr_no AS no, d.status, d.qty, t.trip_no, tr.plate_no FROM delivery_receipts d JOIN trips t ON t.id=d.trip_id LEFT JOIN trucks tr ON tr.id=t.truck_id WHERE d.id=$1`
      : `SELECT 'Gate pass' AS kind, gp_no AS no, g.status, g.qty, t.trip_no, tr.plate_no FROM gate_passes g JOIN trips t ON t.id=g.trip_id LEFT JOIN trucks tr ON tr.id=t.truck_id WHERE g.id=$1`;
    r = (await getPool().query(sql, [id])).rows[0];
  } catch { r = null; }
  return <main style={{ maxWidth: 480 }}><h1>RPPC document check</h1><div className="card">
    {!r ? <p className="err big">Not a genuine RPPC document.</p> : <>
      <p><span className={`pill ${r.status === 'void' ? 'warn' : 'ok'}`}>{r.status === 'void' ? 'VOID' : 'Genuine'}</span></p>
      <p><b>{r.kind} {r.no}</b><br />Trip ticket {r.trip_no}<br />Truck {r.plate_no ?? 'client pickup'}<br />{r.qty} pallets · status {r.status}</p></>}
  </div></main>;
}
