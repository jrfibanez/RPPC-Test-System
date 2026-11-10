import { route } from '@/lib/route';
import { P } from '@rppc/core';
import { ledger } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.INV_READ, async (_req, actor, tx) => ledger.balances(tx, actor));
