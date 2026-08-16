'use strict';

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  MANUAL_SCAN_COOLDOWN_MS,
  SCAN_COOLDOWN_MS,
  claimScanAllowance,
  consumeManualGesture,
  isExtensionUiSender,
  recordManualGesture,
  requestTrackerRefresh,
  collectPageSnapshot,
  collectStablePageSnapshot,
  handleRuntimeMessage,
  isDiscoverableProviderTab,
  isScannableTab,
  isTrackerUrl,
  isTrustedTrackerSender,
  reloadTabAndWait,
  listScannableTabs,
  resetScanCooldowns,
  scanCooldownKey,
  scanTab,
  scanTabIds
} = require('../chrome-extension/background.js');
const trackerOrigins = require('../chrome-extension/tracker-origins.js');

// The scan cooldown is intentionally process-wide state, so it leaks between
// tests unless cleared. Each test starts with a fresh allowance.
beforeEach(() => resetScanCooldowns());

const FAST_SCAN_OPTIONS = {
  settleMs: 0,
  snapshotReadinessTimeoutMs: 0,
  snapshotRetryDelayMs: 0,
  snapshotStabilityTimeoutMs: 0
};

function createTabUpdatedEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(tabId, changeInfo, tab) {
      [...listeners].forEach((listener) => listener(tabId, changeInfo, tab));
    },
    listenerCount() { return listeners.size; }
  };
}

// Derived from the tracker-origins registry rather than hard-coded, so a deployment
// that adds its own hosted origin does not have to edit this test.
test('every registered tracker origin is trusted, on any path', () => {
  assert.ok(trackerOrigins.TRACKERS.length > 0);
  for (const { url } of trackerOrigins.TRACKERS) {
    assert.equal(isTrackerUrl(url), true);
    assert.equal(isTrackerUrl(new URL('/setup', url).href), true);
    assert.equal(isTrustedTrackerSender({ tab: { url } }), true);
  }
});

test('the loopback tracker origins are always trusted', () => {
  assert.equal(isTrackerUrl('http://localhost:5074/'), true);
  assert.equal(isTrackerUrl('http://127.0.0.1:5074/path'), true);
});

test('near-miss tracker origins are rejected', () => {
  assert.equal(isTrackerUrl('http://localhost:9999/'), false);
  assert.equal(isTrackerUrl('https://localhost:5074/'), false);
  assert.equal(isTrackerUrl('http://localhost.evil.example:5074/'), false);
  assert.equal(isTrackerUrl('https://evil.example/?x=http://localhost:5074/'), false);
  assert.equal(isTrackerUrl('not a url'), false);
  assert.equal(isTrustedTrackerSender({ tab: { url: 'http://localhost:8080/' } }), false);
});

test('scannable tabs are limited to remote HTTP pages and exclude the tracker', () => {
  assert.equal(isScannableTab({ id: 1, url: 'https://claude.ai/settings/usage' }), true);
  assert.equal(isScannableTab({ id: 2, url: 'http://localhost:5074/' }), false);
  assert.equal(isScannableTab({ id: 3, url: 'chrome://extensions' }), false);
  assert.equal(isScannableTab({ id: 4, url: 'file:///tmp/private.txt' }), false);
});

test('provider discovery includes loading usage tabs and excludes unrelated browser tabs', async () => {
  assert.equal(isDiscoverableProviderTab({ id: 1, url: 'https://claude.ai/new#settings/usage' }), true);
  assert.equal(isDiscoverableProviderTab({ id: 2, url: 'https://chatgpt.com/codex/cloud/settings/analytics' }), true);
  assert.equal(isDiscoverableProviderTab({ id: 3, url: 'https://mail.google.com/mail/u/0/#inbox' }), false);
  let queryInfo;
  const tabs = await listScannableTabs({
    tabs: {
      async query(value) {
        queryInfo = value;
        return [
          { id: 1, title: 'Claude', url: 'https://claude.ai/new#settings/usage', status: 'loading' },
          { id: 2, title: 'Inbox', url: 'https://mail.google.com/mail/u/0/#inbox', status: 'complete' }
        ];
      }
    }
  });

  assert.deepEqual(queryInfo, {});
  assert.deepEqual(tabs, [{
    id: 1,
    title: 'Claude',
    url: 'https://claude.ai/new#settings/usage',
    status: 'loading'
  }]);
});

