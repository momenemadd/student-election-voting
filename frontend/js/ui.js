// Shared UI helpers for every page (admin, student, auditor).
// Security rule: everything from the server is inserted with textContent (el() below), never innerHTML.
const ROOT = document.body.dataset.root || '';

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs || {})) {
    if (val === null || val === undefined || val === false) continue;
    if (k === 'class') n.className = val;
    else if (k === 'text') n.textContent = val;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), val);
    else n.setAttribute(k, val === true ? '' : val);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
  return n;
}

// Page guard: convenience only - the backend still rejects wrong roles with 401/403.
function guard(role) {
  const u = Auth.user;
  if (!Auth.token || !u || u.role !== role) {
    location.href = ROOT + 'index.html';
    throw new Error('redirecting to login');
  }
  return u;
}

const NAV = {
  ADMIN: [['Elections', 'admin/index.html'], ['Students', 'admin/students.html']],
  STUDENT: [['My elections', 'student/index.html']],
  AUDITOR: [['Audit', 'auditor/index.html']],
};

function renderNav(active) {
  const u = Auth.user || {};
  const links = (NAV[u.role] || []).map(([label, href]) => el('a', { href: ROOT + href, class: label === active ? 'active' : null, text: label }));
  const logout = el('button', {
    class: 'link', text: 'Log out',
    onclick: async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* token may already be invalid */ } Auth.clear(); location.href = ROOT + 'index.html'; },
  });
  document.querySelector('header').replaceChildren(
    el('h1', { text: 'Student Election Voting' }),
    el('nav', {}, links),
    el('span', { class: 'who', text: u.role || '' }),
    logout
  );
}

function flash(message, type = 'error') {
  const box = document.getElementById('flash');
  if (!box) return alert(message);
  box.className = 'flash ' + type;
  box.textContent = message;
  if (type === 'ok') setTimeout(() => { if (box.textContent === message) box.textContent = ''; }, 4000);
}

// Runs an async action, shows the server's error message if it fails, disables the button meanwhile.
async function act(button, fn, okMessage) {
  if (button) button.disabled = true;
  try {
    const out = await fn();
    if (okMessage) flash(okMessage, 'ok');
    return out;
  } catch (err) {
    if (err.status === 401) { location.href = ROOT + 'index.html'; return; }
    flash(err.message);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// In-page confirmation / input box (replaces window.confirm/prompt, which some browsers and
// embedded panes block). Resolves to an object of field values when OK is pressed, or null on Cancel.
function askDialog({ title, fields = [], ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => el('input', {
      name: f.name, value: f.value || '', placeholder: f.placeholder || '',
      minlength: f.minlength, maxlength: f.maxlength || '300', required: f.required, type: f.type || 'text',
    }));
    const dlg = el('dialog', { class: 'dlg' });
    dlg.append(el('form', { method: 'dialog' },
      el('h3', { text: title }),
      fields.map((f, i) => el('label', {}, f.label, inputs[i])),
      el('div', { class: 'row' },
        el('button', { type: 'submit', value: 'ok', class: danger ? 'danger' : null, text: ok }),
        el('button', { type: 'button', class: 'link', text: 'Cancel', onclick: () => dlg.close('cancel') }))));
    dlg.addEventListener('close', () => {
      const values = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      const confirmed = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(confirmed ? values : null);
    });
    document.body.append(dlg);
    dlg.showModal();
    (inputs[0] || dlg.querySelector('button')).focus();
  });
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const toIso = (localValue) => new Date(localValue).toISOString(); // <input type=datetime-local> -> ISO UTC
function toLocalInput(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const STATUS_LABEL = { DRAFT: 'Draft', SCHEDULED: 'Scheduled', OPEN: 'Voting open', CLOSED: 'Voting closed', TALLIED: 'Counted', PUBLISHED: 'Results published', CANCELLED: 'Cancelled' };
const badge = (status) => el('span', { class: 'badge b-' + String(status).toLowerCase(), text: STATUS_LABEL[status] || status });
const qs = (name) => new URLSearchParams(location.search).get(name);
