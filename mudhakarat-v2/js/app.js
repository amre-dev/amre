import { auth, functions, arMessage } from './supa.js';
import { store } from './store.js';
import * as sync from './sync.js';
import { summarize, goalPlan, deriveStatus, validateMarks, scaled, STATUS_LABEL } from './calc.js';
import {
  uid, esc, fmt, parseNum, todayStr, currentMonthKey, addMonths, monthLabel, monthKeyOf, isValidDate,
  dateParts, dateLabel, DAYS_SHORT, DAYS_AR, normalizeAr, pad, downloadBlob, examCount,
} from './util.js';
import { buildBackup, buildScheduleFile, validateBackup, validateScheduleFile, applyBackup } from './backup.js';
import { ICONS } from './icons.js';
import { APP_VERSION } from './config.js';

/* ====================== أدوات عامة ====================== */
const $ = (s, r = document) => r.querySelector(s);
const appEl = $('#app');
const dlg = $('#dlg');

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* تجاهل */ } };

const ROUTES = ['home', 'calendar', 'import', 'settings'];
const ui = {
  route: 'home',
  month: /^\d{4}-\d{2}$/.test(lsGet('mz:ui:month') || '') ? lsGet('mz:ui:month') : currentMonthKey(),
  selDay: null,
  review: null,
  imp: { state: 'idle', id: 0 },
  authTab: 'login',
  sub: null,
  advOpen: false,
};
let currentUser = null;
let recovering = false;
let manualOut = false;
let pendingRender = false;
let unsubStore = null;
let unsubSync = null;

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5500 : 3200);
}

function ask({ title, body = '', buttons }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.setAttribute('aria-labelledby', 'askT');
    d.innerHTML = `<div class="dlg-h"><h2 id="askT">${esc(title)}</h2></div><div class="dlg-b">${body}</div>
      <div class="dlg-f">${buttons.map((b) => `<button class="btn ${b.cls || ''}" data-id="${b.id}">${esc(b.label)}</button>`).join('')}</div>`;
    document.body.append(d);
    let done = false;
    const fin = (v) => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    d.addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) fin(b.dataset.id); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); fin(null); });
    d.showModal();
  });
}

const statusClass = (e) => `s-${deriveStatus(e)}`;
const badge = (st) => `<span class="badge s-${st}">${STATUS_LABEL[st]}</span>`;

/* ====================== الإقلاع والمصادقة ====================== */
async function boot() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  auth.onChange(onAuthEvent);
  const url = await auth.consumeUrlSession().catch(() => null);
  if (recovering) return;
  if (auth.user) { enterApp(auth.user); return; }
  let note = '';
  if (url?.error) note = 'رابط التأكيد أو الاستعادة غير صالح أو انتهت صلاحيته. اطلب رابطاً جديداً.';
  else if (url?.type === 'signup') note = 'تم تأكيد بريدك. سجّل الدخول الآن.';
  showAuth(note);
}

function onAuthEvent(evt) {
  if (evt === 'PASSWORD_RECOVERY') { recovering = true; showRecovery(); return; }
  if (evt === 'SIGNED_IN') { if (!recovering && auth.user && auth.user.id !== currentUser) enterApp(auth.user); return; }
  if (evt === 'SIGNED_OUT') {
    if (currentUser) leaveApp();
    else if (!recovering) showAuth('');
  }
}

function showAuth(note = '') {
  const signup = ui.authTab === 'signup';
  appEl.innerHTML = `
  <div class="authwrap"><div class="card authcard">
    <div class="brand"><img class="logo" src="icons/icon.svg" alt="" width="28" height="28"><b>مذاكراتي</b></div>
    <h1 style="margin-top:10px">${signup ? 'إنشاء حساب' : 'تسجيل الدخول'}</h1>
    <p class="note" style="margin:4px 0 0">${signup ? 'احفظ علاماتك سحابياً وافتحها من أي جهاز.' : 'ادخل إلى حسابك لمتابعة مذاكراتك.'}</p>
    <div class="tabsw" role="tablist">
      <button role="tab" aria-selected="${!signup}" data-act="authtab" data-t="login">دخول</button>
      <button role="tab" aria-selected="${signup}" data-act="authtab" data-t="signup">حساب جديد</button>
    </div>
    ${!navigator.onLine ? '<p class="warnbox">أنت غير متصل بالإنترنت. تسجيل الدخول لأول مرة يحتاج اتصالاً.</p>' : ''}
    ${note ? `<p class="warnbox" role="status">${esc(note)}</p>` : ''}
    <form data-form="auth" novalidate>
      ${signup ? `<div class="field"><label for="a-name">الاسم</label><input id="a-name" type="text" autocomplete="name" maxlength="60" required></div>` : ''}
      <div class="field"><label for="a-email">البريد الإلكتروني</label><input id="a-email" type="email" inputmode="email" dir="ltr" autocomplete="email" required></div>
      <div class="field"><label for="a-pass">كلمة السر ${signup ? '(8 أحرف على الأقل)' : ''}</label><input id="a-pass" type="password" dir="ltr" autocomplete="${signup ? 'new-password' : 'current-password'}" required></div>
      <div class="err" id="a-err" role="alert"></div>
      <button class="btn primary" style="width:100%" id="a-go">${signup ? 'إنشاء الحساب' : 'دخول'}</button>
    </form>
    ${signup ? '' : '<p class="note" style="margin-bottom:0"><button class="link" data-act="forgot">نسيت كلمة السر؟</button></p>'}
  </div></div>`;
}

function showRecovery() {
  appEl.innerHTML = `
  <div class="authwrap"><div class="card authcard">
    <div class="brand"><img class="logo" src="icons/icon.svg" alt="" width="28" height="28"><b>مذاكراتي</b></div>
    <h1 style="margin-top:10px">كلمة سر جديدة</h1>
    <form data-form="recovery" novalidate style="margin-top:14px">
      <div class="field"><label for="r-pass">كلمة السر الجديدة (8 أحرف على الأقل)</label><input id="r-pass" type="password" dir="ltr" autocomplete="new-password" required></div>
      <div class="field"><label for="r-pass2">أعد كتابتها</label><input id="r-pass2" type="password" dir="ltr" autocomplete="new-password" required></div>
      <div class="err" id="a-err" role="alert"></div>
      <button class="btn primary" style="width:100%">حفظ ومتابعة</button>
    </form>
  </div></div>`;
}

const F = {}; // معالجات النماذج
const A = {}; // معالجات النقرات

F.auth = async (form) => {
  const signup = ui.authTab === 'signup';
  const err = $('#a-err');
  const btn = $('#a-go');
  const email = $('#a-email').value.trim();
  const pass = $('#a-pass').value;
  const name = signup ? $('#a-name').value.trim() : '';
  err.textContent = '';
  if (signup && !name) { err.textContent = 'اكتب اسمك'; return; }
  if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'أدخل بريداً إلكترونياً صحيحاً'; return; }
  if (signup && pass.length < 8) { err.textContent = 'كلمة السر يجب ألا تقل عن 8 أحرف'; return; }
  if (!pass) { err.textContent = 'أدخل كلمة السر'; return; }
  btn.disabled = true;
  try {
    if (signup) {
      const r = await auth.signUp(email, pass, name);
      if (r.existing) { err.textContent = 'هذا البريد مسجّل مسبقاً، جرّب تسجيل الدخول'; }
      else if (r.needsConfirm) {
        form.innerHTML = `<p class="warnbox" role="status">أرسلنا رسالة تأكيد إلى <b dir="ltr">${esc(email)}</b>. افتحها واضغط الرابط ثم ارجع وسجّل الدخول. (تحقق من البريد المزعج أيضاً)</p>
          <button type="button" class="btn" style="width:100%;margin-top:12px" data-act="authtab" data-t="login">الذهاب إلى تسجيل الدخول</button>`;
      }
    } else {
      await auth.signIn(email, pass);
    }
  } catch (e) {
    err.textContent = arMessage(e);
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
};

F.recovery = async () => {
  const err = $('#a-err');
  const p1 = $('#r-pass').value;
  const p2 = $('#r-pass2').value;
  err.textContent = '';
  if (p1.length < 8) { err.textContent = 'كلمة السر يجب ألا تقل عن 8 أحرف'; return; }
  if (p1 !== p2) { err.textContent = 'كلمتا السر غير متطابقتين'; return; }
  try {
    await auth.updatePassword(p1);
    recovering = false;
    toast('تم تغيير كلمة السر');
    if (auth.user) enterApp(auth.user); else showAuth('');
  } catch (e) { err.textContent = arMessage(e); }
};

