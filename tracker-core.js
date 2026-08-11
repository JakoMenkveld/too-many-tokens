(function attachTrackerCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.TrackerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTrackerCore() {
  'use strict';

  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const JS_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const HOUR_MS = 60 * 60 * 1000;
  const HISTORY_COALESCE_MS = 5 * 60 * 1000;
  const HISTORY_LIMIT = 500;

  const DEFAULT_MODEL = Object.freeze({
    id: null,
    provider: 'Claude',
    model: 'Custom LLM',
    description: '',
    sourceUrl: '',
    metricKey: '',
    metricLabel: '',
    dashboardEnabled: true,
    lastUpdatedAt: '',
    usageHistory: Object.freeze([]),
    resetAt: '',
    startDay: 'Monday',
    startHour: 0,
    daysInCycle: 7,
    hoursPerDay: 24,
    paceThreshold: 0.02,
    currentHour: 1,
    usageMode: 'percent',
    actualCumUsedPercent: 0,
    currentTokensUsed: 0,
    budgetTokens: 100000,
    promptTokenPrice: 0,
    completionTokenPrice: 0,
    promptRatio: 0.5
  });

  function finiteNumber(value, fallback = 0) {
    if (value == null || value === '' || typeof value === 'boolean') {
      return fallback;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function optionalNumber(value) {
    if (value == null || value === '' || typeof value === 'boolean') {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizedCycle(model) {
    const daysInCycle = Math.max(1, finiteNumber(model?.daysInCycle, 1));
    const hoursPerDay = Math.max(1, finiteNumber(model?.hoursPerDay, 24));
    return {
      daysInCycle,
      hoursPerDay,
      totalHours: daysInCycle * hoursPerDay
    };
  }

  function computeModel(model) {
    const source = { ...DEFAULT_MODEL, ...model };
    const { daysInCycle, hoursPerDay, totalHours } = normalizedCycle(source);
    const startHour = clamp(finiteNumber(source.startHour, 0), 0, 23.999999);
    const currentHour = clamp(Math.round(finiteNumber(source.currentHour, 0)), 0, totalHours);
    const actualCumUsedPercent = clamp(finiteNumber(source.actualCumUsedPercent, 0), 0, 1);
    const currentTokensUsed = Math.max(0, finiteNumber(source.currentTokensUsed, 0));
    const budgetTokens = Math.max(0, finiteNumber(source.budgetTokens, 0));
    const promptTokenPrice = Math.max(0, finiteNumber(source.promptTokenPrice, 0));
    const completionTokenPrice = Math.max(0, finiteNumber(source.completionTokenPrice, 0));
    const promptRatio = clamp(finiteNumber(source.promptRatio, 0), 0, 1);
    const flatRate = totalHours ? 1 / totalHours : 0;
    const flatCum = clamp(flatRate * currentHour, 0, 1);
    const remainingHours = Math.max(0, totalHours - currentHour);
    const actualCum = source.usageMode === 'tokens' && budgetTokens > 0
      ? clamp(currentTokensUsed / budgetTokens, 0, 1)
      : actualCumUsedPercent;
    const remainingPercent = Math.max(0, 1 - actualCum);
    const adjustedRate = remainingHours ? remainingPercent / remainingHours : 0;
    const adjustedCum = actualCum + adjustedRate * remainingHours;
    const delta = actualCum - flatCum;
    const threshold = clamp(finiteNumber(source.paceThreshold, 0), 0, 1);
    const paceStatus = currentHour === 0
      ? 'No data yet'
      : Math.abs(delta) <= threshold
        ? 'On track'
        : delta > 0
          ? 'Ahead of pace — slow down'
          : 'Behind pace — can speed up';
    const costPerToken = promptTokenPrice * promptRatio
      + completionTokenPrice * (1 - promptRatio);
    const runRateTokensPerHour = currentHour ? currentTokensUsed / currentHour : 0;
    const projectedTokens = runRateTokensPerHour * totalHours;
    const projectedCostPerHour = runRateTokensPerHour * costPerToken;
    const projectedCycleCost = projectedTokens * costPerToken;
    const averageUsagePerHour = currentHour > 0 ? actualCum / currentHour : 0;
    const projectedHoursToDepletion = actualCum >= 1
      ? 0
      : averageUsagePerHour > 0
        ? remainingPercent / averageUsagePerHour
        : null;
    const projectedDepletionWithinCycle = projectedHoursToDepletion !== null
      && projectedHoursToDepletion <= remainingHours;

    return {
      ...source,
      totalHours,
      flatRate,
      flatCum,
      remainingHours,
      actualCum,
      remainingPercent,
      adjustedRate,
      adjustedCum,
      paceStatus,
      costPerToken,
      runRateTokensPerHour,
      projectedTokens,
      projectedCostPerHour,
      projectedCycleCost,
      averageUsagePerHour,
      projectedHoursToDepletion,
      projectedDepletionWithinCycle,
      currentHour,
      startHour,
      daysInCycle,
      hoursPerDay
    };
  }

  function asDate(value) {
    if (value instanceof Date) {
      return new Date(value.getTime());
    }
    return new Date(value == null ? Date.now() : value);
  }

  function currentHourFromReset(resetAt, totalHours, now) {
    const reset = asDate(resetAt);
    if (!Number.isFinite(reset.getTime())) {
      return null;
    }

    const cycleMs = totalHours * HOUR_MS;
    let millisecondsUntilReset = reset.getTime() - now.getTime();
    if (millisecondsUntilReset <= 0) {
      millisecondsUntilReset += (Math.floor(-millisecondsUntilReset / cycleMs) + 1) * cycleMs;
    } else if (millisecondsUntilReset > cycleMs) {
      millisecondsUntilReset -= Math.floor((millisecondsUntilReset - 1) / cycleMs) * cycleMs;
    }

    const elapsedHours = totalHours - millisecondsUntilReset / HOUR_MS;
    return clamp(Math.floor(elapsedHours + 1e-9) + 1, 1, Math.ceil(totalHours));
  }

  function calculateCurrentCycleHour(model, nowValue = new Date()) {
    const now = asDate(nowValue);
    const { totalHours } = normalizedCycle(model);
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(totalHours) || totalHours <= 0) {
      return 1;
    }

    if (model?.resetAt) {
      const fromReset = currentHourFromReset(model.resetAt, totalHours, now);
      if (fromReset != null) {
        return fromReset;
      }
    }

    const dayIndex = JS_DAY_NAMES.findIndex(
      (day) => day.toLowerCase() === String(model?.startDay || '').toLowerCase()
    );
    if (dayIndex < 0) {
      return clamp(Math.round(finiteNumber(model?.currentHour, 1)), 1, Math.ceil(totalHours));
    }

    const startHour = clamp(finiteNumber(model?.startHour, 0), 0, 23.999999);
    const boundary = new Date(now.getTime());
    boundary.setSeconds(0, 0);
    boundary.setHours(Math.floor(startHour), Math.round((startHour % 1) * 60), 0, 0);
    boundary.setDate(now.getDate() - ((now.getDay() - dayIndex + 7) % 7));
    if (boundary.getTime() > now.getTime()) {
      boundary.setDate(boundary.getDate() - 7);
    }

    const cycleMs = totalHours * HOUR_MS;
    const elapsedMs = ((now.getTime() - boundary.getTime()) % cycleMs + cycleMs) % cycleMs;
    return clamp(Math.floor(elapsedMs / HOUR_MS) + 1, 1, Math.ceil(totalHours));
  }

  function normalizeSourceUrl(value) {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }

    try {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return '';
      }
      url.hash = '';
      url.search = '';
      url.username = '';
      url.password = '';
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      return url.toString();
    } catch (error) {
      return '';
    }
  }

  function canonicalText(value) {
    return String(value || '').trim().toLocaleLowerCase();
  }

  function textValue(value) {
    return value == null ? '' : String(value).trim();
  }

  function slugifyMetric(value) {
    return canonicalText(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function metricDetails(payload) {
    const metricLabel = textValue(payload?.metricLabel);
    const metricKey = textValue(payload?.metricKey) || slugifyMetric(metricLabel);
    return {
      metricKey,
      metricLabel,
      identity: canonicalText(metricKey)
    };
  }

  function modelMetricIdentity(model) {
    return canonicalText(model?.metricKey);
  }

  function existingSourceUrl(model) {
    const direct = normalizeSourceUrl(model?.sourceUrl);
    if (direct) {
      return direct;
    }

    const legacyMatch = String(model?.description || '').match(/^Scraped from\s+(.+)$/i);
    return legacyMatch ? normalizeSourceUrl(legacyMatch[1]) : '';
  }

  function normalizedDay(value) {
    const text = canonicalText(value);
    return DAY_NAMES.find((day) => day.toLowerCase() === text) || null;
  }

  function validDate(value) {
    if (value == null || value === '') {
      return null;
    }
    const date = asDate(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function inferredCycleHours(payload) {
    const explicit = optionalNumber(payload?.cycleHours);
    if (explicit != null && explicit > 0) {
      return explicit;
    }

    const provider = canonicalText(payload?.provider);
    const descriptor = canonicalText([
      payload?.metricKey,
      payload?.metricLabel,
      payload?.cycleLabel,
      payload?.modelName
    ].filter(Boolean).join(' ')).replace(/[_:]+/g, ' ');

    if ((provider.includes('claude') || provider.includes('anthropic'))
      && /(?:^|\W)(?:session|5[ -]?hours?|five[ -]?hours?)(?:$|\W)/.test(descriptor)) {
      return 5;
    }
    if (/(?:^|\W)daily(?:$|\W)/.test(descriptor)) {
      return 24;
    }
    if (/(?:^|\W)weekly(?:$|\W)/.test(descriptor) || /\ball[ -]?models?\b/.test(descriptor)) {
      return 168;
    }
    return null;
  }

  function applyCycleHours(model, cycleHours) {
    if (!Number.isFinite(cycleHours) || cycleHours <= 0) {
      return;
    }

    if (cycleHours >= 24 && Math.abs(cycleHours / 24 - Math.round(cycleHours / 24)) < 1e-9) {
      model.daysInCycle = Math.max(1, Math.round(cycleHours / 24));
      model.hoursPerDay = 24;
      return;
    }

    model.daysInCycle = 1;
    model.hoursPerDay = cycleHours;
  }

  function nextResetFromSchedule(resetDay, resetHour, cycleHours, now) {
    if (!Number.isFinite(resetHour) || resetHour < 0 || resetHour >= 24) {
      return null;
    }

    const candidate = new Date(now.getTime());
    candidate.setSeconds(0, 0);
    candidate.setHours(Math.floor(resetHour), Math.round((resetHour % 1) * 60), 0, 0);

    if (resetDay) {
      const dayIndex = JS_DAY_NAMES.findIndex((day) => day === resetDay);
      candidate.setDate(now.getDate() + ((dayIndex - now.getDay() + 7) % 7));
      if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 7);
      }
      return candidate;
    }

    if (Math.abs(cycleHours - 24) < 1e-9) {
      if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate;
    }
    return null;
  }

  function normalizeHistory(history) {
    if (!Array.isArray(history)) {
      return [];
    }

    return history
      .map((sample) => {
        const timestamp = validDate(sample?.timestamp);
        let usedPercent = optionalNumber(sample?.usedPercent);
        if (!timestamp || usedPercent == null) {
          return null;
        }
        if (usedPercent > 1 && usedPercent <= 100) {
          usedPercent /= 100;
        }
        return {
          timestamp: timestamp.toISOString(),
          usedPercent: clamp(usedPercent, 0, 1)
        };
      })
      .filter(Boolean)
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  }

  function appendUsageHistory(history, timestamp, usedPercent) {
    const samples = normalizeHistory(history);
    const nextSample = {
      timestamp: timestamp.toISOString(),
      usedPercent: clamp(finiteNumber(usedPercent, 0), 0, 1)
    };
    samples.push(nextSample);
    samples.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

    const coalesced = [];
    samples.forEach((sample) => {
      const previous = coalesced[coalesced.length - 1];
      if (previous
        && Date.parse(sample.timestamp) - Date.parse(previous.timestamp) < HISTORY_COALESCE_MS) {
        previous.usedPercent = sample.usedPercent;
      } else {
        coalesced.push({ ...sample });
      }
    });

    return coalesced.slice(-HISTORY_LIMIT);
  }

  function mergeScrapedPayload(models, payload, options = {}) {
    const sourceModels = Array.isArray(models) ? models : [];
    const currentPercent = optionalNumber(payload?.currentPercent);
    const currentTokens = optionalNumber(payload?.currentTokens);
    const usablePercent = currentPercent != null;
    const usableTokens = currentTokens != null && currentTokens >= 0;
    if (!usablePercent && !usableTokens) {
      return {
        models: sourceModels,
        updated: false,
        created: false,
        index: -1,
        model: null,
        matchedBy: null
      };
    }

    const now = asDate(options.now);
    const effectiveNow = Number.isFinite(now.getTime()) ? now : new Date();
    const scrapedAt = validDate(payload?.scrapedAt);
    const observationTime = scrapedAt || effectiveNow;
    const idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const provider = String(payload?.provider || '').trim();
    const modelName = String(payload?.modelName || '').trim();
    const sourceUrl = normalizeSourceUrl(payload?.sourceUrl || payload?.page);
    const metric = metricDetails(payload);
    const nextModels = sourceModels.map((entry) => ({ ...entry }));
    let index = -1;
    let matchedBy = null;

    if (sourceUrl) {
      const sourceMatches = nextModels
        .map((entry, entryIndex) => ({ entry, entryIndex }))
        .filter(({ entry }) => existingSourceUrl(entry) === sourceUrl);
      const exactMetricMatches = sourceMatches
        .filter(({ entry }) => modelMetricIdentity(entry) === metric.identity);

      if ((metric.identity && exactMetricMatches.length)
        || (!metric.identity && exactMetricMatches.length === 1)) {
        index = exactMetricMatches[0].entryIndex;
        matchedBy = metric.identity ? 'sourceUrlMetric' : 'sourceUrl';
      } else if (metric.identity) {
        const legacyMatches = sourceMatches.filter(({ entry }) => !modelMetricIdentity(entry));
        if (legacyMatches.length === 1
          && (!provider || !legacyMatches[0].entry.provider
            || canonicalText(legacyMatches[0].entry.provider) === canonicalText(provider))) {
          index = legacyMatches[0].entryIndex;
          matchedBy = 'legacySourceUrl';
        }
      }
    }

    if (index < 0 && provider && modelName) {
      const matches = nextModels
        .map((entry, entryIndex) => ({ entry, entryIndex }))
        .filter(({ entry }) => (
          canonicalText(entry.provider) === canonicalText(provider)
          && canonicalText(entry.model) === canonicalText(modelName)
          && modelMetricIdentity(entry) === metric.identity
          && (!sourceUrl || !existingSourceUrl(entry))
        ));
      if (matches.length === 1) {
        index = matches[0].entryIndex;
        matchedBy = 'providerModel';
      }
    }

    const created = index < 0;
    let target = created
      ? { ...DEFAULT_MODEL, id: idFactory() }
      : { ...nextModels[index] };

    if (provider) target.provider = provider;
    if (modelName) target.model = modelName;
    if (sourceUrl) target.sourceUrl = sourceUrl;
    if (metric.metricKey) target.metricKey = metric.metricKey;
    if (metric.metricLabel) target.metricLabel = metric.metricLabel;
    if (!textValue(target.metricLabel) && metric.metricKey) {
      target.metricLabel = metric.metricKey
        .replace(/[-_:]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    if (usablePercent) {
      target.usageMode = 'percent';
      target.actualCumUsedPercent = clamp(currentPercent / 100, 0, 1);
    }
    if (usableTokens) {
      target.currentTokensUsed = currentTokens;
      if (!usablePercent) target.usageMode = 'tokens';
    }

    const budgetTokens = optionalNumber(payload?.budgetTokens);
    if (budgetTokens != null && budgetTokens > 0) {
      target.budgetTokens = budgetTokens;
    }

    const cycleHours = inferredCycleHours(payload);
    if (cycleHours != null) {
      applyCycleHours(target, cycleHours);
    }

    const resetDay = normalizedDay(payload?.resetDay);
    if (resetDay) target.startDay = resetDay;
    const resetHour = optionalNumber(payload?.resetHour);
    if (resetHour != null && resetHour >= 0 && resetHour < 24) {
      target.startHour = resetHour;
    }
    let resetAt = validDate(payload?.resetAt);
    if (!resetAt) {
      resetAt = nextResetFromSchedule(
        resetDay,
        resetHour,
        normalizedCycle(target).totalHours,
        observationTime
      );
    }
    if (resetAt) {
      target.resetAt = resetAt.toISOString();
      if (!resetDay) {
        target.startDay = JS_DAY_NAMES[resetAt.getDay()];
      }
      if (resetHour == null) {
        target.startHour = resetAt.getHours() + resetAt.getMinutes() / 60;
      }
    }

    if (!String(target.description || '').trim()) {
      target.description = sourceUrl ? `Scraped from ${sourceUrl}` : 'Updated by the browser extension';
    }
    target.lastUpdatedAt = observationTime.toISOString();
    target.currentHour = calculateCurrentCycleHour(target, observationTime);
    target.usageHistory = appendUsageHistory(
      target.usageHistory,
      observationTime,
      computeModel(target).actualCum
    );

    if (created) {
      nextModels.unshift(target);
      index = 0;
      matchedBy = 'created';
    } else {
      nextModels[index] = target;
    }

    return {
      models: nextModels,
      updated: true,
      created,
      index,
      model: target,
      matchedBy
    };
  }

  return {
    DAY_NAMES,
    DEFAULT_MODEL,
    calculateCurrentCycleHour,
    computeModel,
    mergeScrapedPayload,
    normalizeSourceUrl
  };
});
