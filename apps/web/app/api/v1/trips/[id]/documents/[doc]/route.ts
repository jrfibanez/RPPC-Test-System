import { route } from '@/lib/route';
import { P, NotFound } from '@rppc/core';
import { htmlToPdf } from '@rppc/pdf';
import { tripDocument, drHtml } from '@/lib/documents';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// GET /trips/:id/documents/dr.pdf | gp.pdf | dr.html | gp.html
export const GET = route(P.TRIP_READ, async (_req, _actor, tx, ctx) => {
  const m = /^(dr|gp)\.(pdf|html)$/.exec(ctx.params.doc);
  if (!m) throw new NotFound();
  const html = await drHtml(await tripDocument(tx, ctx.params.id, m[1] as 'dr' | 'gp'));
  if (m[2] === 'html') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } });
  let pdf: Buffer;
  try { pdf = await htmlToPdf(html); } catch (e) {
    // No Chromium on this host: serve the same document as a printable page rather than failing (print → Save as PDF).
    console.error(JSON.stringify({ level: 'warn', requestId: ctx.requestId, message: `pdf render failed: ${(e as Error).message}` }));
    return new Response(html.replace('</body>', '<p style="color:#555">PDF engine unavailable — use your browser’s Print → Save as PDF.</p></body>'),
      { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } });
  }
  return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${m[1]}-${ctx.params.id}.pdf"` } });
});
