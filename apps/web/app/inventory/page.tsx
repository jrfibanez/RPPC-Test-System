'use client';
import { Shell, useLoad } from '@/components/Shell';
function Inv() {
  const [rows, err] = useLoad<any[]>('/inventory/balances');
  return <div className="card">{err && <p className="err">{err}</p>}<div className="wrap"><table><thead><tr><th>Location</th><th>Client</th><th>Condition</th><th className="n">Pallets</th></tr></thead>
    <tbody>{rows?.map((r, i) => <tr key={i}><td>{r.site_name ?? r.name}</td><td>{r.client_code ?? ''}</td><td>{r.condition}</td><td className="n">{Number(r.qty).toLocaleString()}</td></tr>)}</tbody></table></div></div>;
}
export default function Page() { return <Shell title="Pallet inventory"><Inv /></Shell>; }
