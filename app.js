// app.js — screens, routing, and sync orchestration.
import * as core from './core.js';
import * as gh from './github.js';
import { VERSIONS } from './versions.js';

const CONFIG_KEY = 'pbt.config';
const CACHE_KEY = 'pbt.cache';
const DEFAULT_PATH = 'data/personal-bests.json';
const SAVE_DELAY_MS = 1200;

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const dlg = $('#dlg');
const menuEl = $('#menu');
const statusEl = $('#status');
const addBtn = $('#add-btn');

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
  if (!isConfigured()) return;
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
const fmtValue = (v, unit) => `${fmtNum(v)}${unit ? ` ${esc(unit)}` : ''}`;

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
  if (a.trackOnly) return 'Track only';
  if (a.target == null) return 'Not set';
  return fmtValue(a.target, a.unit);
}

function badges(a) {
  const items = [];
  if (a.trackOnly) items.push('Track only');
  if (a.beaten) items.push('Beaten');
  if (a.reachedGoal) items.push('Goal reached');
  return items.map((t) => `<span class="badge">${t}</span>`).join('');
}

function progressView(prog) {
  const pct = Math.round(prog.fraction * 100);
  return `
    <div class="progress" role="img" aria-label="${pct} percent of the way to target"><span style="width:${pct}%"></span></div>
    <p class="sub">${prog.met ? 'Target reached' : `${pct}% of the way to target`}</p>`;
}

function trendView(tr) {
  const arrow = tr.slope === null || tr.status === 'flat' ? '→' : tr.slope > 0 ? '↗' : '↘';
  const text = {
    none: 'Log two or more attempts to see a trend.',
    flat: `${arrow} Holding steady`,
    'on-track': `${arrow} Moving the right way`,
    'off-track': `${arrow} Moving the wrong way`,
  }[tr.status];
  return `<p class="trend ${tr.status}">${text}</p>`;
}

// ---------- screens ----------

function dashboardView() {
  const today = core.todayISO();
  const notice = isConfigured()
    ? ''
    : `<div class="notice">Not connected to GitHub yet, so your data stays on this device. <button class="link" data-action="settings">Connect</button></div>`;
  if (!state.data.activities.length) {
    return `${notice}
      <div class="empty">
        <p>Nothing tracked yet.</p>
        <button class="btn primary" data-action="new-activity">Add your first activity</button>
      </div>`;
  }
  const hint = state.data.activities.length > 1 ? '<p class="hint">Drag ⋮⋮ to reorder.</p>' : '';
  return `${notice}<div class="cards">${state.data.activities.map((a) => cardView(a, today)).join('')}</div>${hint}`;
}

function cardView(a, today) {
  const best = core.currentBest(a);
  const prog = core.progress(a);
  const tr = core.trend(a);
  const left = core.goalDaysLeft(a, today);
  return `
    <article class="card" data-action="open" data-id="${a.id}">
      <button class="drag-handle" type="button" aria-label="Drag to reorder ${esc(a.name)}">⋮⋮</button>
      <div class="card-body">
        <div class="card-head">
          <h2>${esc(a.name)}</h2>
          <div class="badges">${badges(a)}</div>
        </div>
        <div class="stats">
          <div>
            <span class="label">Current best</span>
            <span class="value">${best ? fmtValue(best.value, a.unit) : '—'}</span>
            ${best ? `<span class="sub">${fmtDate(best.date)}</span>` : ''}
          </div>
          <div>
            <span class="label">Target</span>
            <span class="value">${targetText(a)}</span>
            ${left !== null ? `<span class="sub">${daysText(left)}</span>` : ''}
          </div>
        </div>
        ${prog ? progressView(prog) : ''}
        ${trendView(tr)}
      </div>
    </article>`;
}

