'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/client';

export default function Login() {
  const [mode, setMode] = useState<'office' | 'field'>('office');
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [pin, setPin] = useState(''); const [device, setDevice] = useState('');
  const [step, setStep] = useState<'creds' | 'mfa' | 'enrol'>('creds');
  const [otpauth, setOtpauth] = useState(''); const [secret, setSecret] = useState(''); const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]); const [err, setErr] = useState('');
  useEffect(() => { try { setDevice(localStorage.getItem('rppc_device_id') ?? ''); } catch { /* private mode */ } }, []);

  const office = async () => {
    setErr('');
    try {
      const r = await api<{ mfaRequired: boolean; mfaEnrolled: boolean }>('/auth/login', { body: { username: u, password: p } });
      if (!r.mfaRequired) { location.href = '/'; return; }
      if (r.mfaEnrolled) setStep('mfa');
      else { const s = await api<{ secret: string; otpauth: string }>('/auth/mfa/setup', { body: {} }); setSecret(s.secret); setOtpauth(s.otpauth); setStep('enrol'); }
    } catch (e) { setErr((e as Error).message); }
  };
  const verify = async () => {
    setErr('');
    try { const r = await api<{ recoveryCodes?: string[] }>('/auth/mfa/verify', { body: { code } }); if (r.recoveryCodes) setCodes(r.recoveryCodes); else location.href = '/'; }
    catch (e) { setErr((e as Error).message); }
  };
  const field = async () => {
    setErr('');
    try { try { localStorage.setItem('rppc_device_id', device); } catch { /* */ } await api('/auth/pin-login', { body: { username: u, pin, deviceId: device } }); location.href = '/field'; }
    catch (e) { setErr((e as Error).message); }
  };

  return <main style={{ maxWidth: 420 }}>
    <h1>RPPC Operations</h1>
    <div className="actions"><button className={mode === 'office' ? '' : 'secondary'} onClick={() => setMode('office')}>Office</button>
      <button className={mode === 'field' ? '' : 'secondary'} onClick={() => setMode('field')}>Field (PIN)</button></div>
    <div className="card">
      {mode === 'office' && step === 'creds' && <form onSubmit={(e) => { e.preventDefault(); void office(); }}>
        <label>Username or email</label><input value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" />
        <label>Password</label><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
        <div className="actions"><button type="submit">Sign in</button></div></form>}
      {mode === 'office' && step === 'enrol' && !codes.length && <div>
        <h2>Set up two-factor sign-in</h2><p className="muted">Your role requires an authenticator app. Add this key in Google or Microsoft Authenticator, then enter the 6-digit code.</p>
        <p><code style={{ wordBreak: 'break-all' }}>{secret}</code></p><p className="muted" style={{ wordBreak: 'break-all', fontSize: 12 }}>{otpauth}</p>
        <label>Code</label><input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /><div className="actions"><button onClick={verify}>Verify</button></div></div>}
      {mode === 'office' && step === 'mfa' && <div><label>Authenticator code (or a recovery code)</label><input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        <div className="actions"><button onClick={verify}>Continue</button></div></div>}
      {codes.length > 0 && <div><h2>Save your recovery codes</h2><p className="muted">Each works once if you lose your phone. They are not shown again.</p>
        <pre>{codes.join('\n')}</pre><button onClick={() => { location.href = '/'; }}>I saved them</button></div>}
      {mode === 'field' && <form onSubmit={(e) => { e.preventDefault(); void field(); }}>
        <label>Username</label><input value={u} onChange={(e) => setU(e.target.value)} />
        <label>6-digit PIN</label><input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} />
        <label>Device ID (set once by IT when this phone was enrolled)</label><input value={device} onChange={(e) => setDevice(e.target.value)} />
        <div className="actions"><button type="submit">Sign in</button></div></form>}
      {err && <p className="err">{err}</p>}
    </div>
  </main>;
}
