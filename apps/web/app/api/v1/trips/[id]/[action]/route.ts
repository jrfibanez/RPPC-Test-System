import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
import '@/lib/handlers';
export const POST = actions({
  voucher: { perm: P.VOUCHER_REQUEST, run: (b, a, tx, c, id) => trips.requestVoucher(tx, a, id, b, c) },
  dr: { perm: P.DR_ISSUE, run: (_b, a, tx, c, id) => trips.issueDR(tx, a, id, c) },
  'gate-pass': { perm: P.DR_ISSUE, run: (_b, a, tx, c, id) => trips.issueGatePass(tx, a, id, c) },
  'start-loading': { perm: P.TRIP_DISPATCH, run: (_b, a, tx, c, id) => trips.startLoading(tx, a, id, c) },
  loaded: { perm: P.TRIP_DISPATCH, run: (b, a, tx, c, id) => trips.recordLoaded(tx, a, id, b.lines, c) },
  'verify-gate': { perm: P.GATEPASS_VERIFY, run: (b, a, tx, c, id) => trips.verifyGatePass(tx, a, id, { plateNo: b.plateNo, qty: Number(b.qty) }, c) },
  event: { perm: P.TRIP_OWN, run: (b, a, tx, c, id) => trips.recordTripEvent(tx, a, id, b, c) },
  photo: { perm: P.POD_UPLOAD, run: (b, a, tx, c, id) => trips.recordPodPhoto(tx, a, id, b, c) },
  'signed-dr': { perm: P.DR_RECEIVE, run: (b, a, tx, c, id) => trips.recordSignedDR(tx, a, id, b, c) },
  'external-dr': { perm: P.DR_ISSUE, run: async (b, a, tx, c, id) => {
    const dr = (await tx.query(`SELECT id FROM delivery_receipts WHERE trip_id=$1 AND status <> 'void'`, [id])).rows[0];
    return trips.attachExternalDR(tx, a, dr.id, b.externalDrNo, b.fileId, c);
  } },
  close: { perm: P.TRIP_WRITE, run: (_b, a, tx, c, id) => trips.closeTrip(tx, a, id, c) },
  cancel: { perm: P.TRIP_WRITE, run: (b, a, tx, c, id) => trips.cancelTrip(tx, a, id, b.reason, c) },
});