A.authtab = (t) => { ui.authTab = t.dataset.t; showAuth(''); };
A.forgot = async () => {
  const email = ($('#a-email')?.value || '').trim();
  const err = $('#a-err');
  if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'اكتب بريدك في الحقل أعلاه أولاً ثم اضغط «نسيت كلمة السر»'; return; }
  try {
    await auth.resetPassword(email);
    err.textContent = '';
    toast('إن كان البريد مسجّلاً فستصلك رسالة لاستعادة كلمة السر');
  } catch (e) { err.textContent = arMessage(e); }
};

/* ====================== الهيكل الرئيسي ====================== */
function enterApp(user) {
  currentUser = user.id;
  store.init(user.id);
  lsSet('mz:lastUser', JSON.stringify({ id: user.id, email: user.email }));
  appEl.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand"><img class="logo" src="icons/icon.svg" alt="" width="28" height="28"><b>مذاكراتي</b></div>
      <nav class="tabs" aria-label="التنقل الرئيسي">
        ${[['home', 'الرئيسية'], ['calendar', 'التقويم'], ['import', 'استيراد'], ['settings', 'الإعدادات']]
          .map(([r, l]) => `<button data-act="go" data-r="${r}">${ICONS[r]}<span>${l}</span></button>`).join('')}
      </nav>
      <span class="spacer"></span>
      <button class="syncchip" id="chip" data-act="sync" aria-live="polite"><span class="dot"></span><span id="chipText">…</span></button>
    </header>
    <main id="view" tabindex="-1"></main>
  </div>`;
  ui.route = routeFromHash();
  unsubStore?.(); unsubSync?.();
  unsubStore = store.subscribe(() => render(false));
  unsubSync = sync.onStatus(() => { updateChip(); render(false); });
  sync.start();
  render(true);
  updateChip();
  sync.syncNow();
}

function leaveApp() {
  currentUser = null;
  unsubStore?.(); unsubSync?.();
  unsubStore = unsubSync = null;
  showAuth(manualOut ? '' : 'انتهت جلستك. سجّل الدخول مجدداً (بياناتك المحلية محفوظة على جهازك).');
  manualOut = false;
}

function routeFromHash() {
  const m = /^#\/(\w+)(?:\/(\w+))?/.exec(location.hash);
  const r = m && ROUTES.includes(m[1]) ? m[1] : 'home';
  ui.sub = r === 'settings' && m && m[2] ? m[2] : null;
  return r;
}
window.addEventListener('hashchange', () => {
  if (!currentUser) return;
  ui.route = routeFromHash();
  render(true);
  window.scrollTo(0, 0);
});
function go(route) {
  if (location.hash === `#/${route}`) { ui.route = routeFromHash(); render(true); window.scrollTo(0, 0); } else location.hash = `#/${route}`;
}

const CHIP = {
  synced: 'محفوظ سحابياً',
  syncing: 'جارٍ الحفظ…',
  offline: 'غير متصل',
  failed: 'فشل الحفظ — اضغط للمحاولة',
  pending: 'بانتظار المزامنة',
  idle: '…',
};
function updateChip() {
  const chip = $('#chip');
  if (!chip) return;
  const s = sync.getStatus();
  let text = CHIP[s.state];
  if ((s.state === 'pending' || s.state === 'offline') && s.pending) text += ` (${s.pending})`;
  chip.dataset.s = s.state;
  $('#chipText').textContent = text;
  chip.title = s.lastError || '';
}

A.sync = async () => {
  const s = sync.getStatus();
  if (s.state === 'failed') toast(s.lastError || 'تعذّر حفظ بعض التعديلات. سنعيد المحاولة.', 'err');
  if (!navigator.onLine) { toast('أنت غير متصل. تعديلاتك محفوظة على جهازك وستُرسل عند عودة الاتصال.'); return; }
  await sync.syncNow();
  const n = sync.getStatus();
  if (n.state === 'synced') toast('تمت المزامنة ✓');
};

let forceNext = false;
function render(force = false) {
  const v = $('#view');
  if (!v || !currentUser || !store.ready) return;
  const ae = document.activeElement;
  const typing = v.contains(ae) && ae.matches('input:not([type=checkbox]):not([type=file]),select,textarea');
  if (!force && (typing || dlg.open || document.querySelector('dialog[open]'))) { pendingRender = true; return; }
  pendingRender = false;
  const y = window.scrollY;
  v.innerHTML = VIEWS[ui.route]();
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    if (b.dataset.r === ui.route) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (!force) window.scrollTo(0, y);
}
document.addEventListener('toggle', (e) => { if (e.target && e.target.matches && e.target.matches('details[data-adv]')) ui.advOpen = e.target.open; }, true);
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !document.querySelector('dialog[open]')) render(false); }, 50));
dlg.addEventListener('close', () => { if (pendingRender) render(false); });

/* ====================== مكوّنات العرض ====================== */
function monthbar(key) {
  const n = store.examsOfMonth(key).length;
  return `<div class="monthbar">
    <button class="iconbtn" data-act="month" data-d="-1" aria-label="الشهر السابق">${ICONS.prev}</button>
    <div class="title">${monthLabel(key)}<small>${n ? examCount(n) : 'لا مذاكرات'}${key !== currentMonthKey() ? ' · <button class="link" data-act="thismonth">الشهر الحالي</button>' : ''}</small></div>
    <button class="iconbtn" data-act="month" data-d="1" aria-label="الشهر التالي">${ICONS.next}</button>
  </div>`;
}

function examRow(e) {
  const st = deriveStatus(e);
  const { d, dow } = dateParts(e.exam_date);
  let marks;
  if (st === 'completed') marks = `<span class="m num">${fmt(e.actual_mark)} / ${fmt(e.full_mark)}</span>`;
  else if (st === 'awaiting') marks = `<span class="m num">≈ ${fmt(e.expected_mark)} / ${fmt(e.full_mark)}</span><span class="hint">توقّعي</span>`;
  else marks = `<span class="m num">${fmt(e.full_mark)}</span><span class="hint">العلامة الكاملة</span>`;
  return `<button class="exam s-${st}" data-act="edit" data-id="${e.id}">
    <span class="date"><b class="num">${d}</b>${DAYS_SHORT[dow]}</span>
    <span class="name">${subjAvatar(e.subject_name)}<span>${esc(e.subject_name)}</span></span>
    <span class="marks">${marks}${badge(st)}</span>
    ${e.title ? `<span class="ttl">${esc(e.title)}</span>` : ''}
  </button>`;
}

const SJ_HUES = [38, 160, 210, 270, 330, 12, 190, 90];
function subjHue(name) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return SJ_HUES[h % SJ_HUES.length]; }
function subjAvatar(name) { return `<i class="sj" style="--h:${subjHue(name)}" aria-hidden="true">${esc([...String(name).trim().replace(/^ال(?=.)/, '')][0] || '؟')}</i>`; }
function daysUntil(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const [ty, tm, td] = todayStr().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}
function daysText(n) {
  if (n <= 0) return 'اليوم';
  if (n === 1) return 'غداً';
  if (n === 2) return 'بعد يومين';
  return n <= 10 ? `بعد ${n} أيام` : `بعد ${n} يوماً`;
}

function statCol(kind, label, pct, emptyText, scale) {
  if (pct == null) return `<div class="st ${kind}"><div class="k">${label}</div><div class="v none">—</div><div class="sub">${emptyText}</div></div>`;
  return `<div class="st ${kind}"><div class="k">${label}</div>
    <div class="v num">${fmt(scaled(pct, scale))}<small>${scale === 100 ? '%' : `/${fmt(scale)}`}</small></div>${scale === 100 ? '' : `<div class="sub num">${fmt(pct)}%</div>`}</div>`;
}

// الهدف للعرض فقط. تعديله من الإعدادات ← العرض والهدف.
function goalLine(plan, key) {
  const g = `<b class="num">${fmt(store.monthGoal(key))}%</b>`;
  switch (plan.state) {
    case 'empty': return '';
    case 'achieved': return `<div class="goalline ok">✓ تحقق الهدف ${g}</div>`;
    case 'missed': return `<div class="goalline bad">لم يتحقق الهدف ${g} · نتيجتك <b class="num">${fmt(plan.finalPct)}%</b></div>`;
    case 'impossible': return `<div class="goalline bad">الهدف ${g} غير قابل للتحقيق · الأعلى الممكن <b class="num">${fmt(plan.maxPossiblePct)}%</b></div>`;
    default: return `<div class="goalline">الهدف ${g}<span class="sep" aria-hidden="true"></span>المطلوب في المتبقي <b class="num">${fmt(plan.requiredPct)}%</b></div>`;
  }
}

