'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyScrapedPayloads,
  autoSyncBadgeState,
  documentTitle,
  formatRefreshInterval,
  formatResetDateTime,
  isExtensionRefreshCommand,
  noteExtensionBridgeReady,
  waitForExtensionBridge,
  rateLimitRetryAt,
  rateLimitState,
  isRefreshPlanRunning,
  normalizeRefreshCount,
  normalizeRefreshIntervalSeconds,
  refreshIntervalMilliseconds,
  renderRefreshPlanPanel,
  sanitizeRefreshPlan,
  formatSyncCountdown,
  formatSyncedAgo,
  groupModelsByProvider,
  groupTrackers,
  headlinePaceContext,
  headlineScopeOptions,
  isAutoScrapedOpenAiDayArtifact,
  isAutoScrapedValueOnlyLabelArtifact,
  isValueOnlyLabelPayloadArtifact,
  isValueOnlyMetricLabel,
  isOpenAiDayPayloadArtifact,
  demoModels,
  isTrackerEnabled,
  latestModelUpdate,
  loadModels,
  loadPreferences,
  mergePayloadIntoModels,
  migrateStoredModels,
  normalizedHistory,
  overallPaceSummary,
  pageFromHash,
  paceDeltaContext,
  paceCurveData,
  projectedDepletionContext,
  reconcileTabSelections,
  renderDashboard,
  renderHeadlinePanel,
  renderPage,
  renderPaceGraphs,
  renderRunwayView,
  renderTrendChart,
  resolveHeadlineScope,
  savePreferences,
  syncCountdownState,
  selectedTabIdsForPreferences,
  setTrackerEnabled,
  sendExtensionRequest,
  sortTrackersAlphabetically,
  stableTabUrl,
  tabSelectionProviderKey,
  trackerDisplayLabel,
  runwayOutcome,
  runwayPhysics,
  runwayScene,
  runwayApproachSpeed,
  runwayBrake,
  runwayGhostNote,
  runwayHudReadout,
  settleRunwayCards,
  toggleTabSelectionPreference,
  trendChangeContext,
  updateModelField,
  visualStatus
} = require('../app.js');

function createWindowHarness() {
  const listeners = new Set();
  const requests = [];
  const win = {
    location: { origin: 'http://localhost:5074' },
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    },
    postMessage(message, targetOrigin) {
      requests.push({ message, targetOrigin });
    },
    dispatch(data) {
      for (const listener of [...listeners]) {
        listener({ source: win, origin: win.location.origin, data });
      }
    },
    listenerCount() {
      return listeners.size;
    }
  };
  return { requests, win };
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    value(key) {
      return values.get(key);
    }
  };
}

test('demo mode provides deterministic sample quota trackers', () => {
  const now = Date.parse('2026-08-22T08:00:00.000Z');
  const models = demoModels(now);

  assert.deepEqual(models.map((model) => model.id), [
    'demo-claude-all-models',
    'demo-openai-weekly'
  ]);
  assert.deepEqual(models.map((model) => model.provider), ['Claude', 'OpenAI']);
  assert.equal(models[0].actualCumUsedPercent, 0.34);
  assert.equal(models[0].currentHour, 41);
  assert.equal(models[0].resetAt, '2026-08-27T15:00:00.000Z');
  assert.equal(models[0].usageHistory.length, 2);
});

// content_scripts run at document_idle, so on a fresh page load there is a
// window with no listener for bridge messages. window.postMessage does not queue
// and does not throw, so a request sent then is lost outright and the caller
// waits out its whole timeout for a reply nobody was ever going to send.
test('a request made before the content script exists is held, not lost', async () => {
  const harness = createWindowHarness();
  global.window = harness.win;

  const pending = sendExtensionRequest('EXTENSION_LIST_TABS', {}, 1000);
  assert.equal(harness.requests.length, 0, 'nothing may be posted while nothing is listening');

  noteExtensionBridgeReady(harness.win);
  // A macrotask, so every microtask hop in the readiness handoff has drained.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.requests.length, 1, 'the request goes out once the bridge announces itself');

  harness.win.dispatch({
    channel: 'llm-run-rate-tracker',
    direction: 'response',
    type: 'EXTENSION_LIST_TABS_RESPONSE',
    requestId: harness.requests[0].message.requestId,
    payload: { ok: true, marker: 'held' }
  });
  assert.equal((await pending).marker, 'held');
  assert.equal(harness.win.listenerCount(), 0);
  delete global.window;
});

test('a page with no content script says so instead of timing out silently', async () => {
  const harness = createWindowHarness();
  global.window = harness.win;

  const response = await sendExtensionRequest('EXTENSION_LIST_TABS', {}, 1000, 20);
  assert.equal(response.ok, false);
  assert.match(response.error, /extension is not running on this page/i);
  assert.match(response.error, /content_scripts/);
  assert.equal(harness.requests.length, 0, 'nothing is posted into the void');
  assert.equal(harness.win.listenerCount(), 0);
  delete global.window;
});

test('bridge readiness is per page, so one page does not vouch for another', async () => {
  const first = createWindowHarness();
  const second = createWindowHarness();
  noteExtensionBridgeReady(first.win);

  assert.equal(await waitForExtensionBridge(20, first.win), true);
  assert.equal(await waitForExtensionBridge(20, second.win), false);
});

test('concurrent extension requests only accept their correlated response', async () => {
  const harness = createWindowHarness();
  global.window = harness.win;
  noteExtensionBridgeReady(harness.win);

  const first = sendExtensionRequest('EXTENSION_LIST_TABS', {}, 1000);
  const second = sendExtensionRequest('EXTENSION_LIST_TABS', {}, 1000);
  assert.equal(harness.requests.length, 2);

  const firstRequest = harness.requests[0].message;
  const secondRequest = harness.requests[1].message;
  harness.win.dispatch({
    channel: 'llm-run-rate-tracker',
    direction: 'response',
    type: 'EXTENSION_LIST_TABS_RESPONSE',
    requestId: secondRequest.requestId,
    payload: { ok: true, marker: 'second' }
  });
  harness.win.dispatch({
    channel: 'llm-run-rate-tracker',
    direction: 'response',
    type: 'EXTENSION_LIST_TABS_RESPONSE',
    requestId: firstRequest.requestId,
    payload: { ok: true, marker: 'first' }
  });

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.marker, 'first');
  assert.equal(secondResponse.marker, 'second');
  assert.equal(harness.win.listenerCount(), 0);
  delete global.window;
});

test('extension request timeouts return an explicit error and remove listeners', async () => {
  const harness = createWindowHarness();
  global.window = harness.win;
  noteExtensionBridgeReady(harness.win);

  const response = await sendExtensionRequest('EXTENSION_LIST_TABS', {}, 5);
  assert.equal(response.ok, false);
  assert.match(response.error, /timed out/i);
  assert.equal(harness.win.listenerCount(), 0);
  delete global.window;
});

test('invalid local storage shapes recover to an empty model list', () => {
  global.localStorage = {
    getItem() {
      return '{"unexpected":true}';
    }
  };

  assert.deepEqual(loadModels(), []);
  delete global.localStorage;
});

test('legacy URL preferences migrate to provider-scoped descriptors without tab IDs', () => {
  const storage = createStorage();
  const saved = savePreferences({
    schemaVersion: 1,
    autoSyncEnabled: true,
    providerTabs: {
      initialized: true,
      selectedUrls: [
        'https://ChatGPT.com/codex/settings/usage/?temporary=1#day',
        'https://chatgpt.com/codex/settings/usage'
      ]
    }
  }, storage);

  assert.deepEqual(saved, {
    schemaVersion: 6,
    overviewPaceView: 'bars',
    showHeadlineIndicator: true,
    headlineScope: 'overall',
    refreshPlan: { intervalSeconds: 900, totalRefreshes: 5, remaining: 0, nextAt: null },
    providerTabs: {
      initialized: true,
      selectedTabs: [{
        url: 'https://chatgpt.com/codex/settings/usage',
        providerKey: 'provider:openai:codex-usage'
      }]
    }
  });
  assert.deepEqual(loadPreferences(storage), saved);
  assert.doesNotMatch(storage.value('llmRunRateTracker.preferences'), /tabId|"id"/);
});

test('invalid or future preference shapes fall back safely', () => {
  const invalid = createStorage({ 'llmRunRateTracker.preferences': '{bad json' });
  const future = createStorage({
    'llmRunRateTracker.preferences': JSON.stringify({
      schemaVersion: 99,
      autoSyncEnabled: true,
      providerTabs: { initialized: true, selectedTabs: [{ url: 'https://chatgpt.com/usage' }] }
    })
  });

  assert.deepEqual(loadPreferences(invalid), {
    schemaVersion: 6,
    overviewPaceView: 'bars',
    showHeadlineIndicator: true,
    headlineScope: 'overall',
    refreshPlan: { intervalSeconds: 900, totalRefreshes: 5, remaining: 0, nextAt: null },
    providerTabs: { initialized: false, selectedTabs: [] }
  });
  assert.deepEqual(loadPreferences(future), loadPreferences(invalid));
});

