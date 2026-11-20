// app.js — screens, routing, and sync orchestration.
import * as core from './core.js';
import * as gh from './github.js';
import { VERSIONS } from './versions.js';
import { isUnlocked, showLock, lockNow, unlockedUntil } from './lock.js';

const CONFIG_KEY = 'pbt.config';
const CACHE_KEY = 'pbt.cache';
const DEFAULT_PATH = 'data/personal-bests.json';
const SEEN_KEY = 'pbt.seenVersion';
const VIEW_KEY = 'pbt.exerciseView';
const SAVE_DELAY_MS = 1200;

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const dlg = $('#dlg');
const menuEl = $('#menu');
const statusEl = $('#status');
const addBtn = $('#add-btn');
const whatsNewEl = $('#whatsnew');
const weeklyEl = $('#weekly');

// ---------- state ----------

const state = {
  data: core.emptyData(),
  sha: null, // GitHub's id for the file version we last read or wrote
  dirty: false, // local edits not yet confirmed saved to GitHub
  version: 0, // increments on every edit, so a save in flight knows if it is stale
  config: readJSON(CONFIG_KEY, null),
  status: 'idle',
  message: '',
  lastSynced: null,
  saveTimer: null,
  inFlight: null,
  suppressClick: false,
  started: false, // true once the code screen has been passed
  exView: readJSON(VIEW_KEY, 'tile'),
  bView: readJSON('pbt.bestsView', 'tile'),
  exFilter: '',
  chartRange: 'year', // trend chart range: this year or all time
  tagFilter: '',
  bQ: '',
  bSort: 'manual',
  eQ: '',
  eSort: 'manual',
  showArchived: false,
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    setStatus('error', 'This device is out of local storage space.');
  }
}

const cache = readJSON(CACHE_KEY, null);
if (cache) {
  state.data = core.normalizeData(cache.data);
  state.sha = cache.sha ?? null;
  state.dirty = Boolean(cache.dirty);
  state.lastSynced = cache.lastSynced ?? null;
}

const isConfigured = () => Boolean(state.config?.owner && state.config?.repo && state.config?.token);

function persistCache() {
  writeJSON(CACHE_KEY, { data: state.data, sha: state.sha, dirty: state.dirty, lastSynced: state.lastSynced });
}

// Every change goes through commit(): apply it, cache it, re-render, and schedule a save.
function commit(mutate) {
  const result = mutate(state.data);
  state.dirty = true;
  state.version += 1;
  persistCache();
  render();
  scheduleSave();
  return result;
}

// ---------- status and sync ----------

function setStatus(status, message = '') {
  state.status = status;
  state.message = message;
  renderStatus();
  if (status === 'error' && message) toast(message);
}

