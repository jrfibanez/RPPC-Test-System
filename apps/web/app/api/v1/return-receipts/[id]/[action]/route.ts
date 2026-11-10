import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
export const POST = actions({
  receive: { perm: P.RETURN_RECORD, run: (_b, a, tx, c, id) => trips.receiveReturn(tx, a, id, c) },
});
