// lock.js: a simple code screen that remembers this device for 7 days.
// This is a casual lock that keeps people who pick up your phone or open the site out of your data.
// It is not strong security: the code is checked in the browser, and your real data is protected by
// the private GitHub repository and your access token.
const SALT = 'pbt-lock-v1:';
const CODE_HASH = '002d315cf0862ed298a69dedb26dbbf378caa3403508b54d545cc3c1321a9d63';
const KEY = 'pbt.unlockUntil';
const REMEMBER_DAYS = 7;
const MAX_TRIES = 5;
const WAIT_SECONDS = 30;

async function hash(code) {
  const bytes = new TextEncoder().encode(SALT + code);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isUnlocked() {
  try {
    return Number(localStorage.getItem(KEY)) > Date.now();
  } catch {
    return false;
  }
}

export function lockNow() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

function remember() {
  try {
    localStorage.setItem(KEY, String(Date.now() + REMEMBER_DAYS * 86400000));
  } catch {
    /* storage unavailable */
  }
}

// Shows the code screen and resolves once the right code is entered.
export function showLock(el) {
  if (!globalThis.crypto?.subtle) return Promise.resolve(); // needs a secure page; otherwise do not lock you out
  return new Promise((resolve) => {
    let code = '';
    let tries = 0;
    let waitUntil = 0;
    el.hidden = false;
    el.innerHTML = `
      <div class="lock-box">
        <img class="lock-logo" src="logo-flame.png" alt="" width="40">
        <h1>Enter Code</h1>
        <div class="lock-dots" aria-live="polite"><i></i><i></i><i></i><i></i></div>
        <p class="lock-msg" role="alert"></p>
        <div class="lock-pad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join('')}
          <span></span><button type="button" data-k="0">0</button><button type="button" data-k="back" aria-label="Delete">⌫</button>
        </div>
      </div>`;
    const dots = [...el.querySelectorAll('.lock-dots i')];
    const msg = el.querySelector('.lock-msg');
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < code.length));

    async function press(k) {
      if (Date.now() < waitUntil) {
        msg.textContent = `Too many tries. Wait ${Math.ceil((waitUntil - Date.now()) / 1000)} seconds.`;
        return;
      }
      if (k === 'back') code = code.slice(0, -1);
      else if (code.length < 4) code += k;
      msg.textContent = '';
      paint();
      if (code.length < 4) return;
      if ((await hash(code)) === CODE_HASH) {
        remember();
        document.removeEventListener('keydown', onKey);
        el.hidden = true;
        el.replaceChildren();
        resolve();
        return;
      }
      tries += 1;
      code = '';
      el.querySelector('.lock-dots').classList.add('shake');
      setTimeout(() => el.querySelector('.lock-dots')?.classList.remove('shake'), 400);
      if (tries >= MAX_TRIES) {
        tries = 0;
        waitUntil = Date.now() + WAIT_SECONDS * 1000;
        msg.textContent = `Too many tries. Wait ${WAIT_SECONDS} seconds.`;
      } else {
        msg.textContent = 'Wrong code. Try again.';
      }
      setTimeout(paint, 150);
    }

    const onKey = (e) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
    };
    document.addEventListener('keydown', onKey);
    el.addEventListener('click', (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (k) press(k);
    });
  });
}
