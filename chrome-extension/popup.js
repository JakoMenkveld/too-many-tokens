'use strict';

// This popup never scans or stores anything itself. It asks the service worker
// to record the click and hand the existing dashboard its normal refresh, so
// there is exactly one code path that reads a provider page.

const refreshButton = document.getElementById('refresh');
const openButton = document.getElementById('open');
const statusBox = document.getElementById('status');

function setStatus(text, tone = '') {
  statusBox.textContent = text;
  statusBox.className = tone;
}

function sendMessage(type) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || 'The extension did not respond.' });
          return;
        }
        resolve(response || { ok: false, error: 'The extension returned an empty response.' });
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : 'The extension is unavailable.' });
    }
  });
}

async function run(button, type, busyText) {
  refreshButton.disabled = true;
  openButton.disabled = true;
  setStatus(busyText);

  const response = await sendMessage(type);
  if (!response.ok) {
    setStatus(response.error || 'That did not work.', 'error');
    refreshButton.disabled = false;
    openButton.disabled = false;
    return;
  }

  setStatus(response.message || 'Done.', 'ok');
  // The dashboard reports the outcome of the scan itself, including a rate
  // limit, so the popup closes rather than duplicating that status here.
  if (type === 'POPUP_REFRESH_NOW' && response.refreshed) {
    setTimeout(() => window.close(), 600);
    return;
  }
  if (type === 'POPUP_OPEN_TRACKER') {
    window.close();
    return;
  }
  refreshButton.disabled = false;
  openButton.disabled = false;
}

refreshButton.addEventListener('click', () => {
  void run(refreshButton, 'POPUP_REFRESH_NOW', 'Asking the dashboard to refresh…');
});

openButton.addEventListener('click', () => {
  void run(openButton, 'POPUP_OPEN_TRACKER', 'Opening…');
});
