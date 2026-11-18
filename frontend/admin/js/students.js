// Admin: student roster - add, import, search, edit, activate/deactivate, delete.
// API: POST /api/students, POST /api/students/import, GET /api/students, PATCH/DELETE /api/students/:id
guard('ADMIN');
renderNav('Students');
const $ = (x) => document.getElementById(x);
const enc = encodeURIComponent;

async function load() {
  const term = $('search').value.trim();
  const r = await act(null, () => api('/api/students?limit=200' + (term ? '&search=' + enc(term) : '')));
  if (!r) return;
  $('count').textContent = `(${r.total})`;
  $('students').replaceChildren(...r.items.map((s) => el('tr', {},
    el('td', { text: s.student_number }),
    el('td', { text: s.full_name }),
    el('td', { text: s.email }),
    el('td', { text: s.faculty || '' }),
    el('td', { text: s.active ? 'yes' : 'no' }),
    el('td', {},
      el('button', { class: 'link', text: 'Edit', onclick: async (ev) => {
        const r = await askDialog({ title: `Edit ${s.student_number}`, ok: 'Save', fields: [
          { name: 'full_name', label: 'Full name', value: s.full_name, required: true, minlength: '2', maxlength: '100' },
          { name: 'email', label: 'Email', value: s.email, required: true, type: 'email', maxlength: '254' },
          { name: 'faculty', label: 'Faculty', value: s.faculty || '', maxlength: '80' }] });
        if (!r) return;
        const { full_name, email, faculty } = r;
        if (await act(ev.target, () => api('/api/students/' + enc(s.student_id), { method: 'PATCH', body: { full_name, email, faculty } }), 'Student updated')) load();
      } }),
      el('button', { class: 'link', text: s.active ? 'Deactivate' : 'Activate', onclick: async (ev) => {
        if (await act(ev.target, () => api('/api/students/' + enc(s.student_id), { method: 'PATCH', body: { active: !s.active } }), 'Saved')) load();
      } }),
      el('button', { class: 'link danger', text: 'Delete', onclick: async (ev) => {
        if (!(await askDialog({ title: `Delete ${s.full_name}?`, ok: 'Delete', danger: true }))) return;
        if ((await act(ev.target, () => api('/api/students/' + enc(s.student_id), { method: 'DELETE' }), 'Student deleted')) !== undefined) load();
      } })))));
}

$('add-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const out = await act(ev.submitter, () => api('/api/students', {
    method: 'POST',
    body: { student_number: $('s-number').value, full_name: $('s-name').value, email: $('s-email').value, faculty: $('s-faculty').value || undefined },
  }), 'Student added');
  if (out) { ev.target.reset(); load(); }
});

$('import-btn').addEventListener('click', async (ev) => {
  const students = $('csv').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [student_number, full_name, email, faculty] = line.split(',').map((x) => (x || '').trim());
    return { student_number, full_name, email, faculty: faculty || undefined };
  });
  if (!students.length) return flash('Paste at least one line');
  ev.target.disabled = true;
  try {
    const r = await api('/api/students/import', { method: 'POST', body: { students } });
    showReport(r);
  } catch (err) {
    if (err.data && Array.isArray(err.data.errors)) showReport(err.data); // 400 = nothing imported, report says why
    else flash(err.message);
  } finally { ev.target.disabled = false; }
  load();
});

function showReport(r) {
  const lines = [`Imported: ${r.created}`];
  if (r.duplicates.length) lines.push(`Skipped duplicates: ${r.duplicates.map((d) => `row ${d.row} (${d.student_number})`).join(', ')}`);
  if (r.errors.length) lines.push(...r.errors.map((e) => `Row ${e.row}: ${e.message}`));
  $('import-report').textContent = lines.join('\n');
  flash(`Imported ${r.created} student(s)`, r.errors.length || r.duplicates.length ? 'warn' : 'ok');
}

let timer;
$('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
load();
