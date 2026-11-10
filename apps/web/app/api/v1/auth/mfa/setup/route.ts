import { sessionRoute } from '@/lib/route';
import { auth } from '@rppc/db';
export const POST = sessionRoute('own TOTP enrolment', async (_req, actor, tx) => auth.mfaSetup(tx, actor.id));
