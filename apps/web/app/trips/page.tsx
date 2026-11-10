'use client';
import { useState } from 'react';
import { Shell, useLoad } from '@/components/Shell';

function Trips() {
  const [date, setDate] = useState('');
  const [rows, err] = useLoad<any[]>(`/trips${date ? `?date=${date}` : ''}`, [date]);
  return <div className="card">
    <div className="row"><div><label>Planned date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div></div>
    {err && <p className="err">{err}</p>}
    <div className="wrap"><table><thead><tr><th>Trip ticket</th><th>Date</th><th>Type</th><th>Client / site</th><th>Truck</th><th className="n">Pallets</th><th>Status</th></tr></thead>
      <tbody>{rows?.map((t) => <tr key={t.id}><td><a href={`/trips/${t.id}`}>{t.trip_no}</a></td><td>{t.planned_date}</td><td>{t.trip_type}</td>
        <td>{t.client_code} · {t.site_name}</td><td>{t.plate_no ?? 'client'}</td><td className="n">{t.qty_planned}</td><td><span className="pill">{t.status}</span></td></tr>)}</tbody></table></div>
  </div>;
}
export default function Page() { return <Shell title="Trips"><Trips /></Shell>; }
