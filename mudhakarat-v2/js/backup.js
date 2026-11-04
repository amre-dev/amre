// النسخ الاحتياطي الكامل + ملف مشاركة برنامج المذاكرات (بلا أي علامات) مع التحقق قبل أي استبدال.
import { store } from './store.js';
import { nowIso, isValidDate, normalizeAr } from './util.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function buildBackup() {
  const d = store.data;
  return {
    app: 'mudhakarat-backup',
    version: 1,
    exportedAt: nowIso(),
    settings: { display_scale: d.settings.display_scale, default_goal: d.settings.default_goal },
    subjects: store.subjects().map((s) => ({ id: s.id, name: s.name, default_full_mark: s.default_full_mark })),
    months: Object.values(d.months).filter((m) => !m.deleted && m.goal_pct != null).map((m) => ({ month_key: m.month_key, goal_pct: m.goal_pct })),
    exams: store.exams().map((e) => ({
      subject_id: e.subject_id, subject_name: e.subject_name, title: e.title, notes: e.notes, exam_date: e.exam_date,
      full_mark: e.full_mark, expected_mark: e.expected_mark, actual_mark: e.actual_mark,
    })),
  };
}

/** ملف مشاركة البرنامج: تواريخ ومواد وعناوين فقط، لا علامات ولا أهداف */
export function buildScheduleFile(exams) {
  return {
    app: 'mudhakarat-schedule',
    version: 1,
    exportedAt: nowIso(),
    exams: exams.map((e) => ({ date: e.exam_date, subject: e.subject_name, title: e.title || '', notes: e.notes || '' })),
  };
}

export function validateScheduleFile(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'الملف غير صالح' };
  if (obj.app === 'mudhakarat-backup') return { ok: false, error: 'هذه نسخة احتياطية كاملة وليست برنامج مذاكرات. استوردها من الإعدادات ← النسخ الاحتياطي' };
  if (obj.app !== 'mudhakarat-schedule' || obj.version !== 1 || !Array.isArray(obj.exams)) return { ok: false, error: 'هذا ليس ملف برنامج مذاكرات من التطبيق' };
  if (obj.exams.length > 500) return { ok: false, error: 'الملف يحتوي عدداً كبيراً غير معقول من المذاكرات' };
  const rows = [];
  let skipped = 0;
  for (const e of obj.exams) {
    const date = str(e?.date, 10);
    const subject = str(e?.subject, 80);
    if (!isValidDate(date) || !subject) { skipped++; continue; }
    rows.push({ date, day: '', subject, title: str(e.title, 300), notes: str(e.notes, 1000) });
  }
  if (!rows.length) return { ok: false, error: 'لا توجد مذاكرات صالحة داخل الملف' };
  return { ok: true, rows, skipped };
}

export function validateBackup(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'الملف غير صالح' };
  if (obj.app === 'mudhakarat-schedule') return { ok: false, error: 'هذا ملف برنامج مذاكرات وليس نسخة احتياطية. استورده من تبويب «استيراد»' };
  if (obj.app !== 'mudhakarat-backup' || obj.version !== 1) return { ok: false, error: 'هذا ليس ملف نسخة احتياطية من التطبيق' };
  if (!Array.isArray(obj.exams) || !Array.isArray(obj.subjects) || !Array.isArray(obj.months)) return { ok: false, error: 'بنية الملف ناقصة أو تالفة' };
  if (obj.exams.length > 3000 || obj.subjects.length > 300 || obj.months.length > 600) return { ok: false, error: 'حجم الملف غير معقول' };

  let skipped = 0;
  const subjects = [];
  for (const s of obj.subjects) {
    const name = str(s?.name, 80);
    if (!name || !isNum(s?.default_full_mark) || s.default_full_mark <= 0 || s.default_full_mark > 100000) { skipped++; continue; }
    subjects.push({ id: typeof s.id === 'string' ? s.id : null, name, default_full_mark: s.default_full_mark });
  }
  const exams = [];
  for (const e of obj.exams) {
    const subject_name = str(e?.subject_name, 80);
    const full = e?.full_mark;
    const exp = e?.expected_mark ?? null;
    const act = e?.actual_mark ?? null;
    const okMark = (v) => v === null || (isNum(v) && v >= 0 && v <= full);
    if (!subject_name || !isValidDate(e?.exam_date) || !isNum(full) || full <= 0 || full > 100000 || !okMark(exp) || !okMark(act)) { skipped++; continue; }
    exams.push({ subject_ref: typeof e.subject_id === 'string' ? e.subject_id : null, subject_name, title: str(e.title, 300), notes: str(e.notes, 1000), exam_date: e.exam_date, full_mark: full, expected_mark: exp, actual_mark: act });
  }
  const months = [];
  for (const m of obj.months) {
    if (typeof m?.month_key === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m.month_key) && isNum(m.goal_pct) && m.goal_pct >= 0 && m.goal_pct <= 100) months.push({ month_key: m.month_key, goal_pct: m.goal_pct });
    else skipped++;
  }
  let settings = null;
  const st = obj.settings;
  if (st && isNum(st.display_scale) && st.display_scale > 0 && st.display_scale <= 100000 && isNum(st.default_goal) && st.default_goal >= 0 && st.default_goal <= 100) {
    settings = { display_scale: st.display_scale, default_goal: st.default_goal };
  }
  if (!exams.length && !subjects.length && !months.length) return { ok: false, error: 'لا توجد بيانات صالحة داخل الملف' };
  return { ok: true, clean: { settings, subjects, months, exams }, skipped, counts: { exams: exams.length, subjects: subjects.length, months: months.length } };
}

/** تطبيق نسخة مُتحقَّق منها. دائماً بمعرّفات جديدة لتفادي أي تعارض مع حسابات أخرى. */
export function applyBackup(clean, mode) {
  const replace = mode === 'replace';
  if (replace) {
    store.exams().forEach((e) => store.removeExam(e.id));
    store.subjects().forEach((s) => store.removeSubject(s.id));
  }
  const map = new Map();
  for (const s of clean.subjects) {
    const existing = replace ? null : store.findSubject(s.name);
    const rec = existing || store.saveSubject({ name: s.name, default_full_mark: s.default_full_mark });
    if (s.id) map.set(s.id, rec.id);
  }
  const keyOf = (date, subject, title) => `${date}|${normalizeAr(subject)}|${normalizeAr(title)}`;
  const have = new Set(replace ? [] : store.exams().map((e) => keyOf(e.exam_date, e.subject_name, e.title)));
  let added = 0;
  for (const e of clean.exams) {
    const k = keyOf(e.exam_date, e.subject_name, e.title);
    if (have.has(k)) continue;
    have.add(k);
    const subject = (e.subject_ref && map.get(e.subject_ref)) || store.findSubject(e.subject_name)?.id || null;
    store.saveExam({ subject_id: subject, subject_name: e.subject_name, title: e.title, notes: e.notes, exam_date: e.exam_date, full_mark: e.full_mark, expected_mark: e.expected_mark, actual_mark: e.actual_mark });
    added++;
  }
  for (const m of clean.months) {
    if (replace || !store.hasCustomGoal(m.month_key)) store.setGoal(m.month_key, m.goal_pct);
  }
  if (replace && clean.settings) store.setSettings(clean.settings);
  return { added };
}
