// setup-all.sh copies this to config.js and fills in the API address. Locally the API is on :3000.
const API_BASE = location.port === '8080' ? 'http://localhost:3000' : 'http://28a0b6493f.execute-api.localhost.floci.io:4566';
