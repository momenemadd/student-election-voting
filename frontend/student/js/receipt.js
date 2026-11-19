// Student: my own receipt.  API: GET /api/elections/:id/receipt
guard('STUDENT');
renderNav('My elections');

const id = qs('id');
let ref;

(async () => {
  if (!id) return flash('No election selected');
  const r = await act(null, () => api(`/api/elections/${encodeURIComponent(id)}/receipt`));
  if (!r) return;
  ref = r.receipt_ref;
  document.getElementById('r-title').textContent = r.title;
  document.getElementById('r-date').textContent = new Date(r.voted_on + 'T00:00:00').toLocaleDateString();
  document.getElementById('r-ref').textContent = r.receipt_ref;
  document.getElementById('receipt').hidden = false;
})();

// Checked in the browser only: the code is never sent to the server again.
document.getElementById('check-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const code = document.getElementById('check-code').value.trim().toUpperCase();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.slice(0, 8) === ref) flash('This code matches your receipt ✔', 'ok');
  else flash('This code does not match your receipt');
});