function quickBlock(exams) {
  const today = todayStr();
  const list = exams.filter((e) => e.exam_date <= today && deriveStatus(e) !== 'completed');
  if (!list.length) return '';
  return `<div class="sec-title">بانتظار إدخالك</div>` + list.map((e) => {
    const st = deriveStatus(e);
    const ph = st === 'upcoming' ? 'علامتي المتوقعة' : 'العلامة الفعلية';
    return `<div class="quick s-${st}">
      <button class="who" data-act="edit" data-id="${e.id}"><b>${esc(e.subject_name)}</b><div class="note">${esc(e.title || '')}${e.title ? ' · ' : ''}${dateLabel(e.exam_date)}${st === 'awaiting' ? ` · توقعك <span class="num">${fmt(e.expected_mark)}</span>` : ''}</div></button>
      ${badge(st)}
      <form class="qi" data-form="quick" data-id="${e.id}" novalidate>
        <input type="text" inputmode="decimal" name="v" placeholder="${ph} (من ${fmt(e.full_mark)})" aria-label="${ph} لمادة ${esc(e.subject_name)}">
        <button class="btn primary small">حفظ</button>
      </form></div>`;
  }).join('');
}

/* ====================== الشاشات ====================== */
const VIEWS = { home: viewHome, calendar: viewCalendar, import: viewImport, settings: viewSettings };

function viewHome() {
  const key = ui.month;
  const exams = store.examsOfMonth(key);
  const S = summarize(exams);
  const scale = store.settings().display_scale;
  const plan = goalPlan(exams, store.monthGoal(key));
  const today = todayStr();
  const nextExam = store.exams()
    .filter((e) => e.exam_date >= today && deriveStatus(e) === 'upcoming')
    .sort((a, b) => a.exam_date.localeCompare(b.exam_date) || a.subject_name.localeCompare(b.subject_name, 'ar'))[0];
  const upcoming = exams.filter((e) => e.exam_date > today && deriveStatus(e) === 'upcoming' && e.id !== nextExam?.id);
  const pDone = S.count ? (S.completed / S.count) * 100 : 0;
  const pWait = S.count ? (S.awaiting / S.count) * 100 : 0;
  const name = (store.profile().display_name || auth.user?.user_metadata?.display_name || '').trim();

  let hero;
  if (nextExam) {
    const n = daysUntil(nextExam.exam_date);
    hero = `<button class="hero" data-act="edit" data-id="${nextExam.id}">
      <span class="k">أقرب مذاكرة</span>
      <span class="hrow">${subjAvatar(nextExam.subject_name)}<span class="hname">${esc(nextExam.subject_name)}</span></span>
      ${nextExam.title ? `<span class="htitle">${esc(nextExam.title)}</span>` : ''}
      <span class="hcount${n <= 1 ? ' soon' : ''}">${daysText(n)}</span>
      <span class="hdate">${dateLabel(nextExam.exam_date)}</span></button>`;
  } else {
    hero = `<section class="hero static"><span class="k">أقرب مذاكرة</span><span class="hname">لا توجد مذاكرات قادمة</span>
      <span class="row" style="margin-top:10px"><button class="btn primary small" data-act="go" data-r="import">${ICONS.import}استيراد برنامج</button><button class="btn small" data-act="add">${ICONS.plus}إضافة يدوية</button></span></section>`;
  }

  const body = exams.length ? `
  <section class="card stats">
    <div class="statgrid">
      ${statCol('true', 'المعدل الحقيقي', S.truePct, 'لم تصدر نتيجة بعد', scale)}
      ${statCol('expected', 'المعدل المتوقع', S.expectedPct, 'لم تقدّم توقعاً بعد', scale)}
    </div>
    ${goalLine(plan, key)}
  </section>
  <section class="card slim">
    <div class="row" style="justify-content:space-between"><span class="note">تقدّمك في البرنامج</span><span class="num note">${S.taken} / ${S.count}</span></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${S.count}" aria-valuenow="${S.taken}" aria-label="المذاكرات المقدّمة">
      <i class="p-done" style="width:${pDone}%"></i><i class="p-wait" style="width:${pWait}%"></i></div>
    <div class="legend">
      <span><i class="dotc s-completed"></i>مكتملة <b class="num">${S.completed}</b></span>
      <span><i class="dotc s-awaiting"></i>بانتظار النتيجة <b class="num">${S.awaiting}</b></span>
      <span><i class="dotc s-upcoming"></i>قادمة <b class="num">${S.upcoming}</b></span>
    </div>
  </section>
  ${quickBlock(exams)}
  ${upcoming.length ? `<div class="sec-title"><span>المذاكرات القادمة</span><button class="link" data-act="go" data-r="calendar">عرض الكل</button></div>${upcoming.slice(0, 3).map(examRow).join('')}` : ''}`
    : (nextExam ? `<div class="empty-state">لا توجد مذاكرات في ${monthLabel(key)}.</div>` : '');

  return `<div class="greet"><h2>مرحباً${name ? `، ${esc(name)}` : ''}</h2></div>
  ${hero}
  ${monthbar(key)}
  ${body}`;
}

function viewCalendar() {
  const key = ui.month;
  const [y, m] = key.split('-').map(Number);
  const first = new Date(y, m - 1, 1).getDay();
  const dim = new Date(y, m, 0).getDate();
  const exams = store.examsOfMonth(key);
  const byDay = {};
  exams.forEach((e) => { (byDay[e.exam_date] ||= []).push(e); });
  const today = todayStr();
  const sel = ui.selDay && monthKeyOf(ui.selDay) === key ? ui.selDay : null;

  let cells = DAYS_SHORT.map((d) => `<div class="dn">${d}</div>`).join('');
  for (let i = 0; i < first; i++) cells += '<div class="day empty"></div>';
  for (let d = 1; d <= dim; d++) {
    const ds = `${key}-${pad(d)}`;
    const list = byDay[ds] || [];
    const chips = list.slice(0, 2).map((e) => `<i class="${statusClass(e)}">${esc(e.subject_name)}</i>`).join('');
    cells += `<button class="day${ds === today ? ' today' : ''}${ds === sel ? ' sel' : ''}" data-act="selday" data-date="${ds}" aria-label="${dateLabel(ds)}${list.length ? `، ${examCount(list.length)}` : ''}" aria-pressed="${ds === sel}">
      <span class="n">${d}</span>${chips}${list.length > 2 ? `<span class="more">+${list.length - 2}</span>` : ''}</button>`;
  }

  const selList = sel ? (byDay[sel] || []) : [];
  const panel = sel ? `<section class="card" style="margin-top:12px"><div class="row" style="justify-content:space-between"><b>${dateLabel(sel)}</b>
    <button class="btn small primary" data-act="add" data-date="${sel}">${ICONS.plus}إضافة مذاكرة</button></div>
    <div style="margin-top:10px">${selList.length ? selList.map(examRow).join('') : '<span class="note">لا توجد مذاكرات في هذا اليوم.</span>'}</div></section>` : '';

  return `${monthbar(key)}
  <div class="row" style="margin-bottom:12px"><button class="btn primary" data-act="add">${ICONS.plus}إضافة مذاكرة</button>
    <span class="legend" style="margin:0"><span><i class="dotc s-upcoming"></i>قادمة</span><span><i class="dotc s-awaiting"></i>بانتظار النتيجة</span><span><i class="dotc s-completed"></i>مكتملة</span></span></div>
  <div class="cal" role="grid" aria-label="تقويم ${monthLabel(key)}">${cells}</div>
  ${panel}
  <div class="sec-title">كل مذاكرات الشهر</div>
  ${exams.length ? exams.map(examRow).join('') : `<div class="empty-state">لا توجد مذاكرات في ${monthLabel(key)}.</div>`}`;
}

function viewImport() {
  if (ui.review) return reviewView();
  const ai = store.profile().ai_enabled;
  const advOpen = ui.advOpen || ui.imp.state === 'error';
  return `<h2 class="ptitle">استيراد البرنامج</h2>
  <section class="card">
    <p class="lead">${ai ? 'صورة أو PDF أو ملف برنامج (.json) من زميل.' : 'ملف برنامج (.json) من زميل.'} تراجع النتائج وتعدّلها قبل الإضافة، ولا يُضاف شيء قبل موافقتك.</p>
    <input type="file" id="impFile" hidden accept="${ai ? '.json,application/json,image/*,application/pdf' : '.json,application/json'}">
    <div class="row"><button class="btn primary" data-act="pickfile" ${ui.imp.state === 'busy' ? 'disabled' : ''}>${ICONS.upload}اختيار ملف</button>
      <button class="btn" data-act="add">${ICONS.plus}إضافة يدوية</button></div>
    ${importStatus()}
    ${ai ? `<details class="adv" data-adv ${advOpen ? 'open' : ''}><summary>خيارات متقدمة</summary>${modelPicker()}</details>` : ''}
    <p class="note" style="margin:12px 0 0">${ai ? 'الصور وملفات PDF تحتاج إنترنت. الذكاء الاصطناعي يقرأ المواعيد فقط ولا يحسب أي علامة.'
      : 'قراءة الصور وملفات PDF بالذكاء الاصطناعي غير مفعّلة لحسابك. استورد ملف برنامج من زميل أو أضف المذاكرات يدوياً.'}</p>
  </section>
  <div class="sec-title"><span>مشاركة برنامجك</span></div>
  <section class="card">
    <p class="note" style="margin-top:0">ملف فيه التواريخ والمواد والعناوين فقط، <b>بلا علاماتك أو أهدافك</b>، ليستورده زملاؤك.</p>
    <div class="row"><select id="shareScope" style="max-width:240px" aria-label="نطاق التصدير"><option value="month">${monthLabel(ui.month)}</option><option value="all">كل الأشهر</option></select>
      <button class="btn" data-act="shareschedule">${ICONS.download}تصدير ملف البرنامج</button></div>
  </section>`;
}

