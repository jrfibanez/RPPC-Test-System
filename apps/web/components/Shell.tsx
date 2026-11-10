'use client';
import { useEffect, useState, createContext, useContext } from 'react';
import { api, ApiError } from '@/lib/client';

export interface Me { id: string; username: string; full_name: string; roles: string[]; permissions: string[]; authMethod: string; mfaPassed: boolean }
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx);
export const has = (me: Me | null, p: string) => !!me?.permissions.includes(p);

export function Shell({ children, title }: { children: React.ReactNode; title?: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<Me>('/auth/me').then((m) => {
      if (!m.mfaPassed && m.authMethod === 'password' && m.roles.length && m.permissions.length) { /* MFA pending is handled on /login */ }
      setMe(m);
    }).catch((e: ApiError) => { if (e.status === 401) location.href = '/login'; else setErr(e.message); });
  }, []);
  const logout = async () => { await api('/auth/logout', { body: {} }).catch(() => {}); location.href = '/login'; };
  const nav: Array<[string, string, string]> = [
    ['/', 'Inbox', ''], ['/trips', 'Trips', 'trips.read'], ['/gate', 'Gate', 'gatepass.verify'], ['/inventory', 'Inventory', 'inventory.read'],
    ['/billing', 'Billing', 'billing.read'], ['/payroll', 'Payroll', 'payroll.read'], ['/field', 'My trips', 'trips.own'], ['/admin', 'Admin', 'users.manage'],
  ];
  return (
    <MeCtx.Provider value={me}>
      <header className="top"><b>RPPC</b><nav>{nav.filter(([, , p]) => !p || has(me, p)).map(([h, l]) => <a key={h} href={h}>{l}</a>)}</nav>
        <span className="sp" />{me && <span className="muted" style={{ color: '#c8cad0' }}>{me.full_name} · {me.roles.join(', ')}</span>}
        <button className="secondary" onClick={logout}>Sign out</button></header>
      <main>{title && <h1>{title}</h1>}{err && <p className="err">{err}</p>}{me ? children : <p className="muted">Loading…</p>}</main>
    </MeCtx.Provider>
  );
}

export function useLoad<T>(path: string | null, deps: unknown[] = []): [T | null, string, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => { if (!path) return; setErr(''); api<T>(path).then(setData).catch((e) => setErr(e.message)); }, [path, n, ...deps]);
  return [data, err, () => setN((x) => x + 1)];
}

/** A button that runs an API call, shows errors, and refreshes. Rejections ask for a reason (M13). */
export function Act({ label, run, onDone, kind, needReason }: { label: string; run: (reason?: string) => Promise<unknown>; onDone?: () => void; kind?: 'danger' | 'secondary'; needReason?: string }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  return <span>
    <button className={kind} disabled={busy} onClick={async () => {
      let reason: string | undefined;
      if (needReason) { reason = prompt(needReason) ?? undefined; if (!reason) return; }
      setBusy(true); setErr('');
      try { await run(reason); onDone?.(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
    }}>{label}</button>{err && <span className="err"> {err}</span>}
  </span>;
}