function detailView(a) {
  const today = core.todayISO();
  const best = core.currentBest(a);
  const prog = core.progress(a);
  const tr = core.trend(a);
  const left = core.goalDaysLeft(a, today);
  const history = core.sortAttempts(a.attempts).reverse();
  const bestId = best?.attemptId;

  const rows = history
    .map(
      (t) => `
      <li class="attempt${t.id === bestId ? ' is-best' : ''}">
        <div class="attempt-main">
          <strong>${fmtValue(t.result, a.unit)}</strong>
          <span class="sub">${fmtDate(t.date)}</span>
          ${t.id === bestId ? '<span class="badge">Best</span>' : ''}
        </div>
        ${t.notes ? `<p class="notes">${esc(t.notes)}</p>` : ''}
        <div class="row-actions">
          <button class="link" data-action="edit-attempt" data-id="${a.id}" data-attempt="${t.id}">Edit</button>
          <button class="link danger" data-action="delete-attempt" data-id="${a.id}" data-attempt="${t.id}">Delete</button>
        </div>
      </li>`,
    )
    .join('');

  return `
    <nav class="crumbs"><a href="#/">← All activities</a></nav>
    <header class="detail-head">
      <div>
        <h1>${esc(a.name)}</h1>
        <p class="sub">${a.direction === 'lower' ? 'Lower is better' : 'Higher is better'}${a.unit ? ` · ${esc(a.unit)}` : ''}</p>
        <div class="badges">${badges(a)}</div>
      </div>
      <div class="row-actions">
        <button class="btn" data-action="edit-activity" data-id="${a.id}">Edit</button>
        <button class="btn danger" data-action="delete-activity" data-id="${a.id}">Delete</button>
      </div>
    </header>

    <section class="stats big">
      <div>
        <span class="label">Current best</span>
        <span class="value">${best ? fmtValue(best.value, a.unit) : '—'}</span>
        ${best ? `<span class="sub">${fmtDate(best.date)}${best.source === 'start' ? ' · starting record' : ''}</span>` : ''}
      </div>
      <div>
        <span class="label">Target</span>
        <span class="value">${targetText(a)}</span>
        ${left !== null ? `<span class="sub">${daysText(left)} · ${fmtDate(a.goalDate)}</span>` : ''}
      </div>
    </section>
    ${prog ? progressView(prog) : ''}
    ${trendView(tr)}

    <section class="panel">
      <h2>Log an attempt</h2>
      <form class="attempt-form" data-form="attempt-new" data-id="${a.id}">
        <label>Date<input type="date" name="date" required value="${today}"></label>
        <label>Result${a.unit ? ` (${esc(a.unit)})` : ''}<input type="number" name="result" step="any" inputmode="decimal" required></label>
        <label class="wide">Notes<textarea name="notes" rows="2" placeholder="Optional"></textarea></label>
        <button class="btn primary wide" type="submit">Log attempt</button>
      </form>
    </section>

    <section class="panel">
      <h2>Trend</h2>
      ${chartView(a, tr)}
    </section>

    <section class="panel">
      <h2>History</h2>
      ${history.length ? `<ul class="attempts">${rows}</ul>` : '<p class="sub">No attempts yet.</p>'}
      ${a.startBest ? `<p class="sub start-line">Starting record: ${fmtValue(a.startBest.value, a.unit)} on ${fmtDate(a.startBest.date)}</p>` : ''}
    </section>`;
}

function chartView(a, tr) {
  if (!tr.points.length) return '<p class="sub">Log an attempt to see the trend.</p>';

  const W = 640;
  const H = 300;
  const L = 70;
  const R = 30;
  const T = 30;
  const B = 52;

  const xs = tr.points.map((p) => p.x);
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }

  const ys = tr.points.map((p) => p.y);
  if (a.target != null && !a.trackOnly) ys.push(a.target);
  if (a.startBest) ys.push(a.startBest.value);
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
    out.push(`<text class="axis" x="${L - 10}" y="${sy(v) + 6}" text-anchor="end">${fmtNum(Number(v.toFixed(2)))}</text>`);
  }

  const refLine = (value, cls, label) =>
    `<line class="${cls}" x1="${L}" x2="${W - R}" y1="${sy(value)}" y2="${sy(value)}"/>` +
    `<text class="ref" x="${W - R}" y="${sy(value) - 8}" text-anchor="end">${label} ${fmtNum(value)}</text>`;
  if (a.target != null && !a.trackOnly) out.push(refLine(a.target, 'target', 'Target'));
  if (a.startBest) out.push(refLine(a.startBest.value, 'start', 'Start'));

  if (tr.slope !== null) {
    const y0 = tr.intercept + tr.slope * xMin;
    const y1 = tr.intercept + tr.slope * xMax;
    out.push(`<line class="trendline" x1="${sx(xMin)}" y1="${sy(y0)}" x2="${sx(xMax)}" y2="${sy(y1)}"/>`);
  }

  for (const p of tr.points) {
    out.push(
      `<circle class="dot" cx="${sx(p.x)}" cy="${sy(p.y)}" r="6"><title>${fmtDate(p.date)}: ${fmtValue(p.y, a.unit)}</title></circle>`,
    );
  }

  const first = tr.points[0];
  const last = tr.points[tr.points.length - 1];
  out.push(`<text class="axis" x="${L}" y="${H - 14}" text-anchor="start">${fmtDate(first.date)}</text>`);
  if (last !== first) out.push(`<text class="axis" x="${W - R}" y="${H - 14}" text-anchor="end">${fmtDate(last.date)}</text>`);

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Attempt trend chart">${out.join('')}</svg>`;
}

