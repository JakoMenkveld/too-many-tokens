'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyScrapedPayloads,
  autoSyncIntervalMilliseconds,
  autoSyncBadgeState,
  formatAutoSyncInterval,
  formatResetDateTime,
  groupModelsByProvider,
  groupTrackers,
  isAutoScrapedOpenAiDayArtifact,
  isAutoScrapedValueOnlyLabelArtifact,
  isValueOnlyLabelPayloadArtifact,
  isValueOnlyMetricLabel,
  isOpenAiDayPayloadArtifact,
  isTrackerEnabled,
  loadModels,
  loadPreferences,
  mergePayloadIntoModels,
  migrateStoredModels,
  normalizedHistory,
  pageFromHash,
  paceDeltaContext,
  paceCurveData,
  projectedDepletionContext,
  reconcileTabSelections,
  renderDashboard,
  renderPage,
  renderPaceGraphs,
  renderRunwayView,
  renderTrendChart,
  savePreferences,
  selectedTabIdsForPreferences,
  setTrackerEnabled,
  sendExtensionRequest,
  sortTrackersAlphabetically,
  stableTabUrl,
  tabSelectionProviderKey,
  trackerDisplayLabel,
  runwayOutcome,
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

test('concurrent extension requests only accept their correlated response', async () => {
  const harness = createWindowHarness();
  global.window = harness.win;

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
    schemaVersion: 4,
    autoSyncEnabled: true,
    autoSyncIntervalSeconds: 30,
    overviewPaceView: 'bars',
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
    schemaVersion: 4,
    autoSyncEnabled: false,
    autoSyncIntervalSeconds: 30,
    overviewPaceView: 'bars',
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

test('auto-sync badge always reports off, waiting, or on truthfully', () => {
  assert.deepEqual(autoSyncBadgeState(false, false, 0), { state: 'off', label: 'Auto-sync off' });
  assert.deepEqual(autoSyncBadgeState(true, true, 0), { state: 'waiting', label: 'Auto-sync waiting' });
  assert.deepEqual(autoSyncBadgeState(true, false, 1), { state: 'waiting', label: 'Auto-sync waiting' });
  assert.deepEqual(autoSyncBadgeState(true, true, 1), { state: 'on', label: 'Auto-sync on' });
  assert.match(renderDashboard([], [], 'overview'), /data-auto-sync-state="off"[^>]*><i><\/i>Auto-sync off/);
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

  assert.equal(saved.schemaVersion, 4);
  assert.equal(saved.overviewPaceView, 'graph');
  assert.equal(loadPreferences(storage).overviewPaceView, 'graph');

  const runway = savePreferences({
    ...saved,
    schemaVersion: 4,
    overviewPaceView: 'runway'
  }, storage);
  assert.equal(runway.overviewPaceView, 'runway');
  assert.equal(loadPreferences(storage).overviewPaceView, 'runway');
});

test('auto-sync interval preferences migrate, clamp, and format consistently', () => {
  const storage = createStorage();
  const saved = savePreferences({
    schemaVersion: 4,
    autoSyncEnabled: true,
    autoSyncIntervalSeconds: 120,
    providerTabs: { initialized: false, selectedTabs: [] }
  }, storage);

  assert.equal(saved.autoSyncIntervalSeconds, 120);
  assert.equal(loadPreferences(storage).autoSyncIntervalSeconds, 120);
  assert.equal(formatAutoSyncInterval(30), '30s');
  assert.equal(formatAutoSyncInterval(120), '2m');
  assert.equal(formatAutoSyncInterval(5), '30s');
  assert.equal(formatAutoSyncInterval(7200), '15m');
  assert.equal(autoSyncIntervalMilliseconds(120), 120000);
  const setup = renderPage('setup', [], []);
  assert.match(setup, /data-auto-sync-interval/);
  assert.match(setup, /Auto-sync interval/);
  assert.match(setup, /<option value="30" selected>30s<\/option>/);
  assert.match(setup, /Auto-Sync Every 30s/);
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

test('runway view animates safe stops and projected overruns from depletion timing', () => {
  const safe = {
    id: 'safe',
    provider: 'Claude',
    metricLabel: 'Weekly limit',
    actualCum: 0.1,
    currentHour: 24,
    remainingHours: 144,
    totalHours: 168,
    resetAt: '2099-08-17T14:30:00',
    projectedHoursToDepletion: 216
  };
  const overrun = {
    id: 'overrun',
    provider: 'OpenAI',
    metricLabel: 'Weekly limit',
    actualCum: 0.5,
    currentHour: 48,
    remainingHours: 120,
    totalHours: 168,
    resetAt: '2099-08-13T14:30:00',
    projectedHoursToDepletion: 48
  };
  const html = renderRunwayView([overrun, safe]);

  assert.equal(runwayOutcome(safe).state, 'safe');
  assert.equal(runwayOutcome(overrun).state, 'overrun');
  assert.match(html, /Quota Runway/);
  assert.match(html, /data-pace-view="runway" aria-pressed="true">Runway/);
  assert.equal((html.match(/class="runway-card runway-safe"/g) || []).length, 1);
  assert.equal((html.match(/class="runway-card runway-overrun"/g) || []).length, 1);
  assert.match(html, /class="aircraft-nose"/);
  assert.match(html, /class="aircraft-tailplane aircraft-tailplane-left"/);
  assert.match(html, /class="aircraft-fragments"/);
  assert.match(html, /class="runway-abyss"/);
  assert.match(html, /class="runway-end"/);
  assert.match(html, /class="runway-pavement"/);
  assert.match(html, /class="runway-drop-face"/);
  assert.match(html, /Stops with room/);
  assert.match(html, /Overrun projected/);
  assert.match(html, /<dt>Reset<\/dt><dd>Thu, 13 Aug 2099 at 14:30/);
});

test('projected depletion distinguishes exhaustion before and after reset', () => {
  assert.deepEqual(
    projectedDepletionContext({ actualCum: 0.5, currentHour: 48, totalHours: 168 }),
    {
      value: '2d',
      note: 'before reset',
      tone: 'warning',
      label: 'At the current average usage rate, depletion is projected in 2d, before the reset'
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
