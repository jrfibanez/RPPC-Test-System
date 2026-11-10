import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { commercial } from '@rppc/db';
import '@/lib/handlers';
export const POST = actions({
  submit: { perm: P.PROPOSAL_WRITE, run: (_b, a, tx, c, id) => commercial.submitProposal(tx, a, id, c) },
  approve: { perm: P.PROPOSAL_APPROVE, run: (b, a, tx, c, id) => commercial.decideProposal(tx, a, id, 'approve', b.note ?? null, c) },
  reject: { perm: P.PROPOSAL_APPROVE, run: (b, a, tx, c, id) => commercial.decideProposal(tx, a, id, 'reject', b.note ?? null, c) },
  send: { perm: P.PROPOSAL_SEND, run: (_b, a, tx, c, id) => commercial.sendProposal(tx, a, id, c) },
  conforme: { perm: P.CONTRACT_WRITE, run: (b, a, tx, c, id) => commercial.recordConforme(tx, a, id, b, c) },
  contract: { perm: P.CONTRACT_WRITE, run: (b, a, tx, c, id) => commercial.createContractFromProposal(tx, a, id, b, c) },
});
