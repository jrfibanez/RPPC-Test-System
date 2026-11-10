// §9 PDF: HTML templates → PDF via headless Chromium. One template per document type; QR code links to the verify URL.
import QRCode from 'qrcode';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (d: string | Date | null | undefined) => d ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d)) : '—';

export interface DrDoc {
  kind: 'DELIVERY RECEIPT' | 'GATE PASS'; docNo: string; tripNo: string; soNo: string; issuedAt: string | Date;
  client: string; site: string; siteAddress: string; plateNo?: string | null; driver?: string | null;
  lines: Array<{ type: string; condition: string; qty: number }>; total: number; verifyUrl: string; status: string;
  receiverName?: string | null; receivedAt?: string | Date | null; externalDrNo?: string | null;
}

export async function drHtml(d: DrDoc): Promise<string> {
  const qr = await QRCode.toString(d.verifyUrl, { type: 'svg', margin: 0, width: 110 });
  const rows = d.lines.map((l) => `<tr><td>${esc(l.type)}</td><td>${esc(l.condition)}</td><td class="n">${l.qty}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A5 landscape; margin: 12mm }
  body { font: 11pt/1.35 'Helvetica Neue', Arial, sans-serif; color: #111 }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #b3121b; padding-bottom: 6px }
  h1 { font-size: 15pt; margin: 0; letter-spacing: .04em } .co { color: #b3121b; font-weight: 700 } .muted { color: #555; font-size: 9pt }
  table { width: 100%; border-collapse: collapse; margin-top: 8px } th, td { border: 1px solid #999; padding: 4px 6px; text-align: left } .n { text-align: right }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; margin-top: 8px } .sig { margin-top: 22px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px }
  .sig div { border-top: 1px solid #333; padding-top: 3px; font-size: 9pt } .void { color: #b3121b; font-size: 26pt; font-weight: 800 }
  </style></head><body>
  <header><div><div class="co">RED PALLET PROVIDER CO. (RPPC) · S1 Group</div><div class="muted">Mamplasan, Biñan, Laguna</div>
  <h1>${esc(d.kind)} ${esc(d.docNo)}</h1>${d.status === 'void' ? '<div class="void">VOID</div>' : ''}</div><div>${qr}</div></header>
  <div class="grid"><div><b>Client:</b> ${esc(d.client)}</div><div><b>Trip ticket:</b> ${esc(d.tripNo)}</div>
  <div><b>Deliver to:</b> ${esc(d.site)} — ${esc(d.siteAddress)}</div><div><b>Sales order:</b> ${esc(d.soNo)}</div>
  <div><b>Truck:</b> ${esc(d.plateNo ?? 'Client pickup')}</div><div><b>Issued:</b> ${fmt(d.issuedAt)}</div>
  <div><b>Driver:</b> ${esc(d.driver ?? '—')}</div><div>${d.externalDrNo ? `<b>Crystal DR:</b> ${esc(d.externalDrNo)}` : ''}</div></div>
  <table><thead><tr><th>Pallet type</th><th>Condition</th><th class="n">Qty</th></tr></thead><tbody>${rows}
  <tr><th colspan="2">Total pallets</th><th class="n">${d.total}</th></tr></tbody></table>
  ${d.receiverName ? `<p><b>Received by:</b> ${esc(d.receiverName)} on ${fmt(d.receivedAt)}</p>` : ''}
  <div class="sig"><div>Released by (RPPC)</div><div>Security (gate)</div><div>Received by (name, signature, date/time)</div></div>
  <p class="muted">System-generated document, valid per company memorandum. Verify: ${esc(d.verifyUrl)}</p>
  </body></html>`;
}

/**
 * Render HTML to PDF with headless Chromium. On Vercel (or when PDF_CHROMIUM=sparticuz) it uses @sparticuz/chromium,
 * a Chromium build made for serverless functions, driven by playwright-core; elsewhere the Playwright install
 * (PLAYWRIGHT_MODULE lets a host point at a system-wide one, e.g. /opt/node-tools/node_modules/playwright).
 */
type Browser = { newPage(o: object): Promise<{ setContent(h: string, o: object): Promise<void>; pdf(o: object): Promise<Uint8Array> }>; close(): Promise<void> };
export async function htmlToPdf(html: string): Promise<Buffer> {
  const { createRequire } = await import(/* webpackIgnore: true */ 'node:module');
  const req = createRequire(import.meta.url);
  let browser: Browser;
  if (process.env.VERCEL || process.env.PDF_CHROMIUM === 'sparticuz') {
    const chromium = req('@sparticuz/chromium') as { args: string[]; executablePath(): Promise<string> };
    const { chromium: pw } = req('playwright-core') as { chromium: { launch(o: object): Promise<Browser> } };
    browser = await pw.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
  } else {
    const { chromium } = req(process.env.PLAYWRIGHT_MODULE ?? 'playwright') as { chromium: { launch(o: object): Promise<Browser> } };
    browser = await chromium.launch({ args: ['--no-sandbox'] });
  }
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally { await browser.close(); }
}