function ideasView() {
  const list = core.sortedIdeas(state.data.ideas);
  const count = list.length;
  const form = `
    <form class="idea-form" data-form="idea-new">
      <label class="sr-only" for="idea-text">New idea</label>
      <textarea id="idea-text" name="text" rows="3" placeholder="Write an idea…"></textarea>
      <button class="btn primary" type="submit">Add idea</button>
    </form>`;
  const tools = count
    ? `<div class="idea-tools">
         <span class="sub">${count} idea${count === 1 ? '' : 's'}, newest first</span>
         <span class="grow"></span>
         <button class="btn" data-action="copy-ideas">Copy all</button>
         <button class="btn danger" data-action="delete-all-ideas">Delete all</button>
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
    <nav class="crumbs"><a href="#/">← All activities</a></nav>
    <h1>Ideas</h1>
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
          <span class="badge">${esc(v.number)}</span>
          <strong>${esc(v.title)}</strong>
          <span class="sub">${fmtDate(v.date)}</span>
        </summary>
        <ul>${v.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      </details>`,
  ).join('');
  return `
    <nav class="crumbs"><a href="#/">← All activities</a></nav>
    <h1>Version history</h1>
    <p class="sub">Each version we have built together, newest first.</p>
    <div class="versions">${items}</div>`;
}

// ---------- routing and rendering ----------

function parseRoute() {
  const hash = location.hash;
  const detail = hash.match(/^#\/activity\/([\w-]+)$/);
  if (detail) return { name: 'detail', id: detail[1] };
  if (hash === '#/ideas') return { name: 'ideas' };
  if (hash === '#/versions') return { name: 'versions' };
  return { name: 'dashboard' };
}

function render() {
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
  } else if (route.name === 'ideas') {
    html = ideasView();
    title = 'Ideas · Personal Bests';
  } else if (route.name === 'versions') {
    html = versionsView();
    title = 'Version history · Personal Bests';
  } else {
    html = dashboardView();
  }

  view.innerHTML = html;
  document.title = title;
  addBtn.hidden = route.name !== 'dashboard';
}

// ---------- dialogs ----------

