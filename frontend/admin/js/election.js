// Admin: one election - details, status actions, readiness, positions/candidates, eligibility.
// The page disables controls the backend would refuse, but the backend is what actually enforces it.
const me = guard('ADMIN');
renderNav('Elections');

const id = qs('id');
if (!id) location.href = 'index.html';
const $ = (x) => document.getElementById(x);
const enc = encodeURIComponent;
let election;

const editable = () => election.is_mine && (election.status === 'DRAFT' || election.status === 'SCHEDULED');
const setupEditable = () => election.is_mine && election.status === 'DRAFT';
const eligibilityEditable = () => editable();

async function loadElection() {
  election = await act(null, () => api('/api/elections/' + enc(id)));
  if (!election) return;
  $('title').textContent = election.title;
  $('status').replaceChildren(badge(election.status));
  $('owner').textContent = election.is_mine ? 'You created this election' : 'Created by another admin (read only)';
  $('e-title').value = election.title;
  $('e-desc').value = election.description || '';
  $('e-start').value = toLocalInput(election.start_time);
  $('e-end').value = toLocalInput(election.end_time);
  for (const f of $('edit-form').elements) f.disabled = !editable();
  for (const f of $('pos-form').elements) f.disabled = !setupEditable();
  $('add-all').disabled = !eligibilityEditable();
  $('find-student').disabled = !eligibilityEditable();
  renderActions();
}

function renderActions() {
  const s = election.status;
  const buttons = [];
  const go = (to, label, cls, needReason) => el('button', {
    class: cls, text: label,
    onclick: async (ev) => {
      let reason;
      if (needReason) {
        const r = await askDialog({ title: 'Close voting early', ok: 'Close voting', danger: true,
          fields: [{ name: 'reason', label: 'Reason (at least 10 characters)', required: true, minlength: '10' }] });
        if (!r) return;
        reason = r.reason;
      } else if (!(await askDialog({ title: `${label}?`, ok: label, danger: cls === 'danger' }))) return;
      const out = await act(ev.target, () => api(`/api/elections/${enc(id)}/transition`, { method: 'POST', body: { to, reason } }), `Done – election is now: ${STATUS_LABEL[to]}`);
      if (out) refresh();
    },
  });
  if (election.is_mine) {
    if (s === 'DRAFT') buttons.push(go('SCHEDULED', 'Schedule election', ''));
    if (s === 'DRAFT' || s === 'SCHEDULED') buttons.push(go('CANCELLED', 'Cancel election', 'danger'));
    if (s === 'OPEN') buttons.push(go('CLOSED', 'Close voting early', 'danger', true));
    if (s === 'DRAFT' || s === 'CANCELLED') {
      buttons.push(el('button', {
        class: 'danger', text: 'Delete election',
        onclick: async (ev) => {
          if (!(await askDialog({ title: 'Delete this election permanently?', ok: 'Delete', danger: true }))) return;
          if ((await act(ev.target, () => api('/api/elections/' + enc(id), { method: 'DELETE' }))) !== undefined) location.href = 'index.html';
        },
      }));
    }
  }
  if (s === 'SCHEDULED') buttons.push(el('span', { class: 'hint', text: 'Opens automatically at the start time.' }));
  if (s === 'OPEN') buttons.push(el('span', { class: 'hint', text: 'Voting is open. Nothing can be changed now; it closes automatically at the end time.' }));
  if (s === 'CLOSED') buttons.push(el('span', { class: 'hint', text: 'Voting has closed. Counting and publishing the results happen next.' }));
  $('actions').replaceChildren(...buttons);
}

async function loadReadiness() {
  const r = await act(null, () => api(`/api/elections/${enc(id)}/readiness`));
  if (r) $('readiness').replaceChildren(...r.checks.map((c) => el('li', { class: c.ok ? 'ok' : 'bad', text: `${c.ok ? '✔' : '✖'} ${c.check} – ${c.detail}` })));
  // Turnout comes from the Results & Audit service (cross-service call through the same API)
  try {
    const t = await api(`/api/elections/${enc(id)}/turnout`);
    $('turnout').textContent = `Votes so far: ${t.voted} of ${t.eligible} students.`;
  } catch { $('turnout').textContent = ''; }
}

async function loadPositions() {
  const list = await act(null, () => api(`/api/elections/${enc(id)}/positions`));
  if (!list) return;
  const canEdit = setupEditable();
  $('positions').replaceChildren(...(list.length ? list.map((p) => positionCard(p, canEdit)) : [el('p', { class: 'hint', text: 'No positions yet.' })]));
}

