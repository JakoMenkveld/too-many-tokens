'use strict';

let scraperApi = globalThis.UsageScraper;
if (!scraperApi && typeof importScripts === 'function') {
  importScripts('tracker-origins.js', 'providers.js', 'scraper.js');
  scraperApi = globalThis.UsageScraper;
}
if (!scraperApi && typeof require === 'function') {
  scraperApi = require('./scraper.js');
}
const providers = globalThis.UsageProviders
  || (typeof require === 'function' ? require('./providers.js') : null);
const trackerOrigins = globalThis.TrackerOrigins
  || (typeof require === 'function' ? require('./tracker-origins.js') : null);

const TRACKER_URL = trackerOrigins.DEFAULT_TRACKER_URL;
const RELOAD_TIMEOUT_MS = 12_000;
const PRE_SNAPSHOT_SETTLE_MS = 150;
const SNAPSHOT_READINESS_TIMEOUT_MS = 10_000;
const SNAPSHOT_STABILITY_TIMEOUT_MS = 3_000;
const SNAPSHOT_POLL_MS = 200;
const SNAPSHOT_STABLE_DURATION_MS = 750;

function collectPageSnapshot() {
  return {
    body: String(document.body?.innerText || '').slice(0, 250_000),
    page: location.href,
    title: document.title || ''
  };
}

async function collectStablePageSnapshot(options = {}) {
  const maximumWait = Number.isFinite(options.maximumWait)
    ? Math.min(5_000, Math.max(0, options.maximumWait))
    : 3_000;
  const pollInterval = Number.isFinite(options.pollInterval)
    ? Math.min(1_000, Math.max(25, options.pollInterval))
    : 200;
  const stableDuration = Number.isFinite(options.stableDuration)
    ? Math.min(maximumWait, Math.max(0, options.stableDuration))
    : Math.min(maximumWait, 750);
  const startedAt = Date.now();
  let previousBody = null;
  let stableSince = startedAt;
  let snapshot = null;

  while (Date.now() - startedAt <= maximumWait) {
    snapshot = {
      body: String(document.body?.innerText || '').slice(0, 250_000),
      page: location.href,
      title: document.title || ''
    };
    const observedAt = Date.now();
    if (snapshot.body !== previousBody) {
      previousBody = snapshot.body;
      stableSince = observedAt;
    } else if (snapshot.body && observedAt - stableSince >= stableDuration) {
      break;
    }
    const remaining = maximumWait - (observedAt - startedAt);
    if (remaining <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollInterval, remaining)));
  }

  return snapshot || {
    body: '',
    page: location.href,
    title: document.title || ''
  };
}

function isTrackerUrl(value) {
  return trackerOrigins.matchesUrl(value);
}

function isTrustedTrackerSender(sender) {
  return Boolean(sender?.tab?.url && isTrackerUrl(sender.tab.url));
}

