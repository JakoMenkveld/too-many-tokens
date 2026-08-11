'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BRIDGE_CHANNEL,
  handleWindowMessage,
  sendRuntimeMessage
} = require('../chrome-extension/content-script.js');

function fakeWindow() {
  return {
    location: { origin: 'http://localhost:5074' },
    messages: [],
    postMessage(message, targetOrigin) {
      this.messages.push({ message, targetOrigin });
    }
  };
}

test('valid bridge requests preserve their correlation ID', async () => {
  const win = fakeWindow();
  const chromeApi = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        assert.equal(message.type, 'LIST_TABS');
        callback({ ok: true, tabs: [] });
      }
    }
  };
  const event = {
    source: win,
    origin: win.location.origin,
    data: {
      channel: BRIDGE_CHANNEL,
      direction: 'request',
      type: 'EXTENSION_LIST_TABS',
      requestId: 'request-1'
    }
  };

  assert.equal(await handleWindowMessage(event, win, chromeApi), true);
  assert.equal(win.messages.length, 1);
  assert.equal(win.messages[0].message.requestId, 'request-1');
  assert.equal(win.messages[0].message.payload.ok, true);
  assert.equal(win.messages[0].targetOrigin, win.location.origin);
});

test('messages from another origin are ignored', async () => {
  const win = fakeWindow();
  const handled = await handleWindowMessage({
    source: win,
    origin: 'http://localhost:9999',
    data: {
      channel: BRIDGE_CHANNEL,
      direction: 'request',
      type: 'EXTENSION_LIST_TABS',
      requestId: 'request-2'
    }
  }, win, {});

  assert.equal(handled, false);
  assert.equal(win.messages.length, 0);
});

test('synchronous invalidated-context errors are returned explicitly', async () => {
  const response = await sendRuntimeMessage({
    runtime: {
      sendMessage() {
        throw new Error('Extension context invalidated.');
      }
    }
  }, { type: 'LIST_TABS' });

  assert.equal(response.ok, false);
  assert.match(response.error, /context invalidated/i);
});
