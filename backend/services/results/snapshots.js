// S3 helpers for the saved results file (owner: Mohamed Khaled). Key: snapshots/<election_id>.json
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

let client;
const s3 = () => client || (client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', forcePathStyle: true }));
const enabled = () => !!process.env.RESULTS_BUCKET;   // empty on a local PC: the database copy is used
const keyOf = (id) => `snapshots/${id}.json`;

async function put(id, text) {
  await s3().send(new PutObjectCommand({
    Bucket: process.env.RESULTS_BUCKET, Key: keyOf(id), Body: text, ContentType: 'application/json',
  }));
}

async function get(id) {
  const out = await s3().send(new GetObjectCommand({ Bucket: process.env.RESULTS_BUCKET, Key: keyOf(id) }));
  return out.Body.transformToString();
}

// Added by Mo'men: an S3 "object not found" answer, so callers can tell "missing" from other errors.
const isMissing = (err) => !!err && (err.name === 'NoSuchKey' || err.name === 'NotFound' ||
  (err.$metadata && err.$metadata.httpStatusCode === 404));

// Added by Mo'men: if the upload after counting ever failed, counting again puts the file back.
async function ensure(id, text) {
  try {
    await get(id);
    return false; // already there
  } catch (err) {
    if (!isMissing(err)) throw err;
    await put(id, text);
    return true; // restored
  }
}

module.exports = { enabled, put, get, keyOf, isMissing, ensure };