// المزامنة: دفع التعديلات المحلية (الطابور) ثم سحب التغييرات من Supabase. الأحدث يفوز دون فقدان بيانات.
import { db, auth, arMessage } from './supa.js';
import { store } from './store.js';

const PLAN = [
  ['subjects', 'id'],
  ['months', 'user_id,month_key'],
  ['exams', 'id'],
  ['user_settings', 'user_id'],
];
const CHUNK = 100;

let running = false;
let again = false;
let netDown = false;
let lastError = '';
let timer = null;
const subs = new Set();

export function onStatus(fn) { subs.add(fn); return () => subs.delete(fn); }
function notify() { const s = getStatus(); subs.forEach((f) => { try { f(s); } catch (e) { console.error(e); } }); }

export function getStatus() {
  if (!store.ready) return { state: 'idle', pending: 0 };
  const pending = store.pendingCount();
  const failed = store.failedCount();
  let state = 'synced';
  if (running) state = 'syncing';
  else if (failed || lastError) state = 'failed';
  else if (!navigator.onLine || netDown) state = 'offline';
  else if (pending) state = 'pending';
  return { state, pending, failed, lastError, lastSyncAt: store.data.lastSyncAt };
}

export function schedule(ms = 700) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
  notify();
}

async function push() {
  for (const [table, onConflict] of PLAN) {
    const snapshot = {};
    for (const key of store.queueKeys(table)) snapshot[key] = store.data.queue[key];
    const keys = Object.keys(snapshot);
    if (!keys.length) continue;

    const items = keys
      .map((key) => ({ key, rev: snapshot[key], row: store.rowFor(table, key.slice(table.length + 1)) }))
      .filter((it) => {
        if (!it.row) { store.ack(it.key, it.rev); return false; }
        return true;
      });

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      try {
        await db.upsert(table, chunk.map((c) => c.row), onConflict);
        chunk.forEach((c) => store.ack(c.key, c.rev));
      } catch (e) {
        if (e.network || e.status === 401) throw e;
        // رفض من الخادم: نعزل الصف المسبب بدل إيقاف الباقي
        for (const c of chunk) {
          try {
            await db.upsert(table, [c.row], onConflict);
            store.ack(c.key, c.rev);
          } catch (e2) {
            if (e2.network || e2.status === 401) throw e2;
            store.markFailed(c.key, arMessage(e2));
          }
        }
      }
    }
  }
  store.flush();
}

async function pull() {
  for (const [table] of PLAN) {
    const cursor = store.data.cursors[table];
    // نتراجع دقيقة للخلف لتفادي فقدان صفوف التزمت متأخرة؛ الدمج متكرر الأمان
    let after = cursor ? new Date(Date.parse(cursor) - 60000).toISOString() : null;
    let maxTs = cursor || null;
    for (;;) {
      const rows = await db.select(table, { filters: after ? [['server_updated_at', 'gt', after]] : [], order: 'server_updated_at.asc', limit: 1000 });
      store.applyRemote(table, rows);
      if (rows.length) maxTs = rows[rows.length - 1].server_updated_at;
      if (rows.length < 1000 || maxTs === after) break;
      after = maxTs;
    }
    store.setCursor(table, maxTs);
  }
}

async function pullProfile() {
  const uidv = auth.user?.id;
  if (!uidv) return;
  const rows = await db.select('profiles', { filters: [['id', 'eq', uidv]], limit: 1 });
  if (rows[0]) store.setProfile(rows[0]);
}

export async function syncNow() {
  if (!auth.user || !store.ready) return;
  if (running) { again = true; return; }
  if (!navigator.onLine) { netDown = true; notify(); return; }
  running = true;
  lastError = '';
  notify();
  try {
    await push();
    await pull();
    await pullProfile();
    netDown = false;
    store.markSynced();
  } catch (e) {
    if (e.network) { netDown = true; lastError = ''; } else { netDown = false; lastError = arMessage(e); }
  } finally {
    running = false;
    notify();
    if (again) { again = false; schedule(300); }
  }
}

let started = false;
export function start() {
  if (started) return;
  started = true;
  store.setDirtyHook(() => schedule());
  window.addEventListener('online', () => { netDown = false; syncNow(); });
  window.addEventListener('offline', () => notify());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) syncNow(); }, 90000);
}

export const hasPending = () => store.ready && (store.pendingCount() > 0);
