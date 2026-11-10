// Action tables: one POST handler per resource, where EVERY action declares its own permission (CLAUDE.md rule 1).
import type { NextRequest } from 'next/server';
import type { Actor, Permission } from '@rppc/core';
import { NotFound } from '@rppc/core';
import type { Tx } from '@rppc/db';
import { route, toResponse, reqCtx, type Ctx } from './route';

export interface ActionDef { perm: Permission; stepUp?: boolean; run: (b: any, actor: Actor, tx: Tx, ctx: Ctx, id: string, req: NextRequest) => Promise<unknown> }

export function actions(table: Record<string, ActionDef>) {
  const handlers = Object.fromEntries(Object.entries(table).map(([name, def]) => [name, route(def.perm, async (req, actor, tx, ctx) => {
    const b = req.headers.get('content-type')?.includes('json') ? await req.json().catch(() => ({})) : {};
    return def.run(b ?? {}, actor, tx, ctx, ctx.params.id, req);
  }, { stepUp: def.stepUp })]));
  const fn = async (req: NextRequest, c: { params: Promise<Record<string, string>> }) => {
    const p = await c.params;
    const h = handlers[p.action];
    if (!h) return toResponse(new NotFound(`unknown action ${p.action}`), reqCtx(req).requestId);
    return h(req, { params: Promise.resolve(p) });
  };
  (fn as any).__actions = Object.fromEntries(Object.entries(table).map(([k, v]) => [k, v.perm]));
  return fn;
}
