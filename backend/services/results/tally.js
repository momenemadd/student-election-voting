// Pure counting logic for the Results service (owner: Mohamed Khaled). No database access here.
const crypto = require('crypto');

// Stable JSON: object keys sorted, so the same data always gives the same text and the same hash.
// Needed because Postgres jsonb does NOT keep key order: plain JSON.stringify would give a
// different hash after the data is read back from the database.
function canonicalStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// rows: one per candidate { position_id, position_title, max_selections, candidate_id, name, votes }
function buildResult(election, turnout, rows, talliedAt) {
  const byPosition = new Map();
  for (const r of rows) {
    if (!byPosition.has(r.position_id)) {
      byPosition.set(r.position_id, {
        position_id: r.position_id, title: r.position_title, max_selections: r.max_selections,
        total_votes: 0, tie: false, candidates: [], winners: [],
      });
    }
    const p = byPosition.get(r.position_id);
    p.candidates.push({ candidate_id: r.candidate_id, name: r.name, votes: r.votes });
    p.total_votes += r.votes;
  }

  for (const p of byPosition.values()) {
    // highest votes first, then name (so the order is the same every time)
    p.candidates.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    const scoring = p.candidates.filter((c) => c.votes > 0); // 0 votes can never win
    const k = p.max_selections;
    if (scoring.length === 0) continue;                       // nobody voted: no winners
    if (scoring.length > k && scoring[k].votes === scoring[k - 1].votes) {
      p.tie = true;                                           // tie at the last winning place
      const line = scoring[k - 1].votes;
      p.winners = scoring.filter((c) => c.votes >= line).map((c) => c.candidate_id);
    } else {
      p.winners = scoring.slice(0, k).map((c) => c.candidate_id);
    }
  }

  return {
    election_id: election.election_id,
    title: election.title,
    tallied_at: talliedAt.toISOString(),
    turnout: {
      eligible: turnout.eligible, voted: turnout.voted,
      percent: turnout.eligible ? Math.round((turnout.voted * 100) / turnout.eligible) : 0,
    },
    positions: [...byPosition.values()],
  };
}

module.exports = { canonicalStringify, sha256, buildResult };