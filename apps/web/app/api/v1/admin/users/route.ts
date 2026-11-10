import { z } from 'zod';
import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { auth } from '@rppc/db';
export const dynamic = 'force-dynamic';
const In = z.object({ username: z.string().min(3), fullName: z.string().min(1), email: z.string().email().optional().nullable(), roles: z.array(z.string()).min(1),
  password: z.string().optional(), pin: z.string().optional(), employeeId: z.string().uuid().optional().nullable(),
  scope: z.object({ type: z.enum(['client', 'site']), id: z.string().uuid() }).optional() });
export const GET = route(P.USERS_MANAGE, async (_req, _a, tx) => (await tx.query(`SELECT u.id, u.username, u.full_name, u.status, u.auth_method, u.mfa_enabled, u.last_login_at,
  array_agg(r.code) AS roles FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id GROUP BY u.id ORDER BY u.username`)).rows);
export const POST = route(P.USERS_MANAGE, async (req, actor, tx, ctx) => ({ id: await auth.createUser(tx, actor, In.parse(await body(req)), ctx) }));
