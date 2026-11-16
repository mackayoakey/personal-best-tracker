// github.js — reads and writes the one JSON data file through the GitHub Contents API.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function headers(cfg, extra = {}) {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function fail(res) {
  let detail = '';
  try {
    detail = (await res.json()).message ?? '';
  } catch {
    /* no JSON body */
  }
  const message =
    res.status === 401 ? 'GitHub rejected the token. Check it in Sync settings.'
    : res.status === 403 ? 'GitHub refused the request. Check the token permissions, or wait if you hit a rate limit.'
    : res.status === 404 ? 'Not found on GitHub. Check the owner, repository, and file path.'
    : res.status === 409 || res.status === 422 ? 'The file changed on GitHub.'
    : `GitHub error ${res.status}${detail ? `: ${detail}` : ''}`;
  throw new GitHubError(res.status, message);
}

const repoUrl = (cfg) => `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
const fileUrl = (cfg) => `${repoUrl(cfg)}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}`;

export async function checkRepo(cfg) {
  const res = await fetch(repoUrl(cfg), { headers: headers(cfg) });
  if (!res.ok) await fail(res);
  return true;
}

// Returns { sha, data }. A missing file comes back as { sha: null, data: null }.
export async function getFile(cfg) {
  const res = await fetch(`${fileUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: headers(cfg),
    cache: 'no-store',
  });
  if (res.status === 404) return { sha: null, data: null };
  if (!res.ok) await fail(res);
  const json = await res.json();
  const text = b64decode(json.content ?? '');
  return { sha: json.sha, data: text.trim() ? JSON.parse(text) : null };
}

// Writes the whole data object. Returns the new sha.
export async function putFile(cfg, sha, data) {
  const body = {
    message: 'Update personal bests',
    content: b64encode(JSON.stringify(data, null, 2)),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(fileUrl(cfg), {
    method: 'PUT',
    headers: headers(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    keepalive: true,
  });
  if (!res.ok) await fail(res);
  const json = await res.json();
  return { sha: json.content.sha };
}

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