test('the injected snapshot function is self-contained when serialized', () => {
  const result = vm.runInNewContext(`(${collectPageSnapshot.toString()})()`, {
    document: { body: { innerText: '20% used' }, title: 'Usage' },
    location: { href: 'https://example.test/usage' }
  });

  assert.deepEqual({ ...result }, {
    body: '20% used',
    page: 'https://example.test/usage',
    title: 'Usage'
  });
});

test('the async snapshot waits for dynamic body text to stabilize', async () => {
  let reads = 0;
  let clock = 0;
  const bodies = ['Loading…', 'Loading…', 'Loading…', 'Loading…', '53% used'];
  const result = await vm.runInNewContext(
    `(${collectStablePageSnapshot.toString()})({
      maximumWait: 3000,
      pollInterval: 200,
      stableDuration: 750
    })`,
    {
      Date: { now: () => clock },
      Promise,
      setTimeout(callback, milliseconds) {
        clock += milliseconds;
        queueMicrotask(callback);
      },
      document: {
        body: {
          get innerText() {
            const value = bodies[Math.min(reads, bodies.length - 1)];
            reads += 1;
            return value;
          }
        },
        title: 'Claude Usage'
      },
      location: { href: 'https://claude.ai/settings/usage' }
    }
  );

  assert.equal(result.body, '53% used');
  assert.ok(reads >= 8);
  assert.ok(clock >= 1_500);
});

test('selected tab IDs are fetched and revalidated before injection', async () => {
  let injected = false;
  const chromeApi = {
    tabs: { get: async () => ({ id: 7, url: 'chrome://settings' }) },
    scripting: { executeScript: async () => { injected = true; return []; } }
  };

  const scan = await scanTab(7, chromeApi);
  assert.equal(scan.result, null);
  assert.match(scan.error, /cannot be scanned/i);
  assert.equal(injected, false);
});

test('a valid tab snapshot is parsed into a usage payload', async () => {
  const chromeApi = {
    tabs: {
      get: async () => ({
        id: 8,
        title: 'Claude Usage',
        url: 'https://claude.ai/settings/usage',
        status: 'complete'
      }),
      reload: async () => {}
    },
    scripting: {
      executeScript: async () => [{
        result: {
          body: 'Weekly allowance 40% remaining. Resets Monday at 10:30 AM',
          page: 'https://claude.ai/settings/usage',
          title: 'Claude Usage'
        }
      }]
    }
  };

  const scan = await scanTab(
    8,
    chromeApi,
    new Date(2026, 7, 9, 12).getTime(),
    FAST_SCAN_OPTIONS
  );
  assert.equal(scan.error, null);
  assert.equal(scan.results.length, 1);
  assert.equal(scan.result.currentPercent, 60);
  assert.equal(scan.result.resetDay, 'Monday');
  assert.equal(scan.result.resetHour, 10.5);
});

test('stable loading shells are retried until Claude and Codex quotas are parseable', async () => {
  const tabs = new Map([
    [9, {
      id: 9,
      title: 'Claude Usage',
      url: 'https://claude.ai/settings/usage',
      status: 'complete'
    }],
    [10, {
      id: 10,
      title: 'Codex Usage',
      url: 'https://chatgpt.com/codex/cloud/settings/analytics',
      status: 'complete'
    }]
  ]);
  const attempts = new Map();
  const loadedBodies = new Map([
    [9, [
      'Current session',
      '53% used',
      'All models',
      '50% used'
    ].join('\n')],
    [10, [
      'Current session',
      '20% used',
      'Weekly usage limit',
      '40% used'
    ].join('\n')]
  ]);
  const chromeApi = {
    tabs: {
      get: async (tabId) => ({ ...tabs.get(tabId) }),
      reload: async () => {}
    },
    scripting: {
      executeScript: async ({ target }) => {
        const attempt = (attempts.get(target.tabId) || 0) + 1;
        attempts.set(target.tabId, attempt);
        return [{
          result: {
            body: attempt === 1 ? 'Usage\nLoading…' : loadedBodies.get(target.tabId),
            page: tabs.get(target.tabId).url,
            title: tabs.get(target.tabId).title
          }
        }];
      }
    }
  };

  const scan = await scanTabIds(
    [9, 10],
    chromeApi,
    new Date('2026-08-11T10:00:00.000Z'),
    {
      ...FAST_SCAN_OPTIONS,
      snapshotReadinessTimeoutMs: 1_000
    }
  );

  assert.deepEqual([...attempts.entries()], [[9, 2], [10, 2]]);
  assert.equal(scan.errors.length, 0);
  assert.deepEqual(scan.results.map(({ tabId, provider, metricKey, currentPercent }) => ({
    tabId,
    provider,
    metricKey,
    currentPercent
  })), [
    { tabId: 9, provider: 'Claude', metricKey: 'session', currentPercent: 53 },
    { tabId: 9, provider: 'Claude', metricKey: 'weekly-all-models', currentPercent: 50 },
    { tabId: 10, provider: 'OpenAI', metricKey: 'session', currentPercent: 20 },
    { tabId: 10, provider: 'OpenAI', metricKey: 'weekly', currentPercent: 40 }
  ]);
});

