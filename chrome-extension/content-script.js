'use strict';

const trackerLog = globalThis.TrackerLog
  || (typeof require === 'function' ? require('./log.js') : null);
const log = trackerLog.createLogger('content');

const BRIDGE_CHANNEL = 'llm-run-rate-tracker';
const REQUEST_TYPES = {
  EXTENSION_LIST_TABS: 'LIST_TABS',
  EXTENSION_SCAN_TABS: 'SCAN_SELECTED_TABS'
};

function postBridgeResponse(win, requestType, requestId, payload) {
  win.postMessage({
    channel: BRIDGE_CHANNEL,
    direction: 'response',
    type: `${requestType}_RESPONSE`,
    requestId,
    payload
  }, win.location.origin);
}

function sendRuntimeMessage(chromeApi, message) {
  return new Promise((resolve) => {
    if (!chromeApi?.runtime?.sendMessage) {
      // Orphaned content script: the extension was reloaded underneath this page.
      log.error('Extension context is gone -- this page needs reloading');
      resolve({ ok: false, error: 'Extension context unavailable. Reload the tracker page.' });
      return;
    }

    try {
      chromeApi.runtime.sendMessage(message, (response) => {
        const lastError = chromeApi.runtime.lastError;
        if (lastError) {
          log.error(`Service worker did not answer ${message?.type}`, lastError.message);
          resolve({
            ok: false,
            error: lastError.message || 'The extension service worker did not respond.'
          });
          return;
        }

        resolve(response || { ok: false, error: 'The extension returned an empty response.' });
      });
    } catch (error) {
      resolve({
        ok: false,
        error: error instanceof Error ? error.message : 'Extension context unavailable. Reload the tracker page.'
      });
    }
  });
}

async function handleWindowMessage(event, win = globalThis.window, chromeApi = globalThis.chrome) {
  const message = event?.data;
  if (
    event?.source !== win
    || event.origin !== win.location.origin
    || message?.channel !== BRIDGE_CHANNEL
    || message?.direction !== 'request'
    || typeof message.requestId !== 'string'
    || !REQUEST_TYPES[message.type]
  ) {
    return false;
  }

  log.debug(`Forwarding ${message.type} to the service worker`, { requestId: message.requestId });
  const response = await sendRuntimeMessage(chromeApi, {
    type: REQUEST_TYPES[message.type],
    details: message.details || {}
  });
  log.debug(`Answering ${message.type}`, { requestId: message.requestId, ok: response?.ok, error: response?.error });
  postBridgeResponse(win, message.type, message.requestId, response);
  return true;
}

// The only message the extension pushes to the page unprompted. It carries no
// data and grants the page nothing it could not already do by itself -- the page
// can always start its own scan. It exists so a popup click reaches the normal
// refresh path instead of the extension growing a second way to write results.
function postBridgeCommand(win, type) {
  win.postMessage({
    channel: BRIDGE_CHANNEL,
    direction: 'command',
    type
  }, win.location.origin);
}

function handleRuntimeCommand(message, win = globalThis.window) {
  if (message?.type !== 'TRACKER_REFRESH_NOW') return false;
  log.debug('Popup asked this page to refresh');
  postBridgeCommand(win, 'EXTENSION_REFRESH_NOW');
  return true;
}

if (globalThis.chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only the service worker of this same extension can reach a content script.
    const handled = handleRuntimeCommand(message);
    sendResponse({ ok: handled });
    return false;
  });
}

// The first line the page console shows. If it is absent, the content script
// was never injected here -- check the origin against the manifest's
// content_scripts matches -- and every bridge request will time out untouched.
if (globalThis.chrome?.runtime?.id) {
  log.debug(`Bridge ready on ${globalThis.location?.origin}`);
}

if (globalThis.window?.addEventListener) {
  window.addEventListener('message', (event) => {
    handleWindowMessage(event).catch((error) => {
      const message = event?.data;
      if (message?.type && message?.requestId) {
        postBridgeResponse(window, message.type, message.requestId, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unexpected extension bridge error.'
        });
      }
    });
  });
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    BRIDGE_CHANNEL,
    REQUEST_TYPES,
    handleRuntimeCommand,
    handleWindowMessage,
    postBridgeCommand,
    postBridgeResponse,
    sendRuntimeMessage
  };
}
