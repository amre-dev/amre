// مخزن البيانات المحلي (محلي أولاً). كل تعديل يُحفظ فوراً على الجهاز ويدخل طابور المزامنة.
import { uid, nowIso, normalizeAr, monthKeyOf } from './util.js';
import { deriveStatus } from './calc.js';

const EPOCH = '1970-01-01T00:00:00.000Z';
const keyOf = (id) => `mz:v1:${id}`;

let data = null;
let userId = null;
let persistFailed = false;
let onDirty = () => {};
const subs = new Set();

const blank = () => ({
  v: 1,
  settings: { display_scale: 100, default_goal: 90, updated_at: EPOCH },
  subjects: {},
  months: {},
  exams: {},
  queue: {},     // "table|pk" -> رقم النسخة المعدّلة وغير المزامَنة
  failed: {},    // "table|pk" -> رسالة سبب رفض الخادم
  cursors: {},   // آخر server_updated_at تم سحبه لكل جدول
  profile: { display_name: '', ai_enabled: false },
  lastSyncAt: null,
});

function persist() {
  try { localStorage.setItem(keyOf(userId), JSON.stringify(data)); persistFailed = false; } catch { persistFailed = true; }
}
function emit() { subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }
function dirty(table, pk) {
  const k = `${table}|${pk}`;
  data.queue[k] = (data.queue[k] || 0) + 1;
  delete data.failed[k];
  persist();
  emit();
  onDirty();
}

const num = (v) => (v == null ? null : Number(v));

const META = {
  subjects: { coll: 'subjects', pk: (r) => r.id },
  months: { coll: 'months', pk: (r) => r.month_key },
  exams: { coll: 'exams', pk: (r) => r.id },
  user_settings: { coll: null, pk: () => 'self' },
};

function cleanRemote(table, r) {
  if (table === 'subjects') return { id: r.id, name: r.name, default_full_mark: num(r.default_full_mark), deleted: !!r.deleted, updated_at: r.updated_at };
  if (table === 'months') return { month_key: r.month_key, goal_pct: num(r.goal_pct), deleted: !!r.deleted, updated_at: r.updated_at };
  if (table === 'exams') {
    return {
      id: r.id, subject_id: r.subject_id ?? null, subject_name: r.subject_name, title: r.title || '', notes: r.notes || '',
      exam_date: r.exam_date, full_mark: num(r.full_mark), expected_mark: num(r.expected_mark), actual_mark: num(r.actual_mark),
      status: r.status, deleted: !!r.deleted, updated_at: r.updated_at,
    };
  }
  return { display_scale: num(r.display_scale), default_goal: num(r.default_goal), updated_at: r.updated_at };
}

const ts = (s) => Date.parse(s) || 0;

