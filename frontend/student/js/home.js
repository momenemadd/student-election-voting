// Student: my elections.  API: GET /api/me/elections
guard('STUDENT');
renderNav('My elections');

const link = (href, text, cls = 'button-link') => el('a', { href, class: cls, text });

function actionFor(e) {
  const id = encodeURIComponent(e.election_id);
  if (e.status === 'PUBLISHED') {
    return el('div', { class: 'row' },
      e.has_voted ? el('span', { class: 'voted', text: 'Voted ✔' }) : null,
      link(`../results/index.html?id=${id}`, 'See results'));
  }
  if (e.has_voted) return el('div', { class: 'row' }, el('span', { class: 'voted', text: 'Voted ✔' }), link(`receipt.html?id=${id}`, 'My receipt', 'link'));
  if (e.status === 'OPEN') return link(`vote.html?id=${id}`, 'Vote');
  if (e.status === 'SCHEDULED') return el('span', { class: 'hint', text: 'Voting opens ' + fmtDate(e.start_time) });
  return el('span', { class: 'hint', text: 'You did not vote' });
}

async function load() {
  const list = await act(null, () => api('/api/me/elections'));
  if (!list) return;
  const box = document.getElementById('elections');
  box.replaceChildren(...(list.length
    ? list.map((e) => el('li', { class: 'election' },
        el('div', { class: 'info' },
          el('h3', { text: e.title }),
          el('p', { class: 'hint', text: `${fmtDate(e.start_time)} – ${fmtDate(e.end_time)}` }),
          e.description ? el('p', { class: 'hint', text: e.description }) : null),
        badge(e.status),
        actionFor(e)))
    : [el('li', { class: 'hint', text: 'There are no elections for you at the moment.' })]));
}
load();
