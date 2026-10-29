// عميل Supabase خفيف بلا مكتبات: المصادقة (GoTrue) + قاعدة البيانات (PostgREST) + الدوال الخلفية.
// يستخدم فقط المفتاح العام وجلسة المستخدم. لا أسرار هنا.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const STORE_KEY = 'mz-auth';

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', network = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.network = network;
  }
}

let session = readSession();
let refreshing = null;
const listeners = new Set();

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    return s && s.access_token && s.refresh_token ? s : null;
  } catch { return null; }
}
function writeSession(s) {
  session = s;
  try { s ? localStorage.setItem(STORE_KEY, JSON.stringify(s)) : localStorage.removeItem(STORE_KEY); } catch { /* التخزين غير متاح */ }
}
function emit(evt) {
  listeners.forEach((fn) => { try { fn(evt, session); } catch (e) { console.error(e); } });
}
const nowSec = () => Math.floor(Date.now() / 1000);

async function raw(path, { method = 'GET', headers = {}, body, token } = {}) {
  let res;
  try {
    res = await fetch(SUPABASE_URL + path, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('network', { network: true });
  }
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* ليس JSON */ } }
  if (!res.ok) {
    const code = json?.error_code || json?.code || json?.error || '';
    const msg = json?.msg || json?.message || json?.error_description || res.statusText || 'error';
    throw new ApiError(String(msg), { status: res.status, code: String(code) });
  }
  return json;
}

