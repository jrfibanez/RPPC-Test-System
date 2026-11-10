'use client';
import { Shell, useLoad, useMe, has, Act } from '@/components/Shell';
import { api, when, peso } from '@/lib/client';

function Inbox() {
  const [items, err, reload] = useLoad<any[]>('/approvals');
  const [notes] = useLoad<any[]>('/notifications?unread=1');
  return <>
    <div className="card"><h2>Waiting for me {items ? <span className="pill">{items.length}</span> : null}</h2>
      {err && <p className="err">{err}</p>}
      {items?.length === 0 && <p className="muted">Nothing waiting for your approval.</p>}
      <div className="wrap"><table><tbody>{items?.map((a) => <tr key={a.id}>
        <td><a href={a.link.startsWith('/trips') ? a.link : '#'}>{a.summary}</a><div className="muted">{a.entity_type.replace('_', ' ')} · since {when(a.created_at)}{a.reminder_count ? ` · reminded ${a.reminder_count}×` : ''}</div></td>
        <td className="n"><div className="actions" style={{ justifyContent: 'flex-end' }}>
          <Act label="Approve" run={() => api(`/approvals/${a.id}/approve`, { body: {} })} onDone={reload} />
          <Act label="Reject" kind="secondary" needReason="Reason for rejecting (required)" run={(note) => api(`/approvals/${a.id}/reject`, { body: { note } })} onDone={reload} /></div></td>
      </tr>)}</tbody></table></div></div>
    {notes && notes.length > 0 && <div className="card"><h2>Notifications</h2>{notes.slice(0, 10).map((n) => <div key={n.id} className="muted">• <b>{n.title}</b> — {n.body}</div>)}</div>}
  </>;
}

function Dashboard() {
  const [d] = useLoad<any>('/dashboard');
  if (!d) return null;
  const loc = (t: string) => d.byLocation.find((x: any) => x.type === t)?.qty ?? 0;
  return <div className="card"><h2>Operations today</h2><div className="grid">
    <div className="stat"><span className="muted">At plant</span><b>{loc('plant').toLocaleString()}</b></div>
    <div className="stat"><span className="muted">At client sites</span><b>{loc('client_site').toLocaleString()}</b></div>
    <div className="stat"><span className="muted">In transit</span><b>{loc('in_transit').toLocaleString()}</b></div>
    <div className="stat"><span className="muted">Trips today</span><b>{d.tripsToday.reduce((s: number, x: any) => s + x.n, 0)}</b></div>
    <div className="stat"><span className="muted">DR without POD &gt; 1 day</span><b>{d.drWithoutPod}</b></div>
    <div className="stat"><span className="muted">Vouchers pending</span><b>{d.pendingVouchers}</b></div>
  </div>{d.billing.length > 0 && <p className="muted">Billing: {d.billing.map((b: any) => `${b.status} ${b.n} (${peso(b.total)})`).join(' · ')}</p>}</div>;
}

function Home() {
  const me = useMe();
  return <><Inbox />{has(me, 'inventory.read') && <Dashboard />}</>;
}
export default function Page() { return <Shell title="Inbox"><Home /></Shell>; }