/* ---------- الإعدادات: قائمة أسماء، وكل اسم يفتح صفحته ---------- */
function settingsPages() {
  const list = [
    ['account', 'الحساب والمزامنة', 'الاسم والبريد وحالة الحفظ'],
    ['display', 'العرض والهدف', 'مقياس المعدل وهدف كل شهر'],
    ['subjects', 'المواد والعلامات الكاملة', 'موادك وعلامة كل منها'],
  ];
  if (window.__mzNative) list.push(['notifications', 'التنبيهات', 'تذكيرات المذاكرات على هاتفك']);
  list.push(['backup', 'النسخ الاحتياطي', 'تصدير نسخة من بياناتك واستيرادها']);
  if (store.profile().ai_enabled) list.push(['ai', 'الذكاء الاصطناعي', 'قراءة البرنامج من صورة أو PDF']);
  list.push(['about', 'حول التطبيق', 'الإصدار وشرح البنية']);
  return list;
}

const SETTINGS_BODY = {
  account() {
    const p = store.profile();
    const user = auth.user;
    const s = sync.getStatus();
    const name = p.display_name || user?.user_metadata?.display_name || '';
    const syncText = {
      synced: `محفوظ سحابياً${s.lastSyncAt ? ` · آخر مزامنة ${new Date(s.lastSyncAt).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}` : ''}`,
      syncing: 'جارٍ المزامنة…',
      pending: `${s.pending} تعديل بانتظار المزامنة`,
      offline: `غير متصل. تعديلاتك محفوظة على جهازك${s.pending ? ` (${s.pending} بانتظار الإرسال)` : ''} وستُرسل عند عودة الاتصال.`,
      failed: `فشل الحفظ${s.lastError ? `: ${esc(s.lastError)}` : ''}${s.failed ? ` (${s.failed} عنصر رُفض)` : ''}`,
      idle: '',
    }[s.state];
    return `<section class="card">
      ${name ? `<div class="kv"><span>الاسم</span><span>${esc(name)}</span></div>` : ''}
      <div class="kv"><span>البريد</span><span dir="ltr">${esc(user?.email || '')}</span></div>
      <div class="kv"><span>الحالة</span><span>${syncText}</span></div>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="sync">${ICONS.sync}مزامنة الآن</button><button class="btn danger" data-act="signout">تسجيل الخروج</button></div>
    </section>`;
  },
  display() {
    const st = store.settings();
    const scales = [100, 200, 300];
    const key = ui.month;
    const custom = store.hasCustomGoal(key);
    const th = lsGet('mz_theme') || 'auto';
    return `<section class="card">
      <div class="lbl">مظهر التطبيق</div>
      <div class="chips" style="margin:8px 0">${[['auto', 'تلقائي'], ['dark', 'داكن'], ['light', 'فاتح']].map(([v, l]) => `<button class="chipbtn" data-act="settheme" data-v="${v}" aria-pressed="${th === v}">${l}</button>`).join('')}</div>
    </section>
    <section class="card">
      <div class="lbl">مقياس عرض المعدل (يغيّر العرض فقط، ولا يمس العلامات أو الحسابات)</div>
      <div class="chips" style="margin:8px 0">${scales.map((v) => `<button class="chipbtn" data-act="setscale" data-v="${v}" aria-pressed="${st.display_scale === v}">${v}</button>`).join('')}</div>
      <form class="row" data-form="scale" novalidate><label class="lbl" for="scaleIn">مقياس آخر</label>
        <input id="scaleIn" class="w-sm" type="text" inputmode="decimal" value="${scales.includes(st.display_scale) ? '' : fmt(st.display_scale)}" placeholder="مثلاً 3100"><button class="btn small">تطبيق</button></form>
    </section>
    <section class="card">
      <div class="lbl" style="margin-bottom:6px">الأهداف (تُعدَّل من هنا فقط، وتظهر في الرئيسية للعرض)</div>
      ${monthbar(key)}
      <form class="goalbox" data-form="goal" novalidate>
        <label for="goalIn">هدف ${monthLabel(key)}</label>
        <div class="row"><input id="goalIn" class="w-sm" type="text" inputmode="decimal" value="${fmt(store.monthGoal(key))}" aria-describedby="goalErr"><span class="num">%</span>
          <button class="btn small">حفظ</button>
          ${custom ? `<button type="button" class="link" data-act="resetgoal">استعادة الافتراضي (${fmt(st.default_goal)}%)</button>` : ''}</div>
        <div class="err" id="goalErr"></div>
      </form>
      <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      <form class="row" data-form="defgoal" novalidate><label class="lbl" for="defGoal">الهدف الافتراضي لكل الأشهر (%)</label>
        <input id="defGoal" class="w-sm" type="text" inputmode="decimal" value="${fmt(st.default_goal)}"><button class="btn small">حفظ</button></form>
    </section>`;
  },
  subjects() {
    const subs = store.subjects();
    return `<section class="card">
      ${subs.length ? subs.map((sj) => `<div class="subj-row">
        <input type="text" value="${esc(sj.name)}" maxlength="80" data-sf="name" data-sid="${sj.id}" aria-label="اسم المادة">
        <input type="text" inputmode="decimal" value="${fmt(sj.default_full_mark)}" data-sf="mark" data-sid="${sj.id}" aria-label="العلامة الكاملة لمادة ${esc(sj.name)}">
        <button class="btn danger small" data-act="delsubj" data-sid="${sj.id}" aria-label="حذف مادة ${esc(sj.name)}">${ICONS.trash}</button></div>`).join('')
        : '<p class="note" style="margin-top:0">لم تُضف مواداً بعد. أضف موادك مع علامة كل منها الكاملة، وسيملأها التطبيق تلقائياً عند اعتماد البرنامج.</p>'}
      <form class="subj-row" data-form="addsubj" novalidate style="border-top:1px solid var(--line);margin-top:6px;padding-top:12px">
        <input type="text" name="name" placeholder="اسم المادة" maxlength="80" aria-label="اسم مادة جديدة">
        <input type="text" name="mark" inputmode="decimal" placeholder="العلامة" aria-label="العلامة الكاملة">
        <button class="btn small primary">${ICONS.plus}إضافة</button></form>
      <p class="note" style="margin-bottom:0">تغيير علامة مادة لا يغيّر مذاكراتها الموجودة؛ يمكنك تعديل علامة كل مذاكرة على حدة.</p>
    </section>`;
  },
  notifications() { return '<div id="mzSlot"></div>'; },
  backup() {
    return `<section class="card">
      <p class="note" style="margin-top:0">بياناتك محفوظة سحابياً، وهذه نسخة إضافية على جهازك.</p>
      <input type="file" id="bkFile" hidden accept=".json,application/json">
      <div class="row"><button class="btn" data-act="exportbackup">${ICONS.download}تصدير نسخة احتياطية</button><button class="btn" data-act="importbackup">${ICONS.upload}استيراد نسخة</button></div>
    </section>`;
  },
  ai() {
    return `<section class="card">
      <div class="kv"><span>قراءة برامج المذاكرات</span><span><b style="color:var(--done)">مفعّلة لحسابك</b></span></div>
      ${modelPicker()}
      <p class="note" style="margin-bottom:0">يُستخدم الذكاء الاصطناعي لقراءة صور وملفات برنامج المذاكرات فقط. مفتاح الخدمة محفوظ في خادم Supabase ولا يصل إلى متصفحك أبداً، ولا تُرسل علاماتك إلى أي جهة.</p>
    </section>`;
  },
  about() {
    return `<section class="card"><div class="kv"><span>الإصدار</span><span class="num">${APP_VERSION}</span></div>
      ${window.__mzNative ? '<div id="mzUpd"></div>' : ''}
      <p style="margin-bottom:0"><a class="link" href="architecture.html">شرح البنية المعمارية للتطبيق ←</a></p></section>`;
  },
};

