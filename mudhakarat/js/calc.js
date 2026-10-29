// جميع الحسابات هنا تُنفَّذ محلياً بـ JavaScript. لا يُستخدم الذكاء الاصطناعي في أي منها.
const EPS = 1e-9;

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

/** حالة المذاكرة مشتقة من البيانات: فعلية موجودة → مكتملة، توقع موجود → بانتظار النتيجة، وإلا قادمة */
export function deriveStatus(e) {
  if (e.actual_mark != null) return 'completed';
  if (e.expected_mark != null) return 'awaiting';
  return 'upcoming';
}

export const STATUS_LABEL = { upcoming: 'قادمة', awaiting: 'بانتظار النتيجة', completed: 'مكتملة' };

/** التحقق من العلامات: لا سالب ولا أكبر من العلامة الكاملة */
export function validateMarks({ full, expected, actual }) {
  const errors = {};
  if (full == null || Number.isNaN(full) || full <= 0) errors.full = 'أدخل علامة كاملة أكبر من صفر';
  const check = (v, key, label) => {
    if (v == null) return;
    if (Number.isNaN(v)) errors[key] = 'أدخل رقماً صحيحاً';
    else if (v < 0) errors[key] = `${label} لا يمكن أن تكون سالبة`;
    else if (!errors.full && v > full + EPS) errors[key] = `${label} أكبر من العلامة الكاملة (${full})`;
  };
  check(expected, 'expected', 'العلامة المتوقعة');
  check(actual, 'actual', 'العلامة الفعلية');
  return errors;
}

/** المعدل الحقيقي: مجموع الفعلية ÷ مجموع الكاملة للمذاكرات التي صدرت نتائجها فقط. null إذا لا توجد نتائج. */
export function trueAverage(exams) {
  const done = exams.filter((e) => e.actual_mark != null);
  if (!done.length) return null;
  const full = sum(done, (e) => e.full_mark);
  if (full <= 0) return null;
  return (sum(done, (e) => e.actual_mark) / full) * 100;
}

/** المعدل المتوقع: الفعلية حيث وُجدت، وإلا المتوقعة للمقدَّمة التي تنتظر النتيجة. القادمة مستبعدة. */
export function expectedAverage(exams) {
  const taken = exams.filter((e) => e.actual_mark != null || e.expected_mark != null);
  if (!taken.length) return null;
  const full = sum(taken, (e) => e.full_mark);
  if (full <= 0) return null;
  return (sum(taken, (e) => (e.actual_mark != null ? e.actual_mark : e.expected_mark)) / full) * 100;
}

export function summarize(exams) {
  const completed = exams.filter((e) => deriveStatus(e) === 'completed').length;
  const awaiting = exams.filter((e) => deriveStatus(e) === 'awaiting').length;
  const upcoming = exams.length - completed - awaiting;
  const taken = completed + awaiting;
  return {
    count: exams.length,
    completed,
    awaiting,
    upcoming,
    taken,
    progressPct: exams.length ? (taken / exams.length) * 100 : 0,
    truePct: trueAverage(exams),
    expectedPct: expectedAverage(exams),
  };
}

/**
 * خطة تحقيق الهدف. التوقعات لا تُعدّ علامات مؤكدة؛ المؤكد هو الفعلي فقط.
 * الحالات: empty | achieved | missed | impossible | on
 */
export function goalPlan(exams, goalPct) {
  const totalFull = sum(exams, (e) => e.full_mark);
  if (!exams.length || totalFull <= 0) return { state: 'empty', totalFull: 0 };

  const confirmed = sum(exams.filter((e) => e.actual_mark != null), (e) => e.actual_mark);
  const open = exams.filter((e) => e.actual_mark == null);
  const openFull = sum(open, (e) => e.full_mark);
  const targetMarks = (totalFull * goalPct) / 100;
  const need = targetMarks - confirmed;
  const maxPossiblePct = ((confirmed + openFull) / totalFull) * 100;
  const base = { totalFull, confirmed, openFull, openCount: open.length, targetMarks, goalPct, maxPossiblePct, currentPct: (confirmed / totalFull) * 100 };

  if (!open.length) {
    return { ...base, state: confirmed + EPS >= targetMarks ? 'achieved' : 'missed', finalPct: base.currentPct };
  }
  if (need <= EPS) return { ...base, state: 'achieved', requiredMarks: 0, requiredPct: 0 };
  const requiredPct = (need / openFull) * 100;
  if (requiredPct > 100 + EPS) return { ...base, state: 'impossible', requiredMarks: need, requiredPct };
  return { ...base, state: 'on', requiredMarks: need, requiredPct };
}

/** تحويل نسبة مئوية إلى مقياس العرض (مثلاً 87% على مقياس 200 → 174) */
export const scaled = (pct, scale) => (pct / 100) * scale;
