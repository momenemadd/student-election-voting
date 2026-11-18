// ST-06: fire N parallel votes from the SAME student; exactly one must be 201, the rest 409.
// Usage: STUDENT_TOKEN=... ELECTION_ID=... POSITION_ID=... CANDIDATE_ID=... node tests/race-test.js
const api = process.env.API || 'http://localhost:3000';
const { STUDENT_TOKEN, ELECTION_ID, POSITION_ID, CANDIDATE_ID } = process.env;
if (!STUDENT_TOKEN || !ELECTION_ID || !POSITION_ID || !CANDIDATE_ID) { console.error('Set STUDENT_TOKEN, ELECTION_ID, POSITION_ID, CANDIDATE_ID'); process.exit(1); }

const vote = () => fetch(`${api}/api/elections/${ELECTION_ID}/votes`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${STUDENT_TOKEN}` },
  body: JSON.stringify({ selections: [{ position_id: POSITION_ID, candidate_id: CANDIDATE_ID }], turnstileToken: process.env.TURNSTILE_TOKEN || 'XXXX.DUMMY.TOKEN' }),
}).then((r) => r.status);

Promise.all(Array.from({ length: 20 }, vote)).then((codes) => {
  const tally = codes.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {});
  console.log(tally);
  console.log(tally[201] === 1 ? 'PASS: exactly one vote accepted' : 'FAIL: expected exactly one 201');
});