test('snapshot readiness timeouts are bounded and isolated from other tabs', async () => {
  const tabs = new Map([
    [11, {
      id: 11,
      title: 'Claude Usage',
      url: 'https://claude.ai/settings/usage',
      status: 'complete'
    }],
    [12, {
      id: 12,
      title: 'Codex Usage',
      url: 'https://chatgpt.com/codex/cloud/settings/analytics',
      status: 'complete'
    }]
  ]);
  const attempts = new Map();
  let clock = 0;
  const chromeApi = {
    tabs: {
      get: async (tabId) => ({ ...tabs.get(tabId) }),
      reload: async () => {}
    },
    scripting: {
      executeScript: async ({ target }) => {
        attempts.set(target.tabId, (attempts.get(target.tabId) || 0) + 1);
        return [{
          result: {
            body: target.tabId === 11
              ? 'Usage\nLoading…'
              : 'Weekly usage limit\n40% used',
            page: tabs.get(target.tabId).url,
            title: tabs.get(target.tabId).title
          }
        }];
      }
    }
  };

  const scan = await scanTabIds(
    [11, 12],
    chromeApi,
    new Date('2026-08-11T10:00:00.000Z'),
    {
      ...FAST_SCAN_OPTIONS,
      nowFn: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      snapshotReadinessTimeoutMs: 10,
      snapshotRetryDelayMs: 5
    }
  );

  assert.equal(attempts.get(11), 2);
  assert.equal(attempts.get(12), 1);
  assert.deepEqual(scan.results.map(({ tabId, provider, metricKey }) => ({
    tabId,
    provider,
    metricKey
  })), [{ tabId: 12, provider: 'OpenAI', metricKey: 'weekly' }]);
  assert.equal(scan.errors.length, 1);
  assert.equal(scan.errors[0].tabId, 11);
  assert.match(scan.errors[0].message, /2 snapshot attempts over 10 ms/i);
  assert.match(scan.errors[0].message, /last page text length: \d+/i);
});

test('runtime messages from an untrusted sender are rejected', () => {
  let response;
  const asynchronous = handleRuntimeMessage(
    { type: 'LIST_TABS' },
    { tab: { url: 'http://localhost:8080/' } },
    (value) => { response = value; },
    {}
  );

  assert.equal(asynchronous, false);
  assert.equal(response.ok, false);
  assert.match(response.error, /untrusted/i);
});

test('a tab scan returns every quota metric while preserving the first result', async () => {
  const chromeApi = {
    tabs: {
      get: async () => ({
        id: 12,
        title: 'Claude Usage',
        url: 'https://claude.ai/settings/usage',
        status: 'complete'
      }),
      reload: async () => {}
    },
    scripting: {
      executeScript: async () => [{
        result: {
          body: [
            'Current session',
            'Resets in 3 hr 15 min',
            '53% used',
            'All models',
            'Resets Thu 3:00 PM',
            '50% used',
            'Fable',
            'Resets Thu 3:00 PM',
            '30% used'
          ].join('\n'),
          page: 'https://claude.ai/settings/usage',
          title: 'Claude Usage'
        }
      }]
    }
  };

  const scan = await scanTab(
    12,
    chromeApi,
    new Date('2026-08-10T10:00:00.000Z'),
    FAST_SCAN_OPTIONS
  );
  assert.equal(scan.error, null);
  assert.equal(scan.results.length, 3);
  assert.equal(scan.result, scan.results[0]);
  assert.deepEqual(scan.results.map(({ metricKey }) => metricKey), [
    'session',
    'weekly-all-models',
    'weekly-fable'
  ]);
  assert.ok(scan.results.every(({ tabId }) => tabId === 12));
});

