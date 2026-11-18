// Election lifecycle (state machine) shared by all services. Rules live here once, so the
// Election, Voting and Results services cannot disagree.
//
// DRAFT -> SCHEDULED -> OPEN -> CLOSED -> TALLIED -> PUBLISHED      (DRAFT/SCHEDULED -> CANCELLED)
//
// SCHEDULED->OPEN and OPEN->CLOSED happen automatically by time. We apply them lazily
// (syncStatus, using the DATABASE clock) on every read/vote, so correctness never depends on a
// scheduler firing. EventBridge Scheduler (optional) just calls the same function at the right moment.
const { AppError } = require('./errors');

const TRANSITIONS = {
  DRAFT: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['OPEN', 'CANCELLED'],
  OPEN: ['CLOSED'],
  CLOSED: ['TALLIED'],
  TALLIED: ['PUBLISHED'],
  PUBLISHED: [],
  CANCELLED: [],
};

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'INVALID_TRANSITION', `Election cannot move from ${from} to ${to}`);
  }
}

// Which fields/items may still be edited in which state.
const canEditSetup = (status) => status === 'DRAFT'; // positions, candidates, eligibility
const canEditDetails = (status) => status === 'DRAFT' || status === 'SCHEDULED'; // title, window

// Pure function (unit-tested): what status the election should have at time `now`.
function timeBasedStatus(election, now = new Date()) {
  let status = election.status;
  const start = new Date(election.start_time);
  const end = new Date(election.end_time);
  if (status === 'SCHEDULED' && now >= start) status = 'OPEN';
  if (status === 'OPEN' && now >= end) status = 'CLOSED';
  return status;
}

// Apply time-based transitions in the database and return the fresh election row (or undefined).
async function syncStatus(runQuery, electionId) {
  await runQuery(
    `UPDATE elections SET status='CLOSED', updated_at=now()
      WHERE election_id=$1 AND status IN ('SCHEDULED','OPEN') AND end_time <= now()`,
    [electionId]
  );
  await runQuery(
    `UPDATE elections SET status='OPEN', updated_at=now()
      WHERE election_id=$1 AND status='SCHEDULED' AND start_time <= now() AND end_time > now()`,
    [electionId]
  );
  const { rows } = await runQuery('SELECT * FROM elections WHERE election_id=$1', [electionId]);
  return rows[0];
}

module.exports = { TRANSITIONS, canTransition, assertTransition, canEditSetup, canEditDetails, timeBasedStatus, syncStatus };
