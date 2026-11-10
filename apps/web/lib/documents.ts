// DR and gate pass documents (§5 M5): PDF with a QR code pointing at the public verify URL.
import crypto from 'node:crypto';
import type { Tx } from '@rppc/db';
import { NotFound } from '@rppc/core';
import { drHtml, type DrDoc } from '@rppc/pdf';

function key(): Buffer {
  const k = process.env.APP_ENCRYPTION_KEY; if (!k) throw new Error('APP_ENCRYPTION_KEY is not configured');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(k, 'base64'), Buffer.alloc(0), Buffer.from('rppc-qr'), 32));
}
/** Verify token = kind + id + HMAC; unguessable, so the public verify page cannot be used to enumerate documents. */
export function verifyToken(kind: 'dr' | 'gp', id: string): string {
  const mac = crypto.createHmac('sha256', key()).update(`${kind}:${id}`).digest('base64url').slice(0, 22);
  return `${kind}.${id}.${mac}`;
}
export function parseVerifyToken(t: string): { kind: 'dr' | 'gp'; id: string } {
  const [kind, id, mac] = t.split('.');
  if ((kind !== 'dr' && kind !== 'gp') || !/^[0-9a-f-]{36}$/.test(id ?? '') || verifyToken(kind, id) !== t) throw new NotFound();
  void mac; return { kind, id };
}

export async function tripDocument(tx: Tx, tripId: string, kind: 'dr' | 'gp'): Promise<DrDoc> {
  const t = (await tx.query(`SELECT t.*, tr.plate_no, e.full_name AS driver, so.so_no, c.legal_name, s.name AS site, s.address
    FROM trips t JOIN work_orders wo ON wo.id=t.work_order_id JOIN sales_orders so ON so.id=wo.sales_order_id
    JOIN clients c ON c.id=so.client_id JOIN client_sites s ON s.id=so.site_id LEFT JOIN trucks tr ON tr.id=t.truck_id LEFT JOIN employees e ON e.id=t.driver_id
    WHERE t.id=$1`, [tripId])).rows[0];
  if (!t) throw new NotFound('trip not found');
  const doc = kind === 'dr'
    ? (await tx.query(`SELECT id, dr_no AS no, created_at, status, receiver_name, received_at, external_dr_no FROM delivery_receipts WHERE trip_id=$1 ORDER BY (status='void'), created_at DESC LIMIT 1`, [tripId])).rows[0]
    : (await tx.query(`SELECT id, gp_no AS no, created_at, status FROM gate_passes WHERE trip_id=$1 ORDER BY (status='void'), created_at DESC LIMIT 1`, [tripId])).rows[0];
  if (!doc) throw new NotFound(`no ${kind === 'dr' ? 'DR' : 'gate pass'} issued`);
  const lines = (await tx.query(`SELECT pt.code AS type, l.condition, COALESCE(l.qty_loaded, l.qty_planned) AS qty FROM trip_lines l JOIN pallet_types pt ON pt.id=l.pallet_type_id WHERE l.trip_id=$1`, [tripId])).rows;
  const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  return {
    kind: kind === 'dr' ? 'DELIVERY RECEIPT' : 'GATE PASS', docNo: doc.no, tripNo: t.trip_no, soNo: t.so_no, issuedAt: doc.created_at,
    client: t.legal_name, site: t.site, siteAddress: t.address, plateNo: t.plate_no, driver: t.driver, lines,
    total: lines.reduce((s: number, l: any) => s + Number(l.qty), 0), verifyUrl: `${base}/verify/${verifyToken(kind, doc.id)}`, status: doc.status,
    receiverName: doc.receiver_name, receivedAt: doc.received_at, externalDrNo: doc.external_dr_no,
  };
}
export { drHtml };
