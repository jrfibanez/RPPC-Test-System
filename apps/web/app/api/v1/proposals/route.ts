import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { commercial } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.PROPOSAL_READ, async (_req, _a, tx) => (await tx.query(`SELECT p.*, c.code AS client_code FROM proposals p JOIN clients c ON c.id=p.client_id ORDER BY p.created_at DESC LIMIT 500`)).rows);
export const POST = route(P.PROPOSAL_WRITE, async (req, actor, tx, ctx) => commercial.createProposal(tx, actor, await body(req), ctx));
