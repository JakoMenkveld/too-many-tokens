'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MODEL,
  calculateCurrentCycleHour,
  computeModel,
  mergeScrapedPayload,
  normalizeSourceUrl
} = require('../tracker-core.js');

test('pace guidance tells faster consumers to slow down', () => {
  const result = computeModel({ ...DEFAULT_MODEL, currentHour: 84, actualCumUsedPercent: 0.75 });
  assert.equal(result.paceStatus, 'Ahead of pace — slow down');
});

test('pace guidance tells slower consumers they can speed up', () => {
  const result = computeModel({ ...DEFAULT_MODEL, currentHour: 84, actualCumUsedPercent: 0.25 });
  assert.equal(result.paceStatus, 'Behind pace — can speed up');
});

test('computed percentages and token values are clamped to valid ranges', () => {
  const percent = computeModel({ ...DEFAULT_MODEL, actualCumUsedPercent: -4 });
  const tokens = computeModel({
    ...DEFAULT_MODEL,
    usageMode: 'tokens',
    currentTokensUsed: 200,
    budgetTokens: 100
  });
  assert.equal(percent.actualCum, 0);
  assert.equal(tokens.actualCum, 1);
});

test('depletion projection extrapolates the average cycle usage rate', () => {
  const beforeReset = computeModel({
    ...DEFAULT_MODEL,
    currentHour: 48,
    actualCumUsedPercent: 0.5
  });
  const afterReset = computeModel({
    ...DEFAULT_MODEL,
    currentHour: 24,
    actualCumUsedPercent: 0.1
  });
  const noUsage = computeModel({
    ...DEFAULT_MODEL,
    currentHour: 24,
    actualCumUsedPercent: 0
  });

  assert.equal(beforeReset.projectedHoursToDepletion, 48);
  assert.equal(beforeReset.projectedDepletionWithinCycle, true);
  assert.equal(afterReset.projectedHoursToDepletion, 216);
  assert.equal(afterReset.projectedDepletionWithinCycle, false);
  assert.equal(noUsage.projectedHoursToDepletion, null);
  assert.equal(noUsage.projectedDepletionWithinCycle, false);
});

test('a reset 101 hours away places a 168-hour cycle at hour 68', () => {
  const now = new Date('2026-08-09T08:00:00.000Z');
  const resetAt = new Date(now.getTime() + 101 * 60 * 60 * 1000).toISOString();
  assert.equal(calculateCurrentCycleHour({ ...DEFAULT_MODEL, resetAt }, now), 68);
});

test('source URLs are normalized for stable identity', () => {
  assert.equal(
    normalizeSourceUrl('https://Example.test/usage/?account=1#quota'),
    'https://example.test/usage'
  );
});

test('two pages from the same provider create separate model entries', () => {
  const options = { now: '2026-08-10T10:00:00.000Z', idFactory: (() => {
    let next = 0;
    return () => `model-${++next}`;
  })() };
  const first = mergeScrapedPayload([], {
    page: 'https://claude.ai/usage/sonnet',
    provider: 'Claude',
    modelName: 'Sonnet',
    currentPercent: 20
  }, options);
  const second = mergeScrapedPayload(first.models, {
    page: 'https://claude.ai/usage/opus',
    provider: 'Claude',
    modelName: 'Opus',
    currentPercent: 30
  }, options);

  assert.equal(second.models.length, 2);
  assert.deepEqual(new Set(second.models.map((model) => model.model)), new Set(['Sonnet', 'Opus']));
});

test('distinct source pages remain separate even when provider and model labels match', () => {
  const first = mergeScrapedPayload([], {
    page: 'https://example.test/accounts/work/usage',
    provider: 'Example AI',
    modelName: 'Shared Model',
    currentPercent: 20
  }, { now: '2026-08-10T10:00:00.000Z', idFactory: () => 'work' });
  const second = mergeScrapedPayload(first.models, {
    page: 'https://example.test/accounts/personal/usage',
    provider: 'Example AI',
    modelName: 'Shared Model',
    currentPercent: 30
  }, { now: '2026-08-10T10:00:00.000Z', idFactory: () => 'personal' });

  assert.equal(second.models.length, 2);
  assert.deepEqual(new Set(second.models.map((model) => model.id)), new Set(['work', 'personal']));
});

