'use client';
import { use, useState } from 'react';
import { Shell, useLoad, useMe, has, Act } from '@/components/Shell';
import { api, peso, when } from '@/lib/client';

function Trip({ id }: { id: string }) {
  const me = useMe();
  const [t, err, reload] = useLoad<any>(`/trips/${id}`);
  const [voucherNo, setVoucherNo] = useState(''); const [budget, setBudget] = useState('');
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  if (err) return <p className="err">{err}</p>;
  if (!t) return null;
  const v = t.voucher; const total = t.lines.reduce((s: number, l: any) => s + l.qty_planned, 0);
  const call = (a: string, body: unknown = {}) => api(`/trips/${id}/${a}`, { body });
  return <>
    <div className="card"><h2>{t.trip_no} <span className="pill">{t.status}</span> <span className="pill">{t.trip_type}</span></h2>
      <div className="grid"><div><span className="muted">Client / site</span><div>{t.client_name}<br />{t.site_name}</div></div>
        <div><span className="muted">SO / WO</span><div>{t.so_no} / {t.wo_no}</div></div>
        <div><span className="muted">Truck · driver</span><div>{t.plate_no ?? 'Client pickup'} · {t.driver_name ?? '—'}</div></div>
        <div><span className="muted">Planned</span><div>{t.planned_date}</div></div>
        <div><span className="muted">Delivery</span><div>{t.delivery_mode} {Number(t.delivery_fee) > 0 ? peso(t.delivery_fee) : ''}</div></div></div>
      <table style={{ marginTop: 10 }}><thead><tr><th>Condition</th><th className="n">Planned</th><th className="n">Loaded</th><th className="n">Delivered</th></tr></thead>
        <tbody>{t.lines.map((l: any) => <tr key={l.id}><td>{l.condition}</td><td className="n">{l.qty_planned}</td>
          <td className="n">{t.status === 'loading' && has(me, 'trips.dispatch') ? <input style={{ width: 90 }} inputMode="numeric" value={loaded[l.id] ?? l.qty_loaded ?? ''} onChange={(e) => setLoaded({ ...loaded, [l.id]: e.target.value })} /> : l.qty_loaded ?? '—'}</td>
          <td className="n">{l.qty_delivered ?? '—'}</td></tr>)}<tr><th>Total</th><th className="n">{total}</th><th /><th /></tr></tbody></table>
    </div>

    <div className="card"><h2>Documents and budget</h2>
      <p>Voucher: {v ? <>{v.voucher_no} · {peso(v.budget_amount)} · <span className="pill">{v.status}</span>{v.owner_raised && <span className="pill warn">owner-raised</span>}</> : t.voucher_required ? 'none yet' : 'not needed (client pickup, BR-26)'}</p>
      <p>DR: {t.dr ? <>{t.dr.dr_no} <span className="pill">{t.dr.status}</span> · <a href={`/api/v1/trips/${id}/documents/dr.pdf`} target="_blank">PDF</a>{t.dr.received_at && <> · received {when(t.dr.received_at)} by {t.dr.receiver_name}</>}</> : '—'}
        {' '}· Gate pass: {t.gatePass ? <>{t.gatePass.gp_no} <span className="pill">{t.gatePass.status}</span> · <a href={`/api/v1/trips/${id}/documents/gp.pdf`} target="_blank">PDF</a></> : '—'}</p>
      <div className="actions">
        {t.voucher_required && !v && t.status === 'planned' && has(me, 'vouchers.request') && <><input placeholder="Voucher no. (pad)" value={voucherNo} onChange={(e) => setVoucherNo(e.target.value)} style={{ maxWidth: 180 }} />
          <input placeholder="Budget ₱" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ maxWidth: 130 }} />
          <Act label="Request voucher" run={() => call('voucher', { voucherNo, budgetAmount: budget })} onDone={reload} /></>}
        {v?.status === 'requested' && has(me, 'trips.approve_budget') && <Act label="Approve voucher" run={() => api(`/vouchers/${v.id}/approve`, { body: {} })} onDone={reload} />}
        {v?.status === 'approved' && has(me, 'trips.release_budget') && <Act label="Release cash" run={() => api(`/vouchers/${v.id}/release`, { body: {} })} onDone={reload} />}
        {!t.dr && ['delivery', 'pickup'].includes(t.trip_type) && has(me, 'dr.issue') && <Act label="Issue DR" run={() => call('dr')} onDone={reload} />}
        {!t.gatePass && has(me, 'dr.issue') && <Act label="Issue gate pass" run={() => call('gate-pass')} onDone={reload} />}
        {(t.status === 'budget_released' || (t.trip_type === 'pickup' && t.status === 'planned')) && has(me, 'trips.dispatch') && <Act label="Start loading" run={() => call('start-loading')} onDone={reload} />}
        {t.status === 'loading' && has(me, 'trips.dispatch') && <Act label="Save loaded qty" run={() => call('loaded', { lines: t.lines.map((l: any) => ({ lineId: l.id, qtyLoaded: Number(loaded[l.id] ?? l.qty_loaded ?? 0) })) })} onDone={reload} />}
        {['returned', 'delivered'].includes(t.status) && has(me, 'trips.write') && <Act label="Close trip" run={() => call('close')} onDone={reload} />}
        {['planned', 'budget_approved', 'budget_released'].includes(t.status) && has(me, 'trips.write') && <Act label="Cancel trip" kind="danger" needReason="Reason for cancelling" run={(reason) => call('cancel', { reason })} onDone={reload} />}
        {t.dr && t.dr.status !== 'received' && has(me, 'dr.void') && <Act label="Void DR" kind="danger" needReason="Reason for voiding the DR" run={(reason) => api(`/dr/${t.dr.id}/void`, { body: { reason } })} onDone={reload} />}
      </div></div>

    <div className="card"><h2>Timeline and proof of delivery</h2>
      {t.events.map((e: any) => <div key={e.id}>{when(e.at)} — {e.event.replace(/_/g, ' ')}{e.lat ? ` (${Number(e.lat).toFixed(4)}, ${Number(e.lng).toFixed(4)})` : ''}</div>)}
      {t.photos.map((p: any) => <div key={p.id} className="muted">photo · {p.stage} · {when(p.taken_at_device)} {p.flags.length > 0 && <span className="pill warn">{p.flags.join(', ')}</span>}</div>)}
      {t.events.length === 0 && t.photos.length === 0 && <p className="muted">No field events yet.</p>}
    </div>
  </>;
}
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <Shell><Trip id={id} /></Shell>; }
