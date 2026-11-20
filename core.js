// core.js — pure data logic for Personal Best Tracker. No DOM, no network.

export const SCHEMA_VERSION = 1;
const DAY_MS = 86400000;

// Anything dated before this is an "Old Best". Anything on or after it is a "New Best".
export const NEW_BESTS_START = '2026-11-15';

export const DEFAULT_CATEGORIES = ['Push', 'Pull', 'Legs', 'Abs', 'Cardio'];
export const DEFAULT_TAGS = ['Felt Strong', 'Felt Tired', 'Well Rested', 'Slept Badly', 'Sore', 'Great Conditions'];

// ---------- units ----------

export const BASE_UNITS = [
  ['sec', 'Seconds'], ['min', 'Minutes'], ['hr', 'Hours'],
  ['lb', 'Pounds'], ['kg', 'Kilograms'],
  ['mi', 'Miles'], ['km', 'Kilometers'], ['m', 'Meters'], ['ft', 'Feet'], ['in', 'Inches'],
  ['reps', 'Reps'],
];
const UNIT_ALIASES = {
  second: 'sec', seconds: 'sec', secs: 'sec', s: 'sec',
  minute: 'min', minutes: 'min', mins: 'min',
  hour: 'hr', hours: 'hr', hrs: 'hr',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  mile: 'mi', miles: 'mi',
  kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
  meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  foot: 'ft', feet: 'ft',
  inch: 'in', inches: 'in',
  rep: 'reps', repetitions: 'reps',
};

// Turns "seconds" into "sec" so older entries match the unit list.
export function normalizeUnit(unit) {
  const t = String(unit ?? '').trim();
  return UNIT_ALIASES[t.toLowerCase()] ?? t;
}

export function isTimeUnit(unit) {
  return ['sec', 'min', 'hr'].includes(normalizeUnit(unit));
}

// Choices for the unit drop-down: the standard list, then custom units, then any unit already in use.
export function unitOptions(data) {
  const list = BASE_UNITS.map(([v, l]) => [v, `${l} (${v})`]);
  const seen = new Set(BASE_UNITS.map(([v]) => v));
  const extras = [...(data.customUnits ?? []), ...data.activities.map((a) => a.unit)];
  for (const u of extras) {
    if (u && !seen.has(u)) {
      seen.add(u);
      list.push([u, u]);
    }
  }
  return list;
}

export function rememberUnit(data, unit) {
  if (!unit) return;
  if (unitOptions(data).some(([v]) => v === unit)) return;
  data.customUnits = [...(data.customUnits ?? []), unit];
}

