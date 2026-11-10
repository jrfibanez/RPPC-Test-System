import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
export const POST = actions({
  void: { perm: P.DR_VOID, run: (b, a, tx, c, id) => trips.voidDR(tx, a, id, b.reason, c) },
});