test('stable URL selections reconcile to replacement Chrome tab IDs', () => {
  const preferences = {
    schemaVersion: 1,
    autoSyncEnabled: true,
    providerTabs: {
      initialized: true,
      selectedUrls: ['https://chatgpt.com/codex/settings/usage']
    }
  };

  assert.equal(
    stableTabUrl('https://CHATGPT.com/codex/settings/usage/?temporary=1#day'),
    'https://chatgpt.com/codex/settings/usage'
  );
  assert.deepEqual(selectedTabIdsForPreferences([
    { id: 84, url: 'https://chatgpt.com/codex/settings/usage?refreshed=1' },
    { id: 11, url: 'https://claude.ai/settings/usage' }
  ], preferences), [84]);
});

test('provider selection keys cover only known Claude and OpenAI usage routes', () => {
  assert.equal(
    tabSelectionProviderKey('https://claude.ai/new#settings/usage'),
    'provider:claude:usage'
  );
  assert.equal(
    tabSelectionProviderKey('https://claude.ai/settings/usage'),
    'provider:claude:usage'
  );
  assert.equal(
    tabSelectionProviderKey('https://chatgpt.com/codex/cloud/settings/analytics'),
    'provider:openai:codex-usage'
  );
  assert.equal(tabSelectionProviderKey('https://claude.ai/new'), '');
  assert.equal(tabSelectionProviderKey('https://notclaude.ai/settings/usage'), '');
  assert.equal(tabSelectionProviderKey('https://chatgpt.com/'), '');
  assert.equal(tabSelectionProviderKey('https://mail.google.com/mail/u/0/#inbox'), '');
});

test('Claude and Codex selections survive provider route changes and heal their saved URLs', () => {
  const preferences = savePreferences({
    schemaVersion: 2,
    autoSyncEnabled: false,
    providerTabs: {
      initialized: true,
      selectedTabs: [
        { url: 'https://claude.ai/new#settings/usage' },
        { url: 'https://chatgpt.com/codex/cloud/settings/analytics' }
      ]
    }
  }, createStorage());
  const reconciled = reconcileTabSelections([
    { id: 31, url: 'https://claude.ai/settings/usage' },
    { id: 32, url: 'https://chatgpt.com/codex/settings/analytics' },
    { id: 33, url: 'https://mail.google.com/mail/u/0/#inbox' }
  ], preferences);

  assert.deepEqual(reconciled.selectedTabIds, [31, 32]);
  assert.deepEqual(reconciled.preferences.providerTabs.selectedTabs, [
    { url: 'https://claude.ai/settings/usage', providerKey: 'provider:claude:usage' },
    { url: 'https://chatgpt.com/codex/settings/analytics', providerKey: 'provider:openai:codex-usage' }
  ]);
});

test('closed selections remain remembered and reconnect when the provider tab returns', () => {
  const preferences = {
    schemaVersion: 2,
    autoSyncEnabled: true,
    providerTabs: {
      initialized: true,
      selectedTabs: [{
        url: 'https://claude.ai/settings/usage',
        providerKey: 'provider:claude:usage'
      }]
    }
  };
  const closed = reconcileTabSelections([], preferences);
  assert.deepEqual(closed.selectedTabIds, []);
  assert.deepEqual(closed.preferences.providerTabs.selectedTabs, preferences.providerTabs.selectedTabs);
  assert.deepEqual(selectedTabIdsForPreferences([
    { id: 90, url: 'https://claude.ai/new#settings/usage' }
  ], closed.preferences), [90]);
});

test('ambiguous provider routes do not select an unchecked sibling tab', () => {
  const preferences = {
    schemaVersion: 2,
    autoSyncEnabled: false,
    providerTabs: {
      initialized: true,
      selectedTabs: [{
        url: 'https://claude.ai/old-settings/usage',
        providerKey: 'provider:claude:usage'
      }]
    }
  };
  const reconciled = reconcileTabSelections([
    { id: 41, url: 'https://claude.ai/new#settings/usage' },
    { id: 42, url: 'https://claude.ai/settings/usage' },
    { id: 43, url: 'https://claude.ai/new' }
  ], preferences);
  assert.deepEqual(reconciled.selectedTabIds, []);
});

test('turning off a redirected provider selection removes its healed identity', () => {
  const preferences = {
    schemaVersion: 2,
    autoSyncEnabled: false,
    providerTabs: {
      initialized: true,
      selectedTabs: [{
        url: 'https://chatgpt.com/codex/cloud/settings/analytics',
        providerKey: 'provider:openai:codex-usage'
      }]
    }
  };
  const tabs = [{ id: 77, url: 'https://chatgpt.com/codex/settings/analytics' }];
  const update = toggleTabSelectionPreference(tabs, preferences, 77);
  assert.equal(update.changed, true);
  assert.deepEqual(update.selectedTabIds, []);
  assert.deepEqual(update.preferences.providerTabs.selectedTabs, []);
  assert.deepEqual(selectedTabIdsForPreferences(tabs, update.preferences), []);
});

test('the refresh badge reports off, paused, or running with its remaining count', () => {
  const stopped = { intervalSeconds: 900, totalRefreshes: 5, remaining: 0, nextAt: null };
  const running = { intervalSeconds: 900, totalRefreshes: 5, remaining: 3, nextAt: 1 };

  assert.deepEqual(autoSyncBadgeState(stopped, false, 0), { state: 'off', label: 'Refreshes off' });
  // A plan with a count but no scheduled time is not running, and must not claim to be.
  assert.deepEqual(
    autoSyncBadgeState({ ...running, nextAt: null }, true, 1),
    { state: 'off', label: 'Refreshes off' }
  );
  assert.deepEqual(
    autoSyncBadgeState(running, true, 0),
    { state: 'waiting', label: 'Refreshes paused · 3 of 5 left' }
  );
  assert.deepEqual(
    autoSyncBadgeState(running, false, 1),
    { state: 'waiting', label: 'Refreshes paused · 3 of 5 left' }
  );
  assert.deepEqual(
    autoSyncBadgeState(running, true, 1),
    { state: 'on', label: 'Refreshing · 3 of 5 left' }
  );
  assert.match(
    renderDashboard([], [], 'overview'),
    /data-auto-sync-state="off"[^>]*><i><\/i><span class="pill-label">Refreshes off<\/span>/
  );
});

test('legacy hashes resolve into the simplified Overview and Setup pages', () => {
  assert.equal(pageFromHash('#/overview'), 'overview');
  assert.equal(pageFromHash('#/limits'), 'overview');
  assert.equal(pageFromHash('#sources'), 'setup');
  assert.equal(pageFromHash('#/settings?tracker=abc'), 'setup');
  assert.equal(pageFromHash('#/setup'), 'setup');
  assert.equal(pageFromHash('#/unknown'), 'overview');
});

test('the Overview pace view preference migrates and survives storage round trips', () => {
  const storage = createStorage();
  const saved = savePreferences({
    schemaVersion: 2,
    autoSyncEnabled: true,
    overviewPaceView: 'graph',
    providerTabs: { initialized: true, selectedTabs: [] }
  }, storage);

  assert.equal(saved.schemaVersion, 6);
  assert.equal(saved.overviewPaceView, 'graph');
  assert.equal(loadPreferences(storage).overviewPaceView, 'graph');

  const runway = savePreferences({
    ...saved,
    schemaVersion: 6,
    overviewPaceView: 'runway'
  }, storage);
  assert.equal(runway.overviewPaceView, 'runway');
  assert.equal(loadPreferences(storage).overviewPaceView, 'runway');
});

test('refresh interval and count clamp to the bounds the page is allowed to ask for', () => {
  // The page can only ever ask for slower and fewer. Anything outside the
  // bounds clamps inward rather than being honoured.
  assert.equal(normalizeRefreshIntervalSeconds(30), 300);
  assert.equal(normalizeRefreshIntervalSeconds(1), 300);
  assert.equal(normalizeRefreshIntervalSeconds(900), 900);
  assert.equal(normalizeRefreshIntervalSeconds(86_400), 3600);
  assert.equal(normalizeRefreshIntervalSeconds('nonsense'), 900);

  assert.equal(normalizeRefreshCount(0), 1);
  assert.equal(normalizeRefreshCount(-5), 1);
  assert.equal(normalizeRefreshCount(7), 7);
  assert.equal(normalizeRefreshCount(1000), 10);
  assert.equal(normalizeRefreshCount('nonsense'), 5);

  assert.equal(formatRefreshInterval(30), '5m');
  assert.equal(formatRefreshInterval(900), '15m');
  assert.equal(formatRefreshInterval(7200), '60m');
  assert.equal(refreshIntervalMilliseconds(30), 300000);
  assert.equal(refreshIntervalMilliseconds(1800), 1800000);
});