function positionCard(p, canEdit) {
  const cands = el('ul', { class: 'plain' }, p.candidates.map((c) => el('li', {},
    el('strong', { text: c.name }), c.manifesto ? el('span', { class: 'hint', text: ' – ' + c.manifesto }) : null,
    canEdit ? el('button', { class: 'link', text: 'Rename', onclick: async (ev) => {
      const r = await askDialog({ title: 'Rename candidate', ok: 'Save', fields: [{ name: 'name', label: 'Name', value: c.name, required: true, minlength: '2', maxlength: '80' }] });
      if (!r) return;
      const name = r.name;
      if (await act(ev.target, () => api('/api/candidates/' + enc(c.candidate_id), { method: 'PATCH', body: { name } }), 'Candidate updated')) loadPositions();
    } }) : null,
    canEdit ? el('button', { class: 'link danger', text: 'Remove', onclick: async (ev) => {
      if (!(await askDialog({ title: `Remove ${c.name}?`, ok: 'Remove', danger: true }))) return;
      if ((await act(ev.target, () => api('/api/candidates/' + enc(c.candidate_id), { method: 'DELETE' }), 'Candidate removed')) !== undefined) refresh();
    } }) : null)));

  const form = canEdit ? el('form', { class: 'row', onsubmit: async (ev) => {
    ev.preventDefault();
    const name = ev.target.elements.name.value, manifesto = ev.target.elements.manifesto.value;
    if (await act(ev.submitter, () => api(`/api/positions/${enc(p.position_id)}/candidates`, { method: 'POST', body: { name, manifesto } }), 'Candidate added')) refresh();
  } },
    el('input', { name: 'name', placeholder: 'Candidate name', required: true, minlength: '2', maxlength: '80' }),
    el('input', { name: 'manifesto', placeholder: 'About the candidate, e.g. their main promise (optional)', maxlength: '1000' }),
    el('button', { type: 'submit', text: 'Add candidate' })) : null;

  return el('div', { class: 'position' },
    el('div', { class: 'row' },
      el('h3', { text: p.title }), el('span', { class: 'hint', text: `${p.max_selections} winner(s) · ${p.candidates.length} candidate(s)` }),
      canEdit ? el('button', { class: 'link danger', text: 'Delete position', onclick: async (ev) => {
        if (!(await askDialog({ title: `Delete position ${p.title} and its candidates?`, ok: 'Delete', danger: true }))) return;
        if ((await act(ev.target, () => api('/api/positions/' + enc(p.position_id), { method: 'DELETE' }), 'Position deleted')) !== undefined) refresh();
      } }) : null),
    cands, form);
}

async function loadEligible() {
  const r = await act(null, () => api(`/api/elections/${enc(id)}/eligible-students`));
  if (!r) return;
  $('elig-count').textContent = `(${r.total})`;
  const canEdit = eligibilityEditable();
  $('eligible').replaceChildren(...r.items.map((s) => el('tr', {},
    el('td', { text: s.student_number }), el('td', { text: s.full_name }), el('td', { text: s.faculty || '' }),
    el('td', {}, canEdit ? el('button', { class: 'link danger', text: 'Remove', onclick: async (ev) => {
      if ((await act(ev.target, () => api(`/api/elections/${enc(id)}/eligible-students/${enc(s.student_id)}`, { method: 'DELETE' }), 'Removed')) !== undefined) { loadEligible(); loadReadiness(); }
    } }) : ''))));
}

let findTimer;
$('find-student').addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const term = $('find-student').value.trim();
    if (term.length < 2) return $('found').replaceChildren();
    const r = await act(null, () => api('/api/students?active=true&limit=10&search=' + enc(term)));
    if (!r) return;
    $('found').replaceChildren(...r.items.map((s) => el('li', {},
      el('span', { text: `${s.student_number} – ${s.full_name} ` }),
      el('button', { class: 'link', text: 'Add', onclick: async (ev) => {
        if (await act(ev.target, () => api(`/api/elections/${enc(id)}/eligible-students/${enc(s.student_id)}`, { method: 'PUT' }), 'Student added')) { loadEligible(); loadReadiness(); }
      } }))));
  }, 300);
});

$('add-all').addEventListener('click', async (ev) => {
  const r = await act(ev.target, () => api(`/api/elections/${enc(id)}/eligible-students`, { method: 'POST', body: { all_active: true } }));
  if (r) { flash(`${r.added} student(s) added`, 'ok'); loadEligible(); loadReadiness(); }
});

$('edit-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const out = await act(ev.submitter, () => api('/api/elections/' + enc(id), {
    method: 'PATCH',
    body: { title: $('e-title').value, description: $('e-desc').value, start_time: toIso($('e-start').value), end_time: toIso($('e-end').value) },
  }), 'Saved');
  if (out) loadElection();
});

$('pos-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const out = await act(ev.submitter, () => api(`/api/elections/${enc(id)}/positions`, {
    method: 'POST', body: { title: $('p-title').value, max_selections: Number($('p-max').value) },
  }), 'Position added');
  if (out) { $('p-title').value = ''; refresh(); }
});

// Sections that only display data load at the same time as the election itself (faster page).
// Positions and eligibility need to know whether the election is editable, so they wait for it.
async function refresh() {
  const sections = [loadReadiness()];
  await loadElection();
  if (!election) return;
  await Promise.all([...sections, loadPositions(), loadEligible()]);
}
refresh();
