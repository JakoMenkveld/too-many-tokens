'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseQuantity,
  parseResetSchedule,
  parseUsageSnapshots
} = require('../chrome-extension/scraper.js');

// The extension only ever calls parseUsageSnapshots; this reads its first metric.
const firstSnapshot = (snapshot, nowValue) => parseUsageSnapshots(snapshot, nowValue)[0];

test('parses used percentages without changing their meaning', () => {
  const payload = firstSnapshot({
    body: 'Claude weekly usage: 75% used',
    page: 'https://claude.ai/settings/usage',
    title: 'Usage | Claude'
  });

  assert.equal(payload.currentPercent, 75);
  assert.equal(payload.provider, 'Claude');
});

test('converts remaining percentages into consumed percentages', () => {
  const payload = firstSnapshot({
    body: 'Weekly allowance\n75% remaining',
    page: 'https://chatgpt.com/settings/usage',
    title: 'Usage | ChatGPT'
  });

  assert.equal(payload.currentPercent, 25);
  assert.equal(payload.provider, 'OpenAI');
});

test('ignores OpenAI timeframe controls beside percentage text', () => {
  const payloads = parseUsageSnapshots({
    body: [
      'Day',
      '0% used',
      'Weekly usage limit',
      '82% remaining',
      'Resets Aug 16, 2026 6:28 AM'
    ].join('\n'),
    page: 'https://chatgpt.com/codex/cloud/settings/analytics',
    title: 'Usage | ChatGPT'
  }, new Date('2026-08-10T10:00:00.000Z'));

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].metricKey, 'weekly');
  assert.equal(payloads[0].metricLabel, 'Weekly usage limit');
  assert.equal(payloads[0].currentPercent, 18);
});

test('ignores duplicated OpenAI timeframe controls before metric keys are numbered', () => {
  const payloads = parseUsageSnapshots({
    body: [
      'Day',
      '0% used',
      'Day',
      '0% used',
      'Weekly usage limit',
      '82% remaining',
      'Resets Aug 16, 2026 6:28 AM'
    ].join('\n'),
    page: 'https://chatgpt.com/codex/cloud/settings/analytics',
    title: 'Usage | ChatGPT'
  }, new Date('2026-08-10T10:00:00.000Z'));

  assert.deepEqual(payloads.map(({ metricKey, metricLabel }) => ({ metricKey, metricLabel })), [
    { metricKey: 'weekly', metricLabel: 'Weekly usage limit' }
  ]);
});

// Shape taken from a real chatgpt.com Codex analytics page: a banner mentioning
// its own reset sits above the quota cards, and each card puts the percentage
// and the word "remaining" on separate lines.
test('an OpenAI reset banner above the cards does not swallow their labels', () => {
  const payloads = parseUsageSnapshots({
    body: [
      'Codex and Work Analytics',
      'Group by:',
      'Day',
      'Usage',
      "You're nearing your Codex and Work usage limit. Add credits to keep building"
        + ' now, or upgrade for more usage. Your limit resets on Aug 20, 2026 5:40 AM.',
      'Add credits',
      'Balance',
      'Codex and Work share the same usage limit.',
      '',
      'Weekly usage limit',
      '',
      '7%',
      'remaining',
      'Resets Aug 20, 2026 5:40 AM',
      '',
      'GPT-5.3-Codex-Spark',
      '',
      '100%',
      'remaining'
    ].join('\n'),
    page: 'https://chatgpt.com/codex/cloud/settings/analytics',
    title: 'Codex'
  }, new Date('2026-08-15T07:00:00.000Z'));

  assert.deepEqual(payloads.map((payload) => ({
    metricKey: payload.metricKey,
    metricLabel: payload.metricLabel,
    currentPercent: payload.currentPercent
  })), [
    { metricKey: 'weekly', metricLabel: 'Weekly usage limit', currentPercent: 93 },
    { metricKey: 'gpt-5-3-codex-spark', metricLabel: 'GPT-5.3-Codex-Spark', currentPercent: 0 }
  ]);
  assert.equal(payloads[0].resetDay, 'Thursday');
});

