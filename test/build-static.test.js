'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { buildStatic } = require('../scripts/build-static.js');
const { PUBLIC_ASSETS, SECURITY_HEADERS } = require('../serve.js');

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('build emits only the public asset allow-list and SWA configuration', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'too-many-tokens-'));
  temporaryDirectories.push(temporaryDirectory);
  const outputDirectory = path.join(temporaryDirectory, 'dist');

  buildStatic(outputDirectory);

  const expectedAssets = [...new Set(
    [...PUBLIC_ASSETS.keys()].filter((requestPath) => requestPath !== '/')
      .map((requestPath) => requestPath.slice(1))
  )];
  assert.deepEqual(
    fs.readdirSync(outputDirectory).sort(),
    [...expectedAssets, 'staticwebapp.config.json'].sort()
  );

  const configuration = JSON.parse(
    fs.readFileSync(path.join(outputDirectory, 'staticwebapp.config.json'), 'utf8')
  );
  assert.deepEqual(configuration, { globalHeaders: SECURITY_HEADERS });
});
