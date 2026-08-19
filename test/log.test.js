'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const logPath = require.resolve('../chrome-extension/log.js');

// log.js binds to whatever `globalThis` looked like when it was loaded, so each
// case needs a fresh module instance rather than a shared one.
function loadLogger() {
  delete require.cache[logPath];
  return require(logPath);
}

function captureConsole(run) {
  const lines = [];
  const original = { debug: console.debug, warn: console.warn, error: console.error };
  ['debug', 'warn', 'error'].forEach((method) => {
    console[method] = (...args) => lines.push({ method, args });
  });
  try {
    run();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

test('the logger stays silent outside an extension, so test output is not buried', () => {
  const { createLogger } = loadLogger();
  const log = createLogger('worker');
  const lines = captureConsole(() => {
    log.debug('routine');
    log.warn('trouble');
    log.error('broken');
  });
  assert.strictEqual(lines.length, 0);
});

test('the logger writes to the right console level inside an extension', () => {
  globalThis.chrome = { runtime: { id: 'test-extension-id' } };
  try {
    const { createLogger } = loadLogger();
    const log = createLogger('worker');
    const lines = captureConsole(() => {
      log.debug('routine');
      log.warn('trouble', { tabId: 7 });
    });

    assert.deepStrictEqual(lines.map((line) => line.method), ['debug', 'warn']);
    // Prefix, style, message -- and the detail only when one was passed.
    assert.strictEqual(lines[0].args.length, 3);
    assert.match(lines[0].args[0], /\[TMT worker\]/);
    assert.strictEqual(lines[0].args[2], 'routine');
    assert.deepStrictEqual(lines[1].args[3], { tabId: 7 });
  } finally {
    delete globalThis.chrome;
    delete require.cache[logPath];
  }
});

test('every extension entry point loads the logger', () => {
  const fs = require('node:fs');
  ['background.js', 'content-script.js'].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', file), 'utf8');
    assert.match(source, /TrackerLog/, `${file} should create a logger`);
  });

  const manifest = require('../chrome-extension/manifest.json');
  assert.ok(
    manifest.content_scripts[0].js.indexOf('log.js') === 0,
    'log.js must load before content-script.js'
  );
  const popup = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'popup.html'), 'utf8');
  assert.ok(popup.indexOf('log.js') < popup.indexOf('popup.js'), 'popup.html must load log.js first');
});