test('the extension refuses to reload the same page inside the cooldown', async () => {
  assert.equal(SCAN_COOLDOWN_MS, 5 * 60 * 1000);

  let reloads = 0;
  const chromeApi = {
    tabs: {
      get: async () => ({ id: 31, title: 'Claude Usage', url: 'https://claude.ai/settings/usage', status: 'complete' }),
      reload: async () => { reloads += 1; }
    },
    scripting: {
      executeScript: async () => [{
        result: {
          body: 'Current session\n53% used',
          page: 'https://claude.ai/settings/usage',
          title: 'Claude Usage'
        }
      }]
    }
  };

  const start = Date.parse('2026-08-16T10:00:00.000Z');
  const first = await scanTab(31, chromeApi, start, FAST_SCAN_OPTIONS);
  assert.equal(first.error, null);
  assert.equal(reloads, 1);

  // Inside the window the provider is never contacted at all.
  const blocked = await scanTab(31, chromeApi, start + 60_000, FAST_SCAN_OPTIONS);
  assert.equal(reloads, 1, 'a rate-limited scan must not reload the provider page');
  assert.match(blocked.error, /rate limited/i);
  assert.equal(blocked.retryAfterMs, 4 * 60 * 1000);
  assert.deepEqual(blocked.results, []);

  const allowed = await scanTab(31, chromeApi, start + SCAN_COOLDOWN_MS, FAST_SCAN_OPTIONS);
  assert.equal(allowed.error, null);
  assert.equal(reloads, 2);
});

test('the cooldown is keyed on the page, so reopening the tab grants no new allowance', async () => {
  // Same page, different tab ID and a noisier URL: still one allowance.
  assert.equal(
    scanCooldownKey('https://CLAUDE.ai/settings/usage/?ref=1#x'),
    scanCooldownKey('https://claude.ai/settings/usage')
  );
  assert.notEqual(
    scanCooldownKey('https://claude.ai/settings/usage'),
    scanCooldownKey('https://claude.ai/settings/daily')
  );
  assert.equal(scanCooldownKey('chrome://settings'), '');

  const at = Date.parse('2026-08-16T10:00:00.000Z');
  assert.deepEqual(
    await claimScanAllowance('https://claude.ai/settings/usage', {}, at),
    { allowed: true, retryAfterMs: 0 }
  );
  const reopened = await claimScanAllowance('https://claude.ai/settings/usage?reopened=1', {}, at + 1000);
  assert.equal(reopened.allowed, false);

  // A different page is independent.
  assert.equal(
    (await claimScanAllowance('https://claude.ai/settings/daily', {}, at + 1000)).allowed,
    true
  );
});

test('the cooldown survives service worker eviction via session storage', async () => {
  // The worker restarting is the normal case in MV3, so an in-memory-only limit
  // would reset every ~30 idle seconds. Session storage is what carries it.
  const store = new Map();
  const chromeApi = {
    storage: {
      session: {
        get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (entries) => { Object.entries(entries).forEach(([k, v]) => store.set(k, v)); }
      }
    }
  };

  const at = Date.parse('2026-08-16T10:00:00.000Z');
  assert.equal((await claimScanAllowance('https://chatgpt.com/codex/settings/usage', chromeApi, at)).allowed, true);
  assert.ok(store.size > 0, 'the claim must be persisted, not just held in memory');

  resetScanCooldowns(); // simulate the service worker being evicted
  const afterEviction = await claimScanAllowance('https://chatgpt.com/codex/settings/usage', chromeApi, at + 1000);
  assert.equal(afterEviction.allowed, false, 'a restarted worker must still honour the cooldown');
});

test('only the extension popup can claim a manual gesture, never a page', () => {
  const runtime = { id: 'tmt-extension-id' };
  const chromeApi = { runtime };

  // The popup: this extension's own origin, no tab behind it.
  assert.equal(
    isExtensionUiSender({ id: 'tmt-extension-id', url: 'chrome-extension://tmt-extension-id/popup.html' }, chromeApi),
    true
  );
  // The tracker page, even though it is otherwise trusted, is not extension UI.
  assert.equal(
    isExtensionUiSender({ id: 'tmt-extension-id', url: 'http://localhost:5074/', tab: { id: 4, url: 'http://localhost:5074/' } }, chromeApi),
    false
  );
  // A provider page claiming to be the popup.
  assert.equal(
    isExtensionUiSender({ id: 'tmt-extension-id', url: 'https://claude.ai/settings/usage' }, chromeApi),
    false
  );
  // Another extension.
  assert.equal(
    isExtensionUiSender({ id: 'someone-else', url: 'chrome-extension://someone-else/popup.html' }, chromeApi),
    false
  );
  assert.equal(isExtensionUiSender({}, chromeApi), false);
  assert.equal(isExtensionUiSender(null, chromeApi), false);
});

