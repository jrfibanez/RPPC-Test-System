import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { commercial, trips } from '@rppc/db';
import '@/lib/handlers';
export const POST = actions({
  submit: { perm: P.SO_CREATE, run: (_b, a, tx, c, id) => commercial.submitSalesOrder(tx, a, id, c) },
  approve: { perm: P.SO_APPROVE, run: (b, a, tx, c, id) => commercial.decideSalesOrder(tx, a, id, 'approve', b.note ?? null, c) },
  reject: { perm: P.SO_APPROVE, run: (b, a, tx, c, id) => commercial.decideSalesOrder(tx, a, id, 'reject', b.note ?? null, c) },
  cancel: { perm: P.SO_CREATE, run: (b, a, tx, c, id) => commercial.cancelSalesOrder(tx, a, id, b.reason, c) },
  void: { perm: P.SO_APPROVE, run: (b, a, tx, c, id) => commercial.voidSalesOrder(tx, a, id, b.reason, c) },
  'work-orders': { perm: P.TRIP_WRITE, run: (b, a, tx, c, id) => trips.createWorkOrder(tx, a, id, { qty: Number(b.qty), plannedDate: b.plannedDate }, c) },
});
