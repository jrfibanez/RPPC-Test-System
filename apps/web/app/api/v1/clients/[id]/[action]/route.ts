import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { masters } from '@rppc/db';
export const POST = actions({
  accredit: { perm: P.CLIENT_ACCREDIT, run: (b, a, tx, c, id) => masters.accreditClient(tx, a, id, b.fileId, c) },
  suspend: { perm: P.CLIENT_ACCREDIT, run: (b, a, tx, c, id) => masters.suspendClient(tx, a, id, b.reason, c) },
  sites: { perm: P.CLIENT_WRITE, run: (b, a, tx, c, id) => masters.createSite(tx, a, id, b, c) },
  cutoff: { perm: P.CLIENT_WRITE, run: (b, a, tx, c, id) => masters.setCutoff(tx, a, id, Number(b.cutoffDay), b.effectiveFrom, b.reason ?? null, c) },
});
