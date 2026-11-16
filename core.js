// core.js — pure data logic for Personal Best Tracker. No DOM, no network.

export const SCHEMA_VERSION = 1;
const DAY_MS = 86400000;

// Anything dated before this is an "Old Best". Anything on or after it is a "New Best".
export const NEW_BESTS_START = '2026-11-15';

export const DEFAULT_CATEGORIES = ['Push', 'Pull', 'Legs', 'Abs', 'Cardio'];

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
  return { version: SCHEMA_VERSION, activities: [], ideas: [], exercises: [], categories: [...DEFAULT_CATEGORIES], customUnits: [] };
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

export function trend(activity) {
  const items = sortAttempts(newAttempts(activity)).map((t) => ({ id: t.id, date: t.date, y: t.result }));
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

// How far your New Best has moved toward the target, starting from your first new attempt (0 to 1).
// The target only counts as reached when a new attempt reaches it.
export function progress(activity) {
  if (activity.trackOnly || activity.target == null) return null;
  const news = sortAttempts(newAttempts(activity));
  const nb = newBest(activity);
  const ref = nb ?? oldBest(activity);
  if (!ref) return null;
  const baseline = news[0]?.result ?? ref.value;
  const sign = activity.direction === 'lower' ? -1 : 1;
  const needed = sign * (activity.target - baseline);
  const covered = nb ? sign * (nb.value - baseline) : 0;
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
  if (newAttempts(activity).some((t) => meetsTarget(t.result, activity.target, activity.direction))) return null;
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
// "Beaten" means a new attempt beat the Old Best. "Reached goal" means a new attempt reached the target.
export function refreshFlags(activity) {
  if (activity.trackOnly) {
    activity.beaten = false;
    activity.reachedGoal = false;
    return activity;
  }
  if (oldBestStatus(activity).beaten) activity.beaten = true;
  if (activity.target != null && newAttempts(activity).some((t) => meetsTarget(t.result, activity.target, activity.direction))) {
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

export function parseActivityInput(raw) {
  const name = String(raw.name ?? '').trim();
  if (!name) return { error: 'Give the activity a name.' };

  const trackOnly = Boolean(raw.trackOnly);
  const target = toNumber(raw.target);
  if (!trackOnly && target !== null && !Number.isFinite(target)) return { error: 'Target must be a number.' };

  const goalDate = blank(raw.goalDate) ? null : raw.goalDate;
  if (goalDate && !isISODate(goalDate)) return { error: 'Goal date is not valid.' };

  const startValue = toNumber(raw.startValue);
  if (startValue !== null && !Number.isFinite(startValue)) return { error: 'Starting personal best must be a number.' };
  const startDate = blank(raw.startDate) ? todayISO() : raw.startDate;
  if (startValue !== null && !isISODate(startDate)) return { error: 'Starting personal best date is not valid.' };

  return {
    value: {
      name,
      unit: String(raw.unit ?? '').trim(),
      direction: raw.direction === 'lower' ? 'lower' : 'higher',
      trackOnly,
      target: trackOnly ? null : target,
      goalDate: trackOnly ? null : goalDate,
      startBest: startValue === null ? null : { value: startValue, date: startDate },
    },
  };
}

export function parseAttemptInput(raw) {
  if (!isISODate(raw.date)) return { error: 'Pick a valid date.' };
  const result = toNumber(raw.result);
  if (result === null || !Number.isFinite(result)) return { error: 'Enter the result as a number.' };
  return { value: { date: raw.date, result, notes: String(raw.notes ?? '').trim() } };
}

// ---------- mutations ----------

export function createActivity(data, input) {
  const activity = { id: newId(), ...input, beaten: false, reachedGoal: false, attempts: [], createdAt: Date.now() };
  data.activities.push(activity);
  return refreshFlags(activity);
}

export function updateActivity(activity, input) {
  Object.assign(activity, input);
  return refreshFlags(activity);
}

// Returns { attempt, newRecord }. newRecord is true when this attempt beats the record it was logged against.
export function addAttempt(activity, input) {
  const before = currentBest(activity);
  const attempt = { id: newId(), date: input.date, result: input.result, notes: input.notes ?? '', createdAt: Date.now() };
  activity.attempts.push(attempt);
  refreshFlags(activity);
  const after = currentBest(activity);
  const newRecord = Boolean(before) && after.attemptId === attempt.id;
  return { attempt, newRecord };
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
  return { value: { date: raw.date, sets, notes: String(raw.notes ?? '').trim() } };
}

export function addSession(exercise, input) {
  const session = { id: newId(), date: input.date, sets: input.sets, notes: input.notes ?? '', createdAt: Date.now() };
  exercise.sessions.push(session);
  return session;
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
export function sessionStats(session) {
  let topWeight = 0;
  let topReps = 0;
  let volume = 0;
  let totalReps = 0;
  for (const s of session.sets) {
    if (s.weight > topWeight || (s.weight === topWeight && s.reps > topReps)) {
      topWeight = s.weight;
      topReps = s.reps;
    }
    volume += s.weight * s.reps;
    totalReps += s.reps;
  }
  return { topWeight, topReps, volume, totalReps, setCount: session.sets.length };
}

// Positive when stats a is a better top set than stats b.
function compareTopSets(a, b) {
  if (a.topWeight !== b.topWeight) return a.topWeight - b.topWeight;
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
    const st = sessionStats(s);
    if (!best || compareTopSets(st, bestStats) > 0) {
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
  const a = sessionStats(sorted[sorted.length - 1]);
  const b = sessionStats(sorted[sorted.length - 2]);
  const signed = (n) => `${n > 0 ? '+' : '−'}${Math.abs(Number(n.toFixed(2)))}`;
  const dirOf = (n) => (n > 0 ? 'up' : 'down');
  if (a.topWeight !== b.topWeight) {
    const d = a.topWeight - b.topWeight;
    return { dir: dirOf(d), text: `${signed(d)} ${exercise.unit} on your top set` };
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

// level: 'none' | 'up' | 'down' | 'flat'. pct is the change along the trend line from first to last session.
export function exerciseTrend(exercise) {
  const weighted = usesWeight(exercise);
  const items = sortSessions(exercise.sessions).map((s) => ({
    id: s.id,
    date: s.date,
    y: Math.round(sessionScore(s) * 10) / 10,
  }));
  const tr = buildTrend(items, 'higher');
  let pct = null;
  if (tr.slope !== null) {
    const xs = tr.points.map((p) => p.x);
    const y0 = tr.intercept + tr.slope * Math.min(...xs);
    const y1 = tr.intercept + tr.slope * Math.max(...xs);
    if (y0 > 0) pct = ((y1 - y0) / y0) * 100;
  }
  const level = pct === null ? 'none' : pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat';
  return { ...tr, weighted, pct, level, count: items.length };
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

export function normalizeData(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.activities)) return emptyData();

  const activities = raw.activities.map((a) => ({
    ...a,
    unit: normalizeUnit(a.unit),
    direction: a.direction === 'lower' ? 'lower' : 'higher',
    attempts: Array.isArray(a.attempts) ? a.attempts : [],
    startBest: a.startBest ?? null,
    target: a.target ?? null,
    goalDate: a.goalDate ?? null,
    trackOnly: Boolean(a.trackOnly),
    beaten: Boolean(a.beaten),
    reachedGoal: Boolean(a.reachedGoal),
  }));

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
          sessions: Array.isArray(e.sessions) ? e.sessions.filter((s) => s && Array.isArray(s.sets)) : [],
        }))
    : [];

  const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map((c) => String(c).trim()).filter(Boolean))];
  let categories = Array.isArray(raw.categories) ? clean(raw.categories) : [...DEFAULT_CATEGORIES];
  for (const e of exercises) if (e.category && !categories.includes(e.category)) categories.push(e.category);
  const customUnits = clean(raw.customUnits).map(normalizeUnit);

  return { version: SCHEMA_VERSION, activities, ideas, exercises, categories, customUnits };
}
