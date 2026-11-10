'use client';
import { Shell, useLoad } from '@/components/Shell';
import { peso } from '@/lib/client';
function Pay() {
  const [rows, err] = useLoad<any[]>('/payroll/summary');
  return <div className="card"><h2>Weekly Payroll Summary</h2>{err && <p className="err">{err}</p>}<div className="wrap"><table>
    <thead><tr><th>Week</th><th>Period</th><th>Status</th><th className="n">Total</th><th className="n">Manpower</th><th className="n">Average</th><th className="n">Highest</th><th className="n">Lowest</th></tr></thead>
    <tbody>{rows?.map((r) => <tr key={r.id}><td>{r.week_no}</td><td>{r.period_start} – {r.period_end}</td><td><span className="pill">{r.status}</span></td>
      <td className="n">{peso(r.total_weekly_payroll)}</td><td className="n">{r.no_of_manpower}</td><td className="n">{peso(r.avg_per_manpower)}</td><td className="n">{peso(r.highest_salary)}</td><td className="n">{peso(r.lowest_salary)}</td></tr>)}</tbody></table></div></div>;
}
export default function Page() { return <Shell title="Payroll"><Pay /></Shell>; }