test('a stored refresh plan can never resurrect an unbounded loop', () => {
  const plan = (value) => sanitizeRefreshPlan(value);

  // Both halves are required to count as running.
  assert.equal(isRefreshPlanRunning(plan({ remaining: 4, nextAt: 123 })), true);
  assert.equal(isRefreshPlanRunning(plan({ remaining: 4, nextAt: null })), false);
  assert.equal(isRefreshPlanRunning(plan({ remaining: 0, nextAt: 123 })), false);
  assert.equal(isRefreshPlanRunning(plan({})), false);

  // A hand-edited count above the cap is clamped, not honoured.
  assert.deepEqual(plan({ totalRefreshes: 9999, remaining: 9999, nextAt: 123 }), {
    intervalSeconds: 900, totalRefreshes: 10, remaining: 10, nextAt: 123
  });
  // Remaining can never exceed the total it was drawn from.
  assert.equal(plan({ totalRefreshes: 3, remaining: 50, nextAt: 123 }).remaining, 3);
  // A sub-floor interval clamps up even inside a live plan.
  assert.equal(plan({ intervalSeconds: 5, remaining: 2, nextAt: 123 }).intervalSeconds, 300);
  // Losing nextAt zeroes the count rather than leaving a plan that never ends.
  assert.deepEqual(plan({ remaining: 4, nextAt: 'soon' }), {
    intervalSeconds: 900, totalRefreshes: 5, remaining: 0, nextAt: null
  });
});

test('upgrading from perpetual auto-sync does not start a run', () => {
  const storage = createStorage();
  // Schema 5 with auto-sync switched on and polling every 5 minutes.
  const migrated = savePreferences({
    schemaVersion: 5,
    autoSyncEnabled: true,
    autoSyncIntervalSeconds: 300,
    providerTabs: { initialized: true, selectedTabs: [] }
  }, storage);

  assert.equal(isRefreshPlanRunning(migrated.refreshPlan), false, 'upgrading must not begin reloading pages');
  assert.equal(migrated.refreshPlan.remaining, 0);
  assert.equal(migrated.refreshPlan.nextAt, null);
  // The old cadence is kept as the default for the next run the user starts.
  assert.equal(migrated.refreshPlan.intervalSeconds, 300);
  assert.equal(Object.hasOwn(migrated, 'autoSyncEnabled'), false);
  assert.equal(isRefreshPlanRunning(loadPreferences(storage).refreshPlan), false);
});

test('a rate-limited scan reports when it can be retried instead of failing silently', () => {
  const now = Date.parse('2026-08-16T10:00:00.000Z');

  assert.equal(rateLimitRetryAt([], now), null);
  assert.equal(rateLimitRetryAt([{ message: 'something else' }], now), null);
  // The longest wait wins, so the countdown never expires early.
  assert.equal(
    rateLimitRetryAt([{ retryAfterMs: 60_000 }, { retryAfterMs: 240_000 }], now),
    now + 240_000
  );

  assert.deepEqual(rateLimitState(null, now), { limited: false, label: '' });
  assert.deepEqual(rateLimitState(now - 1, now), { limited: false, label: '' });
  assert.deepEqual(rateLimitState(now + 90_000, now), {
    limited: true, label: 'Rate limited · retry in 1:30'
  });
  // It clears itself as the clock passes it, without needing a scan to reset it.
  assert.equal(rateLimitState(now + 5_000, now + 6_000).limited, false);
});

test('the extension refresh command is accepted only from this page and origin', () => {
  const win = { location: { origin: 'http://localhost:5074' } };
  global.window = win;
  const command = {
    channel: 'llm-run-rate-tracker',
    direction: 'command',
    type: 'EXTENSION_REFRESH_NOW'
  };
  const at = (overrides = {}) => ({ source: win, origin: win.location.origin, data: command, ...overrides });

  assert.equal(isExtensionRefreshCommand(at()), true);
  // A different window, a different origin, or a different shape is ignored, so
  // an embedded frame or a lookalike origin cannot trigger a provider reload.
  assert.equal(isExtensionRefreshCommand(at({ source: {} })), false);
  assert.equal(isExtensionRefreshCommand(at({ origin: 'https://evil.example' })), false);
  assert.equal(isExtensionRefreshCommand(at({ data: { ...command, direction: 'response' } })), false);
  assert.equal(isExtensionRefreshCommand(at({ data: { ...command, channel: 'other' } })), false);
  assert.equal(isExtensionRefreshCommand(at({ data: { ...command, type: 'SOMETHING_ELSE' } })), false);
  assert.equal(isExtensionRefreshCommand(at({ data: undefined })), false);
  assert.equal(isExtensionRefreshCommand(undefined), false);
  delete global.window;
});

test('the Overview refresh control offers only bounded choices and reports progress', () => {
  const stopped = renderRefreshPlanPanel(
    { intervalSeconds: 900, totalRefreshes: 5, remaining: 0, nextAt: null },
    Date.parse('2026-08-16T10:00:00.000Z')
  );
  assert.match(stopped, /data-action="refresh-plan-start"/);
  assert.doesNotMatch(stopped, /refresh-plan-stop/);
  assert.match(stopped, /Stopped · 5 refreshes every 15m when started/);
  assert.match(stopped, /stops on its own/);

  // Nothing faster than 5 minutes or longer than 10 refreshes is selectable.
  const intervals = [...stopped.matchAll(/<option value="(\d+)"[^>]*>\d+m</g)].map((m) => Number(m[1]));
  assert.deepEqual(intervals, [300, 600, 900, 1800, 3600]);
  const counts = [...stopped.matchAll(/<option value="(\d+)"[^>]*>(\d+)</g)]
    .filter((m) => m[1] === m[2]).map((m) => Number(m[1]));
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const now = Date.parse('2026-08-16T10:00:00.000Z');
  const running = renderRefreshPlanPanel(
    { intervalSeconds: 900, totalRefreshes: 10, remaining: 7, nextAt: now + 90_000 },
    now
  );
  assert.match(running, /Refresh 4 of 10 · next in 1:30/);
  assert.match(running, /data-action="refresh-plan-stop"/);
  assert.match(running, /data-action="refresh-plan-reset"/);
  assert.doesNotMatch(running, /data-action="refresh-plan-start"/);
});

function headlineFixture() {
  // A burnt 5-hour session window next to a barely-touched weekly cap: the two
  // weightings disagree loudly, which is the point of the assertions below.
  return [
    {
      id: 'session',
      provider: 'Claude',
      metricLabel: 'Current session',
      daysInCycle: 1,
      hoursPerDay: 5,
      totalHours: 5,
      actualCum: 0.8,
      flatCum: 0.4
    },
    {
      id: 'weekly',
      provider: 'Claude',
      metricLabel: 'Weekly limit',
      daysInCycle: 7,
      hoursPerDay: 24,
      totalHours: 168,
      actualCum: 0.2,
      flatCum: 0.1
    },
    {
      id: 'daily',
      provider: 'OpenAI',
      metricLabel: 'Daily limit',
      daysInCycle: 1,
      hoursPerDay: 24,
      totalHours: 24,
      actualCum: 0.5,
      flatCum: 0.5
    }
  ];
}

test('the headline average weights trackers by cycle length, not by count', () => {
  const models = headlineFixture();
  const summary = overallPaceSummary(models);

  assert.equal(summary.available, true);
  assert.equal(summary.count, 3);
  assert.equal(summary.weightHours, 197);
  // (5*0.8 + 168*0.2 + 24*0.5) / 197 and (5*0.4 + 168*0.1 + 24*0.5) / 197
  assert.equal(summary.actual.toFixed(4), (49.6 / 197).toFixed(4));
  assert.equal(summary.ideal.toFixed(4), (30.8 / 197).toFixed(4));
  assert.equal(summary.delta.toFixed(4), (18.8 / 197).toFixed(4));
  // An equal-weight mean would read +20 points; cycle weighting reports +10.
  assert.equal(paceDeltaContext(summary.actual, summary.ideal).shortLabel, '+10%');

  assert.deepEqual(overallPaceSummary([]), {
    available: false, count: 0, weightHours: 0, actual: 0, ideal: 0, delta: 0
  });
  assert.equal(overallPaceSummary([{ id: 'no-cycle', daysInCycle: 0, hoursPerDay: 0 }]).available, false);
});

test('the headline scope selects overall, a provider, or a single tracker', () => {
  const models = headlineFixture();

  assert.deepEqual(resolveHeadlineScope(models, 'overall').models.map((m) => m.id), ['session', 'weekly', 'daily']);
  assert.equal(resolveHeadlineScope(models, 'overall').label, 'Overall');

  const claude = resolveHeadlineScope(models, 'provider:claude');
  assert.equal(claude.label, 'Claude');
  assert.deepEqual(claude.models.map((m) => m.id), ['session', 'weekly']);
  assert.equal(overallPaceSummary(claude.models).weightHours, 173);

  const session = resolveHeadlineScope(models, 'tracker:session');
  assert.equal(session.label, 'Claude - Current Session');
  assert.deepEqual(session.models.map((m) => m.id), ['session']);

  const options = headlineScopeOptions(models);
  assert.deepEqual(options.providers.map((entry) => entry.value), ['provider:claude', 'provider:openai']);
  assert.deepEqual(options.trackers.map((entry) => entry.value), ['tracker:session', 'tracker:weekly', 'tracker:daily']);
});

