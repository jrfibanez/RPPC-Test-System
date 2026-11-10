import { route } from '@/lib/route';
import { P, NotFound } from '@rppc/core';
import { htmlToPdf } from '@rppc/pdf';
import { tripDocument, drHtml } from '@/lib/documents';
export const dynamic = 'force-dynamic';
// GET /trips/:id/documents/dr.pdf | gp.pdf | dr.html | gp.html
export const GET = route(P.TRIP_READ, async (_req, _actor, tx, ctx) => {
  const m = /^(dr|gp)\.(pdf|html)$/.exec(ctx.params.doc);
  if (!m) throw new NotFound();
  const html = await drHtml(await tripDocument(tx, ctx.params.id, m[1] as 'dr' | 'gp'));
  if (m[2] === 'html') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } });
  const pdf = await htmlToPdf(html);
  return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${m[1]}-${ctx.params.id}.pdf"` } });
});