function renderStatus() {
  const labels = {
    idle: '',
    local: 'On this device only',
    pending: 'Unsaved changes',
    saving: 'Saving…',
    syncing: 'Syncing…',
    synced: 'Synced',
    offline: 'Offline, will sync later',
    error: 'Sync failed, tap to retry',
  };
  statusEl.textContent = labels[state.status] ?? '';
  statusEl.title = state.message;
  statusEl.dataset.state = state.status;
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  if (!isConfigured()) {
    setStatus('local');
    return;
  }
  setStatus('pending');
  state.saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

function flush() {
  clearTimeout(state.saveTimer);
  if (!state.dirty) return Promise.resolve();
  if (!isConfigured()) {
    setStatus('local');
    return Promise.resolve();
  }
  if (!navigator.onLine) {
    setStatus('offline');
    return Promise.resolve();
  }
  if (state.inFlight) return state.inFlight.then(() => (state.dirty ? flush() : undefined));
  state.inFlight = saveNow().finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}

async function saveNow() {
  const version = state.version;
  const snapshot = structuredClone(state.data);
  const cfg = state.config;
  setStatus('saving');
  try {
    let saved;
    try {
      saved = await gh.putFile(cfg, state.sha, snapshot);
    } catch (err) {
      if (err.status !== 409 && err.status !== 422) throw err;
      // The file changed on GitHub since we last read it. Take its current id and save over it.
      const remote = await gh.getFile(cfg);
      saved = await gh.putFile(cfg, remote.sha, snapshot);
    }
    state.sha = saved.sha;
    if (state.version === version) state.dirty = false;
    state.lastSynced = new Date().toISOString();
    persistCache();
    setStatus(state.dirty ? 'pending' : 'synced');
  } catch (err) {
    setStatus(navigator.onLine ? 'error' : 'offline', err.message);
  }
}

// Pending local edits go up. Otherwise the copy on GitHub comes down.
async function pull() {
  if (!state.started || !isConfigured()) return;
  if (state.dirty) return flush();
  if (state.inFlight) return state.inFlight;
  if (!navigator.onLine) {
    setStatus('offline');
    return;
  }
  setStatus('syncing');
  try {
    const remote = await gh.getFile(state.config);
    if (state.dirty) return flush(); // edits were made while we were reading
    if (!remote.data) {
      // No file on GitHub yet, so publish what this device has.
      state.dirty = true;
      state.sha = null;
      persistCache();
      return flush();
    }
    state.sha = remote.sha;
    const incoming = core.normalizeData(remote.data);
    if (JSON.stringify(incoming) !== JSON.stringify(state.data)) {
      state.data = incoming;
      render();
    }
    state.lastSynced = new Date().toISOString();
    persistCache();
    setStatus('synced');
  } catch (err) {
    setStatus(navigator.onLine ? 'error' : 'offline', err.message);
  }
}

// ---------- formatting ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtNum = (v) => String(v);
const fmtValue = (v, unit) => `${core.formatValue(v, unit)}${unit ? ` ${esc(unit)}` : ''}`;
// For big numbers: the unit is smaller and lighter, and the pair never wraps.
const fmtValueHTML = (v, unit) => `${core.formatValue(v, unit)}${unit ? `<small class="unit"> ${esc(unit)}</small>` : ''}`;
const fmtGap = (g) => fmtNum(Number(g.toFixed(4)));

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateShort(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDateTime(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function daysText(left) {
  if (left > 0) return `${left} day${left === 1 ? '' : 's'} to go`;
  if (left === 0) return 'Goal date is today';
  return `${-left} day${left === -1 ? '' : 's'} past goal date`;
}

function targetText(a) {
  if (a.trackOnly) return 'No goal';
  if (a.target == null) return 'Not set yet';
  return fmtValue(a.target, a.unit);
}

function badges(a) {
  const items = [];
  if (a.trackOnly) items.push('📈 Track Only');
  if (a.beaten) items.push('🏆 Personal Best Beaten');
  if (a.reachedGoal) items.push(`🎯 ${core.goalYear(a)} Goal Reached`);
  return items.map((t) => `<span class="badge">${t}</span>`).join('');
}

function progressView(prog, a) {
  const pct = Math.round(prog.fraction * 100);
  return `
    <div class="progress" role="img" aria-label="${pct} percent of the way to your ${core.goalYear(a)} goal"><span style="width:${pct}%"></span></div>
    <p class="sub">${prog.met ? `${core.goalYear(a)} goal reached 🎉` : `${fmtValue(Number(prog.gap.toFixed(4)), a.unit)} to your ${core.goalYear(a)} goal`}</p>`;
}

// Shown when the target is already behind the starting record: usually "lower or higher is better" is the wrong way round.
function directionNotice(a) {
  if (!core.targetBehindRecord(a)) return '';
  const other = a.direction === 'lower' ? 'Higher' : 'Lower';
  return `<p class="warn-note">Your target is already behind your Personal Best, so it isn’t a goal yet. Is ${a.direction === 'lower' ? 'lower' : 'higher'} really better? <button class="link" type="button" data-action="flip-direction" data-id="${a.id}">Switch to ${other} Is Better</button></p>`;
}

function paceView(a) {
  const when = core.projectedDate(a);
  if (!when) return '';
  const year = core.goalYear(a);
  const late = core.yearOf(when) > year;
  const vs = late
    ? ` That is after the end of ${year}.`
    : a.goalDate
      ? when <= a.goalDate ? ' That is ahead of your goal date.' : ' That is behind your goal date.'
      : '';
  return `<p class="trend">At this pace you reach your ${year} goal around ${fmtDate(when)}.${vs}</p>`;
}

// A small trend picture: dots, a dashed trend line, a dotted line at the target, and a dotted vertical line at the goal date.
function sparkline(tr, { target = null, start = null, goalDay = null } = {}) {
  if (tr.points.length < 2) return '';
  const W = 300;
  const H = 70;
  const P = 8;
  const xs = tr.points.map((p) => p.x);
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  if (goalDay !== null && tr.useDays) xMax = Math.max(xMax, goalDay);
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  const ys = tr.points.map((p) => p.y);
  if (target !== null) ys.push(target);
  if (start !== null) ys.push(start);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const sx = (x) => P + ((x - xMin) / (xMax - xMin)) * (W - 2 * P);
  const sy = (y) => P + (1 - (y - yMin) / (yMax - yMin)) * (H - 2 * P);
  const out = [];
  if (start !== null) out.push(`<line class="sp-start" x1="${P}" x2="${W - P}" y1="${sy(start)}" y2="${sy(start)}"/>`);
  if (target !== null) out.push(`<line class="sp-target" x1="${P}" x2="${W - P}" y1="${sy(target)}" y2="${sy(target)}"/>`);
  if (goalDay !== null && tr.useDays) out.push(`<line class="sp-goal" x1="${sx(goalDay)}" x2="${sx(goalDay)}" y1="${P}" y2="${H - P}"/>`);
  if (tr.slope !== null) {
    const dMin = Math.min(...xs);
    const dMax = Math.max(...xs);
    out.push(`<line class="sp-trend" x1="${sx(dMin)}" y1="${sy(tr.intercept + tr.slope * dMin)}" x2="${sx(dMax)}" y2="${sy(tr.intercept + tr.slope * dMax)}"/>`);
  }
  for (const p of tr.points) out.push(`<circle class="sp-dot" cx="${sx(p.x)}" cy="${sy(p.y)}" r="3.5"/>`);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Trend picture">${out.join('')}</svg>`;
}

function trendView(tr) {
  const arrow = tr.slope === null || tr.status === 'flat' ? '→' : tr.slope > 0 ? '↗' : '↘';
  const text = {
    none: 'Log 2 or more attempts to see a trend.',
    flat: `${arrow} Holding steady`,
    'on-track': `${arrow} Heading the right way`,
    'off-track': `${arrow} Drifting the wrong way`,
  }[tr.status];
  return `<p class="trend ${tr.status}">${text}</p>`;
}

// ---------- screens ----------

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function tabsView(active) {
  return `<nav class="tabs" aria-label="Sections">
    <a class="tab${active === 'bests' ? ' active' : ''}" href="#/"${active === 'bests' ? ' aria-current="page"' : ''}>Bests</a>
    <a class="tab${active === 'exercises' ? ' active' : ''}" href="#/exercises"${active === 'exercises' ? ' aria-current="page"' : ''}>Exercises</a>
  </nav>`;
}

const HEAT_WEEKS = 6;

function heatmapView() {
  const weeks = core.heatmapWeeks(core.loggedDates(state.data), HEAT_WEEKS);
  const total = weeks.flat().filter((d) => d.logged).length;
  const dow = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  // Each column is a week, oldest on the left. The label is the Monday of that week.
  const head = `<span></span>${weeks
    .map((days) => `<span class="heat-wk">${new Date(`${days[0].date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`)
    .join('')}`;
  const rows = dow
    .map((letter, i) => {
      const cells = weeks
        .map((days) => {
          const d = days[i];
          const cls = ['heat-cell', d.weekend ? 'we' : '', d.logged ? 'on' : '', d.future ? 'future' : '', d.today ? 'today' : ''].filter(Boolean).join(' ');
          return `<button type="button" class="${cls}" data-action="heat-day" data-date="${d.date}" aria-label="${fmtDate(d.date)}${d.logged ? ', logged' : ''}"></button>`;
        })
        .join('');
      return `<span class="heat-dow${i >= 5 ? ' we' : ''}">${letter}</span>${cells}`;
    })
    .join('');
  return `
    <section class="panel heat" aria-label="Activity heat map">
      <div class="heat-head">
        <h2>Last ${HEAT_WEEKS} Weeks</h2>
        <span class="sub">${total} day${total === 1 ? '' : 's'} logged</span>
      </div>
      <div class="heat-grid" style="grid-template-columns: auto repeat(${HEAT_WEEKS}, minmax(0, 1fr))" aria-label="${total} days logged in the last ${HEAT_WEEKS} weeks">${head}${rows}</div>
      <div class="heat-key"><span><i style="background:var(--accent)"></i>Logged</span><span><i style="background:var(--panel-2)"></i>Nothing</span><span><i style="background:#1f2227"></i>Weekend</span></div>
    </section>`;
}

// ---------- search, sort, archive ----------

const lastDate = (list, key) => list.reduce((m, x) => (x[key] > m ? x[key] : m), '');

// Returns the visible items for a scope ('b' = Bests, 'e' = Exercises) after search and sort.
function finderList(scope, items) {
  const q = (scope === 'b' ? state.bQ : state.eQ).trim().toLowerCase();
  const sort = scope === 'b' ? state.bSort : state.eSort;
  let out = q ? items.filter((x) => `${x.name} ${x.category ?? ''}`.toLowerCase().includes(q)) : [...items];
  if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'recent') {
    const key = (x) => lastDate(scope === 'b' ? x.attempts : x.sessions, 'date');
    out.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  } else if (sort === 'goal' && scope === 'b') {
    const key = (a) => {
      const p = core.progress(a);
      return p ? (p.met ? 1.5 : 1 - p.fraction) : 2;
    };
    out.sort((a, b) => key(a) - key(b));
  }
  return out;
}

function finderHTML(scope, total) {
  if (total < 5) return '';
  const q = scope === 'b' ? state.bQ : state.eQ;
  const sort = scope === 'b' ? state.bSort : state.eSort;
  const opts = [['manual', 'My Order'], ['recent', 'Most Recent'], ['name', 'A–Z'], ...(scope === 'b' ? [['goal', 'Closest To Goal']] : [])];
  return `<div class="finder">
    <input type="search" data-finder="${scope}" placeholder="Search" value="${esc(q)}" autocomplete="off" aria-label="Search">
    <select data-sort="${scope}" aria-label="Sort">${opts.map(([v, l]) => `<option value="${v}"${sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
  </div>`;
}

const canReorder = (scope) => (scope === 'b' ? state.bSort === 'manual' && !state.bQ.trim() : state.eSort === 'manual' && !state.eQ.trim());

// Reorderable tiles and rows carry data-reorder; press and hold, then drag, to move them.
const reorderAttr = (scope) => (canReorder(scope) ? ` data-reorder="${scope}"` : '');

function archivedHTML(scope, archived) {
  if (!archived.length) return '';
  const rows = archived
    .map(
      (x) =>
        `<li><span>${esc(x.name)}</span><button class="link" type="button" data-action="${scope === 'b' ? 'unarchive-activity' : 'unarchive-exercise'}" data-id="${x.id}">Restore</button></li>`,
    )
    .join('');
  return `<section class="archived"><button type="button" class="link" data-action="toggle-archived">${state.showArchived ? 'Hide' : 'Show'} Archived (${archived.length})</button>${state.showArchived ? `<ul>${rows}</ul>` : ''}</section>`;
}

function dashboardView() {
  const today = core.todayISO();
  const notice = isConfigured()
    ? ''
    : `<div class="notice">☁️ Not connected to GitHub yet, so your data stays on this device. <button class="link" data-action="settings">Connect</button></div>`;
  const all = state.data.activities;
  const active = all.filter((a) => !a.archived);
  const archived = all.filter((a) => a.archived);
  const list = active;
  if (!all.length) {
    return `${notice}
      ${tabsView('bests')}
      <section class="welcome">
        <div class="welcome-flame" aria-hidden="true">🔥</div>
        <h1>Let’s Track Your Bests</h1>
        <p class="sub">Three easy steps. You can do them in any order.</p>
        <ol class="steps">
          <li><span class="step-n">1</span><div><strong>Add an Activity</strong><span class="sub">Something you want to get better at, like a 5K run or max bench press.</span></div></li>
          <li><span class="step-n">2</span><div><strong>Log Your Attempts</strong><span class="sub">Each time you try it, log the result. We spot new bests for you.</span></div></li>
          <li><span class="step-n">3</span><div><strong>Set a Goal</strong><span class="sub">Pick a target number to chase. It is optional, and you can change it any time.</span></div></li>
        </ol>
        <button class="btn primary big" data-action="new-activity">＋ Add Your First Activity</button>
      </section>`;
  }
  const reached = list.filter((a) => a.reachedGoal).length;
  const goals = list.filter((a) => !a.trackOnly && a.target != null).length;
  const summary = `${list.length} activit${list.length === 1 ? 'y' : 'ies'}` + (goals ? ` · ${reached} of ${goals} goal${goals === 1 ? '' : 's'} reached` : '');
  const shown = finderList('b', list);
  const hint = list.length > 1 && canReorder('b') ? '<p class="hint">Tip: press and hold a tile, then drag to reorder.</p>' : '';
  return `${notice}
    ${tabsView('bests')}
    <section class="hero">
      <h1>${greeting()} 👋</h1>
      <p class="sub">${summary}</p>
    </section>
    <div class="toolbar"><span class="sub">Your Bests</span>${viewToggle('bests', state.bView)}</div>
    ${finderHTML('b', list.length)}
    ${shown.length || !list.length ? '' : '<p class="sub">Nothing matches your search.</p>'}
    ${
      state.bView === 'list'
        ? `<div class="rows">${shown.map((a) => bestRow(a, today)).join('')}</div>
           <button class="row-add" type="button" data-action="new-activity">＋ New Activity</button>`
        : `<div class="cards">
      ${shown.map((a) => cardView(a, today)).join('')}
      <button class="card-add" type="button" data-action="new-activity">
        <span class="plus">＋</span>
        <strong>New Activity</strong>
        <span class="sub">Something new to track</span>
      </button>
    </div>`
    }
    ${hint}
    ${archivedHTML('b', archived)}`;
}

function goalButtonLabel(a) {
  return a.trackOnly || a.target == null ? '🎯 Set a Goal' : '🎯 Edit Goal';
}

// Personal Best, this year's Best, and this year's Goal side by side.
function recordStats(a, left, withDates = true) {
  const year = core.currentYear();
  const pb = core.personalBest(a);
  const yb = core.yearBest(a, year);
  const target = a.trackOnly ? 'None' : a.target == null ? '—' : fmtValueHTML(a.target, a.unit);
  const cols = [
    `<div><span class="label">Personal Best</span><span class="value">${pb ? fmtValueHTML(pb.value, a.unit) : '—'}</span><span class="sub">${pb ? fmtDate(pb.date) : 'No attempts yet'}</span></div>`,
    `<div><span class="label">${year} Best</span><span class="value">${yb ? fmtValueHTML(yb.value, a.unit) : '—'}</span><span class="sub">${yb ? fmtDate(yb.date) : `Nothing in ${year} yet`}</span></div>`,
    `<div><span class="label">${year} Goal</span><span class="value">${target}</span>${left !== null && withDates ? `<span class="sub">${daysText(left)}</span>` : ''}</div>`,
  ];
  return { html: cols.join(''), three: true };
}

// One line on how you are doing against the Personal Best. Tap it to add or change the Personal Best.
function oldBestLine(a) {
  const tap = `data-action="edit-oldbest" data-id="${a.id}" role="button" tabindex="0"`;
  const ob = core.oldBest(a);
  if (!ob) {
    return a.noOldBest
      ? `<p class="since tap" ${tap}>No Personal Best to beat for now. It is set from your best when ${core.currentYear()} ends. <span class="link">Add one now</span></p>`
      : `<p class="since tap" ${tap}>No Personal Best to beat yet. <span class="link">Add your Personal Best</span></p>`;
  }
  const st = core.oldBestStatus(a);
  const old = fmtValue(ob.value, a.unit);
  const text = st.beaten
    ? `🏆 You beat your Personal Best of ${old}.`
    : st.gap !== null
      ? `${fmtValue(Number(st.gap.toFixed(4)), a.unit)} to beat your Personal Best of ${old}.`
      : `Beat your Personal Best of ${old} with a new attempt.`;
  return `<p class="since tap" ${tap}>${text} <span class="link">Edit</span></p>`;
}

// Short label for the trend of a Best.
function bestPill(tr) {
  const m = { 'on-track': ['up', '↗ On Track'], 'off-track': ['down', '↘ Off Track'], flat: ['flat', '→ Holding'] }[tr.status];
  return m ? `<span class="pill ${m[0]}">${m[1]}</span>` : '<span class="pill muted">No Trend Yet</span>';
}

// One short line: how far to the year goal and to the Personal Best, and days left.
function statusLine(a, prog, left) {
  const parts = [];
  if (prog) parts.push(prog.met ? `${core.goalYear(a)} goal reached 🎉` : `${fmtValue(Number(prog.gap.toFixed(4)), a.unit)} to ${core.goalYear(a)} goal`);
  const st = core.oldBestStatus(a);
  if (st.hasOld) {
    parts.push(st.beaten ? '🏆 Personal Best beaten' : st.gap !== null ? `${fmtValue(Number(st.gap.toFixed(4)), a.unit)} to beat Personal Best` : 'Beat your Personal Best');
  }
  const next = core.milestoneStatus(a).next;
  if (next && !a.trackOnly) parts.push(`Next: ${fmtValue(next.value, a.unit)}`);
  if (left !== null) parts.push(daysText(left));
  return parts.join(' · ');
}

function miniStats(a) {
  const year = core.currentYear();
  const pb = core.personalBest(a);
  const yb = core.yearBest(a, year);
  const target = a.trackOnly ? 'None' : a.target == null ? '—' : fmtValueHTML(a.target, a.unit);
  const cells = [
    `<div><span class="label">Personal Best</span><span class="value">${pb ? fmtValueHTML(pb.value, a.unit) : '—'}</span></div>`,
    `<div><span class="label">${year} Best</span><span class="value">${yb ? fmtValueHTML(yb.value, a.unit) : '—'}</span></div>`,
    `<div><span class="label">${year} Goal</span><span class="value">${target}</span></div>`,
  ];
  return `<div class="mini-stats n${cells.length}">${cells.join('')}</div>`;
}

function cardView(a, today) {
  const prog = core.progress(a);
  const tr = core.trend(a);
  const left = core.goalDaysLeft(a, today);
  const needsGoal = !a.trackOnly && a.target == null;
  const pct = prog ? Math.round(prog.fraction * 100) : 0;
  const spark = sparkline(tr, {
    target: a.trackOnly ? null : a.target,
    start: core.oldBest(a)?.value ?? null,
    goalDay: a.goalDate && !a.trackOnly ? core.dayNumber(a.goalDate) : null,
  });
  const line = needsGoal ? '' : statusLine(a, prog, left);
  return `
    <article class="card compact${a.reachedGoal ? ' reached' : ''}" data-action="open" data-id="${a.id}"${reorderAttr('b')}>
      <div class="card-body">
        <div class="card-head">
          <h2>${esc(a.name)}</h2>
          <div class="badges">${badges(a)}</div>
          <button class="btn primary small" type="button" data-action="log" data-id="${a.id}">＋ Log</button>
        </div>
        ${miniStats(a)}
        ${prog ? `<div class="progress thin" role="img" aria-label="${pct} percent of the way to target"><span style="width:${pct}%"></span></div>` : ''}
        ${line ? `<p class="sub tight">${line}</p>` : ''}
        ${needsGoal ? '<p class="sub tight">No goal yet. <button class="link" type="button" data-action="set-goal" data-id="' + a.id + '">Set a Goal</button></p>' : ''}
        ${!core.oldBest(a) && !a.trackOnly ? '<p class="sub tight">' + (a.noOldBest ? 'No Personal Best to beat for now.' : 'No Personal Best to beat yet.') + ' <button class="link" type="button" data-action="edit-oldbest" data-id="' + a.id + '">Add Personal Best</button></p>' : ''}
        ${directionNotice(a)}
        <div class="card-trend">${spark}${bestPill(tr)}</div>
      </div>
    </article>`;
}

function bestRow(a, today) {
  const prog = core.progress(a);
  const tr = core.trend(a);
  const pb = core.personalBest(a);
  const yb = core.yearBest(a);
  const pct = prog ? Math.round(prog.fraction * 100) : 0;
  const sub = [pb ? `Personal ${fmtValue(pb.value, a.unit)}` : '', yb ? `${core.currentYear()} ${fmtValue(yb.value, a.unit)}` : `No ${core.currentYear()} attempts`].filter(Boolean).join(' · ');
  return `
    <article class="row-card" data-action="open" data-id="${a.id}"${reorderAttr('b')}>
      <div class="row-main">
        <strong>${esc(a.name)}</strong>
        <span class="sub">${sub}</span>
        ${prog ? `<div class="progress thin"><span style="width:${pct}%"></span></div>` : ''}
      </div>
      <div class="row-side">
        <span class="row-top">${a.trackOnly ? 'Track only' : a.target == null ? 'No goal' : `🎯 ${fmtValue(a.target, a.unit)}`}</span>
        ${bestPill(tr)}
      </div>
      <button class="btn primary small plus" type="button" data-action="log" data-id="${a.id}" aria-label="Log attempt for ${esc(a.name)}">＋</button>
    </article>`;
}

function detailView(a) {
  const today = core.todayISO();
  const best = core.currentBest(a);
  const prog = core.progress(a);
  const tr = core.trend(a);
  const left = core.goalDaysLeft(a, today);
  const allHistory = core.sortAttempts(a.attempts).reverse();
  const usedTags = [...new Set(allHistory.flatMap((t) => t.tags ?? []))];
  if (state.tagFilter && !usedTags.includes(state.tagFilter)) state.tagFilter = '';
  const history = state.tagFilter ? allHistory.filter((t) => (t.tags ?? []).includes(state.tagFilter)) : allHistory;
  const insight = core.tagInsight(a);
  const ms = core.milestoneStatus(a);
  const oldId = core.oldBest(a)?.attemptId;
  const pbId = core.personalBest(a)?.attemptId;
  const year = core.currentYear();
  const ybId = core.yearBest(a, year)?.attemptId;
  const range = state.chartRange === 'all' ? 'all' : 'year';
  const chartTr = range === 'year' ? core.trend(a, { year }) : tr;
  const past = core.pastYears(a, today);

  const rows = history
    .map(
      (t) => `
      <li class="attempt${t.id === pbId || t.id === ybId ? ' is-best' : ''}">
        <div class="attempt-main">
          <strong>${fmtValue(t.result, a.unit)}</strong>
          <span class="sub">${fmtDate(t.date)}</span>
          ${t.id === pbId ? '<span class="badge">Personal Best</span>' : ''}${t.id === ybId ? `<span class="badge">${year} Best</span>` : ''}${t.id === oldId && t.id !== pbId ? '<span class="badge">Starting Personal Best</span>' : ''}${core.isNewAttempt(t) ? '' : '<span class="sub">(before 11/15/2026)</span>'}
        </div>
        ${t.notes ? `<p class="notes">${esc(t.notes)}</p>` : ''}
        ${tagChipsHTML(t.tags)}
        <div class="row-actions">
          <button class="link" data-action="edit-attempt" data-id="${a.id}" data-attempt="${t.id}">Edit</button>
          <button class="link danger" data-action="delete-attempt" data-id="${a.id}" data-attempt="${t.id}">Delete</button>
        </div>
      </li>`,
    )
    .join('');

  return `
    <nav class="crumbs"><a href="#/">← All Activities</a></nav>
    <header class="detail-head">
      <div>
        <h1>${esc(a.name)}</h1>
        <p class="sub">${a.direction === 'lower' ? 'Lower is better' : 'Higher is better'}${a.unit ? ` · ${esc(a.unit)}` : ''}</p>
        <div class="badges">${badges(a)}</div>
      </div>
      <div class="row-actions">
        <button class="btn" data-action="edit-activity" data-id="${a.id}">✏️ Edit Activity</button>
        <button class="btn" data-action="archive-activity" data-id="${a.id}">Archive</button>
        <button class="btn danger" data-action="delete-activity" data-id="${a.id}">Delete</button>
      </div>
    </header>

    <section class="stats big${recordStats(a, left).three ? ' three' : ''}">${recordStats(a, left).html.replace(/<span class="sub">(\d+ days? to go|Goal date is today|\d+ days? past goal date)<\/span>/, `<span class="sub">$1 · ${a.goalDate ? fmtDate(a.goalDate) : ''}</span>`)}</section>
    ${oldBestLine(a)}
    ${directionNotice(a)}
    ${prog ? progressView(prog, a) : ''}
    ${trendView(tr)}
    ${paceView(a)}

    <section class="panel goal-panel">
      <div class="panel-head">
        <h2>🎯 ${year} Goal</h2>
        <button class="btn small" data-action="set-goal" data-id="${a.id}">${goalButtonLabel(a).replace('🎯 ', '')}</button>
      </div>
      <p class="sub">${
        a.trackOnly
          ? 'This activity is track only, so there is no goal. Set a goal any time to start chasing one.'
          : a.target == null
            ? `No ${year} goal yet. Pick a target to beat this year and see your progress toward it.`
            : `Working toward ${fmtValue(a.target, a.unit)} in ${year}${a.goalDate ? `, by ${fmtDate(a.goalDate)}` : ''}. You can change it any time.`
      }</p>
    </section>

    ${
      past.length
        ? `<section class="panel"><h2>📅 Past Years</h2>
      <ul class="year-list">${past
        .map(
          (y) =>
            `<li><strong>${y.year}</strong><span>${y.best ? fmtValue(y.best.value, a.unit) : '—'}</span><span class="sub">${y.goal ? `Goal ${fmtValue(y.goal.target, a.unit)} · ${y.goal.reached ? 'reached 🎯' : 'not reached'}` : 'No goal'}</span></li>`,
        )
        .join('')}</ul></section>`
        : ''
    }

    ${
      ms.rows.length
        ? `<section class="panel"><h2>⭐ Milestones</h2>
      <p class="sub">${ms.next ? `Next up: ${fmtValue(ms.next.value, a.unit)}` : 'All milestones reached. Nice work.'}</p>
      <div class="ms-row">${ms.rows.map((r) => `<span class="ms${r.reached ? ' done' : r === ms.next ? ' next' : ''}">${r.reached ? '✓ ' : ''}${fmtValue(r.value, a.unit)}</span>`).join('')}</div></section>`
        : ''
    }

    <section class="panel">
      <h2>＋ Log an Attempt</h2>
      <form class="attempt-form" data-form="attempt-new" data-id="${a.id}">
        <label>Result${a.unit ? ` (${esc(a.unit)})` : ''}${valueInputHTML('result', a.unit, '', true)}${core.isTimeUnit(a.unit) ? `<small>${esc(core.timeHelp(a.unit))}</small>` : ''}</label>
        <label>Date<input type="date" name="date" required value="${today}"></label>
        <label>Notes<textarea name="notes" rows="2" placeholder="Optional"></textarea></label>
        <details class="wide tags-details"><summary>Add Tags</summary>${tagsFieldHTML([])}</details>
        <button class="btn primary wide" type="submit">Log Attempt</button>
      </form>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>📈 Trend</h2>
        <div class="chips"><button type="button" class="chip${range === 'year' ? ' active' : ''}" data-action="chart-range" data-range="year">This Year</button><button type="button" class="chip${range === 'all' ? ' active' : ''}" data-action="chart-range" data-range="all">All Time</button></div>
      </div>
      ${range === 'year' && a.goalDate && !a.trackOnly ? '<p class="sub">The dotted vertical line is your goal date.</p>' : ''}
      ${chartView(a, chartTr, range)}
    </section>

    <section class="panel">
      <h2>🕘 History</h2>
      ${insight ? `<p class="sub">Your results are best on average when tagged <strong>${esc(insight.tag)}</strong>.</p>` : ''}
      ${
        usedTags.length
          ? `<div class="chips tag-filter"><button type="button" class="chip${state.tagFilter === '' ? ' active' : ''}" data-action="tag-filter" data-tag="">All</button>${usedTags
              .map((t) => `<button type="button" class="chip${state.tagFilter === t ? ' active' : ''}" data-action="tag-filter" data-tag="${esc(t)}">${esc(t)}</button>`)
              .join('')}</div>`
          : ''
      }
      ${history.length ? `<ul class="attempts">${rows}</ul>` : allHistory.length ? '<p class="sub">No attempts with that tag.</p>' : '<p class="sub">No attempts yet. Log your first one above.</p>'}
      ${a.startBest ? `<p class="sub start-line">Personal Best entered: ${fmtValue(a.startBest.value, a.unit)} on ${fmtDate(a.startBest.date)}</p>` : ''}
    </section>`;
}

// ---------- exercises ----------

const fmtWeight = (w, unit) => (w > 0 ? `${fmtNum(w)} ${unit}` : 'bodyweight');

// "3×8 @ 135 lb, 1×6 @ 135 lb": runs of identical sets are grouped.
function setsText(sets, unit, assisted = false) {
  const groups = [];
  for (const s of sets) {
    const last = groups[groups.length - 1];
    if (last && last.reps === s.reps && last.weight === s.weight) last.n += 1;
    else groups.push({ n: 1, reps: s.reps, weight: s.weight });
  }
  return groups.map((g) => `${g.n}×${fmtNum(g.reps)}${g.weight > 0 ? ` @ ${fmtNum(g.weight)} ${esc(unit)}${assisted ? ' assist' : ''}` : ''}`).join(', ');
}

function topSetText(st, unit, assisted = false) {
  return st.topWeight > 0 ? `${fmtNum(st.topWeight)} ${esc(unit)}${assisted ? ' assist' : ''} × ${fmtNum(st.topReps)}` : `${fmtNum(st.topReps)} reps`;
}

const ICON_TILE = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="currentColor"><rect x="2" y="2" width="7" height="7" rx="1.8"/><rect x="11" y="2" width="7" height="7" rx="1.8"/><rect x="2" y="11" width="7" height="7" rx="1.8"/><rect x="11" y="11" width="7" height="7" rx="1.8"/></svg>';
const ICON_LIST = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="currentColor"><rect x="2" y="3" width="16" height="3.4" rx="1.7"/><rect x="2" y="8.3" width="16" height="3.4" rx="1.7"/><rect x="2" y="13.6" width="16" height="3.4" rx="1.7"/></svg>';

function viewToggle(scope, current) {
  const btn = (mode, label, icon) =>
    `<button type="button" class="${current === mode ? 'active' : ''}" data-action="set-view" data-scope="${scope}" data-mode="${mode}" aria-label="${label}" aria-pressed="${current === mode}">${icon}</button>`;
  return `<div class="view-toggle" role="group" aria-label="Layout">${btn('tile', 'Tile view', ICON_TILE)}${btn('list', 'List view', ICON_LIST)}</div>`;
}

function topSetHTML(st, unit, assisted = false) {
  return st.topWeight > 0
    ? `${fmtNum(st.topWeight)}<small class="unit"> ${esc(unit)}${assisted ? ' assist' : ''}</small> × ${fmtNum(st.topReps)}`
    : `${fmtNum(st.topReps)}<small class="unit"> reps</small>`;
}

// One short badge that says whether you are progressing, counting both weight and reps.
function trendPill(tr) {
  if (tr.level === 'none') return `<span class="pill muted">${tr.count < 2 ? 'Needs 2 Sessions' : 'No Trend Yet'}</span>`;
  const [arrow, label] = { up: ['↗', 'Progressing'], flat: ['→', 'Holding'], down: ['↘', 'Slipping'] }[tr.level];
  const pct = Math.abs(tr.pct) < 0.05 ? '' : ` ${tr.pct > 0 ? '+' : '−'}${Math.abs(tr.pct).toFixed(1)}%`;
  return `<span class="pill ${tr.level}">${arrow} ${label}${pct}</span>`;
}

function exerciseTile(e) {
  const last = core.lastSession(e);
  const tr = core.exerciseTrend(e);
  return `
    <article class="card plain" data-action="open-exercise" data-id="${e.id}"${reorderAttr('e')}>
      <div class="card-body">
        <div class="card-head">
          <h2>${esc(e.name)}</h2>
          ${e.category ? `<span class="chip static">${esc(e.category)}</span>` : ''}
        </div>
        ${
          last
            ? `<div class="ex-main"><span class="value">${topSetHTML(core.sessionStats(last, e.assisted), e.unit, e.assisted)}</span><span class="sub">${fmtDate(last.date)} · ${e.sessions.length} session${e.sessions.length === 1 ? '' : 's'}</span></div>`
            : '<p class="sub">No sessions yet.</p>'
        }
        <div class="ex-trend">${trendPill(tr)}</div>
        ${sparkline(tr)}
        <div class="card-actions">
          <button class="btn primary small" type="button" data-action="log-session" data-id="${e.id}">＋ Log Session</button>
        </div>
      </div>
    </article>`;
}

function exerciseRow(e) {
  const last = core.lastSession(e);
  const tr = core.exerciseTrend(e);
  return `
    <article class="row-card" data-action="open-exercise" data-id="${e.id}"${reorderAttr('e')}>
      <div class="row-main">
        <strong>${esc(e.name)}</strong>
        <span class="sub">${[e.category, last ? fmtDateShort(last.date) : 'No sessions'].filter(Boolean).map(esc).join(' · ')}</span>
      </div>
      <div class="row-side">
        <span class="row-top">${last ? topSetHTML(core.sessionStats(last, e.assisted), e.unit, e.assisted) : '—'}</span>
        ${trendPill(tr)}
      </div>
      <button class="btn primary small plus" type="button" data-action="log-session" data-id="${e.id}" aria-label="Log session for ${esc(e.name)}">＋</button>
    </article>`;
}

function exercisesView() {
  const allEx = state.data.exercises;
  const list = allEx.filter((e) => !e.archived);
  const archivedEx = allEx.filter((e) => e.archived);
  const tabs = tabsView('exercises');
  if (!allEx.length) {
    return `${tabs}
      <section class="welcome">
        <h1>Track the Exercises You Like</h1>
        <p class="sub">Add an exercise, then log sets, reps, and weight whenever you do it. You will see whether you are lifting more over time.</p>
        <p class="sub">For example: Incline Smith Bench, Flat Dumbbell Bench, Pull-Ups.</p>
        <p><button class="btn primary big" data-action="new-exercise">＋ Add Your First Exercise</button></p>
      </section>`;
  }

  const cats = state.data.categories.filter((c) => list.some((e) => e.category === c));
  const hasNone = list.some((e) => !e.category);
  const filters = [['', 'All'], ...cats.map((c) => [c, c])];
  if (hasNone && cats.length) filters.push(['__none__', 'Other']);
  if (!filters.some(([v]) => v === state.exFilter)) state.exFilter = '';
  const shown = finderList('e', list.filter((e) => !state.exFilter || (state.exFilter === '__none__' ? !e.category : e.category === state.exFilter)));

  const chips = cats.length
    ? `<div class="chips" role="group" aria-label="Filter by category">${filters
        .map(([v, l]) => `<button type="button" class="chip${state.exFilter === v ? ' active' : ''}" data-action="filter" data-cat="${esc(v)}">${esc(l)}</button>`)
        .join('')}</div>`
    : '<span></span>';
  const toggle = viewToggle('exercises', state.exView);

  const body =
    state.exView === 'list'
      ? `<div class="rows">${shown.map(exerciseRow).join('')}</div>
         <button class="row-add" type="button" data-action="new-exercise">＋ New Exercise</button>`
      : `<div class="cards">${shown.map(exerciseTile).join('')}
          <button class="card-add" type="button" data-action="new-exercise">
            <span class="plus">＋</span><strong>New Exercise</strong><span class="sub">Something else to track</span>
          </button></div>`;

  return `${tabs}
    ${heatmapView()}
    <div class="toolbar">${chips}${toggle}</div>
    ${finderHTML('e', list.length)}
    ${body}
    ${archivedHTML('e', archivedEx)}
    <p class="hint"><button class="link" type="button" data-action="manage-categories">Manage Categories</button></p>`;
}

function exerciseDetailView(e) {
  const history = core.sortSessions(e.sessions).reverse();
  const best = core.bestSession(e);
  const last = history[0];
  const tr = core.exerciseTrend(e);
  const verdict =
    tr.level === 'none'
      ? 'Log one more session to see your trend.'
      : tr.level === 'flat'
        ? `Holding steady across ${tr.count} sessions.`
        : tr.lowerBetter
          ? `Effective assistance ${tr.level === 'up' ? 'down' : 'up'} ${Math.abs(tr.pct).toFixed(1)}% across ${tr.count} sessions.`
          : `Estimated max ${tr.level === 'up' ? 'up' : 'down'} ${Math.abs(tr.pct).toFixed(1)}% across ${tr.count} sessions.`;

  const rows = history
    .map(
      (s) => `
      <li class="attempt${best && s.id === best.session.id ? ' is-best' : ''}">
        <div class="attempt-main">
          <strong class="session-sets">${setsText(s.sets, e.unit, e.assisted)}</strong>
          <span class="sub">${fmtDate(s.date)}</span>
          ${best && s.id === best.session.id ? '<span class="badge">Best Top Set</span>' : ''}
        </div>
        ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
        ${tagChipsHTML(s.tags)}
        <div class="row-actions">
          <button class="link" data-action="edit-session" data-id="${e.id}" data-session="${s.id}">Edit</button>
          <button class="link danger" data-action="delete-session" data-id="${e.id}" data-session="${s.id}">Delete</button>
        </div>
      </li>`,
    )
    .join('');

  return `
    <nav class="crumbs"><a href="#/exercises">← Exercises</a></nav>
    <header class="detail-head">
      <div>
        <h1>${esc(e.name)}</h1>
        <p class="sub">${e.category ? `${esc(e.category)} · ` : ''}Weights in ${esc(e.unit)}${e.assisted ? ' · Assisted (less weight is better)' : ''}</p>
        ${e.notes ? `<p class="ex-notes sub">${esc(e.notes)}</p>` : ''}
      </div>
      <div class="row-actions">
        <button class="btn" data-action="edit-exercise" data-id="${e.id}">Edit Exercise</button>
        <button class="btn" data-action="archive-exercise" data-id="${e.id}">Archive</button>
        <button class="btn danger" data-action="delete-exercise" data-id="${e.id}">Delete</button>
      </div>
    </header>

    <section class="stats big">
      <div>
        <span class="label">Last Session</span>
        <span class="value">${last ? topSetHTML(core.sessionStats(last, e.assisted), e.unit, e.assisted) : '—'}</span>
        ${last ? `<span class="sub">${fmtDate(last.date)}</span>` : ''}
      </div>
      <div>
        <span class="label">Best Top Set</span>
        <span class="value">${best ? topSetHTML(best.stats, e.unit, e.assisted) : '—'}</span>
        ${best ? `<span class="sub">${fmtDate(best.session.date)}</span>` : ''}
      </div>
    </section>
    <p class="ex-trend">${trendPill(tr)} <span class="sub">${verdict}</span></p>
    <p><button class="btn primary big" data-action="log-session" data-id="${e.id}">＋ Log Session</button></p>

    <section class="panel">
      <h2>Strength Trend</h2>
      <p class="sub">${tr.lowerBetter ? 'Assistance and reps combine into one number where lower is better, so less assistance or more reps both count as progress.' : 'Weight and reps combine into one estimated-max number, so more weight or more reps both count as progress.'}</p>
      ${chartView({ unit: tr.weighted ? e.unit : 'reps', direction: tr.lowerBetter ? 'lower' : 'higher', target: null, startBest: null, attempts: [], trackOnly: true }, tr)}
    </section>

    <section class="panel">
      <h2>History</h2>
      ${history.length ? `<ul class="attempts">${rows}</ul>` : '<p class="sub">No sessions yet. Tap “Log Session” to add your first.</p>'}
    </section>`;
}

function chartView(a, tr, range = 'all') {
  if (!tr.points.length) return `<p class="sub">${range === 'year' ? `No attempts in ${core.currentYear()} yet. Log one to see the trend.` : 'Log a new attempt to see the trend.'}</p>`;
  const showGoal = range === 'year' && a.target != null && !a.trackOnly;

  const W = 640;
  const H = 300;
  const L = core.isTimeUnit(a.unit) ? 96 : 70;
  const R = 30;
  const T = 34;
  const B = 52;

  const xs = tr.points.map((p) => p.x);
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  const goalX = showGoal && a.goalDate && tr.useDays ? core.dayNumber(a.goalDate) : null;
  if (goalX !== null) xMax = Math.max(xMax, goalX);
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }

  const ys = tr.points.map((p) => p.y);
  if (showGoal) ys.push(a.target);
  const oldRef = a.id ? core.oldBest(a) : null;
  if (oldRef) ys.push(oldRef.value);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  const pad = (yMax - yMin) * 0.12 || Math.max(Math.abs(yMax), 1) * 0.1;
  yMin -= pad;
  yMax += pad;

  const sx = (x) => L + ((x - xMin) / (xMax - xMin)) * (W - L - R);
  const sy = (y) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
  const out = [];

  for (let i = 0; i <= 3; i++) {
    const v = yMin + ((yMax - yMin) * i) / 3;
    out.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>`);
    out.push(`<text class="axis" x="${L - 10}" y="${sy(v) + 6}" text-anchor="end">${core.isTimeUnit(a.unit) ? core.formatValue(core.roundToSecond(v, a.unit), a.unit) : fmtNum(Number(v.toFixed(2)))}</text>`);
  }

  const refLine = (value, cls, label) =>
    `<line class="${cls}" x1="${L}" x2="${W - R}" y1="${sy(value)}" y2="${sy(value)}"/>` +
    `<text class="ref" x="${L + 6}" y="${sy(value) - 8}" text-anchor="start">${label} ${core.formatValue(value, a.unit)}</text>`;
  if (showGoal) out.push(refLine(a.target, 'target', `${core.goalYear(a)} Goal`));
  if (oldRef) out.push(refLine(oldRef.value, 'start', 'Personal Best'));

  if (goalX !== null) {
    out.push(`<line class="goalline" x1="${sx(goalX)}" x2="${sx(goalX)}" y1="${T - 6}" y2="${H - B}"/>`);
    out.push(`<text class="ref" x="${sx(goalX)}" y="${T - 12}" text-anchor="end">Goal date</text>`);
  }

  if (tr.slope !== null) {
    const dMin = Math.min(...xs);
    const dMax = Math.max(...xs);
    out.push(`<line class="trendline" x1="${sx(dMin)}" y1="${sy(tr.intercept + tr.slope * dMin)}" x2="${sx(dMax)}" y2="${sy(tr.intercept + tr.slope * dMax)}"/>`);
  }

  for (const p of tr.points) {
    out.push(
      `<circle class="dot" cx="${sx(p.x)}" cy="${sy(p.y)}" r="6"><title>${fmtDate(p.date)}: ${fmtValue(p.y, a.unit)}</title></circle>`,
    );
  }

  const first = tr.points[0];
  const last = tr.points[tr.points.length - 1];
  out.push(`<text class="axis" x="${L}" y="${H - 14}" text-anchor="start">${fmtDate(first.date)}</text>`);
  if (goalX !== null) out.push(`<text class="axis" x="${W - R}" y="${H - 14}" text-anchor="end">${fmtDate(a.goalDate)}</text>`);
  else if (last.date !== first.date) out.push(`<text class="axis" x="${W - R}" y="${H - 14}" text-anchor="end">${fmtDate(last.date)}</text>`);

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Attempt trend chart">${out.join('')}</svg>`;
}

function ideasView() {
  const list = core.sortedIdeas(state.data.ideas);
  const count = list.length;
  const form = `
    <form class="idea-form" data-form="idea-new">
      <label class="sr-only" for="idea-text">New idea</label>
      <textarea id="idea-text" name="text" rows="3" placeholder="Write an idea…"></textarea>
      <button class="btn primary" type="submit">Add Idea</button>
    </form>`;
  const tools = count
    ? `<div class="idea-tools">
         <span class="sub">${count} idea${count === 1 ? '' : 's'}, newest first</span>
         <span class="grow"></span>
         <button class="btn" data-action="copy-ideas">Copy All</button>
         <button class="btn danger" data-action="delete-all-ideas">Delete All</button>
       </div>`
    : '';
  const items = list
    .map(
      (i) => `
      <li class="idea">
        <div class="idea-text">${esc(i.text)}</div>
        <div class="idea-meta">
          <span class="sub">${fmtDateTime(i.createdAt)}</span>
          <button class="link danger" data-action="delete-idea" data-id="${i.id}">Delete</button>
        </div>
      </li>`,
    )
    .join('');
  return `
    <nav class="crumbs"><a href="#/">← All Activities</a></nav>
    <h1>💡 Ideas</h1>
    <p class="sub">Write ideas as they come. Copy them all when you want to take them back to Claude.</p>
    ${form}
    ${tools}
    ${count ? `<ul class="ideas">${items}</ul>` : '<p class="empty-note">No ideas yet.</p>'}`;
}

function versionsView() {
  const items = VERSIONS.map(
    (v, i) => `
      <details class="version"${i === 0 ? ' open' : ''}>
        <summary>
          <span class="version-title"><span class="badge">${esc(v.number)}</span><strong>${esc(v.title)}</strong></span>
          <span class="version-date">${fmtDate(v.date)}</span>
        </summary>
        <ul>${v.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      </details>`,
  ).join('');
  return `
    <nav class="crumbs"><a href="#/">← All Activities</a></nav>
    <h1>Version History</h1>
    <p class="sub">Every version of the app, newest first.</p>
    <div class="versions">${items}</div>`;
}

function recordsView() {
  const log = core.recordsLog(state.data);
  const items = log
    .map((r) => {
      const link = r.kind === 'best' ? `#/activity/${r.id}` : `#/exercise/${r.id}`;
      const what = r.kind === 'best' ? fmtValue(r.value, r.unit) : topSetText(r.stats, r.unit, r.assisted);
      return `<li class="rec"><span class="rec-dot" aria-hidden="true"></span>
        <div><a href="${link}"><strong>${esc(r.name)}</strong></a> <span class="rec-val">${what}</span>
        <div class="sub">${fmtDate(r.date)}</div>
        <div class="tag-row">${r.badges.map((b) => `<span class="tag hot">${esc(b)}</span>`).join('')}</div></div></li>`;
    })
    .join('');
  return `<nav class="crumbs"><a href="#/">← All Activities</a></nav>
    <h1>Records</h1>
    <p class="sub">Every Personal Best beaten, year goal reached, and new bests, newest first.</p>
    ${log.length ? `<ul class="records">${items}</ul>` : '<p class="sub">No records yet. Your first new best will show up here.</p>'}`;
}

// ---------- weekly summary ----------

const WEEKLY_KEY = 'pbt.weeklyShown';

function weekBlock(title, w, prev) {
  const delta = prev ? w.days - prev.days : null;
  const dtxt = delta === null || delta === 0 ? '' : ` <span class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}</span>`;
  const recs = w.records.length
    ? `<ul class="wk-records">${w.records.slice(0, 5).map((r) => `<li>🔥 ${esc(r.name)} · ${esc(r.badges[0])}</li>`).join('')}</ul>`
    : '';
  return `<section class="wk"><h3>${title}</h3>
    <div class="wk-stats">
      <div><strong>${w.days}</strong><span>Days Logged${dtxt}</span></div>
      <div><strong>${w.attempts}</strong><span>Attempts</span></div>
      <div><strong>${w.sessions}</strong><span>Sessions</span></div>
      <div><strong>${w.records.length}</strong><span>Records</span></div>
    </div>${recs}</section>`;
}

function showWeekly() {
  const mon = core.mondayOf(core.todayISO());
  const last = core.weekSummary(state.data, core.addDaysISO(mon, -7));
  const before = core.weekSummary(state.data, core.addDaysISO(mon, -14));
  const now = core.weekSummary(state.data, mon);
  weeklyEl.innerHTML = `<div class="wn">
      <button class="btn ghost wk-close" type="button" data-wk-close aria-label="Close">✕</button>
      <h2>Weekly Summary</h2>
      ${weekBlock('Last Week', last, before)}
      ${weekBlock('This Week So Far', now, last)}
      <div class="dlg-actions"><span class="grow"></span><button class="btn primary" type="button" data-wk-close>Got It</button></div>
    </div>`;
  if (!weeklyEl.open) weeklyEl.showModal();
  weeklyEl.scrollTop = 0;
}

function showDay(date) {
  const atts = [];
  for (const a of state.data.activities) for (const t of a.attempts) if (t.date === date) atts.push({ a, t });
  const sess = [];
  for (const e of state.data.exercises) for (const x of e.sessions) if (x.date === date) sess.push({ e, x });
  const recs = core.recordsLog(state.data).filter((r) => r.date === date);
  const attHTML = atts
    .map(({ a, t }) => `<li><a href="#/activity/${a.id}" data-wk-close><strong>${esc(a.name)}</strong></a> ${fmtValue(t.result, a.unit)}${t.notes ? `<div class="sub">${esc(t.notes)}</div>` : ''}${tagChipsHTML(t.tags)}</li>`)
    .join('');
  const sesHTML = sess
    .map(({ e, x }) => {
      const st = core.sessionStats(x, e.assisted);
      return `<li><a href="#/exercise/${e.id}" data-wk-close><strong>${esc(e.name)}</strong></a> ${setsText(x.sets, e.unit, e.assisted)}<div class="sub">${x.sets.length} set${x.sets.length === 1 ? '' : 's'}${st.volume ? ` · ${fmtNum(st.volume)} ${esc(e.unit)} total volume` : ''}</div>${x.notes ? `<div class="sub">${esc(x.notes)}</div>` : ''}${tagChipsHTML(x.tags)}</li>`;
    })
    .join('');
  const empty = !atts.length && !sess.length;
  weeklyEl.innerHTML = `<div class="wn">
    <button class="btn ghost wk-close" type="button" data-wk-close aria-label="Close">✕</button>
    <h2>${fmtDate(date)}</h2>
    ${empty ? '<p class="sub">Nothing logged this day.</p>' : ''}
    ${atts.length ? `<section class="wk"><h3>Bests</h3><ul class="day-list">${attHTML}</ul></section>` : ''}
    ${sess.length ? `<section class="wk"><h3>Exercises</h3><ul class="day-list">${sesHTML}</ul></section>` : ''}
    ${recs.length ? `<p class="sub">🔥 ${recs.map((r) => `${esc(r.name)} · ${esc(r.badges[0])}`).join(', ')}</p>` : ''}
  </div>`;
  if (!weeklyEl.open) weeklyEl.showModal();
}

function checkWeekly() {
  if (whatsNewEl.open || new Date().getDay() !== 1) return;
  const today = core.todayISO();
  try {
    if (localStorage.getItem(WEEKLY_KEY) === today) return;
    localStorage.setItem(WEEKLY_KEY, today);
  } catch {
    /* storage unavailable */
  }
  showWeekly();
}

// ---------- routing and rendering ----------

function parseRoute() {
  const hash = location.hash;
  const detail = hash.match(/^#\/activity\/([\w-]+)$/);
  if (detail) return { name: 'detail', id: detail[1] };
  const exDetail = hash.match(/^#\/exercise\/([\w-]+)$/);
  if (exDetail) return { name: 'exercise', id: exDetail[1] };
  if (hash === '#/exercises') return { name: 'exercises' };
  if (hash === '#/records') return { name: 'records' };
  if (hash === '#/ideas') return { name: 'ideas' };
  if (hash === '#/versions') return { name: 'versions' };
  return { name: 'dashboard' };
}

function render() {
  if (!state.started) return;
  const route = parseRoute();
  let html;
  let title = 'Personal Bests';

  if (route.name === 'detail') {
    const a = core.findActivity(state.data, route.id);
    if (!a) {
      location.hash = '#/';
      return;
    }
    html = detailView(a);
    title = `${a.name} · Personal Bests`;
  } else if (route.name === 'exercise') {
    const e = core.findExercise(state.data, route.id);
    if (!e) {
      location.hash = '#/exercises';
      return;
    }
    html = exerciseDetailView(e);
    title = `${e.name} · Personal Bests`;
  } else if (route.name === 'exercises') {
    html = exercisesView();
    title = 'Exercises · Personal Bests';
  } else if (route.name === 'records') {
    html = recordsView();
    title = 'Records · Personal Bests';
  } else if (route.name === 'ideas') {
    html = ideasView();
    title = 'Ideas · Personal Bests';
  } else if (route.name === 'versions') {
    html = versionsView();
    title = 'Version History · Personal Bests';
  } else {
    html = dashboardView();
  }

  view.innerHTML = html;
  document.title = title;
  if (route.name === 'exercises') {
    addBtn.textContent = '＋';
    addBtn.setAttribute('aria-label', 'New Exercise');
    addBtn.hidden = !state.data.exercises.length;
  } else {
    addBtn.textContent = '＋';
    addBtn.setAttribute('aria-label', 'New Activity');
    addBtn.hidden = route.name !== 'dashboard' || !state.data.activities.length;
  }
}

// ---------- dialogs ----------

function fieldHTML(f) {
  const html = fieldInner(f);
  return f.when ? `<div class="when" data-when="${f.when}">${html}</div>` : html;
}

function setRowHTML(n, set = {}) {
  return `<div class="set-row">
    <span class="set-n">${n}</span>
    <input type="number" name="weight" step="any" min="0" inputmode="decimal" placeholder="0" aria-label="Weight for set ${n}" value="${esc(set.weight || '')}">
    <input type="number" name="reps" step="1" min="1" inputmode="numeric" placeholder="reps" aria-label="Reps for set ${n}" value="${esc(set.reps ?? '')}">
    <button type="button" class="link danger" data-remove-set aria-label="Remove set ${n}">✕</button>
  </div>`;
}

const valuePlaceholder = (unit) => ({ hr: 'h:mm:ss', min: 'm:ss', sec: '12.89 or m:ss' })[core.normalizeUnit(unit)] ?? '';

// A text box for a result. Times (minutes, hours) can be typed like 6:36 or 2:34:36, and decimals work too.
function valueInputHTML(name, unit, value = '', required = false) {
  const time = core.isTimeUnit(unit);
  return `<input type="text" name="${name}" data-value-input ${required ? 'required' : ''} inputmode="${time ? 'text' : 'decimal'}" autocomplete="off" autocapitalize="off" placeholder="${esc(valuePlaceholder(unit))}" value="${esc(value)}">`;
}

// Keeps value boxes in step with the unit drop-down (full keyboard for times, number pad otherwise).
function applyUnitHints(form) {
  const unit = form.querySelector('select[name=unit]')?.value ?? '';
  const time = core.isTimeUnit(unit);
  form.querySelectorAll('[data-value-input]').forEach((el) => {
    el.inputMode = time ? 'text' : 'decimal';
    el.placeholder = valuePlaceholder(unit);
  });
  form.querySelectorAll('.time-hint').forEach((el) => {
    el.hidden = !time;
    if (time) el.textContent = core.timeHelp(unit);
  });
}

function fieldInner(f) {
  if (f.type === 'tags') return tagsFieldHTML(f.value ?? []);
  if (f.type === 'action') return `<button type="button" class="btn small" data-field-action="${f.id}">${esc(f.label)}</button>`;
  if (f.type === 'value') {
    return `<label>${esc(f.label)}${valueInputHTML(f.name, f.unit, f.value ?? '', f.required)}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}<small class="time-hint" ${core.isTimeUnit(f.unit) ? '' : 'hidden'}>${core.isTimeUnit(f.unit) ? esc(core.timeHelp(f.unit)) : ''}</small></label>`;
  }
  if (f.type === 'combo') {
    const opts = f.options.map(([v, l]) => `<option value="${esc(v)}" ${f.value === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    return `<div class="combo" data-combo>
      <label>${esc(f.label)}<select name="${f.name}">${opts}<option value="__custom__">${esc(f.customLabel ?? 'Add Custom…')}</option></select></label>
      <label class="combo-custom" hidden>${esc(f.customFieldLabel ?? 'Custom')}<input type="text" name="${f.name}__custom" autocomplete="off" placeholder="${esc(f.placeholder ?? '')}"></label>
    </div>`;
  }
  if (f.type === 'sets') {
    const rows = f.value.map((s, i) => setRowHTML(i + 1, s)).join('');
    return `<div class="sets" data-sets>
      <div class="sets-head"><span>Set</span><span>${f.assisted ? 'Assist' : 'Weight'} (${esc(f.unit)})</span><span>Reps</span><span></span></div>
      <div data-sets-list style="display:grid;gap:8px">${rows}</div>
      ${f.assisted ? '' : `<div class="plate-bar" data-plate-bar data-unit="${esc(f.unit)}"><div class="plate-text" data-plate-text>Tap a weight to see the plates.</div></div>`}
      <button type="button" class="btn small" data-add-set>＋ Add Set</button>
      <small>${f.assisted ? 'Leave a set empty to use the weight from set 1. Enter 0 or clear set 1 for no assistance.' : 'Sets 2 and up use the weight from set 1 unless you type their own. Leave all empty for bodyweight.'}</small>
    </div>`;
  }
  if (f.type === 'section') {
    return `<div class="dlg-section"><h3>${esc(f.title)}</h3>${f.note ? `<p class="sub">${esc(f.note)}</p>` : ''}</div>`;
  }
  if (f.type === 'segmented') {
    const opts = f.options
      .map(
        ([v, l, d]) =>
          `<label class="seg"><input type="radio" name="${f.name}" value="${v}" ${f.value === v ? 'checked' : ''}><span><strong>${esc(l)}</strong><small>${esc(d)}</small></span></label>`,
      )
      .join('');
    return `<div class="segmented" role="radiogroup">${opts}</div>`;
  }
  if (f.type === 'checkbox') {
    return `<label class="check"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
  }
  if (f.type === 'select') {
    const options = f.options.map(([v, l]) => `<option value="${v}" ${f.value === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    return `<label>${esc(f.label)}<select name="${f.name}">${options}</select></label>`;
  }
  if (f.type === 'textarea') {
    return `<label>${esc(f.label)}<textarea name="${f.name}" rows="${f.rows ?? 3}" ${f.readonly ? 'readonly' : ''}>${esc(f.value ?? '')}</textarea></label>`;
  }
  const attrs = [
    `type="${f.type ?? 'text'}"`,
    `name="${f.name}"`,
    f.required ? 'required' : '',
    f.type === 'number' ? 'step="any" inputmode="decimal"' : '',
    f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '',
    f.autocomplete ? `autocomplete="${f.autocomplete}"` : 'autocomplete="off"',
  ].join(' ');
  return `<label>${esc(f.label)}<input ${attrs} value="${esc(f.value ?? '')}">${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
}

// The value of a drop-down that also lets you type a new choice.
function comboValue(raw, name) {
  return raw[name] === '__custom__' ? String(raw[`${name}__custom`] ?? '').trim() : String(raw[name] ?? '').trim();
}

function openDialog(title, fields, { submitLabel = 'Save', onSubmit, secondary, message } = {}) {
  const form = document.createElement('form');
  form.className = 'dlg-form';
  form.innerHTML = `
    <div class="dlg-top"><h2>${esc(title)}</h2><button type="button" class="dlg-x" data-x aria-label="Close">✕</button></div>
    ${message ? `<p class="sub">${esc(message)}</p>` : ''}
    ${fields.map(fieldHTML).join('')}
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions">
      ${secondary ? `<button type="button" class="btn${secondary.danger === false ? '' : ' danger'}" data-secondary></button>` : ''}
      <span class="grow"></span>
      <button type="button" class="btn ghost" data-cancel>Cancel</button>
      <button type="submit" class="btn primary">${esc(submitLabel)}</button>
    </div>
    <div class="discard" hidden role="alertdialog" aria-label="Discard changes?">
      <strong>Discard This Entry?</strong>
      <span class="sub">What you entered won’t be saved.</span>
      <div class="dlg-actions"><button type="button" class="btn" data-keep>Keep Editing</button><button type="button" class="btn danger" data-discard>Discard</button></div>
    </div>`;

  const errorEl = form.querySelector('.form-error');
  const syncWhen = () => {
    const mode = form.querySelector('input[name=mode]:checked')?.value;
    form.querySelectorAll('[data-when]').forEach((el) => {
      el.hidden = el.dataset.when !== mode;
    });
  };
  form.addEventListener('change', (e) => {
    syncWhen();
    const combo = e.target.closest?.('[data-combo]');
    if (combo) {
      const custom = combo.querySelector('.combo-custom');
      const show = combo.querySelector('select').value === '__custom__';
      custom.hidden = !show;
      if (show) custom.querySelector('input').focus();
    }
  });
  syncWhen();

  // Sets editor: add a set (copying the one above it), remove a set, keep the numbers in order.
  const renumber = () => {
    form.querySelectorAll('[data-sets-list] .set-row').forEach((row, i) => {
      row.querySelector('.set-n').textContent = i + 1;
    });
  };
  const plateBar = form.querySelector('[data-plate-bar]');
  if (plateBar) {
    let current = null;
    const showPlates = () => {
      const w = Number(current?.value);
      const unit = plateBar.dataset.unit;
      const text = plateBar.querySelector('[data-plate-text]');
      if (!current) {
        text.textContent = 'Tap a weight to see the plates.';
        return;
      }
      if (!(w > 0)) {
        text.textContent = 'Enter a weight to see the plates.';
        return;
      }
      const r = core.platesPerSide(w, unit);
      if (r.underBar) text.textContent = `Lighter than the ${r.bar} ${unit} bar.`;
      else if (!r.plates.length) text.textContent = `Just the ${r.bar} ${unit} bar.`;
      else text.textContent = `Per side: ${r.plates.join(' + ')}${r.leftover ? ` (+${fmtNum(r.leftover)} ${unit} unmatched)` : ''}`;
    };
    form.addEventListener('focusin', (e) => {
      if (e.target.matches('[data-sets-list] [name=weight]')) {
        current = e.target;
        showPlates();
      }
    });
    form.addEventListener('input', (e) => {
      if (e.target === current) showPlates();
    });
  }

  // Sets 2 and up show set 1's weight in grey while empty, and use it when saved. Typing a weight there overrides it.
  const syncWeightHints = () => {
    const weights = [...form.querySelectorAll('[data-sets-list] [name=weight]')];
    if (!weights.length) return;
    const first = weights[0].value;
    weights.forEach((w, i) => {
      if (i > 0) w.placeholder = first || '0';
    });
  };
  syncWeightHints();
  form.addEventListener('input', (e) => {
    if (e.target.matches('[data-sets-list] [name=weight]')) syncWeightHints();
  });

  form.addEventListener('click', (e) => {
    const list = form.querySelector('[data-sets-list]');
    if (!list) return;
    if (e.target.closest('[data-add-set]')) {
      const rows = list.querySelectorAll('.set-row');
      const prev = rows[rows.length - 1];
      const tmp = document.createElement('div');
      tmp.innerHTML = setRowHTML(rows.length + 1, {
        weight: prev?.querySelector('[name=weight]').value === rows[0]?.querySelector('[name=weight]').value ? '' : prev?.querySelector('[name=weight]').value,
        reps: prev?.querySelector('[name=reps]').value,
      });
      const row = tmp.firstElementChild;
      list.append(row);
      syncWeightHints();
      row.querySelector('[name=reps]').focus();
      row.querySelector('[name=reps]').select();
    } else if (e.target.closest('[data-remove-set]')) {
      const rows = list.querySelectorAll('.set-row');
      if (rows.length > 1) {
        e.target.closest('.set-row').remove();
        renumber();
        syncWeightHints();
      }
    }
  });
  // Closing with anything typed in asks first, so a stray tap does not lose your work.
  const snapshot = () => JSON.stringify([...new FormData(form)].map(([k, v]) => [k, String(v)]));
  const initial = snapshot();
  const discard = form.querySelector('.discard');
  const attemptClose = () => {
    if (snapshot() === initial) {
      closeDialog();
      return;
    }
    discard.hidden = false;
    form.classList.add('confirming');
    discard.querySelector('[data-keep]').focus();
  };
  dlg._attempt = attemptClose;
  form.querySelector('[data-cancel]').addEventListener('click', attemptClose);
  form.querySelector('[data-x]').addEventListener('click', attemptClose);
  // Pressing these buttons must not pull focus out of the field being typed in. Otherwise the phone keyboard
  // closes, the page shifts, and the first tap is lost (it used to take several taps to cancel).
  for (const btn of form.querySelectorAll('[data-x], [data-cancel], [data-keep], [data-discard]')) {
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
  }
  form.querySelector('[data-keep]').addEventListener('click', () => {
    discard.hidden = true;
    form.classList.remove('confirming');
  });
  form.querySelector('[data-discard]').addEventListener('click', closeDialog);
  if (secondary) {
    const btn = form.querySelector('[data-secondary]');
    btn.textContent = secondary.label;
    btn.addEventListener('click', () => {
      closeDialog();
      secondary.onClick();
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('[type=submit]');
    submitBtn.disabled = true;
    try {
      const error = await onSubmit(Object.fromEntries(new FormData(form)), form);
      if (error) errorEl.textContent = error;
      else closeDialog();
    } finally {
      submitBtn.disabled = false;
    }
  });

  dlg.replaceChildren(form);
  if (dlg.open) dlg.close();
  dlg.showModal();
  form.querySelector('input:not([type=checkbox]), select, textarea:not([readonly])')?.focus();
}

function closeDialog() {
  dlg._attempt = null;
  if (dlg.open) dlg.close();
  dlg.replaceChildren();
}

function activityFields(a) {
  const isNew = !a;
  return [
    { type: 'section', title: '1 · What Are You Tracking?', note: isNew ? 'Give it a name and say how it is measured.' : '' },
    { name: 'name', label: 'Name', required: true, value: a?.name ?? '', placeholder: '5K Run' },
    {
      name: 'unit',
      type: 'combo',
      label: 'Unit',
      value: core.normalizeUnit(a?.unit),
      options: [['', 'No Unit'], ...core.unitOptions(state.data)],
      customLabel: 'Add Custom Unit…',
      customFieldLabel: 'Custom Unit',
      placeholder: 'rounds, laps, watts…',
    },
    {
      name: 'direction',
      type: 'select',
      label: 'What Counts as Better?',
      value: a?.direction ?? 'higher',
      options: [
        ['higher', 'A higher number (weight, distance, reps)'],
        ['lower', 'A lower number (time, like a sprint)'],
      ],
    },
    { type: 'section', title: '2 · Goal', note: `Your goal for ${core.currentYear()}. Choose now, or switch later with the Set a Goal button.` },
    {
      name: 'mode',
      type: 'segmented',
      value: a?.trackOnly ? 'track' : 'goal',
      options: [
        ['goal', '🎯 Set a Goal', 'Chase a target number'],
        ['track', '📈 Just Track It', 'Log attempts, no target'],
      ],
    },
    {
      name: 'target',
      type: 'value',
      unit: a?.unit ?? '',
      label: `${core.currentYear()} Goal`,
      value: core.inputText(a?.target, a?.unit),
      hint: `Optional. A target to beat this year, for example 185 when your best is 170. Beating your Personal Best is its own goal.`,
      when: 'goal',
    },
    { name: 'goalDate', type: 'date', label: 'Goal Date', value: a?.goalDate ?? '', hint: `Optional deadline, in ${core.currentYear()}.`, when: 'goal' },
  ];
}

const BEHIND_RECORD_MSG = 'Your target is already beaten by your Personal Best. Check the target, or whether a lower or higher number is better.';

function openActivityDialog(id = null) {
  const existing = id ? core.findActivity(state.data, id) : null;
  openDialog(existing ? 'Edit Activity' : 'New Activity', activityFields(existing), {
    submitLabel: existing ? 'Save Changes' : 'Create Activity',
    onSubmit: (raw) => {
      const unit = comboValue(raw, 'unit');
      const { error, value } = core.parseActivityInput({ ...raw, unit, trackOnly: raw.mode === 'track' });
      if (error) return error;
      value.startBest = existing?.startBest ?? null; // the Personal Best is edited by tapping it on the Best's page
      if (!value.trackOnly && value.target !== null && value.startBest && core.meetsTarget(value.startBest.value, value.target, value.direction)) {
        return BEHIND_RECORD_MSG;
      }
      if (existing) {
        commit((d) => {
          core.rememberUnit(d, value.unit);
          core.updateActivity(core.findActivity(d, id), value);
        });
      } else {
        commit((d) => {
          core.rememberUnit(d, value.unit);
          core.createActivity(d, value);
        });
        location.hash = '#/';
        toast('Activity added. Tap “Log Attempt” to record your first result.');
      }
      return null;
    },
  });

  const form = dlg.querySelector('form');
  form.querySelector('select[name=unit]').addEventListener('change', () => applyUnitHints(form));
  applyUnitHints(form);

  // For a new activity, suggest the usual direction for the unit (time is lower, weight and distance are higher).
  if (!existing) {
    const unitSel = dlg.querySelector('select[name=unit]');
    const dirSel = dlg.querySelector('select[name=direction]');
    let touched = false;
    dirSel.addEventListener('change', () => {
      touched = true;
    });
    unitSel.addEventListener('change', () => {
      if (touched || unitSel.value === '__custom__' || !unitSel.value) return;
      dirSel.value = core.isTimeUnit(unitSel.value) ? 'lower' : 'higher';
    });
  }
}

function openOldBestDialog(id) {
  const a = core.findActivity(state.data, id);
  if (!a) return;
  const has = Boolean(a.startBest);
  const year = core.currentYear();
  openDialog(
    has ? `Edit Personal Best · ${a.name}` : `Add Personal Best · ${a.name}`,
    [
      {
        name: 'value',
        type: 'value',
        unit: a.unit,
        label: `Personal Best${a.unit ? ` (${a.unit})` : ''}`,
        required: true,
        value: core.inputText(a.startBest?.value, a.unit),
        hint: 'The record you are trying to beat.',
      },
      { name: 'date', type: 'date', label: 'When You Set It', value: a.startBest?.date ?? core.todayISO() },
    ],
    {
      message: a.noOldBest
        ? `You chose no Personal Best for now. It will be set from your best when ${year} ends. You can add one here any time.`
        : `Attempts you log from 11/15/2026 on count toward beating it. No Personal Best yet? Choose “No Personal Best” and it will be set from your best when ${year} ends.`,
      submitLabel: 'Save Personal Best',
      secondary: has
        ? {
            label: 'Remove',
            onClick: () => {
              commit((d) => {
                const act = core.findActivity(d, id);
                act.beaten = false;
                core.updateActivity(act, { startBest: null, noOldBest: false });
              });
              toast('Personal Best removed.');
            },
          }
        : {
            label: a.noOldBest ? 'Keep No Personal Best' : 'No Personal Best',
            danger: false,
            onClick: () => {
              commit((d) => core.updateActivity(core.findActivity(d, id), { noOldBest: true }));
              toast(`No Personal Best for now. It will be set from your best when ${year} ends.`);
            },
          },
      onSubmit: (raw) => {
        const p = core.parseValue(raw.value, a.unit);
        if (p.error) return p.error;
        if (p.value === null) return 'Enter your Personal Best.';
        if (!core.isISODate(raw.date)) return 'Pick a valid date.';
        if (!a.trackOnly && a.target != null && core.meetsTarget(p.value, a.target, a.direction)) return BEHIND_RECORD_MSG;
        commit((d) => {
          const act = core.findActivity(d, id);
          act.beaten = false;
          core.updateActivity(act, { startBest: { value: p.value, date: raw.date }, noOldBest: false });
        });
        toast('Personal Best saved 🏆');
        return null;
      },
    },
  );
}

function openGoalDialog(id) {
  const a = core.findActivity(state.data, id);
  if (!a) return;
  const best = core.currentBest(a);
  const hasGoal = !a.trackOnly && a.target != null;
  const year = core.currentYear();
  const last = (a.goalHistory ?? [])[0] ?? null;
  openDialog(
    hasGoal ? `Edit ${year} Goal · ${a.name}` : `Set a ${year} Goal · ${a.name}`,
    [
      {
        name: 'target',
        type: 'value',
        unit: a.unit,
        label: `${year} Target${a.unit ? ` (${a.unit})` : ''}`,
        required: true,
        value: a.trackOnly ? '' : core.inputText(a.target, a.unit),
        hint: `${a.direction === 'lower' ? 'Lower' : 'Higher'} is better.${best ? ` Your best so far is ${fmtValue(best.value, a.unit)}.` : ''}`,
      },
      ...(last && !hasGoal ? [{ type: 'action', id: 'copylast', label: `↺ Use ${last.year}’s target (${fmtValue(last.target, a.unit)})` }] : []),
      { name: 'goalDate', type: 'date', label: 'Goal Date', value: a.trackOnly ? '' : (a.goalDate ?? ''), hint: `Optional deadline, in ${year}.` },
      {
        name: 'milestones',
        type: 'textarea',
        label: 'Milestones (Optional)',
        rows: 3,
        value: (a.milestones ?? []).map((m) => core.inputText(m, a.unit)).join('\n'),
      },
      { type: 'action', id: 'suggest', label: '✨ Suggest Milestones' },
    ],
    {
      message: `This is your goal for ${year}, measured against your ${year} Best. Beating your Personal Best is a separate goal that is tracked automatically. Goals do not change your attempts or records.`,
      submitLabel: 'Save Goal',
      secondary: hasGoal
        ? {
            label: 'Remove Goal',
            onClick: () => {
              const keepsOldBest = Boolean(core.oldBest(a));
              commit((d) => core.updateActivity(core.findActivity(d, id), { trackOnly: !keepsOldBest, target: null, goalYear: null, goalDate: null, milestones: [] }));
              toast(keepsOldBest ? `${year} goal removed. Your Personal Best goal is still tracked.` : 'Goal removed. This activity is now track only.');
            },
          }
        : null,
      onSubmit: (raw) => {
        const base = core.parseActivityInput({ name: a.name, unit: a.unit, trackOnly: false, target: raw.target, goalDate: raw.goalDate });
        if (base.error) return base.error;
        if (base.value.target === null) return 'Enter a target number.';
        const ob = core.oldBest(a);
        if (ob && core.meetsTarget(ob.value, base.value.target, a.direction)) return BEHIND_RECORD_MSG;
        const ms = core.parseMilestones(raw.milestones, a.unit);
        if (ms.error) return ms.error;
        commit((d) =>
          core.updateActivity(core.findActivity(d, id), {
            trackOnly: false,
            target: base.value.target,
            goalYear: base.value.goalYear,
            goalDate: base.value.goalDate,
            milestones: core.sortMilestones(a, ms.value),
          }),
        );
        toast('Goal saved 🎯');
        return null;
      },
    },
  );

  const form = dlg.querySelector('form');
  form.querySelector('[data-field-action=copylast]')?.addEventListener('click', () => {
    const input = form.querySelector('[name=target]');
    input.value = core.inputText(last.target, a.unit);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  form.querySelector('[data-field-action=suggest]').addEventListener('click', () => {
    const t = core.parseValue(form.querySelector('[name=target]').value, a.unit);
    const target = t.value ?? a.target;
    const list = core.suggestMilestones({ ...a, target, milestones: [] });
    if (!list.length) {
      toast('Enter a target that is ahead of your best first.');
      return;
    }
    form.querySelector('[name=milestones]').value = list.map((m) => core.inputText(m, a.unit)).join('\n');
    form.querySelector('[name=milestones]').dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function openAttemptDialog(activityId, attemptId = null) {
  const a = core.findActivity(state.data, activityId);
  if (!a) return;
  const t = attemptId ? core.findAttempt(a, attemptId) : null;
  openDialog(
    t ? 'Edit Attempt' : `Log Attempt · ${a.name}`,
    [
      {
        name: 'result',
        type: 'value',
        unit: a.unit,
        label: `Result${a.unit ? ` (${a.unit})` : ''}`,
        required: true,
        value: core.inputText(t?.result, a.unit),
      },
      { name: 'date', type: 'date', label: 'Date', required: true, value: t?.date ?? core.todayISO() },
      { name: 'notes', type: 'textarea', label: 'Notes', value: t?.notes ?? '' },
      { type: 'tags', value: t?.tags ?? [] },
    ],
    {
      submitLabel: t ? 'Save' : 'Log Attempt',
      secondary: t ? { label: 'Delete', onClick: () => deleteAttempt(activityId, attemptId) } : null,
      onSubmit: (raw, form) => {
        const { error, value } = core.parseAttemptInput({ ...raw, tags: readTags(form) }, a.unit);
        if (error) return error;
        const result = commit((d) => {
          core.rememberTags(d, value.tags);
          const act = core.findActivity(d, activityId);
          if (t) {
            core.updateAttempt(act, attemptId, value);
            return null;
          }
          return core.addAttempt(act, value);
        });
        if (result) afterAttempt(a, result);
        return null;
      },
    },
  );
}

function openExerciseDialog(id = null) {
  const existing = id ? core.findExercise(state.data, id) : null;
  openDialog(
    existing ? 'Edit Exercise' : 'New Exercise',
    [
      { name: 'name', label: 'Name', required: true, value: existing?.name ?? '', placeholder: 'Incline Smith Bench' },
      {
        name: 'category',
        type: 'combo',
        label: 'Category',
        value: existing?.category ?? '',
        options: [['', 'No Category'], ...state.data.categories.map((c) => [c, c])],
        customLabel: 'Add New Category…',
        customFieldLabel: 'New Category',
        placeholder: 'Core, Mobility, Shoulders…',
      },
      {
        name: 'unit',
        type: 'select',
        label: 'Weight Unit',
        value: existing?.unit ?? 'lb',
        options: [
          ['lb', 'Pounds (lb)'],
          ['kg', 'Kilograms (kg)'],
        ],
      },
      { name: 'assisted', type: 'checkbox', label: 'Assisted: less weight is better (like assisted pull-ups)', value: existing?.assisted ?? false },
      {
        name: 'linkedActivityId',
        type: 'select',
        label: 'Link To A Best (Optional)',
        value: existing?.linkedActivityId ?? '',
        options: [['', 'Not Linked'], ...state.data.activities.filter((a) => !a.archived).map((a) => [a.id, `${a.name} (${a.unit || 'no unit'})`])],
        hint: 'Lets a heavy set also count as an attempt on that Best. Its unit should be lb or kg.',
      },
      { name: 'notes', type: 'textarea', label: 'Details (Optional)', value: existing?.notes ?? '' },
    ],
    {
      submitLabel: existing ? 'Save Changes' : 'Add Exercise',
      onSubmit: (raw) => {
        const { error, value } = core.parseExerciseInput({ ...raw, category: comboValue(raw, 'category') });
        if (error) return error;
        const addCategory = (d) => {
          const known = d.categories.find((c) => c.toLowerCase() === value.category.toLowerCase());
          if (known) value.category = known;
          else if (value.category) d.categories.push(value.category);
        };
        if (existing) {
          commit((d) => {
            addCategory(d);
            core.updateExercise(core.findExercise(d, id), value);
          });
        } else {
          const created = commit((d) => {
            addCategory(d);
            return core.createExercise(d, value);
          });
          location.hash = '#/exercises';
          toast(`Added “${created.name}”. Tap “Log Session” to record your sets.`);
        }
        return null;
      },
    },
  );
}

function openCategoriesDialog() {
  const cats = state.data.categories;
  openDialog(
    'Manage Categories',
    [
      ...cats.map((c, i) => ({ name: `cat_${i}`, label: i === 0 ? 'Rename or Clear to Remove' : '', value: c })),
      { name: 'cat_new', label: 'Add a Category', value: '', placeholder: 'Shoulders, Mobility…' },
    ],
    {
      message: 'Exercises in a removed category are kept and move to “Other”.',
      submitLabel: 'Save Categories',
      onSubmit: (raw) => {
        const renames = new Map();
        const next = [];
        cats.forEach((old, i) => {
          const name = String(raw[`cat_${i}`] ?? '').trim();
          if (name && !next.some((c) => c.toLowerCase() === name.toLowerCase())) {
            next.push(name);
            renames.set(old, name);
          } else if (name) {
            renames.set(old, next.find((c) => c.toLowerCase() === name.toLowerCase()));
          } else renames.set(old, '');
        });
        const added = String(raw.cat_new ?? '').trim();
        if (added && !next.some((c) => c.toLowerCase() === added.toLowerCase())) next.push(added);
        commit((d) => {
          d.categories = next;
          for (const e of d.exercises) if (e.category) e.category = renames.get(e.category) ?? e.category;
        });
        return null;
      },
    },
  );
}

function openSessionDialog(exerciseId, sessionId = null) {
  const e = core.findExercise(state.data, exerciseId);
  if (!e) return;
  const existing = sessionId ? e.sessions.find((s) => s.id === sessionId) : null;
  // A new session starts from the last one, so you only change what moved.
  const basis = existing ?? core.lastSession(e);
  // Sets that match set 1's weight start empty, so they follow set 1 when it changes.
  const sets = basis ? basis.sets.map((s, i) => ({ ...s, weight: i > 0 && s.weight === basis.sets[0].weight ? 0 : s.weight })) : [{}, {}, {}];
  const linked = !existing && e.linkedActivityId ? core.findActivity(state.data, e.linkedActivityId) : null;
  const canLink = linked && !e.assisted && !linked.archived && core.normalizeUnit(linked.unit) === e.unit;
  openDialog(
    existing ? `Edit Session · ${e.name}` : `Log Session · ${e.name}`,
    [
      { name: 'date', type: 'date', label: 'Date', required: true, value: existing?.date ?? core.todayISO() },
      { type: 'sets', value: sets, unit: e.unit, assisted: Boolean(e.assisted) },
      { name: 'notes', type: 'textarea', label: 'Notes', value: existing?.notes ?? '', rows: 2 },
      { type: 'tags', value: existing?.tags ?? [] },
      ...(canLink ? [{ name: 'alsoBest', type: 'checkbox', label: `Also log my heaviest set as an attempt for ${linked.name}`, value: true }] : []),
    ],
    {
      message: !existing && basis ? 'Started from your last session. Change what is different today.' : '',
      submitLabel: existing ? 'Save' : 'Log Session',
      secondary: existing ? { label: 'Delete', onClick: () => deleteSession(exerciseId, sessionId) } : null,
      onSubmit: (raw, form) => {
        const rows = [...form.querySelectorAll('[data-sets-list] .set-row')].map((row) => ({
          weight: row.querySelector('[name=weight]').value,
          reps: row.querySelector('[name=reps]').value,
        }));
        // An empty weight on set 2 and up means "same as set 1".
        for (const r of rows.slice(1)) if (String(r.weight).trim() === '') r.weight = rows[0].weight;
        const { error, value } = core.parseSessionInput({ date: raw.date, notes: raw.notes, sets: rows, tags: readTags(form) });
        if (error) return error;
        const outcome = commit((d) => {
          core.rememberTags(d, value.tags);
          const ex = core.findExercise(d, exerciseId);
          if (existing) {
            core.updateSession(ex, sessionId, value);
            return null;
          }
          return core.addSession(ex, value);
        });
        if (!existing && canLink && form.querySelector('[name=alsoBest]')?.checked) {
          const top = core.sessionStats(value).topWeight;
          if (top > 0) {
            const res = commit((d) => core.addAttempt(core.findActivity(d, linked.id), { date: value.date, result: top, notes: `From ${e.name}`, tags: value.tags }));
            afterAttempt(linked, res);
            return null;
          }
        }
        if (!existing) {
          const change = core.sessionChange(core.findExercise(state.data, exerciseId));
          if (outcome?.record) celebrate(`🔥 New best top set on ${e.name}!${change ? `  ${change.text}` : ''}`);
          else toast(change?.dir === 'up' ? `Session logged ✓  ${change.text}` : 'Session logged ✓');
        }
        return null;
      },
    },
  );
}

function openSettings() {
  const c = state.config ?? {};
  openDialog(
    'Sync Settings',
    [
      { name: 'owner', label: 'GitHub Username or Organization', required: true, value: c.owner ?? '', placeholder: 'your-username' },
      { name: 'repo', label: 'Private Repository Name', required: true, value: c.repo ?? '', placeholder: 'personal-bests-data' },
      { name: 'path', label: 'Data File Path', value: c.path ?? DEFAULT_PATH },
      { name: 'branch', label: 'Branch', value: c.branch ?? 'main' },
      {
        name: 'token',
        type: 'password',
        label: 'Access Token',
        value: '',
        placeholder: c.token ? 'Saved on this device. Leave blank to keep it.' : 'github_pat_…',
        hint: 'A fine-grained token with Contents read and write access to this repository. It is stored only in this browser.',
      },
    ],
    {
      submitLabel: 'Save and Sync',
      secondary: isConfigured() ? { label: 'Sign Out of This Device', onClick: signOut } : null,
      onSubmit: async (raw) => {
        const cfg = {
          owner: String(raw.owner ?? '').trim(),
          repo: String(raw.repo ?? '').trim(),
          path: String(raw.path || DEFAULT_PATH).trim().replace(/^\/+/, ''),
          branch: String(raw.branch || 'main').trim(),
          token: String(raw.token ?? '').trim() || c.token || '',
        };
        if (!cfg.owner || !cfg.repo) return 'Enter the owner and repository name.';
        if (!cfg.token) return 'Enter an access token.';
        try {
          await gh.checkRepo(cfg);
        } catch (err) {
          return err.message;
        }
        if (state.config && (state.config.owner !== cfg.owner || state.config.repo !== cfg.repo || state.config.path !== cfg.path)) {
          state.sha = null;
        }
        state.config = cfg;
        writeJSON(CONFIG_KEY, cfg);
        await pull();
        render(); // the connection changed, so refresh the dashboard notice
        return state.status === 'error' ? state.message : null;
      },
    },
  );
}

function signOut() {
  state.config = null;
  localStorage.removeItem(CONFIG_KEY);
  state.sha = null;
  setStatus('local');
  render();
  toast('Signed out. Your data stays on this device.');
}

// ---------- actions ----------

function deleteActivity(id) {
  const removed = commit((d) => core.removeById(d.activities, id));
  if (!removed) return;
  location.hash = '#/';
  toast(`Deleted “${removed.item.name}”`, {
    action: 'Undo',
    onAction: () => commit((d) => core.insertAt(d.activities, removed.item, removed.index)),
  });
}

function deleteAttempt(activityId, attemptId) {
  const removed = commit((d) => core.removeById(core.findActivity(d, activityId).attempts, attemptId));
  if (!removed) return;
  toast('Attempt deleted', {
    action: 'Undo',
    onAction: () => commit((d) => core.insertAt(core.findActivity(d, activityId).attempts, removed.item, removed.index)),
  });
}

function deleteExercise(id) {
  const removed = commit((d) => core.removeById(d.exercises, id));
  if (!removed) return;
  location.hash = '#/exercises';
  toast(`Deleted “${removed.item.name}”`, {
    action: 'Undo',
    onAction: () => commit((d) => core.insertAt(d.exercises, removed.item, removed.index)),
  });
}

function deleteSession(exerciseId, sessionId) {
  const removed = commit((d) => core.removeById(core.findExercise(d, exerciseId).sessions, sessionId));
  if (!removed) return;
  toast('Session deleted', {
    action: 'Undo',
    onAction: () => commit((d) => core.insertAt(core.findExercise(d, exerciseId).sessions, removed.item, removed.index)),
  });
}

function flipDirection(id) {
  const a = core.findActivity(state.data, id);
  if (!a) return;
  commit((d) => {
    const act = core.findActivity(d, id);
    act.direction = act.direction === 'lower' ? 'higher' : 'lower';
    act.beaten = false;
    act.reachedGoal = false;
    core.refreshFlags(act);
  });
  toast(`Now ${core.findActivity(state.data, id).direction === 'lower' ? 'lower' : 'higher'} is better.`);
}

function deleteIdea(id) {
  const removed = commit((d) => core.removeById(d.ideas, id));
  if (!removed) return;
  toast('Idea deleted', {
    action: 'Undo',
    onAction: () => commit((d) => core.insertAt(d.ideas, removed.item, removed.index)),
  });
}

function confirmDeleteAllIdeas() {
  const count = state.data.ideas.length;
  if (!count) return;
  openDialog('Delete All Ideas?', [], {
    message: `This removes all ${count} idea${count === 1 ? '' : 's'}. You can undo right after.`,
    submitLabel: 'Delete All',
    onSubmit: () => {
      const removed = [...state.data.ideas];
      commit((d) => {
        d.ideas = [];
      });
      toast(`Deleted ${removed.length} idea${removed.length === 1 ? '' : 's'}`, {
        action: 'Undo',
        onAction: () =>
          commit((d) => {
            d.ideas.push(...removed);
          }),
      });
      return null;
    },
  });
}

async function copyIdeas() {
  const ideas = state.data.ideas;
  if (!ideas.length) {
    toast('No ideas to copy yet.');
    return;
  }
  const text = core.formatIdeasForClaude(ideas, core.todayISO());
  if (await copyText(text)) {
    toast(`Copied ${ideas.length} idea${ideas.length === 1 ? '' : 's'}`);
  } else {
    openDialog(
      'Copy These Manually',
      [{ name: 'copy', type: 'textarea', label: 'Select All and Copy', value: text, readonly: true, rows: 12 }],
      { submitLabel: 'Done', onSubmit: () => null },
    );
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the older method */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// ---------- update pop-up ----------

function showWhatsNew(current, previous) {
  whatsNewEl.innerHTML = `
    <div class="wn">
      <div class="wn-flame" aria-hidden="true">🔥</div>
      <p class="wn-kicker">${previous ? `Updated from ${esc(previous)}` : 'Update complete'}</p>
      <h2>You’re on ${esc(current.number)}</h2>
      <p class="wn-title">${esc(current.title)}</p>
      <p class="sub">${fmtDate(current.date)}</p>
      <ul class="wn-list">${current.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <div class="dlg-actions">
        <a class="link" href="#/versions" data-wn-history>See Version History</a>
        <span class="grow"></span>
        <button class="btn primary" type="button" data-wn-close>Got It</button>
      </div>
    </div>`;
  if (!whatsNewEl.open) whatsNewEl.showModal();
  whatsNewEl.scrollTop = 0;
  whatsNewEl.querySelector('[data-wn-close]')?.focus({ preventScroll: true });
}

// Shows once per version on each device. A brand-new install just records the version quietly.
function checkWhatsNew() {
  const current = VERSIONS[0];
  let seen = null;
  try {
    seen = localStorage.getItem(SEEN_KEY);
  } catch {
    /* storage unavailable */
  }
  if (seen === current.number) return;
  try {
    localStorage.setItem(SEEN_KEY, current.number);
  } catch {
    /* storage unavailable */
  }
  const existingUser = Boolean(cache || state.config);
  if (seen || existingUser) showWhatsNew(current, seen);
}

weeklyEl.addEventListener('click', (e) => {
  if (e.target === weeklyEl || e.target.closest('[data-wk-close]')) weeklyEl.close();
});
$('#weekly-btn').addEventListener('click', showWeekly);

whatsNewEl.addEventListener('click', (e) => {
  if (e.target === whatsNewEl || e.target.closest('[data-wn-close]') || e.target.closest('[data-wn-history]')) whatsNewEl.close();
});

// ---------- celebration ----------

function celebrate(message) {
  toast(message);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  const colors = ['#f0985a', '#e8704a', '#d9b25f', '#7fc4c0', '#efe6dc'];
  for (let i = 0; i < 48; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.35}s`;
    p.style.animationDuration = `${1.4 + Math.random() * 1.2}s`;
    p.style.setProperty('--dx', `${Math.random() * 160 - 80}px`);
    p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    layer.append(p);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3000);
}

// What to say (and whether to celebrate) after an attempt is logged.
function afterAttempt(activity, result) {
  const ev = result.events;
  if (ev.target) celebrate(`🎯 ${core.goalYear(activity)} goal reached on ${activity.name}!`);
  else if (ev.beatOld) celebrate(`🏆 You beat your Personal Best on ${activity.name}!`);
  else if (ev.milestone !== null) celebrate(`⭐ Milestone reached: ${fmtValue(ev.milestone, activity.unit)}`);
  else if (ev.personalBest) celebrate(`🔥 New Personal Best on ${activity.name}!`);
  else if (ev.yearBest) celebrate(`🔥 New ${core.yearOf(result.attempt.date)} Best on ${activity.name}!`);
  else toast('Attempt logged ✓');
}

// ---------- tags ----------

function tagsFieldHTML(selected = []) {
  const options = [...new Set([...state.data.tags, ...selected])];
  const chips = options
    .map((t) => `<label class="tag-chip"><input type="checkbox" name="tag" value="${esc(t)}" ${selected.includes(t) ? 'checked' : ''}><span>${esc(t)}</span></label>`)
    .join('');
  return `<div class="tags-field"><span class="field-label">Tags (Optional)</span><div class="tag-chips">${chips}</div><input type="text" name="tag_new" placeholder="Add Another Tag" autocomplete="off" maxlength="30"></div>`;
}

function readTags(form) {
  const picked = [...form.querySelectorAll('input[name=tag]:checked')].map((i) => i.value);
  const extra = String(form.querySelector('[name=tag_new]')?.value ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return [...picked, ...extra];
}

const tagChipsHTML = (tags) => (tags?.length ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : '');

// ---------- toast ----------

let toastTimer = null;

function toast(message, { action, onAction } = {}) {
  const el = $('#toast');
  el.replaceChildren();
  const span = document.createElement('span');
  span.textContent = message;
  el.append(span);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = action;
    btn.addEventListener('click', () => {
      el.hidden = true;
      clearTimeout(toastTimer);
      onAction();
    });
    el.append(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

// ---------- events ----------

function onViewClick(e) {
  if (state.suppressClick) return;
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, attempt, session, cat, mode, scope } = el.dataset;
  switch (action) {
    case 'open':
      location.hash = `#/activity/${id}`;
      break;
    case 'new-activity':
      openActivityDialog();
      break;
    case 'log':
      openAttemptDialog(id);
      break;
    case 'set-goal':
      openGoalDialog(id);
      break;
    case 'edit-oldbest':
      openOldBestDialog(id);
      break;
    case 'settings':
      openSettings();
      break;
    case 'edit-activity':
      openActivityDialog(id);
      break;
    case 'delete-activity':
      deleteActivity(id);
      break;
    case 'edit-attempt':
      openAttemptDialog(id, attempt);
      break;
    case 'delete-attempt':
      deleteAttempt(id, attempt);
      break;
    case 'archive-activity':
      commit((d) => {
        core.findActivity(d, id).archived = true;
      });
      location.hash = '#/';
      toast('Archived. Find it under Archived on the Bests page.');
      break;
    case 'unarchive-activity':
      commit((d) => {
        core.findActivity(d, id).archived = false;
      });
      toast('Restored ✓');
      break;
    case 'archive-exercise':
      commit((d) => {
        core.findExercise(d, id).archived = true;
      });
      location.hash = '#/exercises';
      toast('Archived. Find it under Archived on the Exercises page.');
      break;
    case 'unarchive-exercise':
      commit((d) => {
        core.findExercise(d, id).archived = false;
      });
      toast('Restored ✓');
      break;
    case 'toggle-archived':
      state.showArchived = !state.showArchived;
      render();
      break;
    case 'filter':
      state.exFilter = cat;
      render();
      break;
    case 'set-view':
      if (scope === 'bests') {
        state.bView = mode;
        writeJSON('pbt.bestsView', mode);
      } else {
        state.exView = mode;
        writeJSON(VIEW_KEY, mode);
      }
      render();
      break;
    case 'manage-categories':
      openCategoriesDialog();
      break;
    case 'flip-direction':
      flipDirection(id);
      break;
    case 'heat-day':
      showDay(el.dataset.date);
      break;
    case 'chart-range':
      state.chartRange = el.dataset.range === 'all' ? 'all' : 'year';
      render();
      break;
    case 'tag-filter':
      state.tagFilter = el.dataset.tag;
      render();
      break;
    case 'open-exercise':
      location.hash = `#/exercise/${id}`;
      break;
    case 'new-exercise':
      openExerciseDialog();
      break;
    case 'edit-exercise':
      openExerciseDialog(id);
      break;
    case 'delete-exercise':
      deleteExercise(id);
      break;
    case 'log-session':
      openSessionDialog(id);
      break;
    case 'edit-session':
      openSessionDialog(id, session);
      break;
    case 'delete-session':
      deleteSession(id, session);
      break;
    case 'delete-idea':
      deleteIdea(id);
      break;
    case 'copy-ideas':
      copyIdeas();
      break;
    case 'delete-all-ideas':
      confirmDeleteAllIdeas();
      break;
  }
}

function onViewSubmit(e) {
  const form = e.target;
  if (form.dataset.form === 'attempt-new') {
    e.preventDefault();
    const attemptActivity = core.findActivity(state.data, form.dataset.id);
    const { error, value } = core.parseAttemptInput({ ...Object.fromEntries(new FormData(form)), tags: readTags(form) }, attemptActivity?.unit);
    if (error) {
      toast(error);
      return;
    }
    const result = commit((d) => {
      core.rememberTags(d, value.tags);
      return core.addAttempt(core.findActivity(d, form.dataset.id), value);
    });
    afterAttempt(attemptActivity, result);
  } else if (form.dataset.form === 'idea-new') {
    e.preventDefault();
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (!text) {
      toast('Write something first.');
      return;
    }
    commit((d) => {
      d.ideas.push(core.newIdea(text));
    });
    $('#idea-text')?.focus();
  }
}

function onViewKeydown(e) {
  // Ctrl or Cmd + Enter adds the idea.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.form?.dataset.form === 'idea-new') {
    e.target.form.requestSubmit();
  }
}

// Press and hold a tile or row for a moment, then drag it to reorder Bests or Exercises.
// Moving before the hold finishes is a normal scroll or tap, so those still work.
const HOLD_MS = 320;
function onPressStart(e) {
  if (e.button > 0 || e.isPrimary === false) return;
  const card = e.target.closest('[data-reorder]');
  if (!card || e.target.closest('button, a, input, select, textarea')) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const stop = () => {
    clearTimeout(timer);
    document.removeEventListener('pointermove', onMoveEarly);
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);
  };
  const onMoveEarly = (ev) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) stop();
  };
  const timer = setTimeout(() => {
    stop();
    beginDrag(card, e);
  }, HOLD_MS);
  document.addEventListener('pointermove', onMoveEarly);
  document.addEventListener('pointerup', stop);
  document.addEventListener('pointercancel', stop);
}

// While a tile is being dragged the page must not scroll under the finger.
document.addEventListener('touchmove', (e) => { if (state.dragging) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('[data-reorder]')) e.preventDefault(); });

function beginDrag(card, e) {
  const handle = card;
  state.dragging = true;
  state.suppressClick = true;
  document.body.classList.add('reordering');
  navigator.vibrate?.(12);
  const cards = [...card.parentElement.children].filter((c) => c.matches('.card[data-id], .row-card[data-id]'));
  const from = cards.indexOf(card);
  const others = cards.filter((c) => c !== card);
  const startX = e.clientX;
  const startY = e.clientY;
  const startScroll = window.scrollY;
  let to = from;
  let lastEvent = e;

  // Two columns on wide screens: tiles then sit side by side, so the line is vertical there.
  const tops = cards.map((c) => c.getBoundingClientRect().top);
  const sideBySide = tops.some((t, i) => i > 0 && Math.abs(t - tops[0]) < 4);

  card.classList.add('dragging');
  handle.setPointerCapture(e.pointerId);

  // A single line shows where the card will land.
  const line = document.createElement('div');
  line.className = 'drop-line';
  document.body.append(line);
  const placeLine = () => {
    if (!others.length) return;
    const before = to < others.length;
    const r = others[before ? to : others.length - 1].getBoundingClientRect();
    if (sideBySide) {
      line.style.width = '4px';
      line.style.height = `${r.height}px`;
      line.style.marginTop = '0';
      line.style.left = `${(before ? r.left - 8 : r.right + 6)}px`;
      line.style.top = `${r.top}px`;
    } else {
      line.style.width = `${r.width}px`;
      line.style.height = '4px';
      line.style.marginTop = '-2px';
      line.style.left = `${r.left}px`;
      line.style.top = `${(before ? r.top - 7 : r.bottom + 7)}px`;
    }
  };

  const update = () => {
    const ev = lastEvent;
    card.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY + (window.scrollY - startScroll)}px)`;
    to = others.filter((c) => {
      const r = c.getBoundingClientRect();
      if (!sideBySide) return ev.clientY > r.top + r.height / 2;
      return ev.clientY > r.bottom || (ev.clientY >= r.top && ev.clientX > r.left + r.width / 2);
    }).length;
    placeLine();
  };

  // Near the top or bottom edge the page scrolls, so a long list can be reordered in one drag.
  let scrollTimer = null;
  const autoScroll = () => {
    const y = lastEvent.clientY;
    const dy = y < 80 ? -14 : y > window.innerHeight - 120 ? 14 : 0;
    if (dy) {
      window.scrollBy(0, dy);
      update();
    }
  };
  scrollTimer = setInterval(autoScroll, 16);

  const onMove = (ev) => {
    lastEvent = ev;
    update();
  };
  update();

  const onUp = () => {
    clearInterval(scrollTimer);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    card.classList.remove('dragging');
    card.style.transform = '';
    line.remove();
    state.dragging = false;
    document.body.classList.remove('reordering');
    state.suppressClick = true;
    setTimeout(() => {
      state.suppressClick = false;
    }, 300);
    if (to !== from) {
      const ids = cards.map((c) => c.dataset.id);
      const [movedId] = ids.splice(from, 1);
      ids.splice(to, 0, movedId);
      const key = handle.dataset.reorder === 'e' ? 'exercises' : 'activities';
      commit((d) => {
        // Visible cards take the slots the visible ones held, so archived ones stay put.
        const slots = d[key].map((x, i) => (ids.includes(x.id) ? i : -1)).filter((i) => i >= 0);
        const byId = new Map(d[key].map((x) => [x.id, x]));
        ids.forEach((id, k) => {
          d[key][slots[k]] = byId.get(id);
        });
      });
    }
  };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// ---------- no zoom ----------
// Double-tap zoom is turned off in the styles (touch-action), and these stop pinch zoom on iPhone.
['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => document.addEventListener(type, (e) => e.preventDefault()));

// ---------- boot ----------

view.addEventListener('click', onViewClick);
view.addEventListener('submit', onViewSubmit);
view.addEventListener('keydown', onViewKeydown);
// Search re-renders the list as you type; focus and caret are put back so typing is not interrupted.
view.addEventListener('input', (e) => {
  const box = e.target.closest('[data-finder]');
  if (!box) return;
  const scope = box.dataset.finder;
  const pos = box.selectionStart;
  if (scope === 'b') state.bQ = box.value;
  else state.eQ = box.value;
  render();
  const again = view.querySelector(`[data-finder="${scope}"]`);
  again?.focus({ preventScroll: true });
  again?.setSelectionRange(pos, pos);
});
view.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-sort]');
  if (!sel) return;
  if (sel.dataset.sort === 'b') state.bSort = sel.value;
  else state.eSort = sel.value;
  render();
});
view.addEventListener('pointerdown', onPressStart);

addBtn.addEventListener('click', () => (parseRoute().name === 'exercises' ? openExerciseDialog() : openActivityDialog()));
statusEl.addEventListener('click', () => {
  if (state.status === 'error' || state.status === 'pending' || state.status === 'offline') {
    if (isConfigured()) pull();
  }
});

$('#menu-btn').addEventListener('click', () => {
  const until = unlockedUntil();
  $('#menu-remember').textContent = until
    ? `Unlocked until ${String(until.getMonth() + 1).padStart(2, '0')}/${String(until.getDate()).padStart(2, '0')}/${until.getFullYear()}`
    : '';
  if (!menuEl.open) menuEl.showModal();
});
menuEl.addEventListener('click', (e) => {
  if (e.target === menuEl || e.target.closest('[data-close-menu]')) {
    menuEl.close();
    return;
  }
  if (e.target.closest('a')) menuEl.close();
});
$('#menu-settings').addEventListener('click', () => {
  menuEl.close();
  openSettings();
});
$('#menu-lock').addEventListener('click', () => {
  lockNow();
  location.reload();
});
$('#menu-version').textContent = `Version ${VERSIONS[0].number}`;

dlg.addEventListener('click', (e) => {
  if (e.target === dlg) (dlg._attempt ?? closeDialog)();
});
dlg.addEventListener('cancel', (e) => {
  e.preventDefault(); // Escape asks before throwing away what was typed
  (dlg._attempt ?? closeDialog)();
});

window.addEventListener('hashchange', () => {
  state.tagFilter = '';
  window.scrollTo(0, 0);
  render();
});
window.addEventListener('online', () => pull());
window.addEventListener('offline', () => {
  if (isConfigured()) setStatus('offline');
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flush();
  else pull();
});
window.addEventListener('pagehide', () => {
  flush();
});

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  // A new version took over while the app was open: save, then reload so it runs the new code.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    Promise.resolve(flush()).finally(() => location.reload());
  });
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

// Start the app once the code screen is passed (a device that entered the code stays unlocked for 7 days).
function start() {
  state.started = true;
  render();
  setStatus(isConfigured() ? 'syncing' : 'local');
  const pulled = pull();
  checkWhatsNew();
  Promise.resolve(pulled).catch(() => {}).finally(checkWeekly);
}

if (isUnlocked()) start();
else showLock($('#lock')).then(start);
