'use strict';

const fs = require('node:fs');
const path = require('node:path');
const providers = require('../chrome-extension/providers.js');

const manifestPath = path.join(__dirname, '..', 'chrome-extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifest.host_permissions = providers.allOrigins();

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${manifest.host_permissions.length} origins to ${path.relative(process.cwd(), manifestPath)}`);
