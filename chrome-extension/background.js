'use strict';

let scraperApi = globalThis.UsageScraper;
if (!scraperApi && typeof importScripts === 'function') {
  importScripts('log.js', 'tracker-origins.js', 'providers.js', 'scraper.js');
  scraperApi = globalThis.UsageScraper;
}
if (!scraperApi && typeof require === 'function') {
  scraperApi = require('./scraper.js');
}
const providers = globalThis.UsageProviders
  || (typeof require === 'function' ? require('./providers.js') : null);
const trackerOrigins = globalThis.TrackerOrigins
  || (typeof require === 'function' ? require('./tracker-origins.js') : null);
const trackerLog = globalThis.TrackerLog
  || (typeof require === 'function' ? require('./log.js') : null);
const log = trackerLog.createLogger('worker');

const TRACKER_URL = trackerOrigins.DEFAULT_TRACKER_URL;
const RELOAD_TIMEOUT_MS = 12_000;
const PRE_SNAPSHOT_SETTLE_MS = 150;
const SNAPSHOT_READINESS_TIMEOUT_MS = 10_000;
const SNAPSHOT_STABILITY_TIMEOUT_MS = 3_000;
const SNAPSHOT_POLL_MS = 200;
const SNAPSHOT_STABLE_DURATION_MS = 750;

// Every scan reloads a provider page, so the extension refuses to scan the same
// page more often than this no matter what the dashboard asks for. The page-side
// controls are bounded too, but the page is the part an edited script or any
// trusted tracker origin could change; this is the limit that survives that.
// Raising it deliberately means editing this file -- which is the point.
const SCAN_COOLDOWN_MS = 5 * 60 * 1000;
const SCAN_COOLDOWN_STORAGE_KEY = 'scanCooldowns';
const SCAN_COOLDOWN_MAX_ENTRIES = 50;

// A click in the extension's own popup is the one refresh request Chrome can
// vouch for: it cannot originate from a page. That click earns a shorter floor,
// because a person pressing a button is the non-automated case the 5-minute
// limit exists to distinguish from.
//
// The page is never told this exists and cannot request it. A scan only gets the
// shorter floor if a popup gesture was recorded here in the last few seconds,
// and the gesture is consumed by the first scan that uses it, so it buys exactly
// one refresh of the current selection.
const MANUAL_SCAN_COOLDOWN_MS = 60 * 1000;
const MANUAL_GESTURE_TTL_MS = 30 * 1000;
const MANUAL_GESTURE_STORAGE_KEY = 'manualGestureAt';

let manualGestureFallback = null;

// Used only when chrome.storage.session is unavailable. In the extension it
// always is, and session storage is what keeps the limit alive across service
// worker eviction -- a plain module variable would reset every ~30 idle seconds.
const scanCooldownFallback = new Map();