test('repeated scans update the entry with the same source URL', () => {
  const first = mergeScrapedPayload([], {
    page: 'https://claude.ai/settings/usage?account=one',
    provider: 'Claude',
    modelName: 'Sonnet',
    currentPercent: 20
  }, { now: '2026-08-10T10:00:00.000Z', idFactory: () => 'stable-id' });
  const second = mergeScrapedPayload(first.models, {
    page: 'https://claude.ai/settings/usage?account=two',
    provider: 'Claude',
    modelName: 'Sonnet',
    currentPercent: 45
  }, { now: '2026-08-10T11:00:00.000Z' });

  assert.equal(second.models.length, 1);
  assert.equal(second.models[0].id, 'stable-id');
  assert.equal(second.models[0].actualCumUsedPercent, 0.45);
  assert.equal(second.matchedBy, 'sourceUrl');
});

test('payload merging preserves custom descriptions and prefers explicit percentages', () => {
  const existing = [{
    ...DEFAULT_MODEL,
    id: 'configured',
    provider: 'OpenAI',
    model: 'GPT-5',
    description: 'Work account',
    sourceUrl: 'https://chatgpt.com/settings/usage'
  }];
  const result = mergeScrapedPayload(existing, {
    page: 'https://chatgpt.com/settings/usage',
    provider: 'OpenAI',
    modelName: 'GPT-5',
    currentPercent: 40,
    currentTokens: 500,
    budgetTokens: 1000,
    resetAt: '2026-08-13T13:00:00.000Z'
  }, { now: '2026-08-09T08:00:00.000Z' });

  assert.equal(result.models[0].description, 'Work account');
  assert.equal(result.models[0].usageMode, 'percent');
  assert.equal(result.models[0].actualCumUsedPercent, 0.4);
  assert.equal(result.models[0].currentTokensUsed, 500);
  assert.equal(result.models[0].currentHour, 68);
});

test('invalid payload numbers do not create corrupt entries', () => {
  const original = [{ ...DEFAULT_MODEL, id: 'existing' }];
  const result = mergeScrapedPayload(original, { currentPercent: 'not-a-number' });
  assert.equal(result.updated, false);
  assert.strictEqual(result.models, original);
});

test('one source URL retains three independently updating Claude quota metrics', () => {
  const idFactory = (() => {
    let next = 0;
    return () => `quota-${++next}`;
  })();
  const options = { now: '2026-08-10T10:00:00.000Z', idFactory };
  const sourceUrl = 'https://claude.ai/settings/usage';
  const payloads = [
    { metricKey: 'session', metricLabel: 'Current session', currentPercent: 10 },
    { metricKey: 'weekly-all-models', metricLabel: 'All models', currentPercent: 20 },
    { metricKey: 'weekly-sonnet', metricLabel: 'Sonnet weekly', currentPercent: 30 }
  ];

  let models = [];
  payloads.forEach((metric) => {
    models = mergeScrapedPayload(models, {
      page: sourceUrl,
      provider: 'Claude',
      modelName: 'Claude usage',
      scrapedAt: options.now,
      ...metric
    }, options).models;
  });

  assert.equal(models.length, 3);
  const originalIds = new Map(models.map((model) => [model.metricKey, model.id]));

  payloads.forEach((metric, index) => {
    models = mergeScrapedPayload(models, {
      page: `${sourceUrl}?refresh=${index}`,
      provider: 'Claude',
      modelName: 'Claude usage',
      scrapedAt: '2026-08-10T10:10:00.000Z',
      ...metric,
      currentPercent: metric.currentPercent + 5
    }, options).models;
  });

  assert.equal(models.length, 3);
  payloads.forEach((metric) => {
    const model = models.find((entry) => entry.metricKey === metric.metricKey);
    assert.equal(model.id, originalIds.get(metric.metricKey));
    assert.equal(model.actualCumUsedPercent, (metric.currentPercent + 5) / 100);
    assert.equal(model.metricLabel, metric.metricLabel);
  });
});

test('legacy source-only records migrate once without swallowing other metrics', () => {
  const legacy = [{
    ...DEFAULT_MODEL,
    id: 'legacy',
    provider: 'Claude',
    model: 'Claude usage',
    sourceUrl: 'https://claude.ai/settings/usage'
  }];
  const session = mergeScrapedPayload(legacy, {
    page: 'https://claude.ai/settings/usage',
    provider: 'Claude',
    modelName: 'Claude usage',
    metricKey: 'session',
    metricLabel: 'Current session',
    currentPercent: 25
  }, { now: '2026-08-10T10:00:00.000Z', idFactory: () => 'new' });
  const weekly = mergeScrapedPayload(session.models, {
    page: 'https://claude.ai/settings/usage',
    provider: 'Claude',
    modelName: 'Claude usage',
    metricKey: 'weekly-all-models',
    metricLabel: 'All models',
    currentPercent: 50
  }, { now: '2026-08-10T10:10:00.000Z', idFactory: () => 'weekly' });

  assert.equal(session.matchedBy, 'legacySourceUrl');
  assert.equal(session.models[0].id, 'legacy');
  assert.equal(weekly.models.length, 2);
  assert.deepEqual(new Set(weekly.models.map((model) => model.id)), new Set(['legacy', 'weekly']));
});

