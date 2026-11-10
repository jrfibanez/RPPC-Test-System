'use client';
// Driver/helper PWA (§5 M5, §10.6): works offline. Every action is queued in IndexedDB with a client_op_id and replayed
// through /api/v1/sync, which is idempotent, so a double tap or a retry after a dropped connection never doubles an effect.
import { useEffect, useRef, useState, useCallback } from 'react';
import { api, upload } from '@/lib/client';

type Op = { client_op_id: string; type: 'trip_event' | 'pod_photo_ref' | 'receiver_signature'; trip_id: string; payload: any; device_at: string; blob?: Blob; blobPurpose?: 'pod_photo' | 'signature' };
const DB = 'rppc-field', STORE = 'queue';
const idb = () => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'client_op_id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function qAll(): Promise<Op[]> { const d = await idb(); return new Promise((res) => { const r = d.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result as Op[]); }); }
async function qPut(op: Op) { const d = await idb(); await new Promise((res) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(op); t.oncomplete = res; }); }
async function qDel(id: string) { const d = await idb(); await new Promise((res) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(id); t.oncomplete = res; }); }

const gps = () => new Promise<{ lat: number; lng: number; accuracy: number }>((res, rej) =>
  navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), rej, { enableHighAccuracy: true, timeout: 20000 }));

/** Compress a camera photo on the phone to ≤ ~500 KB JPEG (§11). */
async function compress(file: File): Promise<Blob> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  for (const q of [0.7, 0.55, 0.4]) { const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), 'image/jpeg', q)); if (b.size <= 500_000 || q === 0.4) return b; }
  throw new Error('unreachable');
}

function Signature({ onDone }: { onDone: (b: Blob) => void }) {
  const ref = useRef<HTMLCanvasElement>(null); const drawing = useRef(false);
  useEffect(() => { const c = ref.current!; c.width = c.offsetWidth * 2; c.height = c.offsetHeight * 2; const x = c.getContext('2d')!; x.lineWidth = 4; x.lineCap = 'round'; }, []);
  const pt = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return [(e.clientX - r.left) * 2, (e.clientY - r.top) * 2] as const; };
  return <><canvas className="sig" ref={ref}
    onPointerDown={(e) => { drawing.current = true; const [x, y] = pt(e); const g = ref.current!.getContext('2d')!; g.beginPath(); g.moveTo(x, y); }}
    onPointerMove={(e) => { if (!drawing.current) return; const [x, y] = pt(e); const g = ref.current!.getContext('2d')!; g.lineTo(x, y); g.stroke(); }}
    onPointerUp={() => { drawing.current = false; }} />
    <button onClick={() => ref.current!.toBlob((b) => b && onDone(b), 'image/png')}>Save signature</button></>;
}

