import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { billing } from '@rppc/db';
import '@/lib/handlers';
export const POST = actions({
  'submit-review': { perm: P.BILL_WRITE, run: (_b, a, tx, c, id) => billing.submitForReview(tx, a, id, c) },
  review: { perm: P.BILL_REVIEW, run: (b, a, tx, c, id) => billing.reviewSummary(tx, a, id, b.decision ?? 'approve', b.note ?? null, c) },
  send: { perm: P.BILL_WRITE, run: (_b, a, tx, c, id) => billing.sendToClient(tx, a, id, c) },
  'client-approval': { perm: P.BILL_WRITE, run: (b, a, tx, c, id) => billing.recordClientApproval(tx, a, id, b, c) },
  dispute: { perm: P.BILL_WRITE, run: (b, a, tx, c, id) => billing.recordDispute(tx, a, id, b.reason, c) },
  invoice: { perm: P.BILL_WRITE, run: (b, a, tx, c, id) => billing.recordInvoice(tx, a, id, b, c) },
  void: { perm: P.BILL_WRITE, run: (b, a, tx, c, id) => billing.voidSummary(tx, a, id, b.reason, c) },
});
