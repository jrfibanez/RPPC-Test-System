'use client';
import { useState } from 'react';
import { Shell, useLoad } from '@/components/Shell';
import { api } from '@/lib/client';

// Guard at the gate (§5 M5): confirm quantity and plate, record time out. Big targets for a phone.
function Gate() {
  const [rows, , reload] = useLoad<any[]>('/trips');
  const loading = rows?.filter((t) => t.status === 'loading') ?? [];
  const [pick, setPick] = useState<any>(null); const [plate, setPlate] = useState(''); const [qty, setQty] = useState(''); const [msg, setMsg] = useState('');
  return <div className="field">
    {!pick && <><h1>Trucks at the gate</h1>{loading.length === 0 && <p className="muted big">No truck is waiting at the gate.</p>}
      {loading.map((t) => <button key={t.id} onClick={() => { setPick(t); setPlate(''); setQty(''); setMsg(''); }}>{t.trip_no} · {t.plate_no ?? 'client truck'} · {t.qty_planned} pallets</button>)}</>}
    {pick && <><h1>{pick.trip_no}</h1><p className="big">Planned: <b>{pick.plate_no ?? 'client truck'}</b>, {pick.site_name}</p>
      <label>Plate number you see</label><input className="big" value={plate} onChange={(e) => setPlate(e.target.value)} />
      <label>Pallets you counted</label><input className="big" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
      <button onClick={async () => { try { await api(`/trips/${pick.id}/verify-gate`, { body: { plateNo: plate, qty: Number(qty) } }); setMsg('✔ Released. Time out recorded.'); setPick(null); reload(); } catch (e) { setMsg((e as Error).message); } }}>Confirm and release</button>
      <button className="secondary" onClick={() => setPick(null)}>Back</button></>}
    {msg && <p className="banner big">{msg}</p>}
  </div>;
}
export default function Page() { return <Shell><Gate /></Shell>; }
