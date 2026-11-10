'use client';
import { useState } from 'react';
import { Shell, useLoad, useMe, has, Act } from '@/components/Shell';
import { api, peso, csrf } from '@/lib/client';

function Billing() {
  const me = useMe();
  const [rows, err, reload] = useLoad<any[]>('/billing-summaries');
  const [clients] = useLoad<any[]>(has(me, 'clients.read') ? '/clients' : null);
  const [site, setSite] = useState(''); const [sites, setSites] = useState<any[]>([]); const [msg, setMsg] = useState('');
  const pickClient = async (id: string) => { const c = await api<any>(`/clients/${id}`); setSites(c.sites); setSite(c.sites[0]?.id ?? ''); };
  const exportCsv = async (ids: string[]) => {
    const r = await fetch('/api/v1/billing-summaries/export', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify({ ids }) });
    if (!r.ok) { setMsg((await r.json()).error); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = (r.headers.get('content-disposition') ?? '').split('filename="')[1]?.replace('"', '') ?? 'export.csv'; a.click(); reload();
  };
  const act = (id: string, a: string, body: unknown = {}) => api(`/billing-summaries/${id}/${a}`, { body });
  return <>
    {has(me, 'billing.write') && <div className="card"><h2>Generate the next billing summary for a site</h2><div className="row">
      <div><label>Client</label><select onChange={(e) => pickClient(e.target.value)} defaultValue=""><option value="" disabled>Choose…</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.legal_name}</option>)}</select></div>
      <div><label>Site</label><select value={site} onChange={(e) => setSite(e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
      <div><Act label="Generate" run={async () => { const r = await api<any>('/billing-summaries', { body: { siteId: site } }); setMsg(r.unpricedDays ? `⚠ ${r.unpricedDays} day(s) with pallets on site have no rate term — this summary cannot be finalised (BR-28).` : `Created ${r.summary.bs_no}`); }} onDone={reload} /></div></div>
      {msg && <p className="banner">{msg}</p>}</div>}
    <div className="card"><h2>Billing summaries</h2>{err && <p className="err">{err}</p>}
      <div className="wrap"><table><thead><tr><th>No.</th><th>Client · site</th><th>Period</th><th className="n">Pallet-days</th><th className="n">Total (VAT-ex)</th><th>Status</th><th /></tr></thead>
        <tbody>{rows?.map((b) => <tr key={b.id}><td>{b.bs_no}</td><td>{b.client_code} · {b.site_name}</td><td>{b.period_start} – {b.period_end}</td>
          <td className="n">{Number(b.pallet_days).toLocaleString()}</td><td className="n">{peso(b.total_vat_ex)}</td><td><span className="pill">{b.status}</span>{b.dispute_deadline && <div className="muted">dispute by {b.dispute_deadline}</div>}</td>
          <td><div className="actions">
            {b.status === 'draft' && has(me, 'billing.write') && <Act label="Submit for ops review" run={() => act(b.id, 'submit-review')} onDone={reload} />}
            {b.status === 'draft' && has(me, 'billing.review') && <Act label="Ops review OK" run={() => act(b.id, 'review')} onDone={reload} />}
            {b.status === 'ops_reviewed' && has(me, 'billing.write') && <Act label="Mark sent" run={() => act(b.id, 'send')} onDone={reload} />}
            {b.status === 'sent_to_client' && has(me, 'billing.write') && <Act label="Client approved" needReason="Name of the client approver" run={(n) => act(b.id, 'client-approval', { approverName: n })} onDone={reload} />}
            {b.status === 'client_approved' && has(me, 'billing.export') && <button onClick={() => exportCsv([b.id])}>Export CSV for SAP</button>}
            {b.status === 'exported' && has(me, 'billing.write') && <Act label="Record invoice" needReason="SAP invoice no. and receipt date, e.g. SI-0123 2026-11-13" run={(s) => { const [invoiceRef, invoiceReceivedOn] = (s ?? '').split(/\s+/); return act(b.id, 'invoice', { invoiceRef, invoiceReceivedOn }); }} onDone={reload} />}
          </div></td></tr>)}</tbody></table></div></div>
  </>;
}
export default function Page() { return <Shell title="Billing"><Billing /></Shell>; }
