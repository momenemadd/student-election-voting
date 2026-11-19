// Student: ballot + vote.  API: GET /api/elections/:id/ballot, POST /api/elections/:id/votes
// The page only helps the student fill the ballot correctly; the backend checks every rule again.
guard('STUDENT');
renderNav('My elections');

const id = qs('id');
const $ = (x) => document.getElementById(x);
const turnstileValue = () => (document.querySelector('[name="cf-turnstile-response"]') || {}).value || '';
let ballot;

function choiceInput(p, c) {
  const multi = p.max_selections > 1;
  const input = el('input', { type: multi ? 'checkbox' : 'radio', name: p.position_id, value: c.candidate_id });
  if (multi) {
    // stop the student from ticking more boxes than there are seats
    input.addEventListener('change', () => {
      const ticked = document.querySelectorAll(`input[name="${p.position_id}"]:checked`);
      if (ticked.length > p.max_selections) { input.checked = false; flash(`You can choose at most ${p.max_selections} for ${p.title}`, 'warn'); }
    });
  }
  return el('label', { class: 'choice' }, input,
    el('span', {}, c.name, c.manifesto ? el('span', { class: 'manifesto', text: c.manifesto }) : null));
}

function render() {
  $('title').textContent = ballot.title;
  $('info').textContent = `Voting closes ${fmtDate(ballot.end_time)}. You can vote only once.`;
  $('positions').replaceChildren(...ballot.positions.map((p) => el('fieldset', { class: 'position' },
    el('legend', { text: p.title }),
    el('p', { class: 'hint', text: p.max_selections > 1 ? `Choose 1 to ${p.max_selections} candidates` : 'Choose 1 candidate' }),
    p.candidates.map((c) => choiceInput(p, c)))));
  $('ballot-form').hidden = false;
}

// Collect choices: [{ position_id, candidate_id }] + a readable summary.
function collect() {
  const selections = [], summary = [];
  for (const p of ballot.positions) {
    const ticked = [...document.querySelectorAll(`input[name="${p.position_id}"]:checked`)];
    if (ticked.length < 1) throw new Error(`Choose a candidate for ${p.title}`);
    if (ticked.length > p.max_selections) throw new Error(`Choose at most ${p.max_selections} for ${p.title}`);
    const names = ticked.map((t) => p.candidates.find((c) => c.candidate_id === t.value).name);
    ticked.forEach((t) => selections.push({ position_id: p.position_id, candidate_id: t.value }));
    summary.push([p.title, names.join(', ')]);
  }
  return { selections, summary };
}

let pending;
$('ballot-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  try { pending = collect(); } catch (err) { return flash(err.message); }
  if (!turnstileValue()) return flash('Please complete the "I am human" check first');
  $('review-list').replaceChildren(...pending.summary.map(([pos, names]) => el('li', {}, el('strong', { text: pos }), el('span', { text: names }))));
  $('ballot-form').hidden = true;
  $('review').hidden = false;
  flash('', 'ok');
});

$('change').addEventListener('click', () => { $('review').hidden = true; $('ballot-form').hidden = false; });

$('submit-vote').addEventListener('click', async (ev) => {
  const sure = await askDialog({ title: 'Submit your vote? You cannot change it afterwards.', ok: 'Submit vote' });
  if (!sure) return;
  const out = await act(ev.target, () => api(`/api/elections/${encodeURIComponent(id)}/votes`, {
    method: 'POST', body: { selections: pending.selections, turnstileToken: turnstileValue() },
  }));
  if (!out) { // refused: let the student try again with a fresh bot check
    if (window.turnstile) window.turnstile.reset();
    $('review').hidden = true;
    $('ballot-form').hidden = false;
    return;
  }
  pending = null;
  $('review').hidden = true;
  $('receipt-code').textContent = out.receipt_code;
  $('receipt-link').href = 'receipt.html?id=' + encodeURIComponent(id);
  $('receipt').hidden = false;
});

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('receipt-code').textContent); flash('Copied', 'ok'); } catch { flash('Copy failed – write the code down', 'warn'); }
});

(async () => {
  if (!id) return flash('No election selected');
  try {
    ballot = await api(`/api/elections/${encodeURIComponent(id)}/ballot`);
    render();
  } catch (err) {
    if (err.status === 401) { location.href = '../index.html'; return; }
    const code = err.data && err.data.error && err.data.error.code;
    if (code === 'ALREADY_VOTED') { location.href = 'receipt.html?id=' + encodeURIComponent(id); return; }
    flash(err.message);
  }
})();