function isScannableTab(tab) {
  if (!Number.isInteger(tab?.id) || !tab?.url || isTrackerUrl(tab.url)) {
    return false;
  }

  try {
    const url = new URL(tab.url);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function isDiscoverableProviderTab(tab) {
  if (!isScannableTab(tab)) return false;
  try {
    const url = new URL(tab.url);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    const hashPath = url.hash.replace(/^#\/?/, '/').replace(/\/+$/, '').toLowerCase();
    return providers.PROVIDERS.some((p) => p.matchesRoute(hostname, pathname, hashPath));
  } catch (error) {
    return false;
  }
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function boundedDuration(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(0, number)) : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseUsageResults(snapshot, tabId, tabTitle, nowValue) {
  const parsedPayloads = scraperApi.parseUsageSnapshots(snapshot, nowValue);
  return (Array.isArray(parsedPayloads) ? parsedPayloads : [parsedPayloads])
    .filter((payload) => payload && (payload.currentPercent != null || payload.currentTokens != null))
    .map((payload) => ({
      ...payload,
      tabId,
      tabTitle: tabTitle || payload.modelName
    }));
}

function reloadTabAndWait(tabId, chromeApi = globalThis.chrome, options = {}) {
  const timeoutMs = boundedDuration(options.reloadTimeoutMs, RELOAD_TIMEOUT_MS, RELOAD_TIMEOUT_MS);
  const setTimer = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
  const clearTimer = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout;

  return new Promise((resolve, reject) => {
    let finished = false;
    let timer = null;
    const updates = chromeApi?.tabs?.onUpdated;
    const observesUpdates = Boolean(updates?.addListener);

    function cleanup() {
      if (timer != null) {
        clearTimer(timer);
      }
      if (updates?.removeListener) {
        updates.removeListener(onUpdated);
      }
    }

    function finish(error, tab) {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(tab || null);
    }

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId
        && (changeInfo?.status === 'complete' || tab?.status === 'complete')) {
        finish(null, tab);
      }
    }

    if (observesUpdates) {
      updates.addListener(onUpdated);
    }
    timer = setTimer(() => {
      finish(new Error(`Timed out waiting for tab ${tabId} to finish reloading.`));
    }, timeoutMs);

    if (typeof chromeApi?.tabs?.reload !== 'function') {
      finish(new Error('Browser tab reload is unavailable.'));
      return;
    }

    Promise.resolve()
      .then(() => chromeApi.tabs.reload(tabId))
      .then(() => (finished || observesUpdates ? null : chromeApi.tabs.get(tabId)))
      .then((tab) => {
        if (tab?.status === 'complete') {
          finish(null, tab);
        }
      })
      .catch((error) => finish(error));
  });
}

async function scanTab(tabId, chromeApi = globalThis.chrome, nowValue = Date.now(), options = {}) {
  if (!Number.isInteger(tabId)) {
    return { result: null, results: [], error: 'Invalid tab ID.' };
  }

  try {
    const tab = await chromeApi.tabs.get(tabId);
    if (!isScannableTab(tab)) {
      return { result: null, results: [], error: 'The selected tab cannot be scanned.' };
    }

    const reloadForScan = typeof options.reloadTabAndWait === 'function'
      ? options.reloadTabAndWait
      : reloadTabAndWait;
    await reloadForScan(tabId, chromeApi, options);

    const settleMs = boundedDuration(
      options.settleMs,
      PRE_SNAPSHOT_SETTLE_MS,
      PRE_SNAPSHOT_SETTLE_MS
    );
    const wait = typeof options.sleep === 'function' ? options.sleep : sleep;
    if (settleMs > 0) {
      await wait(settleMs);
    }

    const refreshedTab = await chromeApi.tabs.get(tabId);
    if (!isScannableTab(refreshedTab)) {
      return { result: null, results: [], error: 'The reloaded tab cannot be scanned.' };
    }

    const readinessTimeoutMs = boundedDuration(
      options.snapshotReadinessTimeoutMs,
      SNAPSHOT_READINESS_TIMEOUT_MS,
      SNAPSHOT_READINESS_TIMEOUT_MS
    );
    const stabilityTimeoutMs = boundedDuration(
      options.snapshotStabilityTimeoutMs,
      SNAPSHOT_STABILITY_TIMEOUT_MS,
      SNAPSHOT_STABILITY_TIMEOUT_MS
    );
    const snapshotPollMs = boundedDuration(
      options.snapshotPollMs,
      SNAPSHOT_POLL_MS,
      SNAPSHOT_POLL_MS
    );
    const stableDurationMs = boundedDuration(
      options.snapshotStableDurationMs,
      SNAPSHOT_STABLE_DURATION_MS,
      SNAPSHOT_STABILITY_TIMEOUT_MS
    );
    const retryDelayMs = boundedDuration(
      options.snapshotRetryDelayMs,
      SNAPSHOT_POLL_MS,
      SNAPSHOT_POLL_MS
    );
    const now = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
    const snapshotStartedAt = now();
    let attempts = 0;
    let lastBodyLength = 0;

    while (attempts === 0 || now() - snapshotStartedAt < readinessTimeoutMs) {
      const elapsedMs = Math.max(0, now() - snapshotStartedAt);
      const remainingMs = Math.max(0, readinessTimeoutMs - elapsedMs);
      const [injection] = await chromeApi.scripting.executeScript({
        target: { tabId },
        func: collectStablePageSnapshot,
        args: [{
          maximumWait: Math.min(stabilityTimeoutMs, remainingMs),
          pollInterval: snapshotPollMs,
          stableDuration: stableDurationMs
        }]
      });
      attempts += 1;
      if (!injection?.result) {
        return { result: null, results: [], error: 'The selected tab returned no page data.' };
      }

      lastBodyLength = String(injection.result.body || '').length;
      const results = parseUsageResults(
        injection.result,
        tabId,
        refreshedTab.title,
        nowValue
      );
      if (results.length) {
        return {
          result: results[0],
          results,
          error: null
        };
      }

      const remainingAfterAttemptMs = Math.max(
        0,
        readinessTimeoutMs - (now() - snapshotStartedAt)
      );
      if (remainingAfterAttemptMs <= 0) {
        break;
      }
      if (retryDelayMs > 0) {
        await wait(Math.min(retryDelayMs, remainingAfterAttemptMs));
      }
    }

    const elapsedMs = Math.max(0, Math.round(now() - snapshotStartedAt));
    const attemptLabel = attempts === 1 ? 'attempt' : 'attempts';
    return {
      result: null,
      results: [],
      error: `No supported usage value was found after ${attempts} snapshot ${attemptLabel} over ${elapsedMs} ms (last page text length: ${lastBodyLength}).`
    };
  } catch (error) {
    return {
      result: null,
      results: [],
      error: errorMessage(error, 'The selected tab could not be scanned.')
    };
  }
}

async function listScannableTabs(chromeApi = globalThis.chrome) {
  const tabs = await chromeApi.tabs.query({});
  return tabs
    .filter(isDiscoverableProviderTab)
    .map((tab) => ({ id: tab.id, title: tab.title || tab.url, url: tab.url, status: tab.status || 'complete' }));
}

async function scanTabIds(tabIds, chromeApi = globalThis.chrome, nowValue = Date.now(), options = {}) {
  const uniqueIds = [...new Set((Array.isArray(tabIds) ? tabIds : []).filter(Number.isInteger))].slice(0, 100);
  const scans = await Promise.all(uniqueIds.map((tabId) => scanTab(tabId, chromeApi, nowValue, options)));

  return {
    results: scans.flatMap((scan) => (
      Array.isArray(scan.results) ? scan.results : scan.result ? [scan.result] : []
    )),
    errors: scans.flatMap((scan, index) => (
      scan.error ? [{ tabId: uniqueIds[index], message: scan.error }] : []
    ))
  };
}

async function getAllUsageFromTabs(chromeApi = globalThis.chrome) {
  const tabs = await listScannableTabs(chromeApi);
  return scanTabIds(tabs.map((tab) => tab.id), chromeApi);
}

function handleRuntimeMessage(message, sender, sendResponse, chromeApi = globalThis.chrome) {
  if (!isTrustedTrackerSender(sender)) {
    sendResponse({ ok: false, error: 'Request rejected: untrusted tracker origin.' });
    return false;
  }

  if (message?.type === 'LIST_TABS') {
    listScannableTabs(chromeApi)
      .then((tabs) => sendResponse({ ok: true, tabs }))
      .catch((error) => sendResponse({
        ok: false,
        error: errorMessage(error, 'Unable to list browser tabs.'),
        tabs: []
      }));
    return true;
  }

  if (message?.type === 'SCAN_SELECTED_TABS') {
    scanTabIds(message.details?.tabIds, chromeApi)
      .then(({ results, errors }) => sendResponse({ ok: true, results, errors }))
      .catch((error) => sendResponse({
        ok: false,
        error: errorMessage(error, 'Unable to scan the selected tabs.'),
        results: [],
        errors: []
      }));
    return true;
  }

  if (message?.type === 'POLL_OPEN_TABS') {
    getAllUsageFromTabs(chromeApi)
      .then(({ results, errors }) => sendResponse({ ok: true, results, errors }))
      .catch((error) => sendResponse({
        ok: false,
        error: errorMessage(error, 'Unable to scan open tabs.'),
        results: [],
        errors: []
      }));
    return true;
  }

  sendResponse({ ok: false, error: 'Unsupported extension request.' });
  return false;
}

async function openOrFocusTracker(chromeApi = globalThis.chrome) {
  const tabs = await chromeApi.tabs.query({});
  const trackerTab = tabs.find((tab) => isTrackerUrl(tab.url));
  if (trackerTab?.id != null) {
    await chromeApi.tabs.update(trackerTab.id, { active: true });
    if (trackerTab.windowId != null && chromeApi.windows?.update) {
      await chromeApi.windows.update(trackerTab.windowId, { focused: true });
    }
    return trackerTab.id;
  }

  const created = await chromeApi.tabs.create({ url: TRACKER_URL });
  return created?.id ?? null;
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

if (globalThis.chrome?.action?.onClicked) {
  chrome.action.onClicked.addListener(() => {
    openOrFocusTracker().catch((error) => {
      console.error('Unable to open the LLM tracker:', error);
    });
  });
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    TRACKER_URL,
    collectPageSnapshot,
    collectStablePageSnapshot,
    getAllUsageFromTabs,
    handleRuntimeMessage,
    isScannableTab,
    isDiscoverableProviderTab,
    isTrackerUrl,
    isTrustedTrackerSender,
    listScannableTabs,
    openOrFocusTracker,
    reloadTabAndWait,
    scanTab,
    scanTabIds
  };
}
