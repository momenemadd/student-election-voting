// Admin: list + create elections.  API: GET /api/elections, POST /api/elections
guard('ADMIN');
renderNav('Elections');

const tbody = document.getElementById('elections');

async function load() {
  const params = new URLSearchParams();
  const status = document.getElementById('status-filter').value;
  const search = document.getElementById('search').value.trim();
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  const list = await act(null, () => api('/api/elections' + (params.toString() ? '?' + params : '')));
  if (!list) return;
  tbody.replaceChildren(
    ...(list.length
      ? list.map((e) => el('tr', {},
          el('td', {}, el('a', { href: 'election.html?id=' + encodeURIComponent(e.election_id), text: e.title })),
          el('td', {}, badge(e.status)),
          el('td', { text: fmtDate(e.start_time) }),
          el('td', { text: fmtDate(e.end_time) }),
          el('td', { text: e.is_mine ? 'You' : 'Another admin' })))
      : [el('tr', {}, el('td', { colspan: '5', class: 'hint', text: 'No elections yet.' }))])
  );
}

document.getElementById('create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const start = document.getElementById('c-start').value;
  const end = document.getElementById('c-end').value;
  if (new Date(end) <= new Date(start)) return flash('Closing time must be after opening time');
  const created = await act(ev.submitter, () => api('/api/elections', {
    method: 'POST',
    body: { title: document.getElementById('c-title').value, description: document.getElementById('c-desc').value, start_time: toIso(start), end_time: toIso(end) },
  }));
  if (created) location.href = 'election.html?id=' + encodeURIComponent(created.election_id);
});

let timer;
document.getElementById('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
document.getElementById('status-filter').addEventListener('change', load);
load();