// Keyed on the normalized URL rather than the tab ID, so closing and reopening
// the tab does not hand out a fresh allowance.
function scanCooldownKey(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname.toLowerCase()}`;
  } catch (error) {
    return '';
  }
}

async function readScanCooldowns(chromeApi) {
  const store = chromeApi?.storage?.session;
  if (!store?.get) return new Map(scanCooldownFallback);
  try {
    const stored = await store.get(SCAN_COOLDOWN_STORAGE_KEY);
    const entries = stored?.[SCAN_COOLDOWN_STORAGE_KEY];
    return entries && typeof entries === 'object' ? new Map(Object.entries(entries)) : new Map();
  } catch (error) {
    return new Map(scanCooldownFallback);
  }
}

async function writeScanCooldowns(chromeApi, cooldowns, nowValue) {
  const fresh = [...cooldowns.entries()]
    .filter(([, at]) => Number.isFinite(Number(at)) && nowValue - Number(at) < SCAN_COOLDOWN_MS)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, SCAN_COOLDOWN_MAX_ENTRIES);

  scanCooldownFallback.clear();
  fresh.forEach(([key, at]) => scanCooldownFallback.set(key, at));

  const store = chromeApi?.storage?.session;
  if (!store?.set) return;
  try {
    await store.set({ [SCAN_COOLDOWN_STORAGE_KEY]: Object.fromEntries(fresh) });
  } catch (error) {
    // Session storage being unavailable must not turn into an unlimited scanner;
    // the in-memory fallback above still holds the limit for this worker.
  }
}

function describeCooldownWait(milliseconds) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

async function claimScanAllowance(url, chromeApi, nowValue, cooldownMs = SCAN_COOLDOWN_MS) {
  const key = scanCooldownKey(url);
  if (!key) return { allowed: true, retryAfterMs: 0 };
  // Never longer than the standard floor and never shorter than the manual one,
  // whatever a caller passes.
  const window = Math.min(SCAN_COOLDOWN_MS, Math.max(MANUAL_SCAN_COOLDOWN_MS, Number(cooldownMs) || 0));

  // Callers pass either a Date or epoch milliseconds; store one type.
  const parsedNow = Number(nowValue);
  const at = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const cooldowns = await readScanCooldowns(chromeApi);
  const last = Number(cooldowns.get(key));
  if (Number.isFinite(last)) {
    const elapsed = at - last;
    if (elapsed >= 0 && elapsed < window) {
      return { allowed: false, retryAfterMs: window - elapsed };
    }
  }

  cooldowns.set(key, at);
  await writeScanCooldowns(chromeApi, cooldowns, at);
  return { allowed: true, retryAfterMs: 0 };
}

async function recordManualGesture(chromeApi, nowValue) {
  const at = Number(nowValue);
  manualGestureFallback = Number.isFinite(at) ? at : Date.now();
  const store = chromeApi?.storage?.session;
  if (!store?.set) return;
  try {
    await store.set({ [MANUAL_GESTURE_STORAGE_KEY]: manualGestureFallback });
  } catch (error) {
    // The in-memory copy still covers this worker's lifetime.
  }
}

// One-shot: reading the gesture also clears it, so a single popup click cannot
// keep granting the shorter floor to scan after scan.
async function consumeManualGesture(chromeApi, nowValue) {
  const now = Number(nowValue);
  const at = Number.isFinite(now) ? now : Date.now();
  const store = chromeApi?.storage?.session;
  let recordedAt = manualGestureFallback;
  if (store?.get) {
    try {
      const stored = await store.get(MANUAL_GESTURE_STORAGE_KEY);
      const value = Number(stored?.[MANUAL_GESTURE_STORAGE_KEY]);
      if (Number.isFinite(value)) recordedAt = value;
    } catch (error) {
      // Fall back to the in-memory copy.
    }
  }

  manualGestureFallback = null;
  if (store?.remove) {
    try {
      await store.remove(MANUAL_GESTURE_STORAGE_KEY);
    } catch (error) {
      // Already cleared in memory; the TTL below covers a stale stored value.
    }
  }

  const elapsed = at - Number(recordedAt);
  return Number.isFinite(Number(recordedAt)) && elapsed >= 0 && elapsed <= MANUAL_GESTURE_TTL_MS;
}

// Test seam only. There is deliberately no message type that clears the
// cooldown, so the dashboard page cannot reset its own limit.
function resetScanCooldowns() {
  scanCooldownFallback.clear();
  manualGestureFallback = null;
}

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

// The popup runs at this extension's own chrome-extension:// origin and has no
// sender.tab. A web page cannot forge that origin, which is exactly why a click
// arriving here is worth more than one a page claims to have seen.
function isExtensionUiSender(sender, chromeApi = globalThis.chrome) {
  const extensionId = sender?.id;
  if (!extensionId || (chromeApi?.runtime?.id && extensionId !== chromeApi.runtime.id)) {
    return false;
  }
  if (sender.tab) return false;
  try {
    return new URL(String(sender.url || '')).protocol === 'chrome-extension:';
  } catch (error) {
    return false;
  }
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
    log.debug(`Scan starting for tab ${tabId}`, { url: tab?.url, status: tab?.status });
    if (!isScannableTab(tab)) {
      log.warn(`Scan refused for tab ${tabId}: not a scannable tab`, tab?.url);
      return { result: null, results: [], error: 'The selected tab cannot be scanned.' };
    }

    // Claimed before the reload, so a rejected scan never touches the provider.
    const allowance = await claimScanAllowance(tab.url, chromeApi, nowValue, options.cooldownMs);
    if (!allowance.allowed) {
      log.warn(
        `Scan refused for tab ${tabId}: cooldown, ${Math.round(allowance.retryAfterMs / 1000)}s remaining`,
        { key: scanCooldownKey(tab.url) }
      );
      return {
        result: null,
        results: [],
        error: `Rate limited: this page was scanned too recently. Next scan in ${describeCooldownWait(allowance.retryAfterMs)}.`,
        retryAfterMs: allowance.retryAfterMs
      };
    }

    const reloadForScan = typeof options.reloadTabAndWait === 'function'
      ? options.reloadTabAndWait
      : reloadTabAndWait;
    log.debug(`Allowance claimed for tab ${tabId}; reloading`);
    await reloadForScan(tabId, chromeApi, options);
    log.debug(`Tab ${tabId} finished reloading`);

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
      log.warn(`Tab ${tabId} is no longer scannable after reloading`, refreshedTab?.url);
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
        log.warn(`Tab ${tabId} returned no page data on attempt ${attempts}`);
        return { result: null, results: [], error: 'The selected tab returned no page data.' };
      }

      lastBodyLength = String(injection.result.body || '').length;
      const results = parseUsageResults(
        injection.result,
        tabId,
        refreshedTab.title,
        nowValue
      );
      // Page text length, not the text itself: enough to tell 'the page had not
      // rendered yet' apart from 'it rendered and the scraper matched nothing'.
      log.debug(
        `Snapshot ${attempts} for tab ${tabId}: ${lastBodyLength} chars of page text, ${results.length} quota(s) parsed`
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
    log.warn(`Tab ${tabId} produced no usable quota after ${attempts} ${attemptLabel} over ${elapsedMs} ms`);
    return {
      result: null,
      results: [],
      error: `No supported usage value was found after ${attempts} snapshot ${attemptLabel} over ${elapsedMs} ms (last page text length: ${lastBodyLength}).`
    };
  } catch (error) {
    log.error(`Scan of tab ${tabId} threw`, error);
    return {
      result: null,
      results: [],
      error: errorMessage(error, 'The selected tab could not be scanned.')
    };
  }
}

async function listScannableTabs(chromeApi = globalThis.chrome) {
  const tabs = await chromeApi.tabs.query({});
  const discoverable = tabs
    .filter(isDiscoverableProviderTab)
    .map((tab) => ({ id: tab.id, title: tab.title || tab.url, url: tab.url, status: tab.status || 'complete' }));
  // Both halves matter when discovery comes back empty: no visible tabs at all
  // means the host permissions are not granted, while visible-but-unmatched
  // means the provider registry did not recognise the route.
  log.debug(
    `Tab discovery: ${discoverable.length} provider tab(s) matched, ${tabs.length} visible to the extension`,
    { matched: discoverable.map((tab) => tab.url), visible: tabs.map((tab) => tab.url || '(no url)') }
  );
  return discoverable;
}

async function scanTabIds(tabIds, chromeApi = globalThis.chrome, nowValue = Date.now(), options = {}) {
  const uniqueIds = [...new Set((Array.isArray(tabIds) ? tabIds : []).filter(Number.isInteger))].slice(0, 100);
  const scans = await Promise.all(uniqueIds.map((tabId) => scanTab(tabId, chromeApi, nowValue, options)));

  return {
    results: scans.flatMap((scan) => (
      Array.isArray(scan.results) ? scan.results : scan.result ? [scan.result] : []
    )),
    errors: scans.flatMap((scan, index) => (
      scan.error
        ? [{
          tabId: uniqueIds[index],
          message: scan.error,
          ...(Number.isFinite(scan.retryAfterMs) ? { retryAfterMs: scan.retryAfterMs } : {})
        }]
        : []
    ))
  };
}

async function getAllUsageFromTabs(chromeApi = globalThis.chrome) {
  const tabs = await listScannableTabs(chromeApi);
  return scanTabIds(tabs.map((tab) => tab.id), chromeApi);
}

function handleRuntimeMessage(message, sender, sendResponse, chromeApi = globalThis.chrome) {
  log.debug(`Message received: ${message?.type || '(no type)'}`, {
    from: sender?.tab?.url || sender?.url || '(unknown sender)',
    tabId: sender?.tab?.id ?? null
  });

  if (isExtensionUiSender(sender, chromeApi)) {
    if (message?.type === 'POPUP_OPEN_TRACKER') {
      openOrFocusTracker(chromeApi)
        .then((tabId) => sendResponse({ ok: true, tabId }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error, 'Unable to open the tracker.') }));
      return true;
    }

    if (message?.type === 'POPUP_REFRESH_NOW') {
      requestTrackerRefresh(chromeApi)
        .then((outcome) => sendResponse({ ok: true, ...outcome }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error, 'Unable to request a refresh.') }));
      return true;
    }

    sendResponse({ ok: false, error: 'Unsupported extension request.' });
    return false;
  }

  if (!isTrustedTrackerSender(sender)) {
    log.warn('Rejected: sender is not a trusted tracker origin', {
      sender: sender?.tab?.url || sender?.url || '(unknown sender)',
      trusted: trackerOrigins.TRACKERS.map((tracker) => tracker.url)
    });
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
    // The page cannot ask for the shorter floor. It is granted only if a popup
    // click was recorded here moments ago, and consuming it spends it.
    consumeManualGesture(chromeApi, Date.now())
      .then((manual) => {
        log.debug(`Scanning ${(message.details?.tabIds || []).length} tab(s)`, {
          tabIds: message.details?.tabIds,
          cooldown: manual ? '60s (popup gesture)' : '5m (standard)'
        });
        return scanTabIds(message.details?.tabIds, chromeApi, Date.now(), {
          cooldownMs: manual ? MANUAL_SCAN_COOLDOWN_MS : SCAN_COOLDOWN_MS
        });
      })
      .then(({ results, errors }) => {
        log.debug(`Scan finished: ${results.length} quota(s), ${errors.length} failure(s)`, { errors });
        sendResponse({ ok: true, results, errors });
      })
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

// The popup does not scan directly. It records the gesture and asks the open
// dashboard to run its normal refresh, so results land in the page's storage by
// the same path as every other scan -- there is no second way in.
async function requestTrackerRefresh(chromeApi = globalThis.chrome, nowValue = Date.now()) {
  const tabs = await chromeApi.tabs.query({});
  const trackerTab = tabs.find((tab) => isTrackerUrl(tab.url));
  if (!trackerTab?.id) {
    log.debug('No dashboard tab open; opening one', { trusted: trackerOrigins.TRACKERS.map((t) => t.url) });
    const tabId = await openOrFocusTracker(chromeApi);
    return { refreshed: false, opened: true, tabId, message: 'Opened the dashboard. Press Sync there once it loads.' };
  }

  await recordManualGesture(chromeApi, nowValue);
  try {
    await chromeApi.tabs.sendMessage(trackerTab.id, { type: 'TRACKER_REFRESH_NOW' });
    log.debug(`Refresh command delivered to dashboard tab ${trackerTab.id}`);
  } catch (error) {
    // Almost always the content script missing from that tab: either the page
    // predates the last extension reload, or its origin is not in the manifest.
    log.error(`Dashboard tab ${trackerTab.id} did not receive the refresh command`, error);
    // The refresh never reached the page, so give the allowance back rather than
    // leaving it armed for whatever scan happens to come along next.
    await consumeManualGesture(chromeApi, nowValue);
    return {
      refreshed: false,
      opened: false,
      tabId: trackerTab.id,
      message: 'The dashboard tab did not respond. Refresh it, then try again.'
    };
  }
  return { refreshed: true, opened: false, tabId: trackerTab.id, message: 'Refreshing the dashboard…' };
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

// This runs on every wake, not just on install: MV3 evicts the worker after
// roughly 30 idle seconds and re-evaluates this file when the next message
// arrives, so each of these lines marks a fresh worker.
if (globalThis.chrome?.runtime?.id) {
  log.debug('Service worker started', {
    version: chrome.runtime.getManifest?.().version,
    trackerOrigins: trackerOrigins.TRACKERS.map((tracker) => tracker.url),
    providerOrigins: providers.allOrigins(),
    scanCooldown: `${SCAN_COOLDOWN_MS / 60000}m`
  });

  chrome.runtime.onInstalled?.addListener?.((details) => {
    log.debug(`Extension ${details?.reason || 'installed'}`, details);
  });

  chrome.runtime.onStartup?.addListener?.(() => {
    log.debug('Browser started');
  });
}

// No action.onClicked listener: the manifest declares a default_popup, and
// Chrome does not fire onClicked when one is set. Opening the tracker is now the
// popup's "Open dashboard" button, routed through POPUP_OPEN_TRACKER.

if (typeof module === 'object' && module.exports) {
  module.exports = {
    MANUAL_GESTURE_TTL_MS,
    MANUAL_SCAN_COOLDOWN_MS,
    SCAN_COOLDOWN_MS,
    TRACKER_URL,
    claimScanAllowance,
    consumeManualGesture,
    isExtensionUiSender,
    recordManualGesture,
    requestTrackerRefresh,
    collectPageSnapshot,
    collectStablePageSnapshot,
    scanCooldownKey,
    getAllUsageFromTabs,
    handleRuntimeMessage,
    isScannableTab,
    isDiscoverableProviderTab,
    isTrackerUrl,
    isTrustedTrackerSender,
    listScannableTabs,
    openOrFocusTracker,
    reloadTabAndWait,
    resetScanCooldowns,
    scanTab,
    scanTabIds
  };
}
