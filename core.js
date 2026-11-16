// core.js — pure data logic for Personal Best Tracker. No DOM, no network.

export const SCHEMA_VERSION = 1;
const DAY_MS = 86400000;

export function emptyData() {
  return { version: SCHEMA_VERSION, activities: [], ideas: [], exercises: [] };
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
  if (points.length < 2) return { status: 'none', slope: null, intercept: null, points };

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
  return { status, slope, intercept, points };
}

export function trend(activity) {
  const items = sortAttempts(activity.attempts).map((t) => ({ id: t.id, date: t.date, y: t.result }));
  return buildTrend(items, activity.direction);
}

// How far the current best has moved from the baseline toward the target (0 to 1).
export function progress(activity) {
  if (activity.trackOnly || activity.target == null) return null;
  const best = currentBest(activity);
  const baseline = activity.startBest?.value ?? sortAttempts(activity.attempts)[0]?.result;
  if (!best || baseline == null) return null;

  const sign = activity.direction === 'lower' ? -1 : 1;
  const needed = sign * (activity.target - baseline);
  const covered = sign * (best.value - baseline);
  const met = meetsTarget(best.value, activity.target, activity.direction);
  const fraction = needed <= 0 ? (met ? 1 : 0) : Math.min(1, Math.max(0, covered / needed));
  return { fraction, met };
}

// Flags only switch on. Track-only activities never have goal flags.
export function refreshFlags(activity) {
  if (activity.trackOnly) {
    activity.beaten = false;
    activity.reachedGoal = false;
    return activity;
  }
  if (activity.startBest && activity.attempts.some((t) => isBetter(t.result, activity.startBest.value, activity.direction))) {
    activity.beaten = true;
  }
  if (activity.target != null && activity.attempts.some((t) => meetsTarget(t.result, activity.target, activity.direction))) {
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

// One point per session: the top weight, or the top reps for bodyweight exercises.
export function exerciseTrend(exercise) {
  const weighted = usesWeight(exercise);
  const items = sortSessions(exercise.sessions).map((s) => {
    const st = sessionStats(s);
    return { id: s.id, date: s.date, y: weighted ? st.topWeight : st.topReps };
  });
  return { ...buildTrend(items, 'higher'), weighted };
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
          sessions: Array.isArray(e.sessions) ? e.sessions.filter((s) => s && Array.isArray(s.sets)) : [],
        }))
    : [];

  return { version: SCHEMA_VERSION, activities, ideas, exercises };
}
