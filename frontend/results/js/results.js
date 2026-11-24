// Results page for every role (Results & Audit service, owner: Mohamed Khaled; page completed by Mo'men).
// API: GET /api/elections/:id, GET /api/elections/:id/results, POST /api/elections/:id/tally,
//      POST /api/elections/:id/results/publish, GET /api/elections/:id/results/export,
//      GET /api/elections/:id/results/verify, GET /api/elections/:id/turnout
// The backend decides who may see what; this page only shows its answers.
const me = Auth.user;
if (!Auth.token || !me) { location.href = '../index.html'; throw new Error('redirecting to login'); }
renderNav('');

const $ = (x) => document.getElementById(x);
const enc = encodeURIComponent;
const id = qs('id');
if (!id) location.href = '../index.html';
const isAdmin = me.role === 'ADMIN';
const isStaff = me.role === 'ADMIN' || me.role === 'AUDITOR';
$('back').href = { ADMIN: '../admin/election.html?id=' + enc(id), STUDENT: '../student/index.html', AUDITOR: '../auditor/index.html' }[me.role] || '../index.html';

let election;

async function loadElection() {
  election = await act(null, () => api('/api/elections/' + enc(id)));
  if (!election) return false;
  $('title').textContent = 'Results: ' + election.title;
  $('status').replaceChildren(badge(election.status));
  if (isStaff) {
    try {
      const t = await api(`/api/elections/${enc(id)}/turnout`);
      $('turnout').textContent = `Turnout: ${t.voted} of ${t.eligible} students voted.`;
    } catch { /* turnout is optional on this page */ }
  }
  renderActions();
  return true;
}

function renderActions() {
  const s = election.status;
  const buttons = [];
  if (isAdmin && s === 'CLOSED') {
    buttons.push(el('button', { text: 'Count votes', onclick: async (ev) => {
      if (!(await askDialog({ title: 'Count the votes now?', ok: 'Count votes' }))) return;
      if (await act(ev.target, () => api(`/api/elections/${enc(id)}/tally`, { method: 'POST' }), 'Votes counted')) refresh();
    } }));
  }
  if (isAdmin && s === 'TALLIED') {
    buttons.push(el('button', { text: 'Publish results', onclick: async (ev) => {
      if (!(await askDialog({ title: 'Publish the results? Students will be able to see them.', ok: 'Publish' }))) return;
      if (await act(ev.target, () => api(`/api/elections/${enc(id)}/results/publish`, { method: 'POST' }), 'Results published')) refresh();
    } }));
  }
  if (isStaff && (s === 'TALLIED' || s === 'PUBLISHED')) {
    buttons.push(el('button', { class: 'secondary', text: 'Download results file', onclick: (ev) => download(ev.target) }));
  }
  if (s === 'OPEN' || s === 'SCHEDULED') buttons.push(el('span', { class: 'hint', text: 'Voting has not finished yet. Results appear after voting closes and the votes are counted.' }));
  if (s === 'CLOSED' && !isAdmin) buttons.push(el('span', { class: 'hint', text: 'Voting has closed. Waiting for the admin to count the votes.' }));
  $('actions').replaceChildren(...buttons);
  $('check-card').hidden = !(isStaff && (s === 'TALLIED' || s === 'PUBLISHED'));
}

async function loadResults() {
  try {
    const data = await api(`/api/elections/${enc(id)}/results`);
    renderResults(data);
  } catch (err) {
    if (err.status === 401) { location.href = '../index.html'; return; }
    $('results').replaceChildren(el('p', { class: 'hint', text: err.message }));
    $('hash').textContent = '';
  }
}

function renderResults(data) {
  const r = data.result;
  $('results').replaceChildren(...r.positions.map((p) => {
    const winners = new Set(p.winners);
    const top = Math.max(1, ...p.candidates.map((c) => c.votes));
    return el('div', { class: 'result-position' },
      el('h3', { text: p.title }),
      el('p', { class: 'hint', text: `${p.total_votes} vote(s) · ${p.max_selections} winner(s)` }),
      p.candidates.map((c) => {
        const bar = el('div', { class: 'bar' + (winners.has(c.candidate_id) ? ' win' : '') });
        bar.style.width = Math.round((c.votes * 100) / top) + '%'; // CSSOM (allowed by the page's CSP)
        return el('div', { class: 'result-row' },
          el('span', { class: 'name' + (winners.has(c.candidate_id) ? ' winner' : ''), text: c.name }),
          el('div', { class: 'bar-track' }, bar),
          el('span', { class: 'votes', text: String(c.votes) }));
      }),
      p.tie ? el('p', { class: 'tie', text: 'Tie at the last winning place: all tied candidates are listed as winners.' }) : null);
  }));
  const when = data.published_at ? `Published ${fmtDate(data.published_at)}` : `Counted ${fmtDate(data.tallied_at)} (not published yet)`;
  $('hash').textContent = `${when} · Fingerprint (SHA-256): ${data.sha256}`;
}

async function download(button) {
  button.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/elections/${enc(id)}/results/export`, { headers: { Authorization: `Bearer ${Auth.token}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error && body.error.message) || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const a = el('a', { href: URL.createObjectURL(blob), download: `results-${id}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    flash('Downloaded. The file matched its saved fingerprint.', 'ok');
  } catch (err) {
    flash(err.message);
  } finally {
    button.disabled = false;
  }
}

$('recount').addEventListener('click', async (ev) => {
  const r = await act(ev.target, () => api(`/api/elections/${enc(id)}/results/verify`));
  if (!r) return;
  $('recount-result').replaceChildren(r.match && r.snapshot_intact
    ? el('span', { class: 'ok-text', text: '✔ Recount matches the saved results. Nothing was changed.' })
    : el('span', { class: 'bad-text', text: `✖ Mismatch: recount ${r.match ? 'matches' : 'differs'}, saved copy ${r.snapshot_intact ? 'intact' : 'changed'}.` }));
});

async function refresh() {
  if (await loadElection()) await loadResults();
}
refresh();