function viewSettings() {
  const pages = settingsPages();
  const cur = pages.find((x) => x[0] === ui.sub);
  if (!cur) {
    return `<h2 class="ptitle">الإعدادات</h2>
    <nav class="slist" aria-label="أقسام الإعدادات">${pages.map(([id, t, h]) => `<button class="srow" data-act="go" data-r="settings/${id}"><span><b>${t}</b><small>${h}</small></span>${ICONS.next}</button>`).join('')}</nav>`;
  }
  return `<div class="subhead"><button class="iconbtn" data-act="go" data-r="settings" aria-label="رجوع إلى الإعدادات">${ICONS.prev}</button><h2>${cur[1]}</h2></div>${SETTINGS_BODY[cur[0]]()}`;
}

/* ====================== مراجعة الاستيراد ====================== */
function makeRow(x) {
  const sub = store.findSubject(x.subject);
  const row = { rid: uid(), include: true, date: x.date || '', subject: x.subject || '', title: x.title || '', notes: x.notes || '', full: sub ? sub.default_full_mark : null };
  row.dup = isDup(row);
  if (row.dup) row.include = false;
  return row;
}
function isDup(r) {
  const n = normalizeAr(r.subject);
  return !!n && store.exams().some((e) => e.exam_date === r.date && normalizeAr(e.subject_name) === n);
}

function reviewRowHtml(r) {
  return `<div class="review-row${r.include ? '' : ' off'}" data-rid="${r.rid}">
    <div class="head"><label><input type="checkbox" data-r="include" ${r.include ? 'checked' : ''}> إضافة هذه المذاكرة</label>
      <span data-dup>${r.dup ? '<span class="badge plain" style="--c:var(--wait)">موجودة مسبقاً</span>' : ''}</span>
      <button class="iconbtn" data-act="rdel" aria-label="حذف الصف">${ICONS.trash}</button></div>
    <div class="two">
      <div class="field"><label>التاريخ</label><input type="date" data-r="date" value="${esc(r.date)}"><div class="err" data-e="date"></div></div>
      <div class="field"><label>المادة</label><input type="text" list="subjList" data-r="subject" value="${esc(r.subject)}" maxlength="80"><div class="err" data-e="subject"></div></div>
    </div>
    <div class="two">
      <div class="field"><label>العنوان / الوحدة</label><input type="text" data-r="title" value="${esc(r.title)}" maxlength="300"></div>
      <div class="field"><label>العلامة الكاملة</label><input type="text" inputmode="decimal" data-r="full" value="${r.full == null ? '' : fmt(r.full)}" placeholder="مطلوبة"><div class="err" data-e="full"></div></div>
    </div>
  </div>`;
}

function reviewView() {
  const rv = ui.review;
  return `<h2 style="margin-bottom:6px">مراجعة المذاكرات (${rv.rows.length})</h2>
  <p class="note" style="margin-top:0">${rv.source === 'ai' ? 'استخرجها الذكاء الاصطناعي من ملفك. ' : 'من ملف برنامج. '}صحّح أي خطأ، واحذف أو أضف ما تشاء. لن تدخل التقويم قبل اعتمادك.${rv.skipped ? ` (تم تجاهل ${rv.skipped} صف غير صالح)` : ''}</p>
  <datalist id="subjList">${store.subjects().map((s) => `<option value="${esc(s.name)}"></option>`).join('')}</datalist>
  <div id="reviewRows">${rv.rows.map(reviewRowHtml).join('')}</div>
  <div class="row" style="margin-top:14px">
    <button class="btn" data-act="radd">${ICONS.plus}إضافة صف</button>
    <span class="spacer"></span>
    <button class="btn ghost" data-act="rcancel">إلغاء</button>
    <button class="btn primary" data-act="rapprove">${ICONS.check}اعتماد المحدد (<span class="num" id="selCount">${rv.rows.filter((r) => r.include).length}</span>)</button>
  </div>`;
}

function openReview(rows, source, skipped = 0) {
  ui.review = { source, skipped, rows: rows.map(makeRow) };
  go('import');
  render(true);
}

A.radd = () => {
  ui.review.rows.push(makeRow({ date: ui.month + '-01', subject: '', title: '' }));
  ui.review.rows.at(-1).dup = false;
  ui.review.rows.at(-1).include = true;
  render(true);
};
A.rdel = (t) => {
  const rid = t.closest('[data-rid]').dataset.rid;
  ui.review.rows = ui.review.rows.filter((r) => r.rid !== rid);
  if (!ui.review.rows.length) { ui.review = null; }
  render(true);
};
A.rcancel = async () => {
  const a = await ask({ title: 'إلغاء الاستيراد؟', body: '<p>لن تُضاف أي مذاكرة من هذه القائمة.</p>', buttons: [{ id: 'no', label: 'متابعة المراجعة' }, { id: 'yes', label: 'إلغاء الاستيراد', cls: 'danger' }] });
  if (a === 'yes') { ui.review = null; render(true); }
};
A.rapprove = () => {
  const rows = ui.review.rows.filter((r) => r.include);
  if (!rows.length) { toast('حدّد مذاكرة واحدة على الأقل', 'err'); return; }
  let firstBad = null;
  document.querySelectorAll('#reviewRows [data-e]').forEach((el) => { el.textContent = ''; });
  for (const r of rows) {
    const el = document.querySelector(`[data-rid="${r.rid}"]`);
    const set = (k, msg) => { const e = el.querySelector(`[data-e="${k}"]`); e.textContent = msg; firstBad ||= el.querySelector(`[data-r="${k}"]`); };
    if (!isValidDate(r.date)) set('date', 'تاريخ غير صالح');
    if (!r.subject.trim()) set('subject', 'اسم المادة مطلوب');
    if (!(r.full > 0)) set('full', 'حدّد العلامة الكاملة');
  }
  if (firstBad) { firstBad.focus(); toast('أكمل الحقول المطلوبة قبل الاعتماد', 'err'); return; }

  const created = [];
  const newSubj = new Map();
  let first = null;
  for (const r of rows) {
    const norm = normalizeAr(r.subject);
    let sub = store.findSubject(r.subject) || newSubj.get(norm);
    if (!sub) {
      sub = store.saveSubject({ name: r.subject, default_full_mark: r.full });
      newSubj.set(norm, sub);
      created.push(sub.name);
    }
    store.saveExam({ subject_id: sub.id, subject_name: sub.name, title: r.title, notes: r.notes, exam_date: r.date, full_mark: r.full, expected_mark: null, actual_mark: null });
    if (!first || r.date < first) first = r.date;
  }
  ui.review = null;
  ui.month = monthKeyOf(first);
  lsSet('mz:ui:month', ui.month);
  toast(`أُضيفت ${rows.length} مذاكرة${created.length ? ` وأُنشئت مواد جديدة: ${created.join('، ')}` : ''}`);
  go('calendar');
};

/* ====================== ملفات الاستيراد ====================== */
function toBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}
const codeErr = (code) => Object.assign(new Error(code), { code });

async function filePayload(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 5.5 * 1024 * 1024) throw codeErr('file_missing_or_too_large');
    return { mimeType: 'application/pdf', data: await toBase64(file) };
  }
  if (!file.type.startsWith('image/')) throw codeErr('unsupported_file_type');
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw codeErr('ai_provider_error'); }
  const max = 1800;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return { mimeType: 'image/jpeg', data: await toBase64(blob) };
}


/* ====================== حالة الرفع واختيار النموذج ====================== */
const AI_MODELS = [
  ['gemini-2.5-flash', 'Gemini 2.5 Flash — سريع (الافتراضي)'],
  ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite — الأخف والأسرع'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro — الأدق وحدّه أقل'],
];
const MODEL_RE = /^gemini-[a-z0-9][a-z0-9.\-]{0,58}$/;
const getModel = () => { const m = lsGet('mz:aiModel'); return m && MODEL_RE.test(m) ? m : AI_MODELS[0][0]; };

function modelPicker() {
  const cur = getModel();
  const preset = AI_MODELS.some(([v]) => v === cur);
  return `<div class="field" style="margin:14px 0 0">
    <label for="aiModel">نموذج الذكاء الاصطناعي</label>
    <select id="aiModel">${AI_MODELS.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}
      <option value="__custom" ${preset ? '' : 'selected'}>نموذج آخر (اكتب اسمه)…</option></select>
    <input id="aiModelCustom" type="text" dir="ltr" autocapitalize="off" spellcheck="false" placeholder="gemini-…" maxlength="60" value="${preset ? '' : esc(cur)}" ${preset ? 'hidden' : ''} style="margin-top:8px">
    <div class="err" id="aiModelErr"></div>
    <p class="note" style="margin:6px 0 0">يُحفظ الاختيار على هذا الجهاز. إن ظهر خطأ «النموذج غير موجود» أو «حدّ الاستخدام» جرّب نموذجاً آخر.</p>
  </div>`;
}

