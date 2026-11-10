// §10.6 offline field sync: each queued op has a client-generated UUID; a replay returns the stored result, no double effect.
import { z } from 'zod';
import { type Actor, P, requirePermission, AppError } from '@rppc/core';
import { type Pool, withTx, maybe } from '../pool';
import { recordTripEvent, recordPodPhoto, recordSignedDR, assertTripAssignedTo } from './trips';

export const SyncOp = z.object({
  client_op_id: z.string().uuid(),
  type: z.enum(['trip_event', 'pod_photo_ref', 'receiver_signature']),
  trip_id: z.string().uuid(),
  payload: z.record(z.unknown()),
  device_at: z.string().datetime(),
});
export type SyncOpT = z.infer<typeof SyncOp>;

export async function applyOps(pool: Pool, actor: Actor, raw: unknown) {
  requirePermission(actor, P.TRIP_OWN);
  const ops = z.array(SyncOp).max(100).parse(raw);
  const results: unknown[] = [];
  for (const op of ops) {
    try {
      results.push(await withTx(pool, async (tx) => {
        const seen = await maybe<{ result: unknown; user_id: string }>(tx, 'SELECT result, user_id FROM processed_ops WHERE client_op_id=$1', [op.client_op_id]);
        if (seen) {
          if (seen.user_id !== actor.id) throw new AppError('operation id already used', 409);
          return { client_op_id: op.client_op_id, replay: true, result: seen.result };
        }
        await assertTripAssignedTo(tx, actor, op.trip_id);              // scope: own trips only
        const p = op.payload as any;
        let result: unknown;
        if (op.type === 'trip_event') result = await recordTripEvent(tx, actor, op.trip_id, { event: p.event, deviceAt: op.device_at, lat: p.lat, lng: p.lng });
        else if (op.type === 'pod_photo_ref') result = await recordPodPhoto(tx, actor, op.trip_id, { stage: p.stage, fileId: p.file_id, takenAtDevice: p.taken_at ?? op.device_at, lat: p.lat, lng: p.lng, gpsAccuracyM: p.accuracy });
        else result = await recordSignedDR(tx, actor, op.trip_id, { receiverName: p.receiver_name, signatureFileId: p.signature_file_id, delivered: p.delivered ?? [] });
        await tx.query('INSERT INTO processed_ops (client_op_id, user_id, result) VALUES ($1,$2,$3)', [op.client_op_id, actor.id, JSON.stringify(result ?? null)]);
        return { client_op_id: op.client_op_id, ok: true, result };
      }));
    } catch (e) {
      // A failed op is reported back and stays in the phone's queue; it does not block the rest of the batch.
      results.push({ client_op_id: op.client_op_id, ok: false, error: (e as Error).message, status: (e as AppError).status ?? 500 });
    }
  }
  return { results };
}
