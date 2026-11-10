import { route } from '@/lib/route';
import { P } from '@rppc/core';
import { payroll } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.PAY_READ_OWN, async (_req, actor, tx) => payroll.myEarnings(tx, actor));
