'use strict';

const fs = require('node:fs');
const path = require('node:path');
const providers = require('../chrome-extension/providers.js');
const trackerOrigins = require('../chrome-extension/tracker-origins.js');

const manifestPath = path.join(__dirname, '..', 'chrome-extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifest.host_permissions = providers.allOrigins();
manifest.content_scripts[0].matches = trackerOrigins.allMatchPatterns();

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${manifest.host_permissions.length} provider origins and ${manifest.content_scripts[0].matches.length} tracker origins to ${path.relative(process.cwd(), manifestPath)}`);
