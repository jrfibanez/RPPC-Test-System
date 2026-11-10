'use client';
import { Shell, useLoad } from '@/components/Shell';
import { when } from '@/lib/client';
function Admin() {
  const [users] = useLoad<any[]>('/admin/users');
  const [log] = useLoad<any[]>('/admin/audit-log');
  return <><div className="card"><h2>Users</h2><div className="wrap"><table><thead><tr><th>User</th><th>Roles</th><th>Sign-in</th><th>MFA</th><th>Last login</th><th>Status</th></tr></thead>
    <tbody>{users?.map((u) => <tr key={u.id}><td>{u.username}<div className="muted">{u.full_name}</div></td><td>{u.roles.join(', ')}</td><td>{u.auth_method}</td><td>{u.mfa_enabled ? '✔' : ''}</td><td>{when(u.last_login_at)}</td><td>{u.status}</td></tr>)}</tbody></table></div></div>
    <div className="card"><h2>Audit log (latest 200)</h2><div className="wrap"><table><thead><tr><th>#</th><th>When</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead>
      <tbody>{log?.map((l) => <tr key={l.id}><td>{l.id}</td><td>{when(l.at)}</td><td>{l.action}</td><td className="muted">{l.entity_type ?? ''}</td><td className="muted">{l.ip ?? ''}</td></tr>)}</tbody></table></div></div></>;
}
export default function Page() { return <Shell title="Admin"><Admin /></Shell>; }
