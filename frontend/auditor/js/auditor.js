// Auditor page (Results & Audit service, owner: Mohamed Khaled; page completed by Mo'men).
// API: GET /api/monitoring/security-summary, GET /api/elections, GET /api/audit-logs, GET /api/audit-logs/verify
guard('AUDITOR');
renderNav('Audit');
const $ = (x) => document.getElementById(x);
const enc = encodeURIComponent;
const LABELS = { LOGIN_FAILED: 'Wrong passwords', LOGIN_LOCKED: 'Locked accounts', ACCESS_DENIED: 'Blocked requests', RATE_LIMITED: 'Too many tries', EMAIL_CODE_FAILED: 'Wrong email codes' };

async function loadSummary() {
  const s = await act(null, () => api('/api/monitoring/security-summary?hours=' + enc($('hours').value)));
  if (!s) return;
  $('summary').replaceChildren(...Object.entries(s.counts).map(([k, n]) =>
    el('div', { class: 'stat' + (n > 0 ? ' alert' : '') }, el('div', { class: 'num', text: String(n) }), el('div', { class: 'lbl', text: LABELS[k] || k }))));
  $('top-denied').replaceChildren(...(s.top_denied.length
    ? s.top_denied.map((d) => el('li', {}, el('span', { text: d.resource }), el('span', { class: 'hint', text: ` × ${d.count}` })))
    : [el('li', { class: 'hint', text: 'Nothing blocked in this period.' })]));
}

async function loadElections() {
  const list = await act(null, () => api('/api/elections'));
  if (!list) return;
  $('elections').replaceChildren(...list.map((e) => el('tr', {},
    el('td', { text: e.title }), el('td', {}, badge(e.status)), el('td', { text: fmtDate(e.end_time) }),
    el('td', {}, el('a', { href: '../results/index.html?id=' + enc(e.election_id), text: 'Results' })))));
  for (const e of list) $('scope').append(el('option', { value: e.election_id, text: 'Election: ' + e.title }));
}

async function loadLog() {
  const p = new URLSearchParams({ limit: '200' });
  if ($('scope').value) p.set('election', $('scope').value);
  if ($('action').value.trim()) p.set('action', $('action').value.trim().toUpperCase());
  if ($('from').value) p.set('from', toIso($('from').value));
  if ($('to').value) p.set('to', toIso($('to').value));
  const rows = await act(null, () => api('/api/audit-logs?' + p));
  if (!rows) return;
  $('log').replaceChildren(...(rows.length ? rows.map((r) => el('tr', {},
    el('td', { text: String(r.seq) }), el('td', { text: fmtDate(r.ts) }), el('td', { text: r.action }),
    el('td', { text: r.role }), el('td', { class: 'res', text: r.resource }), el('td', { class: 'out-' + r.outcome, text: r.outcome })))
    : [el('tr', {}, el('td', { colspan: '6', class: 'hint', text: 'No records match.' }))]));
}

$('verify').addEventListener('click', async (ev) => {
  const p = $('scope').value ? '?election=' + enc($('scope').value) : '';
  const r = await act(ev.target, () => api('/api/audit-logs/verify' + p));
  if (!r) return;
  $('verify-result').replaceChildren(r.valid
    ? el('span', { class: 'ok-text', text: `✔ Chain valid: ${r.count} record(s), nothing edited or removed.` })
    : el('span', { class: 'bad-text', text: `✖ Chain broken at record ${r.brokenAt} (of ${r.count}). The log was changed.` }));
});

$('filter').addEventListener('submit', (ev) => { ev.preventDefault(); loadLog(); });
$('hours').addEventListener('change', loadSummary);
loadSummary();
loadElections().then(loadLog);
