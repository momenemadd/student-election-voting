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

module.exports = { enabled, put, get, keyOf };