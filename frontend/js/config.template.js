// setup-all.sh copies this to config.js and fills in the API address. Locally the API is on :3000.
const API_BASE = location.port === '8080' ? 'http://localhost:3000' : '__API_URL__';
