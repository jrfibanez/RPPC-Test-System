import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { commercial } from '@rppc/db';
export const POST = actions({
  sign: { perm: P.CONTRACT_WRITE, run: (b, a, tx, c, id) => commercial.signContract(tx, a, id, b, c) },
});