export const store = {
  init(id) {
    userId = id;
    let loaded = null;
    try { loaded = JSON.parse(localStorage.getItem(keyOf(id))); } catch { /* بيانات تالفة: نبدأ من جديد */ }
    const b = blank();
    data = loaded && loaded.v === 1 ? { ...b, ...loaded, settings: { ...b.settings, ...loaded.settings }, profile: { ...b.profile, ...loaded.profile } } : b;
    emit();
  },
  get ready() { return !!data; },
  get data() { return data; },
  get persistFailed() { return persistFailed; },
  setDirtyHook(fn) { onDirty = fn; },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  clearUser(id) { try { localStorage.removeItem(keyOf(id)); } catch { /* تجاهل */ } if (id === userId) { data = null; userId = null; } },

  // ---------- قراءة ----------
  settings() { return data.settings; },
  profile() { return data.profile; },
  subjects() {
    return Object.values(data.subjects).filter((s) => !s.deleted).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  },
  findSubject(name) {
    const n = normalizeAr(name);
    if (!n) return null;
    return this.subjects().find((s) => normalizeAr(s.name) === n) || null;
  },
  exams() { return Object.values(data.exams).filter((e) => !e.deleted); },
  examsOfMonth(key) {
    return this.exams().filter((e) => monthKeyOf(e.exam_date) === key)
      .sort((a, b) => a.exam_date.localeCompare(b.exam_date) || a.subject_name.localeCompare(b.subject_name, 'ar'));
  },
  getExam(id) { const e = data.exams[id]; return e && !e.deleted ? e : null; },
  monthGoal(key) {
    const m = data.months[key];
    return m && !m.deleted && m.goal_pct != null ? m.goal_pct : data.settings.default_goal;
  },
  hasCustomGoal(key) { const m = data.months[key]; return !!(m && !m.deleted && m.goal_pct != null); },
  pendingCount() { return Object.keys(data.queue).length; },
  failedCount() { return Object.keys(data.failed).length; },

  // ---------- كتابة ----------
  setSettings(patch) {
    Object.assign(data.settings, patch, { updated_at: nowIso() });
    dirty('user_settings', 'self');
  },
  saveSubject({ id, name, default_full_mark }) {
    id = id || uid();
    data.subjects[id] = { id, name: name.trim(), default_full_mark, deleted: false, updated_at: nowIso() };
    dirty('subjects', id);
    return data.subjects[id];
  },
  removeSubject(id) {
    const s = data.subjects[id];
    if (!s) return;
    s.deleted = true;
    s.updated_at = nowIso();
    dirty('subjects', id);
  },
  saveExam(x) {
    const id = x.id || uid();
    const rec = {
      id,
      subject_id: x.subject_id ?? null,
      subject_name: x.subject_name.trim(),
      title: (x.title || '').trim(),
      notes: (x.notes || '').trim(),
      exam_date: x.exam_date,
      full_mark: x.full_mark,
      expected_mark: x.expected_mark ?? null,
      actual_mark: x.actual_mark ?? null,
      deleted: false,
      updated_at: nowIso(),
    };
    rec.status = deriveStatus(rec);
    data.exams[id] = rec;
    dirty('exams', id);
    return rec;
  },
  removeExam(id) {
    const e = data.exams[id];
    if (!e) return;
    e.deleted = true;
    e.updated_at = nowIso();
    dirty('exams', id);
  },
  setGoal(key, pct) {
    const prev = data.months[key];
    if (pct == null && !(prev && prev.goal_pct != null)) return;
    data.months[key] = { month_key: key, goal_pct: pct, deleted: false, updated_at: nowIso() };
    dirty('months', key);
  },

  // ---------- المزامنة ----------
  rowFor(table, pk) {
    const uidv = userId;
    if (table === 'subjects') { const r = data.subjects[pk]; return r && { ...r, user_id: uidv }; }
    if (table === 'months') { const r = data.months[pk]; return r && { ...r, user_id: uidv }; }
    if (table === 'exams') {
      const r = data.exams[pk];
      if (!r) return null;
      const sub = r.subject_id && data.subjects[r.subject_id];
      return { ...r, subject_id: sub ? r.subject_id : null, user_id: uidv };
    }
    return { user_id: uidv, display_scale: data.settings.display_scale, default_goal: data.settings.default_goal, updated_at: data.settings.updated_at };
  },
  queueKeys(table) { return Object.keys(data.queue).filter((k) => k.startsWith(table + '|')); },
  ack(key, rev) {
    if (data.queue[key] === rev) { delete data.queue[key]; }
    delete data.failed[key];
  },
  markFailed(key, msg) { data.failed[key] = msg; },
  setCursor(table, v) { if (v) data.cursors[table] = v; },
  markSynced() { data.lastSyncAt = nowIso(); persist(); emit(); },
  setProfile(p) { data.profile = { display_name: p.display_name || '', ai_enabled: !!p.ai_enabled }; persist(); emit(); },
  flush() { persist(); emit(); },

  /** دمج صفوف قادمة من الخادم: الأحدث يفوز، وتعديل محلي أحدث غير مزامَن يُحفظ */
  applyRemote(table, rows) {
    let changed = false;
    for (const raw of rows) {
      const r = cleanRemote(table, raw);
      const meta = META[table];
      const pk = meta.pk(r);
      const qk = `${table}|${pk}`;
      const local = meta.coll ? data[meta.coll][pk] : data.settings;
      const isDirty = qk in data.queue;
      if (local && isDirty && ts(local.updated_at) >= ts(r.updated_at)) continue; // التعديل المحلي أحدث
      if (isDirty) delete data.queue[qk]; // الخادم أحدث: نتخلى عن التعديل المحلي القديم
      if (meta.coll) data[meta.coll][pk] = r; else data.settings = r;
      changed = true;
    }
    if (changed) { persist(); emit(); }
    return changed;
  },
};
