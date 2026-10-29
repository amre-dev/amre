import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, validateMarks, trueAverage, expectedAverage, summarize, goalPlan, scaled } from '../js/calc.js';
import { parseNum, normalizeAr, isValidDate, fmt, addMonths } from '../js/util.js';

const ex = (full, expected = null, actual = null) => ({ full_mark: full, expected_mark: expected, actual_mark: actual });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('status is derived from marks', () => {
  assert.equal(deriveStatus(ex(100)), 'upcoming');
  assert.equal(deriveStatus(ex(100, 80)), 'awaiting');
  assert.equal(deriveStatus(ex(100, 80, 70)), 'completed');
  assert.equal(deriveStatus(ex(100, null, 0)), 'completed'); // صفر علامة حقيقية وليست فراغاً
});

test('true average uses summed marks, not the mean of percentages (300 + 200 example)', () => {
  const list = [ex(300, null, 270), ex(200, null, 100)];
  // مجموع 370 من 500 = 74%، بينما متوسط النسبتين البسيط = 70%
  close(trueAverage(list), 74);
});

test('true average excludes exams without actual results and returns null when none', () => {
  assert.equal(trueAverage([ex(100), ex(100, 90)]), null);
  close(trueAverage([ex(100, null, 50), ex(100, 100)]), 50);
});

test('expected average mixes actual and expected for taken exams and ignores upcoming', () => {
  const list = [ex(300, null, 240), ex(200, 150), ex(300)];
  close(expectedAverage(list), ((240 + 150) / 500) * 100);
  assert.equal(expectedAverage([ex(100)]), null);
});

test('summarize counts and progress', () => {
  const s = summarize([ex(100, null, 90), ex(100, 80), ex(100), ex(100)]);
  assert.deepEqual([s.completed, s.awaiting, s.upcoming, s.taken], [1, 1, 2, 2]);
  close(s.progressPct, 50);
});

test('mark validation', () => {
  assert.deepEqual(validateMarks({ full: 100, expected: 50, actual: null }), {});
  assert.ok(validateMarks({ full: 100, expected: -1, actual: null }).expected);
  assert.ok(validateMarks({ full: 100, expected: null, actual: 101 }).actual);
  assert.ok(validateMarks({ full: 0 }).full);
  assert.ok(validateMarks({ full: 100, expected: NaN }).expected);
  assert.deepEqual(validateMarks({ full: 100, expected: 100, actual: 0 }), {});
});

test('goal plan: required marks over unresolved exams, expectations not treated as confirmed', () => {
  // الكاملة: 300+200+300+200 = 1000. الهدف 90% = 900. المؤكد: 270. المتبقي المطلوب 630 من 700 = 90%
  const list = [ex(300, null, 270), ex(200, 190), ex(300), ex(200)];
  const p = goalPlan(list, 90);
  assert.equal(p.state, 'on');
  close(p.requiredMarks, 630);
  close(p.requiredPct, 90);
  assert.equal(p.openCount, 3);
});

test('goal plan: achieved already', () => {
  const p = goalPlan([ex(100, null, 95), ex(100)], 45);
  assert.equal(p.state, 'achieved');
});

test('goal plan: impossible shows the highest possible percentage', () => {
  const p = goalPlan([ex(100, null, 20), ex(100)], 90);
  assert.equal(p.state, 'impossible');
  close(p.maxPossiblePct, 60);
});

test('goal plan: no open exams gives final verdict, never an undefined requirement', () => {
  assert.equal(goalPlan([ex(100, null, 95), ex(100, null, 90)], 90).state, 'achieved');
  const missed = goalPlan([ex(100, null, 50)], 90);
  assert.equal(missed.state, 'missed');
  assert.equal(missed.requiredPct, undefined);
});

test('goal plan: boundary exactly 100% required is possible', () => {
  const p = goalPlan([ex(100, null, 80), ex(100)], 90);
  assert.equal(p.state, 'on');
  close(p.requiredPct, 100);
});

test('goal plan: empty month', () => {
  assert.equal(goalPlan([], 90).state, 'empty');
});

test('scale is display only', () => {
  close(scaled(87, 200), 174);
  close(scaled(87, 100), 87);
});

test('number parsing supports Arabic digits and separators', () => {
  assert.equal(parseNum('٢٧٫٥'), 27.5);
  assert.equal(parseNum('27,5'), 27.5);
  assert.equal(parseNum(' 300 '), 300);
  assert.equal(parseNum(''), null);
  assert.ok(Number.isNaN(parseNum('abc')));
  assert.ok(Number.isNaN(parseNum('1e5')));
  assert.ok(Number.isNaN(parseNum('-5')));
});

test('subject normalization matches common spelling variants', () => {
  assert.equal(normalizeAr('الرياضيات'), normalizeAr(' رياضيات '));
  assert.equal(normalizeAr('اللغة العربية'), normalizeAr('لغة عربيّة'));
  assert.equal(normalizeAr('إسلامية'), normalizeAr('اسلاميه'));
  assert.notEqual(normalizeAr('العلوم'), normalizeAr('الرياضيات'));
});

test('date helpers', () => {
  assert.ok(isValidDate('2026-02-28'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('2026-13-01'));
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(fmt(87.1234), '87.12');
  assert.equal(fmt(300), '300');
});
