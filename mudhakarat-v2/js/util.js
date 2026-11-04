export const MONTHS_AR = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
export const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const DAYS_SHORT = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 3) | 8).toString(16);
}));

export const nowIso = () => new Date().toISOString();

export const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD بالتوقيت المحلي */
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const monthKeyOf = (dateStr) => String(dateStr).slice(0, 7);
export const currentMonthKey = () => todayStr().slice(0, 7);

export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_AR[m - 1]} ${y}`;
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function dateParts(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d, dow: new Date(y, m - 1, d).getDay() };
}

export function dateLabel(s, withDay = true) {
  if (!isValidDate(s)) return s || '';
  const { m, d, dow } = dateParts(s);
  return `${withDay ? DAYS_AR[dow] + ' ' : ''}${d} ${MONTHS_AR[m - 1]}`;
}

/** تحويل نص مُدخل إلى رقم: يدعم الأرقام العربية-الهندية والفاصلة العربية. null للفارغ، NaN لغير الصالح */
export function parseNum(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٫,،]/g, '.')
    .replace(/\s/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/** تنسيق رقم للعرض بدون أصفار زائدة */
export function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  const r = Number(Number(n).toFixed(digits));
  return Object.is(r, -0) ? '0' : String(r);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** توحيد اسم المادة للمطابقة: إزالة التشكيل، توحيد الألف والياء والتاء المربوطة، وحذف "ال" التعريف */
export function normalizeAr(s) {
  let t = String(s ?? '').normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  // حذف "ال" التعريف من بداية كل كلمة (لتطابق "اللغة العربية" مع "لغة عربية")
  return t.split(' ').map((w) => (w.startsWith('ال') && w.length > 4 ? w.slice(2) : w)).join(' ');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** عدد المذاكرات بصيغة عربية صحيحة: مذاكرة واحدة / مذاكرتان / 3 مذاكرات / 11 مذاكرة */
export function examCount(n) {
  if (n === 1) return 'مذاكرة واحدة';
  if (n === 2) return 'مذاكرتان';
  if (n >= 3 && n <= 10) return `${n} مذاكرات`;
  return `${n} مذاكرة`;
}