export function emptyData() {
  return { version: SCHEMA_VERSION, activities: [], ideas: [], exercises: [], categories: [...DEFAULT_CATEGORIES], customUnits: [], tags: [...DEFAULT_TAGS] };
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- dates ----------

export function todayISO(now = new Date()) {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

// Accepts only real calendar dates (rejects 2026-02-30 and similar).
export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function dayNumber(iso) {
  return Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
}

export function daysBetween(fromISO, toISO) {
  return Math.round(dayNumber(toISO) - dayNumber(fromISO));
}

// ---------- comparisons ----------

export function isBetter(value, reference, direction) {
  return direction === 'lower' ? value < reference : value > reference;
}

export function meetsTarget(value, target, direction) {
  return direction === 'lower' ? value <= target : value >= target;
}

// ---------- lookup and list helpers ----------

export function findActivity(data, id) {
  return data.activities.find((a) => a.id === id);
}

export function findAttempt(activity, attemptId) {
  return activity.attempts.find((t) => t.id === attemptId);
}

// Removes the item with this id and returns { item, index } so it can be put back (undo).
export function removeById(list, id) {
  const index = list.findIndex((x) => x.id === id);
  if (index === -1) return null;
  const [item] = list.splice(index, 1);
  return { item, index };
}

export function insertAt(list, item, index) {
  list.splice(Math.min(index, list.length), 0, item);
}

export function sortAttempts(attempts) {
  return [...attempts].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

// ---------- personal bests ----------

// The current record: the starting best, improved on by any attempt that beats it.
export function currentBest(activity) {
  let best = activity.startBest
    ? { value: activity.startBest.value, date: activity.startBest.date, source: 'start', attemptId: null }
    : null;
  for (const t of sortAttempts(activity.attempts)) {
    if (!best || isBetter(t.result, best.value, activity.direction)) {
      best = { value: t.result, date: t.date, source: 'attempt', attemptId: t.id };
    }
  }
  return best;
}

// Least-squares trend over a list of { id, date, y } items (already in date order).
// status: 'none' (fewer than two items) | 'flat' | 'on-track' | 'off-track'
function buildTrend(items, direction) {
  const useDays = new Set(items.map((t) => t.date)).size > 1;
  const points = items.map((t, i) => ({
    id: t.id,
    date: t.date,
    y: t.y,
    x: useDays ? dayNumber(t.date) : i,
  }));
  if (points.length < 2) return { status: 'none', slope: null, intercept: null, points, useDays };

  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;

  let status;
  if (Math.abs(slope) < 1e-9) status = 'flat';
  else status = (direction === 'lower' ? slope < 0 : slope > 0) ? 'on-track' : 'off-track';
  return { status, slope, intercept, points, useDays };
}

export function trend(activity, { year = null } = {}) {
  const list = newAttempts(activity).filter((t) => year === null || yearOf(t.date) === year);
  const items = sortAttempts(list).map((t) => ({ id: t.id, date: t.date, y: t.result }));
  return buildTrend(items, activity.direction);
}

export const isNewAttempt = (t) => t.date >= NEW_BESTS_START;
export const newAttempts = (activity) => activity.attempts.filter(isNewAttempt);

// The record to beat: the starting record you entered, or any earlier attempt that is better.
export function oldBest(activity) {
  let best = activity.startBest
    ? { value: activity.startBest.value, date: activity.startBest.date, source: 'start', attemptId: null }
    : null;
  for (const t of sortAttempts(activity.attempts)) {
    if (!isNewAttempt(t) && (!best || isBetter(t.result, best.value, activity.direction))) {
      best = { value: t.result, date: t.date, source: 'attempt', attemptId: t.id };
    }
  }
  return best;
}

// The best attempt since the cutoff date.
export function newBest(activity) {
  let best = null;
  for (const t of sortAttempts(newAttempts(activity))) {
    if (!best || isBetter(t.result, best.value, activity.direction)) {
      best = { value: t.result, date: t.date, attemptId: t.id };
    }
  }
  return best;
}

// Where you stand against the Old Best: { hasOld, beaten, gap } (gap is null until you have a New Best).
export function oldBestStatus(activity) {
  const ob = oldBest(activity);
  const nb = newBest(activity);
  if (!ob) return { hasOld: false, beaten: false, gap: null };
  const beaten = Boolean(nb && isBetter(nb.value, ob.value, activity.direction));
  return { hasOld: true, beaten, gap: nb && !beaten ? Math.abs(ob.value - nb.value) : null };
}

// ---------- years ----------
// Every activity has two records: the Personal Best (all time) and a Year Best (one calendar year).
// Both are worked out from the attempts (and the Old Best), so nothing extra is stored.

export const yearOf = (iso) => Number(String(iso).slice(0, 4));
export const currentYear = (today = todayISO()) => yearOf(today);

// The best result of all time.
export const personalBest = (activity) => currentBest(activity);

// The best result within one calendar year. The Old Best counts if it was set in that year.
export function yearBest(activity, year = currentYear()) {
  let best =
    activity.startBest && yearOf(activity.startBest.date) === year
      ? { value: activity.startBest.value, date: activity.startBest.date, source: 'start', attemptId: null, year }
      : null;
  for (const t of sortAttempts(activity.attempts)) {
    if (yearOf(t.date) === year && (!best || isBetter(t.result, best.value, activity.direction))) {
      best = { value: t.result, date: t.date, source: 'attempt', attemptId: t.id, year };
    }
  }
  return best;
}

// The best of everything logged before this attempt (optionally only within one year). null when there is nothing earlier.
function bestBefore(activity, attempt, year = null) {
  const ok = (date) => year === null || yearOf(date) === year;
  let best = activity.startBest && ok(activity.startBest.date) ? activity.startBest.value : null;
  for (const o of sortAttempts(activity.attempts)) {
    if (o.id === attempt.id) break;
    if (ok(o.date) && (best === null || isBetter(o.result, best, activity.direction))) best = o.result;
  }
  return best;
}

// Earlier years, newest first: { year, best, goal } where goal is that year's archived goal (or null).
export function pastYears(activity, today = todayISO()) {
  const now = currentYear(today);
  const history = activity.goalHistory ?? [];
  const years = new Set(activity.attempts.map((t) => yearOf(t.date)));
  if (activity.startBest) years.add(yearOf(activity.startBest.date));
  for (const h of history) years.add(h.year);
  return [...years]
    .filter((y) => y < now)
    .sort((a, b) => b - a)
    .map((year) => ({ year, best: yearBest(activity, year), goal: history.find((h) => h.year === year) ?? null }));
}

// ---------- the year goal ----------
// The target is a goal for one calendar year (goalYear). Only new attempts dated in that year count toward it.

export const goalYear = (activity) => activity.goalYear ?? currentYear();
export const goalAttempts = (activity) => newAttempts(activity).filter((t) => yearOf(t.date) === goalYear(activity));

// The best attempt that counts toward the year goal.
export function goalBest(activity) {
  let best = null;
  for (const t of sortAttempts(goalAttempts(activity))) {
    if (!best || isBetter(t.result, best.value, activity.direction)) best = { value: t.result, date: t.date, attemptId: t.id };
  }
  return best;
}

// When a new year starts, last year's goal moves into goalHistory with its outcome and the year starts with no goal.
export function rolloverGoal(activity, today = todayISO()) {
  const year = currentYear(today);
  if (activity.target == null) {
    activity.goalYear = null;
    return activity;
  }
  if (activity.goalYear == null) activity.goalYear = year;
  if (activity.goalYear < year) {
    refreshFlags(activity);
    const entry = { year: activity.goalYear, target: activity.target, goalDate: activity.goalDate ?? null, reached: Boolean(activity.reachedGoal) };
    activity.goalHistory = [...(activity.goalHistory ?? []).filter((h) => h.year !== entry.year), entry].sort((a, b) => b.year - a.year);
    activity.target = null;
    activity.goalDate = null;
    activity.reachedGoal = false;
    activity.goalYear = null;
    activity.milestones = [];
  }
  return activity;
}

// An activity marked "no Personal Best for now" gets one when a year ends: the best result from the years before
// the current one becomes its Personal Best to beat. With no earlier attempts it keeps waiting.
export function rolloverOldBest(activity, today = todayISO()) {
  if (!activity.noOldBest || activity.startBest) return activity;
  const year = currentYear(today);
  let best = null;
  for (const t of sortAttempts(activity.attempts)) {
    if (yearOf(t.date) < year && (!best || isBetter(t.result, best.result, activity.direction))) best = t;
  }
  if (best) {
    activity.startBest = { value: best.result, date: best.date };
    activity.noOldBest = false;
  }
  return activity;
}

// How far your Year Best has moved toward the year goal, starting from your first attempt of the year (0 to 1).
// The goal only counts as reached when an attempt in that year reaches it.
export function progress(activity) {
  if (activity.trackOnly || activity.target == null) return null;
  const news = sortAttempts(goalAttempts(activity));
  const gb = goalBest(activity);
  const ref = gb ?? currentBest(activity);
  if (!ref) return null;
  const baseline = news[0]?.result ?? ref.value;
  const sign = activity.direction === 'lower' ? -1 : 1;
  const needed = sign * (activity.target - baseline);
  const covered = gb ? sign * (gb.value - baseline) : 0;
  const met = news.some((t) => meetsTarget(t.result, activity.target, activity.direction));
  const fraction = needed <= 0 ? (met ? 1 : 0) : Math.min(1, Math.max(0, covered / needed));
  return { fraction, met, gap: met ? 0 : Math.abs(activity.target - ref.value) };
}

// True when the target is already at or behind the Old Best, which usually means
// the "lower or higher is better" setting is the wrong way round.
export function targetBehindRecord(activity) {
  const ob = oldBest(activity);
  return Boolean(
    !activity.trackOnly && activity.target != null && ob && meetsTarget(ob.value, activity.target, activity.direction) && !activity.reachedGoal,
  );
}

// When the trend line would cross the target, if you are on track and it is within three years.
export function projectedDate(activity, today = todayISO()) {
  if (activity.trackOnly || activity.target == null) return null;
  if (goalAttempts(activity).some((t) => meetsTarget(t.result, activity.target, activity.direction))) return null;
  const tr = trend(activity);
  if (!tr.useDays || tr.status !== 'on-track' || !tr.slope) return null;
  // Too little data makes a pace guess meaningless: need 3+ attempts spread over 2+ weeks.
  const days = tr.points.map((p) => p.x);
  if (tr.points.length < 3 || Math.max(...days) - Math.min(...days) < 14) return null;
  const x = (activity.target - tr.intercept) / tr.slope;
  const now = dayNumber(today);
  if (!Number.isFinite(x) || x <= now || x - now > 1095) return null;
  return new Date(Math.round(x) * DAY_MS).toISOString().slice(0, 10);
}

// Flags only switch on. Track-only activities never have goal flags.
// "Beaten" means a new attempt beat the Old Best. "Reached goal" means an attempt this goal year reached the year goal.
export function refreshFlags(activity) {
  if (activity.trackOnly) {
    activity.beaten = false;
    activity.reachedGoal = false;
    return activity;
  }
  if (oldBestStatus(activity).beaten) activity.beaten = true;
  if (activity.target != null && goalAttempts(activity).some((t) => meetsTarget(t.result, activity.target, activity.direction))) {
    activity.reachedGoal = true;
  }
  return activity;
}

export function goalDaysLeft(activity, today = todayISO()) {
  return activity.goalDate ? daysBetween(today, activity.goalDate) : null;
}

// ---------- input parsing ----------

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const toNumber = (v) => (blank(v) ? null : Number(v));

// ---------- times and numbers ----------
// Times are stored as a plain number in the activity's unit (6:36 in minutes is 6.6),
// so trends and comparisons keep working. They are typed and shown as m:ss or h:mm:ss.

const TIME_FACTOR = { sec: 1, min: 60, hr: 3600 };

export function timeHelp(unit) {
  const u = normalizeUnit(unit);
  if (u === 'hr') return 'Use h:mm:ss like 2:34:36, or a decimal like 2.5.';
  if (u === 'min') return 'Use m:ss like 6:36, or a decimal like 6.5.';
  return 'Use seconds like 12.89, or m:ss like 1:02.5.';
}

// Turns what was typed into a number. Returns { value } (null when blank) or { error }.
export function parseValue(raw, unit) {
  if (blank(raw)) return { value: null };
  const text = String(raw).trim();
  const u = normalizeUnit(unit);
  if (text.includes(':')) {
    if (!isTimeUnit(u)) return { error: 'Use a plain number for this unit.' };
    const parts = text.split(':').map((x) => x.trim());
    const bad = parts.length > 3 || parts.some((x) => !/^\d+(\.\d+)?$/.test(x)) || parts.slice(0, -1).some((x) => x.includes('.'));
    if (bad) return { error: timeHelp(u) };
    const nums = parts.map(Number);
    if (nums.slice(1).some((n) => n >= 60)) return { error: 'Minutes and seconds go up to 59.' };
    let seconds;
    if (nums.length === 3) seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
    else if (u === 'hr') seconds = nums[0] * 3600 + nums[1] * 60; // h:mm
    else seconds = nums[0] * 60 + nums[1]; // m:ss
    return { value: Math.round((seconds / TIME_FACTOR[u]) * 1e6) / 1e6 };
  }
  const n = Number(text.replace(',', '.'));
  if (!Number.isFinite(n)) return { error: isTimeUnit(u) ? timeHelp(u) : 'Enter a number.' };
  return { value: n };
}

// How a value is shown: minutes and hours as m:ss / h:mm:ss, everything else as a plain number.
export function formatValue(v, unit) {
  const u = normalizeUnit(unit);
  if (u === 'min' || u === 'hr') {
    const total = Math.round(v * TIME_FACTOR[u] * 100) / 100;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = Math.round((total - h * 3600 - m * 60) * 100) / 100;
    const secText = String(sec).includes('.') ? String(sec) : String(sec);
    const ss = sec < 10 ? `0${secText}` : secText;
    if (h > 0 || u === 'hr') return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
  }
  return String(Math.round(v * 1e4) / 1e4);
}

// Rounds a time to the nearest whole second (for tidy chart labels).
export function roundToSecond(v, unit) {
  const f = TIME_FACTOR[normalizeUnit(unit)];
  return f ? Math.round(v * f) / f : v;
}

// The text to put back into an input when editing.
export function inputText(v, unit) {
  if (v === null || v === undefined || v === '') return '';
  return isTimeUnit(unit) ? formatValue(v, unit) : String(v);
}

export function parseActivityInput(raw) {
  const name = String(raw.name ?? '').trim();
  if (!name) return { error: 'Give the activity a name.' };

  const unit = normalizeUnit(String(raw.unit ?? '').trim());
  const trackOnly = Boolean(raw.trackOnly);
  const targetP = trackOnly ? { value: null } : parseValue(raw.target, unit);
  if (targetP.error) return { error: `Target: ${targetP.error}` };
  const target = targetP.value;

  const goalDate = blank(raw.goalDate) ? null : raw.goalDate;
  if (goalDate && !isISODate(goalDate)) return { error: 'Goal date is not valid.' };
  const year = currentYear();
  if (!trackOnly && goalDate && yearOf(goalDate) !== year) return { error: `The goal date must be in ${year}, because this is your ${year} goal.` };

  const startP = parseValue(raw.startValue, unit);
  if (startP.error) return { error: `Personal Best: ${startP.error}` };
  const startValue = startP.value;
  const startDate = blank(raw.startDate) ? todayISO() : raw.startDate;
  if (startValue !== null && !isISODate(startDate)) return { error: 'Personal Best date is not valid.' };

  return {
    value: {
      name,
      unit,
      direction: raw.direction === 'lower' ? 'lower' : 'higher',
      trackOnly,
      target: trackOnly ? null : target,
      goalYear: trackOnly || target === null ? null : year,
      goalDate: trackOnly ? null : goalDate,
      startBest: startValue === null ? null : { value: startValue, date: startDate },
    },
  };
}

export function parseAttemptInput(raw, unit = '') {
  if (!isISODate(raw.date)) return { error: 'Pick a valid date.' };
  const r = parseValue(raw.result, unit);
  if (r.error) return { error: r.error };
  if (r.value === null) return { error: isTimeUnit(unit) ? `Enter the result. ${timeHelp(unit)}` : 'Enter the result as a number.' };
  return { value: { date: raw.date, result: r.value, notes: String(raw.notes ?? '').trim(), tags: cleanTags(raw.tags) } };
}

export function createActivity(data, input) {
  const activity = { id: newId(), ...input, beaten: false, reachedGoal: false, goalHistory: [], attempts: [], createdAt: Date.now() };
  data.activities.push(activity);
  return refreshFlags(activity);
}

export function updateActivity(activity, input) {
  Object.assign(activity, input);
  return refreshFlags(activity);
}

const metTarget = (activity) =>
  !activity.trackOnly && activity.target != null && goalAttempts(activity).some((t) => meetsTarget(t.result, activity.target, activity.direction));

// Returns { attempt, newRecord, events }. events says what this attempt achieved:
// beatOld (first time beating the Old Best), target (first time reaching the year goal), milestone (a value),
// personalBest (a new all-time best), yearBest (a new best for that attempt's year).
export function addAttempt(activity, input) {
  const before = {
    best: currentBest(activity),
    beaten: oldBestStatus(activity).beaten,
    met: metTarget(activity),
    yb: yearBest(activity, yearOf(input.date)),
    ms: new Set(milestoneStatus(activity).rows.filter((r) => r.reached).map((r) => r.value)),
  };
  const attempt = {
    id: newId(),
    date: input.date,
    result: input.result,
    notes: input.notes ?? '',
    tags: cleanTags(input.tags),
    createdAt: Date.now(),
  };
  activity.attempts.push(attempt);
  refreshFlags(activity);
  const after = currentBest(activity);
  const ybAfter = yearBest(activity, yearOf(attempt.date));
  const newlyReached = activity.trackOnly ? [] : milestoneStatus(activity).rows.filter((r) => r.reached && !before.ms.has(r.value));
  const events = {
    target: !before.met && metTarget(activity),
    beatOld: !before.beaten && oldBestStatus(activity).beaten,
    milestone: newlyReached.length ? newlyReached[newlyReached.length - 1].value : null,
    personalBest: Boolean(before.best) && after.attemptId === attempt.id,
    yearBest: Boolean(before.yb) && ybAfter?.attemptId === attempt.id,
  };
  const newRecord = Boolean(before.best) && after.attemptId === attempt.id;
  return { attempt, newRecord, events };
}

export function updateAttempt(activity, attemptId, input) {
  const attempt = findAttempt(activity, attemptId);
  if (!attempt) return null;
  Object.assign(attempt, input);
  refreshFlags(activity);
  return attempt;
}

// ---------- exercises ----------
// An exercise is something you like to track (for example "Incline smith bench").
// It holds sessions, and each session holds sets of { reps, weight }.

export function findExercise(data, id) {
  return (data.exercises ?? []).find((e) => e.id === id);
}

export function parseExerciseInput(raw) {
  const name = String(raw.name ?? '').trim();
  if (!name) return { error: 'Give the exercise a name.' };
  return {
    value: {
      name,
      unit: raw.unit === 'kg' ? 'kg' : 'lb',
      category: String(raw.category ?? '').trim(),
      notes: String(raw.notes ?? '').trim(),
      linkedActivityId: String(raw.linkedActivityId ?? '') || null,
      assisted: Boolean(raw.assisted),
    },
  };
}

export function createExercise(data, input) {
  const exercise = { id: newId(), ...input, sessions: [], createdAt: Date.now() };
  data.exercises.push(exercise);
  return exercise;
}

export function updateExercise(exercise, input) {
  Object.assign(exercise, input);
  return exercise;
}

// raw: { date, notes, sets: [{ reps, weight }] }. Empty rows are ignored; a blank weight means bodyweight.
export function parseSessionInput(raw) {
  if (!isISODate(raw.date)) return { error: 'Pick a valid date.' };
  const sets = [];
  for (const row of raw.sets ?? []) {
    if (blank(row.reps) && blank(row.weight)) continue;
    const reps = toNumber(row.reps);
    const weight = blank(row.weight) ? 0 : Number(row.weight);
    if (reps === null || !Number.isFinite(reps) || reps <= 0) return { error: 'Each set needs a number of reps.' };
    if (!Number.isFinite(weight) || weight < 0) return { error: 'Weight must be zero or more.' };
    sets.push({ reps, weight });
  }
  if (!sets.length) return { error: 'Add at least one set.' };
  return { value: { date: raw.date, sets, notes: String(raw.notes ?? '').trim(), tags: cleanTags(raw.tags) } };
}

export function addSession(exercise, input) {
  const before = bestSession(exercise);
  const session = { id: newId(), date: input.date, sets: input.sets, notes: input.notes ?? '', tags: cleanTags(input.tags), createdAt: Date.now() };
  exercise.sessions.push(session);
  const after = bestSession(exercise);
  return { session, record: Boolean(before) && after.session.id === session.id };
}

export function updateSession(exercise, sessionId, input) {
  const session = exercise.sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  Object.assign(session, input);
  return session;
}

export function sortSessions(sessions) {
  return sortAttempts(sessions);
}

// The top set is the heaviest set, and the most reps at that weight.
// assisted: for exercises where less weight is better (assisted pull-ups), the top set is the lightest one.
export function sessionStats(session, assisted = false) {
  let topWeight = assisted ? Infinity : 0;
  let topReps = 0;
  let volume = 0;
  let totalReps = 0;
  for (const s of session.sets) {
    const lighter = assisted ? s.weight < topWeight : s.weight > topWeight;
    if (lighter || (s.weight === topWeight && s.reps > topReps)) {
      topWeight = s.weight;
      topReps = s.reps;
    }
    if (!assisted) volume += s.weight * s.reps;
    totalReps += s.reps;
  }
  if (!Number.isFinite(topWeight)) topWeight = 0;
  return { topWeight, topReps, volume, totalReps, setCount: session.sets.length };
}

// Positive when stats a is a better top set than stats b.
function compareTopSets(a, b, assisted = false) {
  if (a.topWeight !== b.topWeight) return assisted ? b.topWeight - a.topWeight : a.topWeight - b.topWeight;
  return a.topReps - b.topReps;
}

export function usesWeight(exercise) {
  return exercise.sessions.some((s) => s.sets.some((x) => x.weight > 0));
}

export function lastSession(exercise) {
  const sorted = sortSessions(exercise.sessions);
  return sorted[sorted.length - 1] ?? null;
}

// The best session so far, judged by top set.
export function bestSession(exercise) {
  let best = null;
  let bestStats = null;
  for (const s of sortSessions(exercise.sessions)) {
    const st = sessionStats(s, exercise.assisted);
    if (!best || compareTopSets(st, bestStats, exercise.assisted) > 0) {
      best = s;
      bestStats = st;
    }
  }
  return best ? { session: best, stats: bestStats } : null;
}

// How the latest session compares with the one before it.
// Returns null with fewer than two sessions, otherwise { dir: 'up' | 'down' | 'same', text }.
export function sessionChange(exercise) {
  const sorted = sortSessions(exercise.sessions);
  if (sorted.length < 2) return null;
  const assisted = Boolean(exercise.assisted);
  const a = sessionStats(sorted[sorted.length - 1], assisted);
  const b = sessionStats(sorted[sorted.length - 2], assisted);
  const signed = (n) => `${n > 0 ? '+' : '−'}${Math.abs(Number(n.toFixed(2)))}`;
  const dirOf = (n) => (n > 0 ? 'up' : 'down');
  if (a.topWeight !== b.topWeight) {
    const d = a.topWeight - b.topWeight;
    // Assisted: less weight is the improvement.
    return { dir: dirOf(assisted ? -d : d), text: `${signed(d)} ${exercise.unit}${assisted ? ' assistance' : ''} on your top set` };
  }
  if (a.topReps !== b.topReps) {
    const d = a.topReps - b.topReps;
    return { dir: dirOf(d), text: `${signed(d)} rep${Math.abs(d) === 1 ? '' : 's'} on your top set` };
  }
  if (a.volume !== b.volume) {
    const d = a.volume - b.volume;
    return { dir: dirOf(d), text: `${signed(d)} ${exercise.unit} total volume` };
  }
  return { dir: 'same', text: 'Same as last time' };
}

// One strength number per set blends weight and reps (estimated max, Epley formula),
// so lifting more weight or doing more reps both count as progress.
// Bodyweight sets (no weight) simply use their reps.
export function setScore(set) {
  return set.weight > 0 ? set.weight * (1 + set.reps / 30) : set.reps;
}

export function sessionScore(session) {
  return Math.max(...session.sets.map(setScore));
}

// Assisted exercises: lower is better, so a set's score is the assistance spread over the reps
// (less assistance or more reps both lower it).
function assistScore(set) {
  return set.weight / (1 + set.reps / 30);
}

// level: 'none' | 'up' | 'down' | 'flat'. pct is the change along the trend line from first to last session.
export function exerciseTrend(exercise) {
  const weighted = usesWeight(exercise);
  const lowerBetter = Boolean(exercise.assisted) && weighted;
  const items = sortSessions(exercise.sessions).map((s) => ({
    id: s.id,
    date: s.date,
    y: Math.round((lowerBetter ? Math.min(...s.sets.map(assistScore)) : sessionScore(s)) * 10) / 10,
  }));
  const tr = buildTrend(items, lowerBetter ? 'lower' : 'higher');
  let pct = null;
  if (tr.slope !== null) {
    const xs = tr.points.map((p) => p.x);
    const y0 = tr.intercept + tr.slope * Math.min(...xs);
    const y1 = tr.intercept + tr.slope * Math.max(...xs);
    // pct is progress: positive is better, which for assisted exercises means the assistance went down.
    if (y0 > 0) pct = (((y1 - y0) / y0) * 100) * (lowerBetter ? -1 : 1);
  }
  const level = pct === null ? 'none' : pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat';
  return { ...tr, weighted, lowerBetter, pct, level, count: items.length };
}

// ---------- tags ----------

const cleanTags = (list) => [...new Set((Array.isArray(list) ? list : []).map((t) => String(t).trim()).filter(Boolean))];

export function rememberTags(data, tags) {
  data.tags = cleanTags([...(data.tags ?? []), ...(tags ?? [])]);
}

// Which tag goes with your better results (needs two tags that each have two or more attempts).
export function tagInsight(activity) {
  const byTag = new Map();
  for (const t of activity.attempts) {
    for (const tag of t.tags ?? []) byTag.set(tag, [...(byTag.get(tag) ?? []), t.result]);
  }
  const rows = [...byTag].filter(([, v]) => v.length >= 2).map(([tag, v]) => ({ tag, avg: v.reduce((a, b) => a + b, 0) / v.length }));
  if (rows.length < 2) return null;
  rows.sort((a, b) => (activity.direction === 'lower' ? a.avg - b.avg : b.avg - a.avg));
  return rows[0];
}

// ---------- milestones ----------
// Smaller steps on the way to the year goal. They count when an attempt in the goal year reaches them.

export function sortMilestones(activity, list) {
  return [...list].sort((a, b) => (activity.direction === 'lower' ? b - a : a - b));
}

export function parseMilestones(text, unit) {
  const out = [];
  for (const piece of String(text ?? '').split(/[\n;,]+/)) {
    if (!piece.trim()) continue;
    const r = parseValue(piece, unit);
    if (r.error) return { error: `Milestones: ${r.error}` };
    if (r.value !== null && !out.includes(r.value)) out.push(r.value);
  }
  return { value: out };
}

export function milestoneStatus(activity) {
  const list = sortMilestones(activity, activity.milestones ?? []);
  const news = goalAttempts(activity);
  const rows = list.map((value) => ({ value, reached: news.some((t) => meetsTarget(t.result, value, activity.direction)) }));
  const next = rows.find((r) => !r.reached) ?? null;
  return { rows, next, reachedCount: rows.filter((r) => r.reached).length };
}

// Three evenly spaced steps between where you are and the target.
export function suggestMilestones(activity) {
  if (activity.target == null) return [];
  const ref = (goalBest(activity) ?? currentBest(activity))?.value;
  if (ref == null || meetsTarget(ref, activity.target, activity.direction)) return [];
  const out = [];
  for (const k of [1, 2, 3]) {
    let v = ref + ((activity.target - ref) * k) / 4;
    v = isTimeUnit(activity.unit) ? roundToSecond(v, activity.unit) : Math.round(v * 100) / 100;
    if (v !== ref && v !== activity.target && !out.includes(v)) out.push(v);
  }
  return sortMilestones(activity, out);
}

// ---------- weights ----------

// Plates to load on each side of the bar, using the common plate sizes.
export function platesPerSide(weight, unit) {
  const kg = normalizeUnit(unit) === 'kg';
  const bar = kg ? 20 : 45;
  const sizes = kg ? [25, 20, 15, 10, 5, 2.5, 1.25] : [45, 35, 25, 10, 5, 2.5];
  if (!(weight > 0)) return { bar, plates: [], leftover: 0, underBar: false };
  if (weight < bar) return { bar, plates: [], leftover: 0, underBar: true };
  let side = (weight - bar) / 2;
  const plates = [];
  for (const p of sizes) {
    while (side >= p - 1e-9) {
      plates.push(p);
      side -= p;
    }
  }
  return { bar, plates, leftover: Math.round(side * 100) / 100, underBar: false };
}

// ---------- dates ----------

export function addDaysISO(iso, n) {
  return new Date((dayNumber(iso) + n) * DAY_MS).toISOString().slice(0, 10);
}

export function mondayOf(iso) {
  const dow = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDaysISO(iso, -dow);
}

// ---------- records ----------
// Every time a new best was set, newest first. Built from your attempts and sessions, so nothing extra is stored.

export function recordsLog(data) {
  const out = [];
  for (const a of data.activities) {
    const ob = oldBest(a);
    let beaten = false;
    const goals = [
      ...(a.goalHistory ?? []).map((h) => ({ year: h.year, target: h.target, reached: false })),
      ...(!a.trackOnly && a.target != null ? [{ year: goalYear(a), target: a.target, reached: false }] : []),
    ];
    for (const t of sortAttempts(newAttempts(a))) {
      const year = yearOf(t.date);
      const beatsOld = !beaten && ob && isBetter(t.result, ob.value, a.direction);
      const hit = goals.find((g) => !g.reached && g.year === year && meetsTarget(t.result, g.target, a.direction));
      const pbPrev = bestBefore(a, t);
      const yearPrev = bestBefore(a, t, year);
      if (beatsOld) beaten = true;
      if (hit) hit.reached = true;
      const badges = [];
      if (beatsOld) badges.push('Beat Personal Best');
      if (hit) badges.push(`${year} Goal Reached`);
      if (!badges.length && pbPrev !== null && isBetter(t.result, pbPrev, a.direction)) badges.push('New Personal Best');
      else if (!badges.length && yearPrev !== null && isBetter(t.result, yearPrev, a.direction)) badges.push(`New ${year} Best`);
      if (badges.length) out.push({ kind: 'best', id: a.id, name: a.name, date: t.date, createdAt: t.createdAt ?? 0, value: t.result, unit: a.unit, badges, tags: t.tags ?? [] });
    }
  }
  for (const e of data.exercises ?? []) {
    let top = null;
    for (const s of sortSessions(e.sessions)) {
      const st = sessionStats(s, e.assisted);
      if (top && compareTopSets(st, top, e.assisted) > 0) {
        out.push({ kind: 'exercise', id: e.id, name: e.name, date: s.date, createdAt: s.createdAt ?? 0, stats: st, unit: e.unit, assisted: Boolean(e.assisted), badges: ['New Best Top Set'], tags: s.tags ?? [] });
      }
      if (!top || compareTopSets(st, top, e.assisted) > 0) top = st;
    }
  }
  return out.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.createdAt - a.createdAt));
}

// ---------- year in review ----------

// Years that have anything logged, newest first (always includes the current year).
export function reviewYears(data, today = todayISO()) {
  const years = new Set([currentYear(today)]);
  for (const d of loggedDates(data)) years.add(yearOf(d));
  return [...years].sort((a, b) => b - a);
}

// Everything worth remembering about one calendar year, worked out from the attempts and sessions.
export function yearReview(data, year) {
  const logged = [...loggedDates(data)].filter((d) => yearOf(d) === year).sort();
  let streak = 0;
  let run = 0;
  let prev = null;
  for (const d of logged) {
    run = prev && dayNumber(d) - dayNumber(prev) === 1 ? run + 1 : 1;
    streak = Math.max(streak, run);
    prev = d;
  }
  const months = Array(12).fill(0);
  for (const d of logged) months[Number(d.slice(5, 7)) - 1] += 1;
  const topMonth = Math.max(...months);

  const records = recordsLog(data).filter((r) => yearOf(r.date) === year);
  const recordsFor = (id) => records.filter((r) => r.id === id);

  let attempts = 0;
  const activities = [];
  const goals = { reached: 0, total: 0 };
  for (const a of data.activities) {
    const list = sortAttempts(a.attempts.filter((t) => yearOf(t.date) === year));
    attempts += list.length;
    const hist = (a.goalHistory ?? []).find((h) => h.year === year);
    const goal = hist
      ? { target: hist.target, reached: hist.reached }
      : !a.trackOnly && a.target != null && goalYear(a) === year
        ? { target: a.target, reached: Boolean(a.reachedGoal) }
        : null;
    if (goal) {
      goals.total += 1;
      if (goal.reached) goals.reached += 1;
    }
    if (!list.length && !goal) continue;
    let best = null;
    for (const t of list) if (!best || isBetter(t.result, best.result, a.direction)) best = t;
    const first = list[0] ?? null;
    const change = first && best && first.result !== 0 ? Math.abs(best.result - first.result) / Math.abs(first.result) : null;
    activities.push({
      id: a.id, name: a.name, unit: a.unit, attempts: list.length,
      first: first?.result ?? null, best: best?.result ?? null, change: change && change > 0 ? change : null,
      newBests: recordsFor(a.id).filter((r) => r.badges.some((b) => b.includes('Personal Best'))).length,
      goal,
    });
  }

  let sessions = 0;
  let sets = 0;
  const volumes = {};
  const exercises = [];
  for (const e of data.exercises ?? []) {
    const list = sortSessions(e.sessions.filter((s) => yearOf(s.date) === year));
    if (!list.length) continue;
    sessions += list.length;
    let best = null;
    let volume = 0;
    for (const s of list) {
      const st = sessionStats(s, e.assisted);
      sets += st.setCount;
      volume += st.volume;
      if (!best || compareTopSets(st, best, e.assisted) > 0) best = st;
    }
    if (volume > 0) volumes[e.unit] = (volumes[e.unit] ?? 0) + volume;
    exercises.push({ id: e.id, name: e.name, unit: e.unit, assisted: Boolean(e.assisted), sessions: list.length, first: sessionStats(list[0], e.assisted), best, volume });
  }

  return {
    year, days: logged.length, attempts, sessions, sets, volumes, streak, months,
    topMonth: topMonth > 0 ? months.indexOf(topMonth) : null,
    records, goals, activities, exercises,
  };
}

// A seven-day summary starting on a Monday.
export function weekSummary(data, mondayISO) {
  const start = mondayISO;
  const end = addDaysISO(mondayISO, 6);
  const logged = loggedDates(data);
  const inRange = (d) => d >= start && d <= end;
  let days = 0;
  for (let i = 0; i < 7; i++) if (logged.has(addDaysISO(start, i))) days += 1;
  const attempts = data.activities.reduce((n, a) => n + a.attempts.filter((t) => inRange(t.date)).length, 0);
  const sessions = (data.exercises ?? []).reduce((n, e) => n + e.sessions.filter((x) => inRange(x.date)).length, 0);
  const records = recordsLog(data).filter((r) => inRange(r.date));
  return { start, end, days, attempts, sessions, records };
}

// ---------- activity heat map ----------

// Every date with at least one logged attempt or exercise session.
export function loggedDates(data) {
  const dates = new Set();
  for (const a of data.activities) for (const t of a.attempts) dates.add(t.date);
  for (const e of data.exercises ?? []) for (const s of e.sessions) dates.add(s.date);
  return dates;
}

// Calendar weeks (Monday first), oldest first, ending with the week that holds today.
// Each day: { date, logged, weekend, future, today }.
export function heatmapWeeks(logged, weeks = 6, now = new Date()) {
  const today = todayISO(now);
  const sinceMonday = (now.getDay() + 6) % 7;
  const out = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const offset = -(sinceMonday + w * 7) + d;
      const date = todayISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
      days.push({ date, logged: logged.has(date), weekend: d >= 5, future: date > today, today: date === today });
    }
    out.push(days);
  }
  return out;
}