test('an unavailable headline scope falls back to overall instead of blanking', () => {
  const models = headlineFixture();

  for (const missing of ['tracker:deleted', 'provider:gemini', 'nonsense', '', null]) {
    const scope = resolveHeadlineScope(models, missing);
    assert.equal(scope.scope, 'overall');
    assert.equal(scope.label, 'Overall');
    assert.equal(scope.models.length, 3);
  }
  assert.equal(resolveHeadlineScope(models, 'tracker:deleted').resolved, false);
  assert.equal(resolveHeadlineScope(models, 'overall').resolved, true);
});

test('the page title carries the headline delta only while the indicator is on', () => {
  const models = headlineFixture();
  const on = { schemaVersion: 5, showHeadlineIndicator: true, headlineScope: 'overall' };

  assert.equal(documentTitle(models, on), '+10% — Too Many Tokens');
  assert.equal(
    documentTitle(models, { ...on, headlineScope: 'tracker:session' }),
    '+40% — Too Many Tokens'
  );
  assert.equal(
    documentTitle(models, { ...on, headlineScope: 'tracker:daily' }),
    '0% — Too Many Tokens'
  );
  assert.equal(documentTitle(models, { ...on, showHeadlineIndicator: false }), 'Too Many Tokens');
  assert.equal(documentTitle([], on), 'Too Many Tokens');
});

test('overview opens with one row of cards: sync-and-refreshes, then overall', () => {
  const models = headlineFixture();
  const overview = renderPage('overview', models, models);

  assert.match(overview, /class="overview-top-row"/);
  const refreshes = overview.indexOf('refresh-plan-panel');
  const headline = overview.indexOf('headline-panel');
  assert.ok(refreshes >= 0 && headline >= 0, 'both cards render');
  assert.ok(refreshes < headline, 'cards keep their order');
  // The combined card carries the chrome the header used to hold, same hooks.
  assert.match(overview, /refresh-plan-panel[^]*data-header-status/);
  assert.match(overview, /refresh-plan-panel[^]*data-action="connect-scan"/);
  assert.doesNotMatch(overview, /sync-status-panel/);
});

