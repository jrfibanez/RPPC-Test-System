import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
export const POST = actions({
  approve: { perm: P.TRIP_APPROVE_BUDGET, run: (b, a, tx, c, id) => trips.decideVoucher(tx, a, id, 'approve', b.note ?? null, c) },
  reject: { perm: P.TRIP_APPROVE_BUDGET, run: (b, a, tx, c, id) => trips.decideVoucher(tx, a, id, 'reject', b.note ?? null, c) },
  release: { perm: P.TRIP_RELEASE_BUDGET, run: (_b, a, tx, c, id) => trips.releaseVoucher(tx, a, id, c) },
  liquidate: { perm: P.VOUCHER_REQUEST, run: (b, a, tx, c, id) => trips.liquidateVoucher(tx, a, id, b.actualAmount, c) },
  void: { perm: P.VOUCHER_REQUEST, run: (b, a, tx, c, id) => trips.voidVoucher(tx, a, id, b.reason, c) },
});