// ---------- ideas ----------

export function newIdea(text) {
  return { id: newId(), text: text.trim(), createdAt: Date.now() };
}

// Newest first.
export function sortedIdeas(ideas) {
  return [...ideas].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// Plain text laid out so it can be pasted straight into a Claude chat.
export function formatIdeasForClaude(ideas, today) {
  const list = sortedIdeas(ideas);
  const count = list.length;
  const lines = [
    'Ideas for the Personal Best Tracker app',
    `${count} idea${count === 1 ? '' : 's'}, newest first, copied ${today}`,
    '',
  ];
  list.forEach((idea, i) => {
    const [first, ...rest] = idea.text.split('\n');
    lines.push(`${i + 1}. [${todayISO(new Date(idea.createdAt))}] ${first}`);
    for (const line of rest) lines.push(`   ${line}`);
  });
  return lines.join('\n');
}

// ---------- stored data ----------

export function normalizeData(raw, today = todayISO()) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.activities)) return emptyData();

  const activities = raw.activities.map((a) => ({
    ...a,
    unit: normalizeUnit(a.unit),
    direction: a.direction === 'lower' ? 'lower' : 'higher',
    attempts: Array.isArray(a.attempts) ? a.attempts : [],
    startBest: a.startBest ?? null,
    noOldBest: Boolean(a.noOldBest) && !a.startBest,
    target: a.target ?? null,
    goalDate: a.goalDate ?? null,
    trackOnly: Boolean(a.trackOnly),
    beaten: Boolean(a.beaten),
    reachedGoal: Boolean(a.reachedGoal),
    goalYear: a.target != null ? Number(a.goalYear) || currentYear(today) : null,
    goalHistory: (Array.isArray(a.goalHistory) ? a.goalHistory : [])
      .filter((h) => h && Number.isFinite(Number(h.year)) && Number.isFinite(Number(h.target)))
      .map((h) => ({ year: Number(h.year), target: Number(h.target), goalDate: h.goalDate ?? null, reached: Boolean(h.reached) })),
    archived: Boolean(a.archived),
    milestones: (Array.isArray(a.milestones) ? a.milestones : []).map(Number).filter(Number.isFinite),
  }));
  for (const a of activities) {
    rolloverGoal(a, today);
    rolloverOldBest(a, today);
  }

  const ideas = Array.isArray(raw.ideas)
    ? raw.ideas
        .filter((i) => i && typeof i.text === 'string' && i.text.trim())
        .map((i) => ({ id: i.id ?? newId(), text: i.text, createdAt: Number(i.createdAt) || Date.now() }))
    : [];

  const exercises = Array.isArray(raw.exercises)
    ? raw.exercises
        .filter((e) => e && typeof e.name === 'string' && e.name.trim())
        .map((e) => ({
          ...e,
          id: e.id ?? newId(),
          unit: e.unit === 'kg' ? 'kg' : 'lb',
          notes: e.notes ?? '',
          category: typeof e.category === 'string' ? e.category : '',
          archived: Boolean(e.archived),
          linkedActivityId: e.linkedActivityId ?? null,
          assisted: Boolean(e.assisted),
          sessions: Array.isArray(e.sessions) ? e.sessions.filter((s) => s && Array.isArray(s.sets)) : [],
        }))
    : [];

  const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map((c) => String(c).trim()).filter(Boolean))];
  let categories = Array.isArray(raw.categories) ? clean(raw.categories) : [...DEFAULT_CATEGORIES];
  for (const e of exercises) if (e.category && !categories.includes(e.category)) categories.push(e.category);
  const customUnits = clean(raw.customUnits).map(normalizeUnit);

  const tags = Array.isArray(raw.tags) ? cleanTags(raw.tags) : [...DEFAULT_TAGS];
  for (const t of [...activities.flatMap((a) => a.attempts), ...exercises.flatMap((e) => e.sessions)].flatMap((x) => x.tags ?? [])) {
    if (!tags.includes(t)) tags.push(t);
  }

  return { version: SCHEMA_VERSION, activities, ideas, exercises, categories, customUnits, tags };
}