function fieldHTML(f) {
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

function openDialog(title, fields, { submitLabel = 'Save', onSubmit, secondary, message } = {}) {
  const form = document.createElement('form');
  form.className = 'dlg-form';
  form.innerHTML = `
    <h2>${esc(title)}</h2>
    ${message ? `<p class="sub">${esc(message)}</p>` : ''}
    ${fields.map(fieldHTML).join('')}
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions">
      ${secondary ? '<button type="button" class="btn danger" data-secondary></button>' : ''}
      <span class="grow"></span>
      <button type="button" class="btn ghost" data-cancel>Cancel</button>
      <button type="submit" class="btn primary">${esc(submitLabel)}</button>
    </div>`;

  const errorEl = form.querySelector('.form-error');
  form.querySelector('[data-cancel]').addEventListener('click', closeDialog);
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
      const error = await onSubmit(Object.fromEntries(new FormData(form)));
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
  if (dlg.open) dlg.close();
  dlg.replaceChildren();
}

function activityFields(a) {
  return [
    { name: 'name', label: 'Name', required: true, value: a?.name ?? '', placeholder: '100 meter sprint' },
    { name: 'unit', label: 'Unit', value: a?.unit ?? '', placeholder: 'seconds, km, kg' },
    {
      name: 'direction',
      type: 'select',
      label: 'Better when',
      value: a?.direction ?? 'higher',
      options: [
        ['higher', 'A higher number is better'],
        ['lower', 'A lower number is better'],
      ],
    },
    { name: 'trackOnly', type: 'checkbox', label: 'Track only (no target, no goal flags)', value: Boolean(a?.trackOnly) },
    {
      name: 'target',
      type: 'number',
      label: 'Target',
      value: a?.target ?? '',
      hint: 'The number you are working toward. Optional, and you can change it any time.',
    },
    { name: 'goalDate', type: 'date', label: 'Goal date', value: a?.goalDate ?? '', hint: 'Optional deadline for the target.' },
    {
      name: 'startValue',
      type: 'number',
      label: 'Starting personal best',
      value: a?.startBest?.value ?? '',
      hint: 'The existing record to beat. Optional.',
    },
    { name: 'startDate', type: 'date', label: 'Starting personal best date', value: a?.startBest?.date ?? core.todayISO() },
  ];
}

function openActivityDialog(id = null) {
  const existing = id ? core.findActivity(state.data, id) : null;
  openDialog(existing ? 'Edit activity' : 'New activity', activityFields(existing), {
    submitLabel: existing ? 'Save' : 'Create',
    onSubmit: (raw) => {
      const { error, value } = core.parseActivityInput(raw);
      if (error) return error;
      if (existing) commit((d) => core.updateActivity(core.findActivity(d, id), value));
      else {
        commit((d) => core.createActivity(d, value));
        location.hash = '#/';
      }
      return null;
    },
  });
}

function openAttemptDialog(activityId, attemptId = null) {
  const a = core.findActivity(state.data, activityId);
  if (!a) return;
  const t = attemptId ? core.findAttempt(a, attemptId) : null;
  openDialog(
    t ? 'Edit attempt' : 'Log attempt',
    [
      { name: 'date', type: 'date', label: 'Date', required: true, value: t?.date ?? core.todayISO() },
      {
        name: 'result',
        type: 'number',
        label: `Result${a.unit ? ` (${a.unit})` : ''}`,
        required: true,
        value: t?.result ?? '',
      },
      { name: 'notes', type: 'textarea', label: 'Notes', value: t?.notes ?? '' },
    ],
    {
      submitLabel: t ? 'Save' : 'Log',
      secondary: t ? { label: 'Delete', onClick: () => deleteAttempt(activityId, attemptId) } : null,
      onSubmit: (raw) => {
        const { error, value } = core.parseAttemptInput(raw);
        if (error) return error;
        commit((d) => {
          const act = core.findActivity(d, activityId);
          if (t) core.updateAttempt(act, attemptId, value);
          else core.addAttempt(act, value);
        });
        return null;
      },
    },
  );
}

function openSettings() {
  const c = state.config ?? {};
  openDialog(
    'Sync settings',
    [
      { name: 'owner', label: 'GitHub username or organization', required: true, value: c.owner ?? '', placeholder: 'your-username' },
      { name: 'repo', label: 'Private repository name', required: true, value: c.repo ?? '', placeholder: 'personal-bests-data' },
      { name: 'path', label: 'Data file path', value: c.path ?? DEFAULT_PATH },
      { name: 'branch', label: 'Branch', value: c.branch ?? 'main' },
      {
        name: 'token',
        type: 'password',
        label: 'Access token',
        value: '',
        placeholder: c.token ? 'Saved on this device. Leave blank to keep it.' : 'github_pat_…',
        hint: 'A fine-grained token with Contents read and write access to this repository. It is stored only in this browser.',
      },
    ],
    {
      submitLabel: 'Save and sync',
      secondary: isConfigured() ? { label: 'Sign out of this device', onClick: signOut } : null,
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
  openDialog('Delete all ideas?', [], {
    message: `This removes all ${count} idea${count === 1 ? '' : 's'}. You can undo right after.`,
    submitLabel: 'Delete all',
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
      'Copy these manually',
      [{ name: 'copy', type: 'textarea', label: 'Select all and copy', value: text, readonly: true, rows: 12 }],
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
  if (state.suppressClick || e.target.closest('.drag-handle')) return;
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, attempt } = el.dataset;
  switch (action) {
    case 'open':
      location.hash = `#/activity/${id}`;
      break;
    case 'new-activity':
      openActivityDialog();
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
    const { error, value } = core.parseAttemptInput(Object.fromEntries(new FormData(form)));
    if (error) {
      toast(error);
      return;
    }
    const { newRecord } = commit((d) => core.addAttempt(core.findActivity(d, form.dataset.id), value));
    toast(newRecord ? 'New personal best!' : 'Attempt logged');
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

// Drag a card by its handle to reorder the dashboard.
function onDragStart(e) {
  const handle = e.target.closest('.drag-handle');
  if (!handle || e.button > 0) return;
  e.preventDefault();

  const cards = [...view.querySelectorAll('.card')];
  const card = handle.closest('.card');
  const from = cards.indexOf(card);
  const others = cards.filter((c) => c !== card);
  const startY = e.clientY;
  let to = from;

  card.classList.add('dragging');
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    card.style.transform = `translateY(${ev.clientY - startY}px)`;
    to = others.filter((c) => {
      const r = c.getBoundingClientRect();
      return ev.clientY > r.top + r.height / 2;
    }).length;
  };

  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    card.classList.remove('dragging');
    card.style.transform = '';
    state.suppressClick = true;
    setTimeout(() => {
      state.suppressClick = false;
    }, 300);
    if (to !== from) {
      commit((d) => {
        const [moved] = d.activities.splice(from, 1);
        d.activities.splice(to, 0, moved);
      });
    }
  };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// ---------- boot ----------

view.addEventListener('click', onViewClick);
view.addEventListener('submit', onViewSubmit);
view.addEventListener('keydown', onViewKeydown);
view.addEventListener('pointerdown', onDragStart);

addBtn.addEventListener('click', () => openActivityDialog());
statusEl.addEventListener('click', () => {
  if (state.status === 'error' || state.status === 'pending' || state.status === 'offline') {
    if (isConfigured()) pull();
  }
});

$('#menu-btn').addEventListener('click', () => {
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
$('#menu-version').textContent = `Version ${VERSIONS[0].number}`;

dlg.addEventListener('click', (e) => {
  if (e.target === dlg) closeDialog();
});

window.addEventListener('hashchange', () => {
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
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
setStatus(isConfigured() ? 'syncing' : 'local');
pull();
