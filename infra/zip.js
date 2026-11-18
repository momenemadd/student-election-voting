// Builds backend/lambda.zip (the one package used by all three Lambda functions).
// Includes only code + node_modules. NEVER includes .env, tests or the zip itself.
// Run from backend/:  npm install && npm run zip
const path = require('path');
const fs = require('fs');
const AdmZip = require(path.join(__dirname, '..', 'backend', 'node_modules', 'adm-zip'));

const root = path.join(__dirname, '..', 'backend');
const zip = new AdmZip();
for (const dir of ['lambda', 'services', 'shared', 'node_modules']) zip.addLocalFolder(path.join(root, dir), dir);
zip.addLocalFile(path.join(root, 'package.json'));

const out = path.join(root, 'lambda.zip');
zip.writeZip(out);
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