test('a popup gesture shortens the floor once, and the page cannot ask for it', async () => {
  const store = new Map();
  const chromeApi = {
    runtime: { id: 'tmt' },
    storage: {
      session: {
        get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (entries) => { Object.entries(entries).forEach(([k, v]) => store.set(k, v)); },
        remove: async (key) => { store.delete(key); }
      }
    }
  };
  const url = 'https://claude.ai/settings/usage';
  const start = Date.parse('2026-08-16T10:00:00.000Z');

  // Establish a cooldown.
  assert.equal((await claimScanAllowance(url, chromeApi, start)).allowed, true);

  // Two minutes later the standard floor still refuses.
  assert.equal((await claimScanAllowance(url, chromeApi, start + 120_000)).allowed, false);

  // A popup click lets the same page through after only a minute...
  await recordManualGesture(chromeApi, start + 120_000);
  assert.equal(await consumeManualGesture(chromeApi, start + 120_000), true);
  assert.equal(
    (await claimScanAllowance(url, chromeApi, start + 120_000, MANUAL_SCAN_COOLDOWN_MS)).allowed,
    true
  );

  // ...but the gesture is spent, so the next read of it is false.
  assert.equal(await consumeManualGesture(chromeApi, start + 121_000), false);

  // And a stale gesture past its TTL does not count.
  await recordManualGesture(chromeApi, start);
  assert.equal(await consumeManualGesture(chromeApi, start + 120_000), false);
});

test('the manual floor is a floor, not an override', async () => {
  const chromeApi = { runtime: { id: 'tmt' } };
  const url = 'https://chatgpt.com/codex/settings/usage';
  const start = Date.parse('2026-08-16T10:00:00.000Z');

  assert.equal((await claimScanAllowance(url, chromeApi, start)).allowed, true);

  // A caller asking for no cooldown at all still gets the 60-second minimum.
  assert.equal((await claimScanAllowance(url, chromeApi, start + 1000, 0)).allowed, false);
  assert.equal((await claimScanAllowance(url, chromeApi, start + 59_000, 1)).allowed, false);
  assert.equal((await claimScanAllowance(url, chromeApi, start + 60_000, 0)).allowed, true);
});

test('popup messages are accepted only from extension UI, scan messages only from the tracker', async () => {
  const chromeApi = {
    runtime: { id: 'tmt' },
    tabs: { query: async () => [] , create: async () => ({ id: 9 }) }
  };
  const popupSender = { id: 'tmt', url: 'chrome-extension://tmt/popup.html' };

  const rejected = await new Promise((resolve) => {
    handleRuntimeMessage({ type: 'POPUP_REFRESH_NOW' }, { tab: { url: 'https://claude.ai/settings/usage' } }, resolve, chromeApi);
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /untrusted tracker origin/i);

  // The popup cannot drive a raw scan either -- only its two named actions.
  const notAScanner = await new Promise((resolve) => {
    handleRuntimeMessage({ type: 'SCAN_SELECTED_TABS', details: { tabIds: [1] } }, popupSender, resolve, chromeApi);
  });
  assert.equal(notAScanner.ok, false);
  assert.match(notAScanner.error, /unsupported/i);
});

test('multi-tab scans flatten all metric results', async () => {
  const tabs = new Map([
    [21, { id: 21, title: 'Claude Usage', url: 'https://claude.ai/settings/usage' }],
    [22, { id: 22, title: 'Daily Usage', url: 'https://claude.ai/settings/daily' }]
  ]);
  const chromeApi = {
    tabs: {
      get: async (tabId) => ({ ...tabs.get(tabId), status: 'complete' }),
      reload: async () => {}
    },
    scripting: {
      executeScript: async ({ target }) => [{
        result: target.tabId === 21
          ? {
              body: 'Current session\n53% used\nAll models\n50% used',
              page: tabs.get(21).url,
              title: tabs.get(21).title
            }
          : {
              body: 'Daily usage limit\n25% used',
              page: tabs.get(22).url,
              title: tabs.get(22).title
            }
      }]
    }
  };

  const scan = await scanTabIds(
    [21, 22],
    chromeApi,
    new Date('2026-08-10T10:00:00.000Z'),
    FAST_SCAN_OPTIONS
  );
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.results.length, 3);
  assert.deepEqual(scan.results.map(({ tabId, metricKey }) => [tabId, metricKey]), [
    [21, 'session'],
    [21, 'weekly-all-models'],
    [22, 'daily']
  ]);
});