test('quota labels infer cycle configuration and reset-relative current hours', () => {
  const now = new Date('2026-08-10T10:00:00.000Z');
  const cases = [
    {
      metricKey: 'session',
      metricLabel: 'Current session',
      resetAt: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      expectedDays: 1,
      expectedHoursPerDay: 5,
      expectedCurrentHour: 2
    },
    {
      metricKey: 'weekly-all-models',
      metricLabel: 'All models',
      resetAt: new Date(now.getTime() + 101 * 60 * 60 * 1000).toISOString(),
      expectedDays: 7,
      expectedHoursPerDay: 24,
      expectedCurrentHour: 68
    },
    {
      metricKey: 'daily',
      metricLabel: 'Daily usage',
      resetAt: new Date(now.getTime() + 10 * 60 * 60 * 1000).toISOString(),
      expectedDays: 1,
      expectedHoursPerDay: 24,
      expectedCurrentHour: 15
    }
  ];

  cases.forEach((quota) => {
    const result = mergeScrapedPayload([], {
      page: 'https://claude.ai/settings/usage',
      provider: 'Claude',
      modelName: 'Claude usage',
      currentPercent: 10,
      scrapedAt: now.toISOString(),
      ...quota
    }, { now, idFactory: () => quota.metricKey });
    assert.equal(result.model.daysInCycle, quota.expectedDays);
    assert.equal(result.model.hoursPerDay, quota.expectedHoursPerDay);
    assert.equal(result.model.currentHour, quota.expectedCurrentHour);
    assert.equal(result.model.resetAt, quota.resetAt);
  });
});

test('a daily reset hour fills in the next reset boundary automatically', () => {
  const now = new Date(2026, 7, 10, 10, 0, 0, 0);
  const expectedReset = new Date(now.getTime());
  expectedReset.setHours(12, 0, 0, 0);
  const result = mergeScrapedPayload([], {
    page: 'https://example.test/daily-usage',
    provider: 'Example AI',
    modelName: 'Daily allowance',
    metricKey: 'daily',
    metricLabel: 'Daily usage',
    currentPercent: 40,
    resetHour: 12,
    scrapedAt: now.toISOString()
  }, { now, idFactory: () => 'daily' });

  assert.equal(result.model.daysInCycle, 1);
  assert.equal(result.model.hoursPerDay, 24);
  assert.equal(result.model.resetAt, expectedReset.toISOString());
  assert.equal(result.model.currentHour, 23);
});

test('usage history coalesces close scans, remains immutable, and stays capped', () => {
  const source = {
    page: 'https://example.test/usage',
    provider: 'Example AI',
    modelName: 'Example model',
    metricKey: 'daily',
    metricLabel: 'Daily usage'
  };
  const first = mergeScrapedPayload([], {
    ...source,
    currentPercent: 10,
    scrapedAt: '2026-08-10T10:00:00.000Z'
  }, { idFactory: () => 'history' });
  const firstHistory = first.model.usageHistory;
  const nearby = mergeScrapedPayload(first.models, {
    ...source,
    currentPercent: 20,
    scrapedAt: '2026-08-10T10:02:00.000Z'
  });
  const later = mergeScrapedPayload(nearby.models, {
    ...source,
    currentPercent: 30,
    scrapedAt: '2026-08-10T10:06:00.000Z'
  });

  assert.deepEqual(firstHistory, [{ timestamp: '2026-08-10T10:00:00.000Z', usedPercent: 0.1 }]);
  assert.deepEqual(nearby.model.usageHistory, [
    { timestamp: '2026-08-10T10:00:00.000Z', usedPercent: 0.2 }
  ]);
  assert.deepEqual(later.model.usageHistory, [
    { timestamp: '2026-08-10T10:00:00.000Z', usedPercent: 0.2 },
    { timestamp: '2026-08-10T10:06:00.000Z', usedPercent: 0.3 }
  ]);

  let models = later.models;
  for (let index = 0; index < 505; index += 1) {
    models = mergeScrapedPayload(models, {
      ...source,
      currentPercent: index % 101,
      scrapedAt: new Date(Date.parse('2026-08-11T00:00:00.000Z') + index * 6 * 60 * 1000).toISOString()
    }).models;
  }
  assert.equal(models[0].usageHistory.length, 500);
});
