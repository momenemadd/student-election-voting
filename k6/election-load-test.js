// Lab 8: load test for the Student Election API with Grafana k6.
// Run through the helper (it reads the admin login from backend/.env without printing it):
//   bash infra/load-test.sh run-a        # or run-b / run-c, against http://localhost:8080
// Plain k6:  k6 run -e BASE_URL=http://localhost:8080 -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... k6/election-load-test.js
//
// VU = one simulated user looping over the mix below. p(95) = 95% of requests were faster than this.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  stages: [
    { duration: '30s', target: 15 }, // ramp-up
    { duration: '60s', target: 15 }, // steady
    { duration: '20s', target: 50 }, // spike
    { duration: '40s', target: 50 }, // hold the spike
    { duration: '30s', target: 0 },  // ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // the slow tail is what users notice
    http_req_failed: ['rate<0.05'],   // fewer than 5% failed (5xx or no answer)
  },
};

// Which worker answered (header X-Instance-Id) - shows round robin and failover in the summary.
const servedBy = {
  'ecs-task-vertical': new Counter('served_by_ecs_task_vertical'),
  'ecs-task-1': new Counter('served_by_ecs_task_1'),
  'ecs-task-2': new Counter('served_by_ecs_task_2'),
  'ecs-task-3': new Counter('served_by_ecs_task_3'),
  'ecs-task-4': new Counter('served_by_ecs_task_4'),
};
const servedByOther = new Counter('served_by_other');
const rateLimited = new Counter('rate_limited_429');

// Runs once: log in as admin (one login, not one per request) and find elections to read.
export function setup() {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({
    email: __ENV.ADMIN_EMAIL, password: __ENV.ADMIN_PASSWORD, turnstileToken: 'XXXX.DUMMY.TOKEN',
  }), { headers: { 'Content-Type': 'application/json' } });
  if (res.status !== 200) throw new Error(`setup login failed: ${res.status} ${res.body}`);
  const token = res.json('token');
  const list = http.get(`${BASE}/api/elections`, { headers: { Authorization: `Bearer ${token}` } });
  const ids = (list.json() || []).map((e) => e.election_id);
  if (!ids.length) throw new Error('no elections to read - create one first');
  return { token, ids };
}

// The mix each VU repeats: 60% list elections, 20% one election, 10% its positions, 10% health check.
export default function (data) {
  const auth = { headers: { Authorization: `Bearer ${data.token}` } };
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const r = Math.random();
  let res;
  if (r < 0.6) res = http.get(`${BASE}/api/elections`, Object.assign({ tags: { name: 'list elections' } }, auth));
  else if (r < 0.8) res = http.get(`${BASE}/api/elections/${id}`, Object.assign({ tags: { name: 'one election' } }, auth));
  else if (r < 0.9) res = http.get(`${BASE}/api/elections/${id}/positions`, Object.assign({ tags: { name: 'positions' } }, auth));
  else res = http.get(`${BASE}/api/health`, { tags: { name: 'health' } });

  check(res, { 'status is 200': (x) => x.status === 200 });
  if (res.status === 429) rateLimited.add(1);
  const who = res.headers['X-Instance-Id'];
  (servedBy[who] || servedByOther).add(1);
  sleep(1);
}