test('parses token ratios and compact quantity suffixes', () => {
  const payload = firstSnapshot({
    body: 'Tokens used: 1.2M of 2M tokens',
    page: 'https://example.test/usage',
    title: 'Example Model'
  });

  assert.equal(parseQuantity('2.5k'), 2500);
  assert.equal(payload.currentTokens, 1_200_000);
  assert.equal(payload.budgetTokens, 2_000_000);
});

test('keeps reset weekday and time captures', () => {
  const now = new Date(2026, 7, 9, 12, 0, 0);
  const schedule = parseResetSchedule('Weekly limit resets Monday at 10:30 AM', now);

  assert.equal(schedule.resetDay, 'Monday');
  assert.equal(schedule.resetHour, 10.5);
  assert.ok(new Date(schedule.resetAt) > now);
});

test('parses relative reset schedules into a future boundary', () => {
  const now = new Date('2026-08-10T10:00:00.000Z');
  const schedule = parseResetSchedule('Resets in 2 hours 30 minutes', now);

  assert.equal(new Date(schedule.resetAt).getTime() - now.getTime(), 2.5 * 60 * 60 * 1000);
});

test('parses every Claude quota block with stable metric metadata', () => {
  const now = new Date('2026-08-10T10:00:00.000Z');
  const payloads = parseUsageSnapshots({
    body: [
      'Current session',
      'Resets in 3 hr 15 min',
      '53% used',
      'All models',
      'Resets Thu 3:00 PM',
      '50% used',
      'Fable',
      'Resets Thu 3:00 PM',
      '30% used',
      'Weekly usage limit',
      '82% remaining',
      'Resets Aug 16, 2026 6:28 AM'
    ].join('\n'),
    page: 'https://claude.ai/settings/usage',
    title: 'Usage | Claude'
  }, now);

  assert.equal(payloads.length, 4);
  assert.deepEqual(payloads.map((payload) => ({
    metricKey: payload.metricKey,
    metricLabel: payload.metricLabel,
    cycleHours: payload.cycleHours,
    currentPercent: payload.currentPercent
  })), [
    { metricKey: 'session', metricLabel: 'Current session', cycleHours: 5, currentPercent: 53 },
    { metricKey: 'weekly-all-models', metricLabel: 'All models', cycleHours: 168, currentPercent: 50 },
    { metricKey: 'weekly-fable', metricLabel: 'Fable', cycleHours: 168, currentPercent: 30 },
    { metricKey: 'weekly', metricLabel: 'Weekly usage limit', cycleHours: 168, currentPercent: 18 }
  ]);
  assert.equal(new Date(payloads[0].resetAt).getTime() - now.getTime(), 3.25 * 60 * 60 * 1000);
  assert.equal(payloads[1].resetDay, 'Thursday');
  assert.equal(payloads[1].resetHour, 15);
  assert.equal(payloads[2].resetDay, 'Thursday');
  assert.equal(payloads[3].resetDay, 'Sunday');
  assert.equal(payloads[3].resetHour, 6 + 28 / 60);
});

test('keeps metric keys stable when values and layout change', () => {
  const page = 'https://claude.ai/settings/usage';
  const first = parseUsageSnapshots({
    body: 'Current session Resets in 3 hr 15 min 53% used All models Resets Thu 3:00 PM 50% used',
    page,
    title: 'Claude Usage'
  });
  const second = parseUsageSnapshots({
    body: 'Current session\nResets in 2 hr\n61% used\nAll models\nResets Fri 4:30 PM\n55% used',
    page,
    title: 'Claude Usage'
  });

  assert.deepEqual(first.map(({ metricKey }) => metricKey), ['session', 'weekly-all-models']);
  assert.deepEqual(second.map(({ metricKey }) => metricKey), ['session', 'weekly-all-models']);
  assert.equal(firstSnapshot({
    body: 'Current session\nResets in 2 hr\n61% used\nAll models\n55% used',
    page,
    title: 'Claude Usage'
  }).metricKey, 'session');
});

test('infers a daily metric cycle', () => {
  const [payload] = parseUsageSnapshots({
    body: 'Daily usage limit\n25% used\nResets in 6 hr',
    page: 'https://claude.ai/settings/usage',
    title: 'Claude Usage'
  });

  assert.equal(payload.metricKey, 'daily');
  assert.equal(payload.metricLabel, 'Daily usage limit');
  assert.equal(payload.cycleHours, 24);
});