export default function Field() {
  const [trips, setTrips] = useState<any[] | null>(null); const [trip, setTrip] = useState<any>(null);
  const [queue, setQueue] = useState(0); const [online, setOnline] = useState(true); const [msg, setMsg] = useState('');
  const [receiver, setReceiver] = useState(''); const [delivered, setDelivered] = useState<Record<string, string>>({}); const [sigStep, setSigStep] = useState(false);

  const refresh = useCallback(async () => {
    setQueue((await qAll()).length);
    try { setTrips(await api('/field/trips')); if (trip) setTrip(await api(`/field/trips/${trip.id}`)); }
    catch (e) { if ((e as any).status === 401) location.href = '/login'; }
  }, [trip]);

  const flush = useCallback(async () => {
    const ops = await qAll(); if (!ops.length || !navigator.onLine) return;
    for (const op of ops) {
      try {
        if (op.blob && !op.payload.file_id && !op.payload.signature_file_id) {             // upload the photo/signature first
          const id = await upload(op.blob, op.blobPurpose!);
          if (op.type === 'pod_photo_ref') op.payload.file_id = id; else op.payload.signature_file_id = id;
          await qPut(op);
        }
        const { blob: _b, blobPurpose: _p, ...wire } = op;
        const { results } = await api<{ results: any[] }>('/sync', { body: [wire] });
        const r = results[0];
        if (r.ok || r.replay) await qDel(op.client_op_id);
        else if (r.status && r.status < 500) { await qDel(op.client_op_id); setMsg(`Not accepted: ${r.error}`); }  // a rule refused it; do not retry forever
      } catch { break; }                                                                    // offline again: keep the queue
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const on = () => { setOnline(navigator.onLine); if (navigator.onLine) void flush(); };
    window.addEventListener('online', on); window.addEventListener('offline', on); setOnline(navigator.onLine);
    void refresh(); const t = setInterval(() => void flush(), 20000);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); clearInterval(t); };
  }, []);  // eslint-disable-line

  const enqueue = async (op: Omit<Op, 'client_op_id' | 'device_at'>) => {
    await qPut({ ...op, client_op_id: crypto.randomUUID(), device_at: new Date().toISOString() });
    setQueue((await qAll()).length); setMsg(navigator.onLine ? 'Saved, sending…' : 'Saved on the phone. It will send when there is signal.');
    void flush();
  };
  const event = async (ev: string) => { let g: any = {}; try { g = await gps(); } catch { /* GPS optional on events */ } await enqueue({ type: 'trip_event', trip_id: trip.id, payload: { event: ev, lat: g.lat, lng: g.lng } }); };
  const photo = async (stage: 'loaded' | 'unloaded', f: File | undefined) => {
    if (!f) return;
    let g; try { g = await gps(); } catch { setMsg('Turn on location: photos need GPS.'); return; }
    await enqueue({ type: 'pod_photo_ref', trip_id: trip.id, payload: { stage, lat: g.lat, lng: g.lng, accuracy: g.accuracy, taken_at: new Date().toISOString() }, blob: await compress(f), blobPurpose: 'pod_photo' });
  };
  const has = (e: string) => trip?.events?.some((x: any) => x.event === e);
  const photos = (s: string) => trip?.photos?.filter((p: any) => p.stage === s).length ?? 0;

  return <div className="field">
    <h1>{trip ? trip.trip_no : 'My trips'}</h1>
    {!online && <div className="banner">Offline — actions are saved on the phone.</div>}
    {queue > 0 && <div className="banner">{queue} action(s) waiting to send. <button className="secondary" onClick={() => void flush()}>Send now</button></div>}
    {msg && <p className="big">{msg}</p>}
    {!trip && trips?.map((t) => <button key={t.id} onClick={async () => setTrip(await api(`/field/trips/${t.id}`))}>{t.trip_no} · {t.planned_date} · {t.status}</button>)}
    {!trip && trips?.length === 0 && <p className="muted big">No trips assigned to you.</p>}
    {trip && <>
      <p className="big">{trip.client_name}<br />{trip.site_name} · <b>{trip.status}</b></p>
      <label className="big">1. Photo of the loaded pallets ({photos('loaded')}/2)</label>
      <input type="file" accept="image/*" capture="environment" disabled={photos('loaded') >= 2} onChange={(e) => photo('loaded', e.target.files?.[0])} />
      <button disabled={trip.status !== 'dispatched' || has('arrived_site')} onClick={() => event('arrived_site')}>2. Arrived at site (time in)</button>
      <label className="big">3. Photo after unloading ({photos('unloaded')}/2)</label>
      <input type="file" accept="image/*" capture="environment" disabled={trip.status !== 'at_site' || photos('unloaded') >= 2} onChange={(e) => photo('unloaded', e.target.files?.[0])} />
      {trip.status === 'at_site' && !trip.dr?.receiver_name && <>
        <label className="big">4. Receiver name</label><input className="big" value={receiver} onChange={(e) => setReceiver(e.target.value)} />
        {trip.lines.map((l: any) => <div key={l.id}><label>Pallets delivered ({l.condition}, loaded {l.qty_loaded})</label>
          <input className="big" inputMode="numeric" value={delivered[l.id] ?? String(l.qty_loaded ?? '')} onChange={(e) => setDelivered({ ...delivered, [l.id]: e.target.value })} /></div>)}
        {!sigStep ? <button disabled={!receiver} onClick={() => setSigStep(true)}>Receiver signs</button>
          : <Signature onDone={async (b) => { setSigStep(false); await enqueue({ type: 'receiver_signature', trip_id: trip.id, blob: b, blobPurpose: 'signature',
              payload: { receiver_name: receiver, delivered: trip.lines.map((l: any) => ({ lineId: l.id, qtyDelivered: Number(delivered[l.id] ?? l.qty_loaded ?? 0) })) } }); }} />}
      </>}
      <button disabled={trip.status !== 'at_site' || has('departed_site')} onClick={() => event('departed_site')}>5. Leaving site (time out)</button>
      <button disabled={trip.status !== 'delivered'} onClick={() => event('returned_plant')}>6. Back at the plant</button>
      <button className="secondary" onClick={() => { setTrip(null); void refresh(); }}>All my trips</button>
    </>}
  </div>;
}