test('the headline panel renders on Overview and hides when switched off', () => {
  const models = headlineFixture();
  const overview = renderPage('overview', models, models);

  assert.match(overview, /class="panel headline-panel"/);
  assert.match(overview, /headline-delta warning">\+10%/);
  assert.match(overview, /Overall<\/span>/);
  assert.match(overview, /197h of quota/);
  assert.ok(overview.indexOf('headline-panel') < overview.indexOf('overview-pace'));

  assert.equal(renderHeadlinePanel([]), '');
  assert.equal(
    headlinePaceContext(models, { schemaVersion: 5, showHeadlineIndicator: false }).available,
    false
  );

  const setup = renderPage('setup', models, models);
  assert.match(setup, /data-action="toggle-headline"/);
  assert.match(setup, /data-headline-scope/);
  assert.match(setup, /<option value="tracker:session" >/);
  assert.match(setup, /<optgroup label="Provider">/);
});

test('the scope selector moves the title only — the Overview panel stays overall', () => {
  const models = headlineFixture();
  const scoped = {
    schemaVersion: 5,
    showHeadlineIndicator: true,
    headlineScope: 'tracker:session'
  };

  // Same preferences, two readings: the title narrows, the panel does not.
  assert.equal(documentTitle(models, scoped), '+40% — Too Many Tokens');
  assert.equal(headlinePaceContext(models, scoped).scope.scope, 'tracker:session');
  assert.equal(headlinePaceContext(models, scoped, { scoped: false }).scope.scope, 'overall');
  assert.equal(headlinePaceContext(models, scoped, { scoped: false }).summary.count, 3);
  assert.equal(headlinePaceContext(models, scoped, { scoped: false }).delta.shortLabel, '+10%');

  const panel = renderHeadlinePanel(models);
  assert.match(panel, /headline-eyebrow">Overall</);
  assert.match(panel, /headline-delta warning">\+10%/);
  assert.doesNotMatch(panel, /\+40%/);
  assert.match(panel, /Every shown tracker, weighted by cycle length/);

  // The switch still governs both surfaces together.
  assert.equal(documentTitle(models, { ...scoped, showHeadlineIndicator: false }), 'Too Many Tokens');
});

test('the header reports the auto-sync countdown and how stale the numbers are', () => {
  assert.equal(formatSyncCountdown(0), '0s');
  assert.equal(formatSyncCountdown(-5000), '0s');
  assert.equal(formatSyncCountdown(24_000), '24s');
  assert.equal(formatSyncCountdown(59_000), '59s');
  assert.equal(formatSyncCountdown(59_400), '1:00');
  assert.equal(formatSyncCountdown(90_000), '1:30');
  assert.equal(formatSyncCountdown(600_000), '10:00');
  assert.equal(formatSyncCountdown('nope'), '—');

  const now = Date.parse('2026-08-16T12:00:00.000Z');
  assert.equal(formatSyncedAgo(null, now), 'Never synced');
  assert.equal(formatSyncedAgo('not a date', now), 'Never synced');
  assert.equal(formatSyncedAgo(now - 3_000, now), 'Synced just now');
  assert.equal(formatSyncedAgo(now - 42_000, now), 'Synced 42s ago');
  assert.equal(formatSyncedAgo(now - 5 * 60_000, now), 'Synced 5m ago');
  assert.equal(formatSyncedAgo(now - 3 * 3_600_000, now), 'Synced 3h ago');
  assert.equal(formatSyncedAgo(now - 50 * 3_600_000, now), 'Synced 2d ago');

  assert.deepEqual(syncCountdownState(false, now + 30_000, false, now), { state: 'idle', label: '' });
  assert.deepEqual(syncCountdownState(true, null, false, now), { state: 'idle', label: '' });
  assert.deepEqual(syncCountdownState(true, now + 30_000, false, now), {
    state: 'counting', label: 'next in 30s'
  });
  assert.deepEqual(syncCountdownState(true, now + 30_000, true, now), {
    state: 'syncing', label: 'syncing now'
  });

  const header = renderDashboard([], [], 'overview');
  assert.match(header, /data-header-status/);
  assert.match(header, /data-sync-age[^>]*>Never synced</);
});

test('last synced comes from the newest tracker timestamp', () => {
  assert.equal(latestModelUpdate([]), null);
  assert.equal(latestModelUpdate([{ lastUpdatedAt: '' }, { lastUpdatedAt: 'nope' }]), null);
  assert.equal(latestModelUpdate([
    { lastUpdatedAt: '2026-08-16T10:00:00.000Z' },
    { lastUpdatedAt: '2026-08-16T11:30:00.000Z' },
    { lastUpdatedAt: 'unparseable' }
  ]), Date.parse('2026-08-16T11:30:00.000Z'));
});

test('tracker visibility defaults on and can be persisted off independently', () => {
  let stored = JSON.stringify([
    { id: 'session', metricLabel: 'Current session' },
    { id: 'spend', metricLabel: '$0.00 spent' }
  ]);
  global.localStorage = {
    getItem() { return stored; },
    setItem(key, value) { stored = value; }
  };

  assert.equal(isTrackerEnabled(JSON.parse(stored)[1]), true);
  assert.equal(setTrackerEnabled('spend', false), true);
  const models = JSON.parse(stored);
  assert.equal(isTrackerEnabled(models[0]), true);
  assert.equal(isTrackerEnabled(models[1]), false);
  delete global.localStorage;
});

test('manual field edits persist immediately without waiting for a change event', () => {
  let stored = JSON.stringify([{ id: 'manual', provider: 'Claude', metricLabel: 'Custom limit' }]);
  global.localStorage = {
    getItem() { return stored; },
    setItem(key, value) { stored = value; }
  };

  assert.equal(updateModelField('manual', 'provider', 'OpenAI', false), true);
  assert.equal(JSON.parse(stored)[0].provider, 'OpenAI');
  delete global.localStorage;
});

test('legacy migration removes the proven OpenAI analytics Day control artifact', () => {
  const artifact = {
    id: 'artifact',
    provider: 'OpenAI',
    model: 'Day',
    metricKey: 'day-2',
    metricLabel: 'Day',
    sourceUrl: 'https://chatgpt.com/codex/cloud/settings/analytics',
    description: 'Scraped from https://chatgpt.com/codex/cloud/settings/analytics',
    lastUpdatedAt: '2026-08-10T10:00:00.000Z',
    daysInCycle: 7,
    hoursPerDay: 24
  };
  const manualDay = {
    ...artifact,
    id: 'manual-day',
    sourceUrl: '',
    description: 'My manual Day tracker'
  };
  const realDaily = {
    ...artifact,
    id: 'daily',
    model: 'Daily usage limit',
    metricKey: 'daily',
    metricLabel: 'Daily usage limit',
    daysInCycle: 1,
    description: 'Scraped from https://chatgpt.com/codex/cloud/settings/analytics'
  };
  const realAutoDayCycle = {
    ...artifact,
    id: 'real-day-cycle',
    daysInCycle: 1
  };
  const unrelatedAutoDay = {
    ...artifact,
    id: 'unrelated-auto-day',
    sourceUrl: 'https://chatgpt.com/day',
    description: 'Scraped from https://chatgpt.com/day'
  };
  const legacyUsageArtifact = {
    ...artifact,
    id: 'legacy-usage-artifact',
    sourceUrl: 'https://chatgpt.com/codex/settings/usage',
    description: 'Scraped from https://chatgpt.com/codex/settings/usage'
  };
  const exactDayArtifact = {
    ...artifact,
    id: 'exact-day-artifact',
    metricKey: 'day'
  };
  const editedDescription = {
    ...artifact,
    id: 'edited-description',
    description: 'My Day comparison'
  };
  const invalidTimestamp = {
    ...artifact,
    id: 'invalid-timestamp',
    lastUpdatedAt: 'not-a-date'
  };

  assert.equal(isAutoScrapedOpenAiDayArtifact(artifact), true);
  const migrated = migrateStoredModels([
    artifact,
    manualDay,
    realDaily,
    realAutoDayCycle,
    unrelatedAutoDay,
    legacyUsageArtifact,
    exactDayArtifact,
    editedDescription,
    invalidTimestamp
  ]);
  assert.equal(migrated.changed, true);
  assert.deepEqual(
    migrated.models.map((model) => model.id),
    [
      'manual-day',
      'daily',
      'real-day-cycle',
      'unrelated-auto-day',
      'edited-description',
      'invalid-timestamp'
    ]
  );
});

test('loading models persists the narrow Day migration once', () => {
  const models = [{
    id: 'artifact',
    provider: 'OpenAI',
    model: 'Day',
    metricKey: 'day',
    metricLabel: 'Day',
    sourceUrl: 'https://chatgpt.com/codex/cloud/settings/analytics',
    description: 'Scraped from https://chatgpt.com/codex/cloud/settings/analytics',
    lastUpdatedAt: '2026-08-10T10:00:00.000Z',
    daysInCycle: 7,
    hoursPerDay: 24
  }, { id: 'weekly', provider: 'OpenAI', metricKey: 'weekly', metricLabel: 'Weekly usage limit' }];
  let stored = JSON.stringify(models);
  global.localStorage = {
    getItem() { return stored; },
    setItem(key, value) { stored = value; }
  };

  assert.deepEqual(loadModels().map((model) => model.id), ['weekly']);
  assert.deepEqual(JSON.parse(stored).map((model) => model.id), ['weekly']);
  delete global.localStorage;
});

test('dashboard rejects a false OpenAI Day payload even from a stale extension', () => {
  const dayPayload = {
    page: 'https://chatgpt.com/codex/cloud/settings/analytics',
    sourceUrl: 'https://chatgpt.com/codex/cloud/settings/analytics',
    provider: 'OpenAI',
    modelName: 'Day',
    metricKey: 'day',
    metricLabel: 'Day',
    currentPercent: 0,
    scrapedAt: '2026-08-10T10:00:00.000Z'
  };
  const weeklyPayload = {
    ...dayPayload,
    modelName: 'Weekly usage limit',
    metricKey: 'weekly',
    metricLabel: 'Weekly usage limit',
    currentPercent: 30
  };
  const duplicatedDayPayload = { ...dayPayload, metricKey: 'day-2' };
  let stored = '[]';
  global.localStorage = {
    getItem() { return stored; },
    setItem(key, value) { stored = value; }
  };

  assert.equal(isOpenAiDayPayloadArtifact(dayPayload), true);
  assert.equal(isOpenAiDayPayloadArtifact(duplicatedDayPayload), true);
  assert.equal(isOpenAiDayPayloadArtifact(weeklyPayload), false);
  assert.equal(isOpenAiDayPayloadArtifact({
    ...dayPayload,
    page: 'https://chatgpt.com/day',
    sourceUrl: 'https://chatgpt.com/day'
  }), false);
  assert.equal(applyScrapedPayloads([duplicatedDayPayload, weeklyPayload]), 1);
  assert.deepEqual(JSON.parse(stored).map((model) => model.metricKey), ['weekly']);
  delete global.localStorage;
});

test('trackers from one provider window stay individually addressable in one group', () => {
  const groups = groupTrackers([
    { id: 'session', provider: 'Claude', sourceUrl: 'https://claude.ai/settings/usage' },
    { id: 'spend', provider: 'Claude', sourceUrl: 'https://claude.ai/settings/usage', dashboardEnabled: false },
    { id: 'weekly', provider: 'OpenAI', sourceUrl: 'https://chatgpt.com/settings/usage' }
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].models.map((model) => model.id), ['session', 'spend']);
  assert.equal(isTrackerEnabled(groups[0].models[0]), true);
  assert.equal(isTrackerEnabled(groups[0].models[1]), false);
});

test('dashboard analytics group trackers by provider without case-sensitive splits', () => {
  const groups = groupModelsByProvider([
    { id: 'session', provider: 'Claude' },
    { id: 'weekly', provider: 'OpenAI' },
    { id: 'fable', provider: 'claude' }
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].provider, 'Claude');
  assert.deepEqual(groups[0].models.map((model) => model.id), ['session', 'fable']);
  assert.deepEqual(groups[1].models.map((model) => model.id), ['weekly']);
});

test('Overview bars render one flat list with provider-qualified Title Case labels', () => {
  const models = [
    { id: 'session', provider: 'Claude', metricLabel: 'Current session', actualCum: 0.5, flatCum: 0.4, totalHours: 5, currentHour: 2, resetAt: '2099-08-12T14:30:00' },
    { id: 'fable', provider: 'Claude', metricLabel: 'Fable', actualCum: 0.3, flatCum: 0.4, totalHours: 168, currentHour: 67 },
    { id: 'weekly', provider: 'OpenAI', metricLabel: 'Weekly usage limit', actualCum: 0.2, flatCum: 0.18, totalHours: 168, currentHour: 30 }
  ];

  const overview = renderPage('overview', models, models);
  assert.match(overview, /Claude - Current Session/);
  assert.match(overview, /Claude - Fable/);
  assert.match(overview, /OpenAI - Weekly Usage Limit/);
  assert.doesNotMatch(overview, /pace-provider-header|pace-provider-group/);
  assert.match(overview, /Actual vs Ideal Pace/);
  assert.match(overview, /Projected depletion/);
  assert.match(overview, /resets Wed, 12 Aug 2099 at 14:30/);
  assert.doesNotMatch(overview, /Usage trend|Usage Trend/);
});

test('tracker display labels preserve provider names and normalize metric title casing', () => {
  assert.equal(
    trackerDisplayLabel({ provider: 'OpenAI', metricLabel: 'Weekly usage limit' }),
    'OpenAI - Weekly Usage Limit'
  );
  assert.equal(
    trackerDisplayLabel({ provider: 'Claude', metricLabel: 'Current session' }),
    'Claude - Current Session'
  );
});

test('bars and graphs use the same alphabetical provider-qualified tracker order', () => {
  const models = [
    { id: 'weekly', provider: 'OpenAI', metricLabel: 'Weekly usage limit', actualCum: 0.2, flatCum: 0.1 },
    { id: 'fable', provider: 'Claude', metricLabel: 'Fable', actualCum: 0.3, flatCum: 0.2 },
    { id: 'session', provider: 'Claude', metricLabel: 'Current session', actualCum: 0.4, flatCum: 0.3 },
    { id: 'all', provider: 'Claude', metricLabel: 'All models', actualCum: 0.5, flatCum: 0.4 }
  ];
  const expected = [
    'Claude - All Models',
    'Claude - Current Session',
    'Claude - Fable',
    'OpenAI - Weekly Usage Limit'
  ];
  assert.deepEqual(sortTrackersAlphabetically(models).map(trackerDisplayLabel), expected);

  [renderPage('overview', models, models), renderPaceGraphs(models)].forEach((html) => {
    const positions = expected.map((label) => html.indexOf(label));
    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  });
});

test('pace graphs show ideal, actual, and current cycle position for each provider tracker', () => {
  const models = [{
    id: 'session',
    provider: 'Claude',
    metricLabel: 'Current session',
    actualCum: 0.53,
    flatCum: 0.4,
    totalHours: 5,
    resetAt: '2099-08-12T14:30:00',
    lastUpdatedAt: '2026-08-10T10:00:00.000Z',
    usageHistory: [
      { timestamp: '2026-08-10T09:00:00.000Z', usedPercent: 0.3 },
      { timestamp: '2026-08-10T10:00:00.000Z', usedPercent: 0.53 }
    ]
  }];
  const data = paceCurveData(models[0], new Date('2026-08-10T10:00:00.000Z').getTime());
  const html = renderPaceGraphs(models);

  assert.equal(data.points.length, 2);
  assert.match(html, /Actual vs Ideal Pace/);
  assert.match(html, /class="pace-curve-ideal"/);
  assert.match(html, /class="pace-curve-actual series-0"/);
  assert.match(html, /class="pace-curve-now"/);
  assert.match(html, /Claude - Current Session/);
  assert.match(html, /Projected depletion/);
  assert.match(html, /Resets Wed, 12 Aug 2099 at 14:30/);
  assert.doesNotMatch(html, /pace-graph-provider|pace-provider-header/);
  assert.match(html, />Graphs<\/button>/);
});

function runwayModel(overrides = {}) {
  return {
    id: 'runway',
    provider: 'Claude',
    metricLabel: 'Weekly limit',
    actualCum: 0.4,
    flatCum: 0.4,
    currentHour: 67.2,
    remainingHours: 100.8,
    totalHours: 168,
    resetAt: '2099-08-17T14:30:00',
    ...overrides
  };
}

// Severity is a scale, not a verdict: every band has to be reachable by moving
// one number, and the bands have to stay in order.
test('runway bands walk a continuous margin from ample through off the end', () => {
  const bandFor = (projectedHoursToDepletion) => runwayPhysics(
    runwayModel({ projectedHoursToDepletion })
  );

  assert.equal(bandFor(200).state, 'ample');
  assert.equal(bandFor(130).state, 'comfortable');
  assert.equal(bandFor(105).state, 'marginal');
  assert.equal(bandFor(95).state, 'overrun');
  assert.equal(bandFor(50).state, 'off-end');

  const severities = [200, 130, 105, 95, 50].map((hours) => bandFor(hours).severity);
  severities.slice(1).forEach((value, index) => {
    assert.ok(value > severities[index], `severity should rise: ${severities.join(', ')}`);
  });
  assert.equal(bandFor(200).severity, 0);
  assert.equal(bandFor(20).severity, 1);
});

test('runway margin is reported in hours either side of the reset', () => {
  const spare = runwayPhysics(runwayModel({ projectedHoursToDepletion: 124.8 }));
  assert.equal(Math.round(spare.marginHours), 24);
  assert.match(spare.detail, /1d/);

  const short = runwayPhysics(runwayModel({ projectedHoursToDepletion: 76.8 }));
  assert.equal(Math.round(short.marginHours), -24);
  assert.match(short.detail, /runs dry 1d before the reset/);
});

// The scene geometry is the measurement, so it has to move with the margin and
// not with the band. Two cards in the same band at different margins must not
// draw the same picture.
test('runway geometry moves continuously with the margin, not with the band', () => {
  const sceneFor = (overrides) => runwayScene(runwayPhysics(runwayModel(overrides)));
  const flagFor = (projectedHoursToDepletion) => sceneFor({ projectedHoursToDepletion }).flagX;

  // More margin pulls the reset post back toward the aircraft -- the reset
  // catches you having burned less.
  const flags = [105, 120, 150, 200, 260].map(flagFor);
  flags.slice(1).forEach((value, index) => {
    assert.ok(value < flags[index], 'the flag should move left as margin grows');
  });

  // Margin 1 lands the flag exactly on the wall: running dry at the reset.
  const onTheNumbers = sceneFor({ projectedHoursToDepletion: 100.8 });
  assert.ok(Math.abs(onTheNumbers.flagX - 620) < 0.5, 'margin 1 is the wall itself');

  // Less margin pushes the flag past the wall, into the overrun ground.
  assert.ok(flagFor(80) > 620);

  // Two margins inside the same band still differ on screen.
  assert.equal(runwayPhysics(runwayModel({ projectedHoursToDepletion: 200 })).state, 'ample');
  assert.equal(runwayPhysics(runwayModel({ projectedHoursToDepletion: 260 })).state, 'ample');
  assert.notEqual(flagFor(200), flagFor(260));

  // The aircraft stands at its used fraction, and the ghost at the ideal one.
  const light = sceneFor({ actualCum: 0.2, flatCum: 0.4, projectedHoursToDepletion: 200 });
  const heavy = sceneFor({ actualCum: 0.7, flatCum: 0.4, projectedHoursToDepletion: 200 });
  assert.ok(heavy.planeDx > light.planeDx, 'more used draws the aircraft further down the runway');
  assert.equal(light.ghostDx, heavy.ghostDx, 'the even-pace ghost only moves with the ideal');
  assert.ok(light.planeDx < light.ghostDx, 'under ideal pace the aircraft trails its ghost');
  assert.ok(heavy.planeDx > heavy.ghostDx, 'over ideal pace the aircraft leads its ghost');

  // And the clamp keeps the flag on the card.
  assert.ok(flagFor(5) <= 700);
});

// This used to render as a mint badge and a perfect landing, which was the one
// case where the picture asserted something the data did not support.
test('runway treats an unmeasurable rate as its own state, not as a safe landing', () => {
  const physics = runwayPhysics(runwayModel({ actualCum: 0, flatCum: 0, currentHour: 0, projectedHoursToDepletion: null }));
  assert.equal(physics.state, 'holding');
  assert.equal(physics.margin, null);
  assert.equal(physics.marginHours, null);
  assert.equal(physics.drop, 0);
  assert.match(physics.detail, /no burn rate/);

  const html = renderRunwayView([runwayModel({ actualCum: 0, flatCum: 0, currentHour: 0, projectedHoursToDepletion: null })]);
  assert.match(html, /class="runway-card runway-holding"/);
  assert.doesNotMatch(html, /runway-ample|runway-comfortable/);
});

test('runway reports an already spent quota as exhausted', () => {
  const physics = runwayPhysics(runwayModel({ actualCum: 1, currentHour: 120, projectedHoursToDepletion: 0 }));
  assert.equal(physics.state, 'exhausted');
  assert.equal(physics.severity, 1);
  assert.equal(physics.drop, 1);
});

// Second channel: how hard the approach is, read off the pace delta and
// independent of whether the landing ends well.
test('runway approach speed tracks the pace delta independently of the outcome', () => {
  assert.equal(runwayApproachSpeed(0), 1);
  assert.ok(runwayApproachSpeed(0.2) > runwayApproachSpeed(0.05));
  assert.ok(runwayApproachSpeed(-0.2) < 1);
  assert.equal(runwayApproachSpeed(1), 2.4, 'clamped at the top');
  assert.equal(runwayApproachSpeed(-1), 0.35, 'clamped at the bottom');

  // Above ideal pace but still stopping in time: fast approach, safe outcome.
  const hot = runwayPhysics(runwayModel({ actualCum: 0.6, flatCum: 0.4, projectedHoursToDepletion: 200 }));
  assert.equal(hot.state, 'ample');
  assert.ok(hot.speed > 1.4, `expected a hot approach, got ${hot.speed}`);
});

// Third channel: is the burn rate itself rising or falling? Positive is braking.
test('runway brake reads the direction of the burn rate from history', () => {
  const at = (minutes) => new Date(Date.UTC(2099, 7, 12, 0, minutes)).toISOString();
  const steady = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const slowing = [0.1, 0.3, 0.5, 0.55, 0.58, 0.6];
  const building = [0.1, 0.12, 0.15, 0.3, 0.45, 0.6];
  const historyOf = (values) => values.map((usedPercent, index) => ({ timestamp: at(index * 30), usedPercent }));

  assert.ok(Math.abs(runwayBrake(runwayModel({ usageHistory: historyOf(steady) }))) < 1e-9, 'a constant rate is no trend');
  assert.ok(runwayBrake(runwayModel({ usageHistory: historyOf(slowing) })) > 0.3);
  assert.ok(runwayBrake(runwayModel({ usageHistory: historyOf(building) })) < -0.3);
  assert.equal(runwayBrake(runwayModel({ usageHistory: [] })), 0, 'no history is not a trend');
});

// The ghost is recomputed from stored history rather than persisted, so it can
// never disagree with the samples the rest of the dashboard draws.
test('runway ghost recovers the previous reading and names the change', () => {
  const at = (minutes) => new Date(Date.UTC(2099, 7, 12, 0, minutes)).toISOString();
  const model = runwayModel({
    actualCum: 0.5,
    currentHour: 84,
    remainingHours: 84,
    projectedHoursToDepletion: 84,
    usageHistory: [
      { timestamp: at(0), usedPercent: 0.2 },
      { timestamp: at(60), usedPercent: 0.5 }
    ]
  });
  const physics = runwayPhysics(model);
  assert.ok(physics.ghost, 'a second sample an hour back should produce a ghost');
  assert.ok(physics.ghost.marginHours > physics.marginHours, 'the earlier reading was healthier');
  assert.match(runwayGhostNote(physics), /worse than 1h ago\./);
  assert.notEqual(runwayScene(physics).prev, null);

  // A drop in usage means the cycle reset in between, so the two readings
  // describe different runways and must not be compared.
  const acrossReset = runwayPhysics(runwayModel({
    actualCum: 0.2,
    currentHour: 84,
    remainingHours: 84,
    projectedHoursToDepletion: 84,
    usageHistory: [
      { timestamp: at(0), usedPercent: 0.9 },
      { timestamp: at(60), usedPercent: 0.2 }
    ]
  }));
  assert.equal(acrossReset.ghost, null);
  assert.equal(runwayGhostNote(acrossReset), '');
  assert.equal(runwayScene(acrossReset).prev, null);
});

// The camera rides with the aircraft, so there is no room to draw a ghost
// behind it. The ghost is always set down ahead: its distance is how much
// changed since the last reading, its colour which way it went.
test('the previous projection lands on the side the flag walked away from', () => {
  const at = (minutes) => new Date(Date.UTC(2099, 7, 12, 0, minutes)).toISOString();
  const withHistory = (earlier, now) => runwayModel({
    actualCum: now,
    currentHour: 84,
    remainingHours: 84,
    projectedHoursToDepletion: 84,
    usageHistory: [{ timestamp: at(0), usedPercent: earlier }, { timestamp: at(60), usedPercent: now }]
  });

  // Burning harder than before: the projection blew out rightward, so the
  // previous reading's flag sits behind the live one.
  const worse = runwayScene(runwayPhysics(withHistory(0.2, 0.7)));
  assert.equal(worse.prev.direction, 1);
  assert.ok(worse.prev.x < worse.flagX, 'the healthier past projection lies left of the live flag');

  // Barely moved since: the projection improved, so the past sits beyond it.
  const better = runwayScene(runwayPhysics(withHistory(0.68, 0.7)));
  assert.equal(better.prev.direction, -1);
  assert.ok(better.prev.x > better.flagX, 'the worse past projection lies right of the live flag');
});

// A spent quota has no runway left to measure, only time.
test('an exhausted quota crashes into the wall and counts down to the reset', () => {
  const scene = runwayScene(runwayPhysics(runwayModel({
    actualCum: 1,
    currentHour: 148,
    remainingHours: 20,
    totalHours: 168,
    projectedHoursToDepletion: 0
  })));
  assert.equal(scene.prev, null, 'the countdown replaces the previous-projection marker');
  assert.equal(scene.ghostDx, null, 'even pace means nothing once the quota is gone');
  assert.ok(Math.abs(scene.planeDx + 155.5 - 620) < 0.5, 'the nose touches the wall');
  assert.ok(scene.flagX > 620, 'the reset stands in the overrun ground beyond the wall');
  assert.equal(scene.approach.seconds, 20 * 3600, 'it closes over exactly the remaining wait');
  assert.ok(Math.abs(scene.approach.dx - (scene.flagX - 624)) < 0.5, 'the crawl ends at the wall');

  // Nearer the reset, it waits closer.
  const nearer = runwayScene(runwayPhysics(runwayModel({
    actualCum: 1, currentHour: 166, remainingHours: 2, totalHours: 168, projectedHoursToDepletion: 0
  })));
  assert.ok(nearer.flagX < scene.flagX, 'a shorter wait draws the reset nearer');

  const html = renderRunwayView([runwayModel({
    id: 'spent', actualCum: 1, currentHour: 148, remainingHours: 20, totalHours: 168, projectedHoursToDepletion: 0
  })]);
  assert.match(html, /rw-reset-slider rw-reset-approach/);
  assert.match(html, /class="rw-smoke"/);
  // Crashed, not parked: the wall leans and the aircraft noses down.
  assert.match(html, /class="rw-wall" transform="rotate\(6 620 140\)"/);
  assert.match(html, /rw-jet rw-jet-dead" transform="rotate\(-2.5 154 140\)"/);
  assert.match(html, /data-runway-approach="72000"/);
});

test('runway hud reports pace, rate direction, and margin as real numbers', () => {
  const hud = runwayHudReadout(runwayPhysics(runwayModel({
    actualCum: 0.58,
    flatCum: 0.4,
    projectedHoursToDepletion: 76.8
  })));
  assert.equal(hud.pace, '+18%');
  assert.equal(hud.margin, '−1d');
  assert.equal(hud.rate, 'STEADY');
});

test('runway view renders the scene from the numbers rather than from a class', () => {
  const overrun = runwayModel({ id: 'overrun', provider: 'OpenAI', actualCum: 0.5, currentHour: 48, remainingHours: 120, resetAt: '2099-08-13T14:30:00', projectedHoursToDepletion: 48 });
  const safe = runwayModel({ id: 'safe', actualCum: 0.1, currentHour: 24, remainingHours: 144, projectedHoursToDepletion: 216 });
  const html = renderRunwayView([overrun, safe]);

  assert.equal(runwayOutcome(safe).state, 'ample');
  assert.equal(runwayOutcome(overrun).state, 'off-end');
  assert.match(html, /Quota Runway/);
  assert.match(html, /data-pace-view="runway" aria-pressed="true">Runway/);
  assert.equal((html.match(/class="runway-card runway-ample"/g) || []).length, 1);
  assert.equal((html.match(/class="runway-card runway-off-end"/g) || []).length, 1);

  // Every card carries its animated values somewhere the page's
  // Content-Security-Policy will not throw away; static geometry is plain
  // SVG attributes, which CSP does not govern either.
  ['severity', 'speed', 'plane', 'flag', 'approach', 'approach-dx'].forEach((name) => {
    assert.equal((html.match(new RegExp(`data-runway-${name}="`, 'g')) || []).length, 2, `missing data-runway-${name}`);
  });

  assert.equal((html.match(/<svg class="runway-scene"/g) || []).length, 2);
  assert.equal((html.match(/class="rw-jet"/g) || []).length, 2);
  assert.equal((html.match(/class="rw-ghost-jet"/g) || []).length, 2);
  assert.equal((html.match(/class="rw-flow"/g) || []).length, 2);
  assert.equal((html.match(/class="rw-wall"/g) || []).length, 2);
  assert.equal((html.match(/class="rw-reset"/g) || []).length, 2);
  // The safe card's spare lies before the wall; the overrun card's stranded
  // stretch lies beyond it.
  assert.match(html, /rw-zone-spare/);
  assert.match(html, /rw-zone-short/);
  assert.match(html, /rw-pace-line/);
  assert.match(html, /Ample runway/);
  assert.match(html, /Off the end/);
  assert.match(html, /Δ PACE/);
  assert.match(html, /dry in /);
  assert.match(html, /reset in /);
  assert.match(html, /<dt>Margin at reset<\/dt><dd>3d spare/);
  assert.match(html, /<dt>Reset<\/dt><dd>Thu, 13 Aug 2099 at 14:30/);
});

// serve.js sends `style-src 'self'` with no 'unsafe-inline', so a style
// attribute in the markup is discarded by the browser and every card falls back
// to the registered initial values -- one identical runway whatever the numbers
// said. The scene values have to reach the element through CSSOM instead.
test('runway scene values never travel in a style attribute', () => {
  const html = renderRunwayView([
    runwayModel({ id: 'x', projectedHoursToDepletion: 200 }),
    runwayModel({ id: 'y', provider: 'OpenAI', actualCum: 1, projectedHoursToDepletion: 0 })
  ]);
  assert.doesNotMatch(html, /style=/);
  assert.doesNotMatch(html, /--runway-/);
});

test('settling a card applies every scene value to the element', () => {
  const html = renderRunwayView([runwayModel({ id: 'applied', actualCum: 1, currentHour: 148, remainingHours: 20, totalHours: 168, projectedHoursToDepletion: 0 })]);
  const card = createRunwayCardStub(html);
  settleRunwayCards({ querySelectorAll: () => [card] });

  assert.equal(card.style.values['--runway-severity'], '1');
  assert.equal(card.style.values['--runway-approach'], '72000');
  assert.equal(card.style.values['--runway-plane'], card.attributes['data-runway-plane']);
  assert.equal(card.style.values['--runway-flag'], card.attributes['data-runway-flag']);
  ['severity', 'speed', 'plane', 'flag', 'approach', 'approach-dx'].forEach((name) => {
    assert.ok(card.style.values[`--runway-${name}`] !== undefined, `--runway-${name} was not applied`);
  });
});

// The from-values only exist so a refresh can slide between two readings.
test('runway cards settle from the previous geometry on the next render', () => {
  const model = runwayModel({ id: 'settling', actualCum: 0.3, projectedHoursToDepletion: 200 });
  const first = renderRunwayView([model]);
  assert.doesNotMatch(first, /data-runway-from=/, 'nothing to move from on the first render');

  const frames = [];
  const cards = [createRunwayCardStub(first)];
  settleRunwayCards({ querySelectorAll: () => cards });

  const second = renderRunwayView([runwayModel({ id: 'settling', actualCum: 0.45, projectedHoursToDepletion: 105 })]);
  assert.match(second, /data-runway-from="/);
  const moving = createRunwayCardStub(second, frames);
  settleRunwayCards({ querySelectorAll: () => [moving] });

  // Set back to where the scene already was, then handed the new values on the
  // next frame -- which is what makes it a slide rather than a jump.
  assert.equal(moving.style.values['--runway-plane'], cards[0].attributes['data-runway-plane']);
  assert.equal(moving.style.values['--runway-flag'], cards[0].attributes['data-runway-flag']);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(moving.style.values['--runway-plane'], moving.attributes['data-runway-plane']);
  assert.equal(moving.style.values['--runway-flag'], moving.attributes['data-runway-flag']);
});

function createRunwayCardStub(html, frames) {
  const attributes = {};
  for (const [, name, value] of html.matchAll(/(data-runway-[a-z-]+)="([^"]*)"/g)) attributes[name] = value;
  globalThis.requestAnimationFrame = frames ? (callback) => frames.push(callback) : undefined;
  return {
    attributes,
    offsetWidth: 0,
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; }
  };
}

test('projected depletion distinguishes exhaustion before and after reset', () => {
  assert.deepEqual(
    projectedDepletionContext({ actualCum: 0.5, currentHour: 48, totalHours: 168 }),
    {
      value: '2d',
      note: '~3d before reset',
      tone: 'warning',
      label: 'At the current average usage rate, depletion is projected in 2d, ~3d before reset'
    }
  );
  assert.deepEqual(
    projectedDepletionContext({ actualCum: 0.34, currentHour: 41, totalHours: 168 }),
    {
      value: '3d 7h',
      note: '~2d before reset',
      tone: 'warning',
      label: 'At the current average usage rate, depletion is projected in 3d 7h, ~2d before reset'
    }
  );
  assert.equal(
    projectedDepletionContext({ actualCum: 0.1, currentHour: 24, totalHours: 168 }).note,
    'not before reset'
  );
  assert.equal(projectedDepletionContext({ actualCum: 0.1, currentHour: 24, totalHours: 168 }).value, '—');
  assert.equal(projectedDepletionContext({ actualCum: 0, currentHour: 24, totalHours: 168 }).value, '—');
  assert.equal(formatResetDateTime('2099-08-12T14:30:00'), 'Wed, 12 Aug 2099 at 14:30');
});

test('top bar exposes one accessible icon-only sync action', () => {
  const html = renderDashboard([], [], 'overview');
  assert.doesNotMatch(html, /Manage sources/);
  assert.match(html, /data-action="connect-scan"/);
  assert.match(html, /aria-label="Sync provider tabs"/);
  assert.doesNotMatch(html, />\s*Sync provider tabs\s*<\/button>/);
  assert.doesNotMatch(html, /header-copy|Compare current quota burn|Local dashboard/);
});

test('later provider scans preserve an individually hidden tracker', () => {
  const existing = {
    id: 'spend',
    provider: 'Claude',
    model: '$0.00 spent',
    metricKey: 'weekly-spend',
    metricLabel: '$0.00 spent',
    sourceUrl: 'https://claude.ai/settings/usage',
    dashboardEnabled: false,
    actualCumUsedPercent: 0
  };
  const merged = mergePayloadIntoModels([existing], {
    provider: 'Claude',
    modelName: '$0.00 spent',
    metricKey: 'weekly-spend',
    metricLabel: '$0.00 spent',
    sourceUrl: 'https://claude.ai/settings/usage',
    currentPercent: 12,
    scrapedAt: '2026-08-10T12:00:00.000Z'
  });

  assert.equal(merged.updated, true);
  assert.equal(merged.model.dashboardEnabled, false);
  assert.equal(merged.model.actualCumUsedPercent, 0.12);
});

test('history normalization accepts ratio and whole-percent samples in time order', () => {
  const history = normalizedHistory({
    usageHistory: [
      { timestamp: '2026-08-10T11:00:00.000Z', usedPercent: 25 },
      { timestamp: '2026-08-10T10:00:00.000Z', usedPercent: 0.1 }
    ]
  });

  assert.deepEqual(history.map((sample) => sample.used), [0.1, 0.25]);
});

test('trend change context signs percentage-point movement and flags reset drops', () => {
  assert.deepEqual(
    trendChangeContext([{ used: 0.2 }]),
    { label: '—', tone: 'neutral', resetDrop: false }
  );
  assert.deepEqual(
    trendChangeContext([{ used: 0.2 }, { used: 0.35 }]),
    { label: '+15%', tone: 'increase', resetDrop: false }
  );
  assert.deepEqual(
    trendChangeContext([{ used: 0.82 }, { used: 0.07 }]),
    { label: '−75%', tone: 'reset', resetDrop: true }
  );
});

test('usage trend renders an accessible grouped summary and an explicitly capped line-only plot', () => {
  const firstAt = '2026-08-10T08:00:00.000Z';
  const lastAt = '2026-08-10T10:00:00.000Z';
  const models = Array.from({ length: 7 }, (_, index) => ({
    id: `metric-${index}`,
    provider: index < 4 ? 'Claude' : 'OpenAI',
    sourceUrl: index < 4
      ? 'https://claude.ai/settings/usage'
      : 'https://chatgpt.com/codex/settings/usage',
    metricKey: `quota-${index}`,
    metricLabel: `Quota ${index + 1}`,
    usageHistory: [
      { timestamp: firstAt, usedPercent: 0.1 + index * 0.02 },
      { timestamp: lastAt, usedPercent: 0.2 + index * 0.02 }
    ]
  }));

  const html = renderTrendChart(models);
  assert.match(html, />6 of 7 shown</);
  assert.match(html, />12 samples</);
  assert.match(html, /Local · /);
  assert.equal((html.match(/class="trend-summary-row"/g) || []).length, 6);
  assert.equal((html.match(/>Claude<\/h3>/g) || []).length, 1);
  assert.equal((html.match(/>OpenAI<\/h3>/g) || []).length, 1);
  assert.match(html, />20%<\/dd>/);
  assert.match(html, />\+10%/);
  assert.match(html, />0%<\/text>/);
  assert.equal((html.match(/trend-x-label/g) || []).length, 5);
  assert.match(html, /<svg class="trend-chart"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /role="img"|<circle|trend-dot/);
  assert.equal((html.match(/<path class="trend-line /g) || []).length, 6);
});

test('trend series colors remain stable when model order changes', () => {
  const models = ['Alpha', 'Beta', 'Gamma'].map((metricLabel, index) => ({
    id: metricLabel.toLowerCase(),
    provider: 'Claude',
    sourceUrl: 'https://claude.ai/settings/usage',
    metricKey: metricLabel.toLowerCase(),
    metricLabel,
    usageHistory: [
      { timestamp: '2026-08-10T08:00:00.000Z', usedPercent: 0.1 + index * 0.1 },
      { timestamp: '2026-08-10T09:00:00.000Z', usedPercent: 0.2 + index * 0.1 }
    ]
  }));
  const colorFor = (html, label) => html.match(new RegExp(`series-bg-(\\d)[^>]*><\\/i><strong>${label}<\\/strong>`))?.[1];
  const forward = renderTrendChart(models);
  const reverse = renderTrendChart([...models].reverse());

  models.forEach((model) => {
    assert.ok(colorFor(forward, model.metricLabel));
    assert.equal(colorFor(forward, model.metricLabel), colorFor(reverse, model.metricLabel));
  });
});

test('visual status marks faster quota consumption as an alert', () => {
  assert.deepEqual(
    visualStatus({ actualCum: 0.53, flatCum: 0.4, paceThreshold: 0.02 }),
    { tone: 'warning', label: 'Burning fast' }
  );
  assert.deepEqual(
    visualStatus({ actualCum: 0.3, flatCum: 0.5, paceThreshold: 0.02 }),
    { tone: 'healthy', label: 'Room to spend' }
  );
});

test('pace delta context reports percentage-point direction', () => {
  assert.deepEqual(
    paceDeltaContext(0.53, 0.4),
    { label: '+13 points above ideal', shortLabel: '+13%', tone: 'warning' }
  );
  assert.deepEqual(
    paceDeltaContext(0.3, 0.5),
    { label: '20 points below ideal', shortLabel: '−20%', tone: 'healthy' }
  );
});

test('a tracker named after a reading is recognised as a scraped artifact', () => {
  assert.equal(isValueOnlyMetricLabel('$0.00 spent'), true);
  assert.equal(isValueOnlyMetricLabel('1.2M tokens used'), true);
  assert.equal(isValueOnlyMetricLabel('17%'), true);
  assert.equal(isValueOnlyMetricLabel('0 credits remaining'), true);

  // Real quota names must survive, including one that is only a model name.
  assert.equal(isValueOnlyMetricLabel('Current session'), false);
  assert.equal(isValueOnlyMetricLabel('All models'), false);
  assert.equal(isValueOnlyMetricLabel('Fable'), false);
  assert.equal(isValueOnlyMetricLabel('Weekly usage limit'), false);
  assert.equal(isValueOnlyMetricLabel('GPT-5.3-Codex-Spark'), false);
  assert.equal(isValueOnlyMetricLabel(''), false);
});

test('scraped value-named trackers are pruned, hand-made ones are kept', () => {
  const scraped = {
    id: 'scraped-spend',
    provider: 'Claude',
    model: '$0.00 spent',
    metricKey: 'weekly-0-00-spent',
    metricLabel: '$0.00 spent',
    daysInCycle: 7,
    hoursPerDay: 24,
    lastUpdatedAt: '2026-08-15T07:00:00.000Z',
    sourceUrl: 'https://claude.ai/settings/usage',
    description: 'Scraped from https://claude.ai/settings/usage'
  };
  const handMade = { ...scraped, id: 'hand-made', description: 'My spend tracker' };
  const namedQuota = { ...scraped, id: 'named', metricLabel: 'All models', metricKey: 'weekly-all-models' };

  assert.equal(isAutoScrapedValueOnlyLabelArtifact(scraped), true);
  assert.equal(isAutoScrapedValueOnlyLabelArtifact(handMade), false);
  assert.equal(isAutoScrapedValueOnlyLabelArtifact(namedQuota), false);

  const migrated = migrateStoredModels([scraped, handMade, namedQuota]);
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.models.map((model) => model.id), ['hand-made', 'named']);
});

test('a payload named after a reading never becomes a tracker', () => {
  assert.equal(isValueOnlyLabelPayloadArtifact({ metricLabel: '$0.00 spent' }), true);
  assert.equal(isValueOnlyLabelPayloadArtifact({ metricLabel: 'Weekly usage limit' }), false);
});