test('a selected tab reloads, settles, and is re-fetched before script injection', async () => {
  const updates = createTabUpdatedEvent();
  const events = [];
  let tab = {
    id: 30,
    title: 'Old title',
    url: 'https://claude.ai/settings/usage',
    status: 'complete'
  };
  const chromeApi = {
    tabs: {
      onUpdated: updates,
      get: async () => ({ ...tab }),
      reload: async (tabId) => {
        events.push('reload');
        tab = { ...tab, status: 'loading' };
        queueMicrotask(() => {
          tab = { ...tab, title: 'Fresh title', status: 'complete' };
          updates.emit(tabId, { status: 'complete' }, { ...tab });
        });
      }
    },
    scripting: {
      executeScript: async () => {
        events.push('inject');
        return [{
          result: {
            body: 'Daily usage limit\n25% used',
            page: tab.url,
            title: tab.title
          }
        }];
      }
    }
  };

  const scan = await scanTab(30, chromeApi, Date.now(), {
    settleMs: 25,
    sleep: async () => { events.push('settle'); },
    snapshotStabilityTimeoutMs: 0
  });

  assert.equal(scan.error, null);
  assert.equal(scan.result.tabTitle, 'Fresh title');
  assert.deepEqual(events, ['reload', 'settle', 'inject']);
  assert.equal(updates.listenerCount(), 0);
});

test('a redirect during reload is revalidated before injection', async () => {
  let reloaded = false;
  let injected = false;
  const chromeApi = {
    tabs: {
      get: async () => reloaded
        ? { id: 31, title: 'Internal', url: 'chrome://settings', status: 'complete' }
        : { id: 31, title: 'Usage', url: 'https://example.test/usage', status: 'complete' },
      reload: async () => { reloaded = true; }
    },
    scripting: {
      executeScript: async () => { injected = true; return []; }
    }
  };

  const scan = await scanTab(31, chromeApi, Date.now(), FAST_SCAN_OPTIONS);
  assert.match(scan.error, /reloaded tab cannot be scanned/i);
  assert.equal(injected, false);
});

test('reload timeouts and errors are isolated from other selected tabs', async () => {
  const updates = createTabUpdatedEvent();
  const states = new Map([
    [41, 'complete'],
    [42, 'complete'],
    [43, 'complete']
  ]);
  const chromeApi = {
    tabs: {
      onUpdated: updates,
      get: async (tabId) => ({
        id: tabId,
        title: `Tab ${tabId}`,
        url: `https://example.test/usage/${tabId}`,
        status: states.get(tabId)
      }),
      reload: async (tabId) => {
        if (tabId === 41) {
          states.set(tabId, 'loading');
          return;
        }
        if (tabId === 42) {
          throw new Error('Reload denied');
        }
        states.set(tabId, 'complete');
        queueMicrotask(() => updates.emit(tabId, { status: 'complete' }, {
          id: tabId,
          title: `Tab ${tabId}`,
          url: `https://example.test/usage/${tabId}`,
          status: 'complete'
        }));
      }
    },
    scripting: {
      executeScript: async ({ target }) => [{
        result: {
          body: 'Daily usage limit\n25% used',
          page: `https://example.test/usage/${target.tabId}`,
          title: `Tab ${target.tabId}`
        }
      }]
    }
  };

  const scan = await scanTabIds([41, 42, 43], chromeApi, Date.now(), {
    ...FAST_SCAN_OPTIONS,
    reloadTimeoutMs: 10
  });

  assert.deepEqual(scan.results.map(({ tabId }) => tabId), [43]);
  assert.equal(scan.errors.length, 2);
  assert.match(scan.errors.find(({ tabId }) => tabId === 41).message, /timed out/i);
  assert.match(scan.errors.find(({ tabId }) => tabId === 42).message, /reload denied/i);
  assert.equal(updates.listenerCount(), 0);
});
