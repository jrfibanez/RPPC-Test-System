// The route() wrapper of §10.3 for Next.js route handlers (CLAUDE.md rule 1): every handler declares its permission.
// It loads the actor from the session cookie, checks CSRF on mutating requests, enforces the permission (incl. PIN and
// step-up rules), maps errors to safe JSON (no stack traces, §8.5), and audits denied attempts in their own transaction
// so a blocked self-approval / dispatch / negative-stock attempt is on record (Phase 1 acceptance 3).
import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { type Actor, type Permission, requirePermission, AppError, Unauthorized } from '@rppc/core';
import { getPool, withTx, audit, auth, type Tx, type RequestCtx } from '@rppc/db';

export const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-rppc' : 'rppc_session';
export const CSRF_HEADER = 'x-csrf-token';

export interface Ctx extends RequestCtx { requestId: string; params: Record<string, string> }
type Handler = (req: NextRequest, actor: Actor, tx: Tx, ctx: Ctx) => Promise<Response | unknown>;
type PublicHandler = (req: NextRequest, ctx: Ctx) => Promise<Response | unknown>;

export function reqCtx(req: NextRequest, params: Record<string, string> = {}): Ctx {
  return {
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    ip: (req.headers.get('x-forwarded-for')?.split(',')[0] ?? '').trim() || '127.0.0.1',
    userAgent: req.headers.get('user-agent'), params,
  };
}

export function toResponse(e: unknown, requestId: string): Response {
  if (e instanceof ZodError) return NextResponse.json({ error: 'invalid input', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), requestId }, { status: 422 });
  if (e instanceof AppError) return NextResponse.json({ error: e.message, code: e.code, requestId }, { status: e.status });
  const pgErr = e as { code?: string; constraint?: string; message?: string };
  if (pgErr?.code === '23505' || pgErr?.code === '23P01') return NextResponse.json({ error: 'conflicts with an existing record', constraint: pgErr.constraint, requestId }, { status: 409 });
  if (pgErr?.code === '23514' || pgErr?.code === '23503') return NextResponse.json({ error: 'not allowed by a data rule', constraint: pgErr.constraint, requestId }, { status: 422 });
  if (pgErr?.code === 'P0001') return NextResponse.json({ error: pgErr.message, requestId }, { status: 422 });   // RAISE EXCEPTION in a trigger
  console.error(JSON.stringify({ level: 'error', requestId, message: (e as Error)?.message }));          // no stack to the client
  return NextResponse.json({ error: 'internal error', requestId }, { status: 500 });
}

const wrap = (out: unknown) => (out instanceof Response ? out : NextResponse.json(out ?? { ok: true }));
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function auditDenied(actor: Actor | null, perm: string, req: NextRequest, e: AppError, ctx: Ctx) {
  try {
    await withTx(getPool(), (tx) => audit(tx, actor, 'access.denied', null, null, null, { permission: perm, path: req.nextUrl.pathname, method: req.method, reason: e.message, status: e.status }, ctx));
  } catch { /* never mask the original error */ }
}

/** Authenticated route. The whole handler runs in ONE transaction with its audit rows (CLAUDE.md rule 5). */
export function route(perm: Permission, handler: Handler, opts: { stepUp?: boolean; csrf?: boolean } = {}) {
  const fn = async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const ctx = reqCtx(req, await params);
    let actor: Actor | null = null;
    try {
      return wrap(await withTx(getPool(), async (tx) => {
        actor = await auth.loadActor(tx, req.cookies.get(SESSION_COOKIE)?.value);
        if (MUTATING.has(req.method) && opts.csrf !== false && !(await auth.checkCsrf(tx, actor.sessionId!, req.headers.get(CSRF_HEADER)))) {
          throw new AppError('missing or bad CSRF token', 403, 'csrf');
        }
        requirePermission(actor, perm, { stepUp: opts.stepUp });
        return handler(req, actor, tx, ctx);
      }));
    } catch (e) {
      if (e instanceof AppError && (e.status === 403 || e.code === 'rule_violation') && !(e instanceof Unauthorized)) await auditDenied(actor, perm, req, e, ctx);
      return toResponse(e, ctx.requestId);
    }
  };
  (fn as any).__permission = perm;
  return fn;
}

/** Explicitly public route (login, QR verify, health). The reason is required so the static check can list them. */
export function publicRoute(reason: string, handler: PublicHandler) {
  const fn = async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const ctx = reqCtx(req, await params);
    try { return wrap(await handler(req, ctx)); } catch (e) { return toResponse(e, ctx.requestId); }
  };
  (fn as any).__public = reason;
  return fn;
}

/** A session-only route for the signed-in user's own data (me, logout, MFA, notifications): needs a session, no permission. */
export function sessionRoute(reason: string, handler: Handler, opts: { csrf?: boolean; allowMfaPending?: boolean } = {}) {
  const fn = async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const ctx = reqCtx(req, await params);
    try {
      return wrap(await withTx(getPool(), async (tx) => {
        const actor = await auth.loadActor(tx, req.cookies.get(SESSION_COOKIE)?.value);
        if (MUTATING.has(req.method) && opts.csrf !== false && !(await auth.checkCsrf(tx, actor.sessionId!, req.headers.get(CSRF_HEADER)))) throw new AppError('missing or bad CSRF token', 403, 'csrf');
        return handler(req, actor, tx, ctx);
      }));
    } catch (e) { return toResponse(e, ctx.requestId); }
  };
  (fn as any).__session = reason;
  return fn;
}

export async function body<T = any>(req: NextRequest): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > 1_000_000) throw new AppError('request too large', 413);
  try { return (await req.json()) as T; } catch { throw new AppError('JSON body expected', 400); }
}

export function setSessionCookies(res: NextResponse, token: string, csrf: string, expiresAt: Date) {
  const secure = process.env.NODE_ENV === 'production';
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: expiresAt });
  // The CSRF token is readable by our own JS and must be echoed in the x-csrf-token header (double-submit + server check).
  res.cookies.set('rppc_csrf', csrf, { httpOnly: false, secure, sameSite: 'strict', path: '/', expires: expiresAt });
  return res;
}