const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const IMP_STEPS = ['تجهيز الملف وضغطه', 'إرسال الملف وقراءته بالذكاء الاصطناعي (قد يستغرق حتى دقيقة)', 'تجهيز النتائج للمراجعة'];
const IMP_HINTS = {
  ai_model_not_found: 'اختر نموذجاً آخر من القائمة أدناه ثم أعد المحاولة.',
  ai_key_invalid: 'تأكد أن المفتاح GEMINI_API_KEY مضبوط في Supabase ← Edge Functions ← Secrets وأنه صالح.',
  ai_not_configured: 'أضف المفتاح GEMINI_API_KEY في Supabase ← Edge Functions ← Secrets.',
  ai_rate_limited: 'الخطة المجانية لها حدّ في الدقيقة وفي اليوم. انتظر دقيقة أو بدّل النموذج.',
  ai_overloaded: 'الخدمة مشغولة. أعد المحاولة بعد قليل أو بدّل النموذج.',
  ai_bad_request: 'جرّب صورة أوضح أو نموذجاً آخر.',
  ai_provider_error: 'جرّب صورة أوضح أو نموذجاً آخر.',
  ai_bad_output: 'جرّب صورة أوضح أو نموذجاً آخر.',
  ai_not_enabled: 'هذه الميزة مفعّلة لحساب المسؤول فقط. استورد ملف برنامج (.json) من زميل.',
  network: 'تحقق من اتصالك بالإنترنت ثم أعد المحاولة.',
  timeout: 'جرّب صورة أصغر وأوضح، أو نموذج Flash-Lite الأسرع.',
  file_missing_or_too_large: 'صغّر الملف (الحدّ نحو 5 ميغابايت للـ PDF).',
  unsupported_file_type: 'استخدم صورة (PNG/JPG/WEBP) أو PDF أو ملف برنامج (.json).',
  no_exams: 'جرّب صورة أوضح تُظهر الجدول كاملاً، أو أضف المذاكرات يدوياً.',
  bad_json: 'اختر ملف برنامج صدّره زميلك من تطبيق مذاكراتي.',
};

function importStatus() {
  const s = ui.imp;
  if (s.state === 'busy') {
    const el = Math.max(0, Math.round((Date.now() - s.t0) / 1000));
    return `<div class="statuspanel busy" role="status" aria-live="polite">
      <div class="row"><span class="spin"></span><b>جارٍ تحليل البرنامج…</b></div>
      <div class="note" style="margin:6px 0">${esc(s.fileName)} · ${fmtSize(s.size)} · النموذج: <span class="mono">${esc(s.model)}</span></div>
      <ol class="steps">${IMP_STEPS.map((t, i) => `<li class="${i < s.step ? 'done' : i === s.step ? 'now' : ''}">${t}</li>`).join('')}</ol>
      <div class="row" style="justify-content:space-between"><span class="note">الوقت المنقضي: <b class="num" id="impElapsed">${el}</b> ث</span>
        <button class="btn" data-act="impcancel">إلغاء</button></div></div>`;
  }
  if (s.state === 'error') {
    const e = s.err;
    const tech = [e.code && `code: ${e.code}`, e.status && `status: ${e.status}`, e.model && `model: ${e.model}`, e.detail && `detail: ${e.detail}`].filter(Boolean).join('\n');
    return `<div class="statuspanel err" role="alert">
      <b>⚠ ${esc(e.title)}</b>
      ${e.hint ? `<p style="margin:6px 0">${esc(e.hint)}</p>` : ''}
      ${tech ? `<details><summary>التفاصيل التقنية</summary><pre class="mono" dir="ltr">${esc(tech)}</pre></details>` : ''}
      <div class="row" style="margin-top:8px">${s.file ? '<button class="btn primary" data-act="imptry">إعادة المحاولة</button>' : ''}
        <button class="btn" data-act="impdismiss">إغلاق</button></div></div>`;
  }
  return '';
}

function setImportError(e, extra = {}) {
  const code = e?.code || (e?.network ? 'network' : extra.code || '');
  ui.imp = {
    ...ui.imp,
    state: 'error',
    err: {
      title: extra.title || arMessage(e),
      hint: IMP_HINTS[code] || '',
      code,
      status: e?.status || 0,
      model: ui.imp.model || '',
      detail: e?.message && e.message !== 'network' && e.message !== code ? String(e.message).slice(0, 300) : '',
    },
  };
  render(true);
}

let impTimer = null;
const stopImpTimer = () => { clearInterval(impTimer); impTimer = null; };

async function handleImportFile(file) {
  if (!file) return;
  const myId = ui.imp.id + 1;
  ui.imp = { state: 'idle', id: myId, file, fileName: file.name, size: file.size };
  if (file.type === 'application/json' || /\.json$/i.test(file.name)) {
    let obj;
    try { obj = JSON.parse(await file.text()); } catch { setImportError(null, { title: 'الملف ليس JSON صالحاً', code: 'bad_json' }); return; }
    const v = validateScheduleFile(obj);
    if (!v.ok) { setImportError(null, { title: v.error, code: 'bad_json' }); return; }
    ui.imp = { state: 'idle', id: myId };
    openReview(v.rows, 'file', v.skipped);
    return;
  }
  if (!store.profile().ai_enabled) { setImportError(null, { title: 'قراءة الصور والـ PDF غير مفعّلة لحسابك', code: 'ai_not_enabled' }); return; }
  if (!navigator.onLine) { setImportError({ network: true }, { title: 'تحليل البرنامج بالذكاء الاصطناعي يحتاج اتصالاً بالإنترنت' }); return; }

  const model = getModel();
  ui.imp = { state: 'busy', id: myId, file, fileName: file.name, size: file.size, model, step: 0, t0: Date.now() };
  render(true);
  stopImpTimer();
  impTimer = setInterval(() => { const n = $('#impElapsed'); if (n) n.textContent = Math.round((Date.now() - ui.imp.t0) / 1000); }, 1000);
  const alive = () => ui.imp.id === myId && ui.imp.state === 'busy';
  try {
    const payload = await filePayload(file);
    if (!alive()) return;
    ui.imp.step = 1; render(true);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(codeErr('timeout')), 100000));
    const r = await Promise.race([functions.invoke('parse-schedule', { ...payload, model, referenceYear: Number(ui.month.slice(0, 4)) }), timeout]);
    if (!alive()) return;
    ui.imp.step = 2; render(true);
    const list = Array.isArray(r?.exams) ? r.exams : [];
    if (!list.length) { setImportError(null, { title: 'لم يجد الذكاء الاصطناعي مذاكرات في الملف', code: 'no_exams' }); return; }
    ui.imp = { state: 'idle', id: myId };
    openReview(list, 'ai');
  } catch (e) {
    if (alive()) setImportError(e);
  } finally {
    if (ui.imp.id === myId && ui.imp.state !== 'busy') stopImpTimer();
    if (ui.imp.id === myId && ui.imp.state === 'busy') { ui.imp = { state: 'idle', id: myId }; stopImpTimer(); render(true); }
  }
}

A.impcancel = () => { ui.imp = { state: 'idle', id: ui.imp.id + 1 }; stopImpTimer(); render(true); toast('أُلغي التحليل'); };
A.impdismiss = () => { ui.imp = { state: 'idle', id: ui.imp.id }; render(true); };
A.imptry = () => { const f = ui.imp.file; if (f) handleImportFile(f); };