function setFromTokenResponse(r) {
  writeSession({
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at || nowSec() + (Number(r.expires_in) || 3600),
    user: r.user ? { id: r.user.id, email: r.user.email, user_metadata: r.user.user_metadata || {} } : session?.user || null,
  });
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    // قد يكون تبويب آخر جدّد الجلسة للتو
    const stored = readSession();
    if (stored) session = stored;
    if (session && session.expires_at - nowSec() > 60) return;
    if (!session) throw new ApiError('no session', { status: 401 });
    try {
      const r = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
      setFromTokenResponse(r);
      emit('TOKEN_REFRESHED');
    } catch (e) {
      // فقط الرفض الصريح من الخادم يُنهي الجلسة؛ انقطاع الشبكة لا يُخرج المستخدم
      if (!e.network && [400, 401, 403].includes(e.status)) {
        writeSession(null);
        emit('SIGNED_OUT');
      }
      throw e;
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function getToken() {
  if (!session) throw new ApiError('no session', { status: 401 });
  if (session.expires_at - nowSec() > 60) return session.access_token;
  try { await refresh(); } catch (e) { if (!e.network) throw e; }
  return session?.access_token;
}

async function authed(path, opts = {}) {
  const token = await getToken();
  try {
    return await raw(path, { ...opts, token });
  } catch (e) {
    if (e.status === 401 && !e.network) {
      if (session) session.expires_at = 0;
      await refresh();
      return raw(path, { ...opts, token: session?.access_token });
    }
    throw e;
  }
}

export const auth = {
  get session() { return session; },
  get user() { return session?.user || null; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async signUp(email, password, displayName) {
    const redirect = encodeURIComponent(location.origin + location.pathname);
    const r = await raw(`/auth/v1/signup?redirect_to=${redirect}`, { method: 'POST', body: { email, password, data: { display_name: displayName } } });
    if (r?.access_token) {
      setFromTokenResponse(r);
      emit('SIGNED_IN');
      return { signedIn: true };
    }
    // بريد مسجّل مسبقاً: يرد الخادم بمستخدم وهمي بلا هويات حمايةً من كشف الحسابات
    if (r && Array.isArray(r.identities) && r.identities.length === 0) return { signedIn: false, existing: true };
    return { signedIn: false, needsConfirm: true };
  },

  async signIn(email, password) {
    const r = await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    setFromTokenResponse(r);
    emit('SIGNED_IN');
  },

  async signOut() {
    const token = session?.access_token;
    writeSession(null);
    emit('SIGNED_OUT');
    if (token) { try { await raw('/auth/v1/logout', { method: 'POST', token }); } catch { /* الجلسة المحلية أُزيلت أصلاً */ } }
  },

  async resetPassword(email) {
    const redirect = encodeURIComponent(location.origin + location.pathname);
    await raw(`/auth/v1/recover?redirect_to=${redirect}`, { method: 'POST', body: { email } });
  },

  async updatePassword(password) {
    await authed('/auth/v1/user', { method: 'PUT', body: { password } });
  },

  /** معالجة روابط التأكيد/الاستعادة القادمة من البريد (الرمز في hash الرابط) */
  async consumeUrlSession() {
    const h = location.hash || '';
    if (!/(access_token|error_code|error=)/.test(h)) return null;
    const p = new URLSearchParams(h.replace(/^#\/?/, ''));
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('error') || p.get('error_code')) {
      return { error: p.get('error_code') || p.get('error'), description: p.get('error_description') || '' };
    }
    const access = p.get('access_token');
    const refreshTok = p.get('refresh_token');
    if (!access || !refreshTok) return null;
    writeSession({
      access_token: access,
      refresh_token: refreshTok,
      expires_at: Number(p.get('expires_at')) || nowSec() + (Number(p.get('expires_in')) || 3600),
      user: null,
    });
    try {
      const u = await raw('/auth/v1/user', { token: access });
      session.user = { id: u.id, email: u.email, user_metadata: u.user_metadata || {} };
      writeSession(session);
    } catch (e) {
      if (!e.network) { writeSession(null); return { error: 'invalid_link', description: '' }; }
    }
    const type = p.get('type');
    emit(type === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN');
    return { type };
  },
};

export const db = {
  select(table, { filters = [], order, limit } = {}) {
    const q = new URLSearchParams();
    q.set('select', '*');
    filters.forEach(([col, op, val]) => q.append(col, `${op}.${val}`));
    if (order) q.set('order', order);
    if (limit) q.set('limit', String(limit));
    return authed(`/rest/v1/${table}?${q.toString()}`);
  },
  upsert(table, rows, onConflict) {
    return authed(`/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: rows,
    });
  },
};

export const functions = {
  invoke(name, body) { return authed(`/functions/v1/${name}`, { method: 'POST', body }); },
};

/** رسالة عربية مفهومة لأخطاء الخادم الشائعة */
export function arMessage(e) {
  if (!e) return 'حدث خطأ غير متوقع';
  if (e.network) return 'لا يوجد اتصال بالإنترنت';
  const c = e.code || '';
  const m = (e.message || '').toLowerCase();
  if (c === 'invalid_credentials' || m.includes('invalid login')) return 'البريد الإلكتروني أو كلمة السر غير صحيحة';
  if (c === 'email_not_confirmed' || m.includes('not confirmed')) return 'لم يُؤكَّد بريدك بعد. افتح رسالة التأكيد المرسلة إلى بريدك';
  if (c === 'user_already_exists' || m.includes('already registered')) return 'هذا البريد مسجّل مسبقاً، جرّب تسجيل الدخول';
  if (c === 'weak_password') return 'كلمة السر ضعيفة، اختر كلمة أطول وأصعب';
  if (c === 'over_email_send_rate_limit' || c === 'over_request_rate_limit' || e.status === 429) return 'تم تجاوز الحد المسموح مؤقتاً. انتظر قليلاً ثم حاول مجدداً';
  if (c === 'signup_disabled') return 'التسجيل مغلق حالياً';
  if (c === 'validation_failed' || c === 'email_address_invalid') return 'تحقق من صحة البريد الإلكتروني';
  if (c === 'same_password') return 'كلمة السر الجديدة مطابقة للقديمة';
  if (c === 'ai_not_enabled') return 'تحليل البرامج بالذكاء الاصطناعي غير مفعّل لحسابك';
  if (c === 'ai_not_configured') return 'خدمة الذكاء الاصطناعي لم تُضبط بعد على الخادم';
  if (c === 'ai_rate_limited') return 'تم بلوغ حد الاستخدام المجاني للذكاء الاصطناعي. حاول بعد قليل';
  if (c === 'ai_provider_error' || c === 'ai_bad_output') return 'تعذّر على الذكاء الاصطناعي قراءة الملف. جرّب صورة أوضح';
  if (c === 'unsupported_file_type') return 'نوع الملف غير مدعوم (صورة أو PDF فقط)';
  if (c === 'file_missing_or_too_large') return 'الملف كبير جداً';
  if (e.status === 401) return 'انتهت الجلسة، سجّل الدخول من جديد';
  return 'تعذّر إتمام العملية. حاول مرة أخرى';
}
