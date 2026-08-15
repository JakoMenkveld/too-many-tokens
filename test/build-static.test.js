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

const projectRoot = path.join(__dirname, '..');

test('build refuses to delete the project directory or an ancestor', () => {
  for (const target of [projectRoot, path.join(projectRoot, '..'), path.join(projectRoot, '.', '')]) {
    assert.throws(
      () => buildStatic(target),
      /is the project directory or one of its ancestors/,
      `expected ${target} to be rejected`
    );
  }

  // The guard must run before anything is removed.
  assert.ok(fs.existsSync(path.join(projectRoot, 'package.json')));
  assert.ok(fs.existsSync(path.join(projectRoot, '.git')));
});

test('build refuses to delete a directory holding files it does not generate', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'too-many-tokens-'));
  temporaryDirectories.push(temporaryDirectory);

  const occupied = path.join(temporaryDirectory, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'important.txt'), 'do not delete me');

  assert.throws(() => buildStatic(occupied), /holds files this build does not generate/);
  assert.equal(fs.readFileSync(path.join(occupied, 'important.txt'), 'utf8'), 'do not delete me');
});

test('build reuses a directory holding only its own previous output', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'too-many-tokens-'));
  temporaryDirectories.push(temporaryDirectory);
  const outputDirectory = path.join(temporaryDirectory, 'dist');

  buildStatic(outputDirectory);
  assert.doesNotThrow(() => buildStatic(outputDirectory));
});