A.pickfile = () => $('#impFile')?.click();
A.shareschedule = async () => {
  const scope = $('#shareScope').value;
  const exams = scope === 'all' ? store.exams() : store.examsOfMonth(ui.month);
  if (!exams.length) { toast('لا توجد مذاكرات لتصديرها', 'err'); return; }
  const blob = new Blob([JSON.stringify(buildScheduleFile(exams), null, 2)], { type: 'application/json' });
  const name = `mudhakarat-schedule-${scope === 'all' ? 'all' : ui.month}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'برنامج المذاكرات' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadBlob(name, blob);
  toast('تم تنزيل ملف البرنامج، أرسله لزملائك');
};

/* ====================== نافذة المذاكرة ====================== */
function openExamEditor(id, presetDate) {
  const e = id ? store.getExam(id) : null;
  if (id && !e) return;
  const subs = store.subjects();
  const known = e ? store.findSubject(e.subject_name) : null;
  const selVal = e ? (known ? known.id : '__new') : (subs[0]?.id || '__new');
  const date = e?.exam_date || presetDate || (ui.month === currentMonthKey() ? todayStr() : `${ui.month}-01`);
  const full = e ? e.full_mark : (subs[0]?.default_full_mark ?? '');
  dlg.setAttribute('aria-labelledby', 'edT');
  dlg.innerHTML = `
  <form data-form="exam" novalidate data-id="${e?.id || ''}">
    <div class="dlg-h"><h2 id="edT">${e ? 'تعديل مذاكرة' : 'مذاكرة جديدة'}</h2><button type="button" class="iconbtn" data-act="closedlg" aria-label="إغلاق">${ICONS.close}</button></div>
    <div class="dlg-b">
      <div class="field"><label for="ex-subj">المادة</label>
        <select id="ex-subj">${subs.map((s) => `<option value="${s.id}" ${s.id === selVal ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}<option value="__new" ${selVal === '__new' ? 'selected' : ''}>${subs.length ? 'مادة أخرى…' : 'اكتب اسم المادة…'}</option></select>
        <input id="ex-new" type="text" maxlength="80" placeholder="اسم المادة" value="${selVal === '__new' && e ? esc(e.subject_name) : ''}" ${selVal === '__new' ? '' : 'hidden'}>
        <div class="err" id="ex-e-subj"></div></div>
      <div class="field"><label for="ex-title">عنوان المذاكرة / الوحدة</label><input id="ex-title" type="text" maxlength="300" value="${esc(e?.title || '')}"></div>
      <div class="two">
        <div class="field"><label for="ex-date">التاريخ</label><input id="ex-date" type="date" value="${esc(date)}"><div class="err" id="ex-e-date"></div></div>
        <div class="field"><label for="ex-full">العلامة الكاملة</label><input id="ex-full" type="text" inputmode="decimal" value="${full === '' ? '' : fmt(full)}"><div class="err" id="ex-e-full"></div></div>
      </div>
      <div class="two">
        <div class="field"><label for="ex-exp">العلامة المتوقعة</label><input id="ex-exp" type="text" inputmode="decimal" value="${e?.expected_mark != null ? fmt(e.expected_mark) : ''}" placeholder="بعد المذاكرة"><div class="err" id="ex-e-expected"></div></div>
        <div class="field"><label for="ex-act">العلامة الفعلية</label><input id="ex-act" type="text" inputmode="decimal" value="${e?.actual_mark != null ? fmt(e.actual_mark) : ''}" placeholder="عند صدور النتيجة"><div class="err" id="ex-e-actual"></div></div>
      </div>
      <div class="row" style="margin-bottom:12px"><span class="lbl">الحالة:</span><span id="ex-status"></span></div>
      <div class="field"><label for="ex-notes">ملاحظات</label><textarea id="ex-notes" maxlength="1000">${esc(e?.notes || '')}</textarea></div>
    </div>
    <div class="dlg-f">
      <button class="btn primary grow">حفظ</button>
      <button type="button" class="btn" data-act="closedlg">إلغاء</button>
      ${e ? `<button type="button" class="btn danger" data-act="delexam" data-id="${e.id}">${ICONS.trash}حذف</button>` : ''}
    </div>
  </form>`;
  dlg.showModal();
  updateEditorStatus();
}

function updateEditorStatus() {
  const el = $('#ex-status');
  if (!el) return;
  const exp = parseNum($('#ex-exp').value);
  const act = parseNum($('#ex-act').value);
  const st = deriveStatus({ expected_mark: Number.isNaN(exp) ? null : exp, actual_mark: Number.isNaN(act) ? null : act });
  el.innerHTML = badge(st);
}

A.closedlg = () => dlg.close();
A.edit = (t) => openExamEditor(t.dataset.id);
A.add = (t) => openExamEditor(null, t.dataset.date);
A.delexam = async (t) => {
  const e = store.getExam(t.dataset.id);
  if (!e) return;
  const a = await ask({ title: 'حذف المذاكرة؟', body: `<p>سيتم حذف مذاكرة <b>${esc(e.subject_name)}</b> بتاريخ ${dateLabel(e.exam_date)} مع علاماتها.</p>`, buttons: [{ id: 'no', label: 'تراجع' }, { id: 'yes', label: 'حذف', cls: 'danger' }] });
  if (a === 'yes') { store.removeExam(e.id); dlg.close(); toast('تم حذف المذاكرة'); }
};

F.exam = (form) => {
  const id = form.dataset.id || null;
  const existing = id ? store.getExam(id) : null;
  const setErr = (k, m) => { const el = $(`#ex-e-${k}`); if (el) el.textContent = m || ''; };
  ['subj', 'date', 'full', 'expected', 'actual'].forEach((k) => setErr(k, ''));
  document.querySelectorAll('#dlg [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
  const bad = (sel) => $(sel)?.setAttribute('aria-invalid', 'true');

  const selVal = $('#ex-subj').value;
  let subject = null;
  let name;
  if (selVal === '__new') { name = $('#ex-new').value.trim(); subject = store.findSubject(name); if (subject) name = subject.name; }
  else { subject = store.subjects().find((s) => s.id === selVal); name = subject?.name || ''; }
  const date = $('#ex-date').value;
  const full = parseNum($('#ex-full').value);
  const expected = parseNum($('#ex-exp').value);
  const actual = parseNum($('#ex-act').value);

  let ok = true;
  if (!name) { setErr('subj', 'اختر المادة أو اكتب اسمها'); bad(selVal === '__new' ? '#ex-new' : '#ex-subj'); ok = false; }
  if (!isValidDate(date)) { setErr('date', 'اختر تاريخاً صحيحاً'); bad('#ex-date'); ok = false; }
  const errs = validateMarks({ full, expected, actual });
  if (errs.full) { setErr('full', errs.full); bad('#ex-full'); ok = false; }
  if (errs.expected) { setErr('expected', errs.expected); bad('#ex-exp'); ok = false; }
  if (errs.actual) { setErr('actual', errs.actual); bad('#ex-act'); ok = false; }
  if (!ok) { $('#dlg [aria-invalid]')?.focus(); return; }

  let createdSubject = false;
  if (!existing && !subject) {
    subject = store.saveSubject({ name, default_full_mark: full }); // مادة جديدة: تُحفظ علامتها الكاملة الافتراضية
    createdSubject = true;
  }
  store.saveExam({
    id: existing?.id,
    subject_id: subject?.id ?? null,
    subject_name: name,
    title: $('#ex-title').value,
    notes: $('#ex-notes').value,
    exam_date: date,
    full_mark: full,
    expected_mark: expected,
    actual_mark: actual,
  });
  if (monthKeyOf(date) !== ui.month) { ui.month = monthKeyOf(date); lsSet('mz:ui:month', ui.month); }
  dlg.close();
  toast(createdSubject ? `تم الحفظ، وأُضيفت مادة «${name}» لإعداداتك` : 'تم الحفظ');
};

/* ====================== بقية المعالجات ====================== */
A.go = (t) => go(t.dataset.r);
A.month = (t) => { ui.month = addMonths(ui.month, Number(t.dataset.d)); ui.selDay = null; lsSet('mz:ui:month', ui.month); render(true); };
A.thismonth = () => { ui.month = currentMonthKey(); ui.selDay = null; lsSet('mz:ui:month', ui.month); render(true); };
A.selday = (t) => { ui.selDay = ui.selDay === t.dataset.date ? null : t.dataset.date; render(true); };
A.resetgoal = () => { store.setGoal(ui.month, null); toast('عاد هدف الشهر إلى الافتراضي'); render(true); };

F.goal = () => {
  const v = parseNum($('#goalIn').value);
  const err = $('#goalErr');
  if (v == null || Number.isNaN(v) || v < 0 || v > 100) { err.textContent = 'أدخل نسبة بين 0 و100'; return; }
  store.setGoal(ui.month, v);
  toast('تم حفظ الهدف');
  render(true);
};

F.quick = (form) => {
  const e = store.getExam(form.dataset.id);
  if (!e) return;
  const n = parseNum(form.v.value);
  if (n == null) { form.v.focus(); return; }
  if (Number.isNaN(n) || n < 0) { toast('أدخل رقماً صحيحاً غير سالب', 'err'); return; }
  if (n > e.full_mark) { toast(`العلامة أكبر من العلامة الكاملة (${fmt(e.full_mark)})`, 'err'); return; }
  const st = deriveStatus(e);
  store.saveExam({ ...e, [st === 'upcoming' ? 'expected_mark' : 'actual_mark']: n });
  toast(st === 'upcoming' ? 'حُفظ توقعك' : 'حُفظت العلامة الفعلية');
  render(true);
};

A.settheme = (t) => {
  const v = t.dataset.v; lsSet('mz_theme', v);
  const eff = v === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : v;
  document.documentElement.setAttribute('data-theme', eff);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = eff === 'light' ? '#f3fbf0' : '#070b07';
  render(true);
};
A.setscale = (t) => { store.setSettings({ display_scale: Number(t.dataset.v) }); render(true); };
F.scale = () => {
  const v = parseNum($('#scaleIn').value);
  if (v == null) return;
  if (Number.isNaN(v) || v <= 0 || v > 100000) { toast('أدخل مقياساً صحيحاً أكبر من صفر', 'err'); return; }
  store.setSettings({ display_scale: v });
  toast('تم تغيير مقياس العرض');
  render(true);
};
F.defgoal = () => {
  const v = parseNum($('#defGoal').value);
  if (v == null || Number.isNaN(v) || v < 0 || v > 100) { toast('أدخل نسبة بين 0 و100', 'err'); return; }
  store.setSettings({ default_goal: v });
  toast('تم حفظ الهدف الافتراضي');
  render(true);
};

F.addsubj = (form) => {
  const name = form.name.value.trim();
  const mark = parseNum(form.mark.value);
  if (!name) { form.name.focus(); toast('اكتب اسم المادة', 'err'); return; }
  if (mark == null || Number.isNaN(mark) || mark <= 0 || mark > 100000) { form.mark.focus(); toast('أدخل علامة كاملة أكبر من صفر', 'err'); return; }
  if (store.findSubject(name)) { toast('هذه المادة موجودة مسبقاً', 'err'); return; }
  store.saveSubject({ name, default_full_mark: mark });
  render(true);
};
A.delsubj = async (t) => {
  const s = store.subjects().find((x) => x.id === t.dataset.sid);
  if (!s) return;
  const a = await ask({ title: 'حذف المادة؟', body: `<p>ستُحذف <b>${esc(s.name)}</b> من إعداداتك فقط. مذاكراتها الموجودة وعلاماتها تبقى كما هي.</p>`, buttons: [{ id: 'no', label: 'تراجع' }, { id: 'yes', label: 'حذف', cls: 'danger' }] });
  if (a === 'yes') { store.removeSubject(s.id); render(true); }
};

A.signout = async () => {
  if (store.pendingCount() > 0 && navigator.onLine) { toast('جارٍ حفظ تعديلاتك قبل الخروج…'); await sync.syncNow(); }
  if (store.pendingCount() > 0) {
    const a = await ask({
      title: 'تعديلات غير محفوظة سحابياً',
      body: `<p>لديك <b>${store.pendingCount()}</b> تعديلاً لم يُرسل إلى الخادم بعد. الخروج الآن سيحذفها نهائياً من هذا الجهاز.</p>`,
      buttons: [{ id: 'stay', label: 'البقاء' }, { id: 'out', label: 'خروج وحذف التعديلات', cls: 'danger' }],
    });
    if (a !== 'out') return;
  }
  const id = currentUser;
  manualOut = true;
  await auth.signOut();
  store.clearUser(id);
  lsSet('mz:lastUser', '');
};

A.exportbackup = () => {
  const blob = new Blob([JSON.stringify(buildBackup(), null, 2)], { type: 'application/json' });
  downloadBlob(`mudhakarat-backup-${todayStr()}.json`, blob);
  toast('تم تنزيل النسخة الاحتياطية');
};
A.importbackup = () => $('#bkFile')?.click();

async function handleBackupFile(file) {
  if (!file) return;
  let obj;
  try { obj = JSON.parse(await file.text()); } catch { toast('الملف ليس JSON صالحاً', 'err'); return; }
  const v = validateBackup(obj);
  if (!v.ok) { toast(v.error, 'err'); return; }
  const c = v.counts;
  const a = await ask({
    title: 'استيراد نسخة احتياطية',
    body: `<p>الملف سليم ويحتوي: <b>${c.exams}</b> مذاكرة، <b>${c.subjects}</b> مادة، <b>${c.months}</b> هدف شهري.${v.skipped ? ` (سيُتجاهل ${v.skipped} عنصر غير صالح)` : ''}</p>
      <p class="note"><b>دمج:</b> يضيف ما ليس عندك ولا يحذف شيئاً.<br><b>استبدال:</b> يحل محل بياناتك الحالية (ننزّل لك نسخة منها تلقائياً قبل ذلك).</p>`,
    buttons: [{ id: 'cancel', label: 'إلغاء' }, { id: 'replace', label: 'استبدال', cls: 'danger' }, { id: 'merge', label: 'دمج', cls: 'primary' }],
  });
  if (!a || a === 'cancel') return;
  if (a === 'replace') {
    const ok = await ask({ title: 'تأكيد الاستبدال', body: '<p>ستُستبدل كل بياناتك الحالية بمحتوى الملف. هل أنت متأكد؟</p>', buttons: [{ id: 'no', label: 'تراجع' }, { id: 'yes', label: 'نعم، استبدل', cls: 'danger' }] });
    if (ok !== 'yes') return;
    downloadBlob(`mudhakarat-before-replace-${todayStr()}.json`, new Blob([JSON.stringify(buildBackup(), null, 2)], { type: 'application/json' }));
  }
  const r = applyBackup(v.clean, a);
  toast(a === 'replace' ? 'تم استبدال البيانات' : `تم الدمج، أُضيفت ${examCount(r.added)}`);
  render(true);
}

/* ====================== أحداث عامة ====================== */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const fn = A[t.dataset.act];
  if (fn) { e.preventDefault(); fn(t, e); }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  F[form.dataset.form]?.(form);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.closest('#dlg')) {
    if (t.id === 'ex-exp' || t.id === 'ex-act') updateEditorStatus();
    if (t.id === 'ex-full') t.dataset.touched = '1';
    return;
  }
  const rowEl = t.closest('[data-rid]');
  if (rowEl && t.dataset.r && ui.review) {
    const r = ui.review.rows.find((x) => x.rid === rowEl.dataset.rid);
    if (!r) return;
    const k = t.dataset.r;
    if (k === 'include') { r.include = t.checked; rowEl.classList.toggle('off', !r.include); const n = $('#selCount'); if (n) n.textContent = ui.review.rows.filter((x) => x.include).length; }
    else if (k === 'full') { const v = parseNum(t.value); r.full = v == null || Number.isNaN(v) ? null : v; }
    else r[k] = t.value;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'ex-subj') {
    const isNew = t.value === '__new';
    $('#ex-new').hidden = !isNew;
    if (isNew) $('#ex-new').focus();
    const fullEl = $('#ex-full');
    const sub = store.subjects().find((s) => s.id === t.value);
    if (sub && !fullEl.dataset.touched && !document.querySelector('#dlg form').dataset.id) fullEl.value = fmt(sub.default_full_mark);
    return;
  }
  if (t.id === 'aiModel') {
    const custom = $('#aiModelCustom');
    if (t.value === '__custom') { custom.hidden = false; custom.focus(); return; }
    custom.hidden = true; $('#aiModelErr').textContent = '';
    lsSet('mz:aiModel', t.value); toast('تم اختيار النموذج');
    return;
  }
  if (t.id === 'aiModelCustom') {
    const v = t.value.trim().toLowerCase();
    if (!MODEL_RE.test(v)) { $('#aiModelErr').textContent = 'اكتب اسم نموذج صحيحاً يبدأ بـ gemini- مثل gemini-2.5-flash'; return; }
    $('#aiModelErr').textContent = ''; t.value = v;
    lsSet('mz:aiModel', v); toast('تم اختيار النموذج');
    return;
  }
  if (t.id === 'impFile') { const f = t.files[0]; t.value = ''; handleImportFile(f); return; }
  if (t.id === 'bkFile') { const f = t.files[0]; t.value = ''; handleBackupFile(f); return; }

  const rowEl = t.closest('[data-rid]');
  if (rowEl && ui.review && (t.dataset.r === 'subject' || t.dataset.r === 'date')) {
    const r = ui.review.rows.find((x) => x.rid === rowEl.dataset.rid);
    if (!r) return;
    if (t.dataset.r === 'subject') {
      const sub = store.findSubject(r.subject);
      if (sub && (r.full == null)) { r.full = sub.default_full_mark; rowEl.querySelector('[data-r="full"]').value = fmt(r.full); }
    }
    r.dup = isDup(r);
    rowEl.querySelector('[data-dup]').innerHTML = r.dup ? '<span class="badge plain" style="--c:var(--wait)">موجودة مسبقاً</span>' : '';
    return;
  }

  const sid = t.dataset.sid;
  if (sid && t.dataset.sf) {
    const s = store.subjects().find((x) => x.id === sid);
    if (!s) return;
    if (t.dataset.sf === 'name') {
      const name = t.value.trim();
      const other = store.findSubject(name);
      if (!name || (other && other.id !== sid)) { toast(!name ? 'اسم المادة لا يمكن أن يكون فارغاً' : 'يوجد مادة بهذا الاسم', 'err'); render(true); return; }
      store.saveSubject({ id: sid, name, default_full_mark: s.default_full_mark });
    } else {
      const v = parseNum(t.value);
      if (v == null || Number.isNaN(v) || v <= 0 || v > 100000) { toast('أدخل علامة كاملة أكبر من صفر', 'err'); render(true); return; }
      store.saveSubject({ id: sid, name: s.name, default_full_mark: v });
    }
    toast('تم حفظ المادة');
  }
});

window.addEventListener('online', () => { updateChip(); if (!currentUser && !recovering) showAuth(''); });
window.addEventListener('offline', updateChip);

boot();
