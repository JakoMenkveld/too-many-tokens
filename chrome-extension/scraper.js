(function attachUsageScraper(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.UsageScraper = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createUsageScraper() {
  'use strict';

  const providers = (typeof require === 'function')
    ? require('./providers.js')
    : globalThis.UsageProviders;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const QUANTITY_FACTORS = {
    k: 1_000,
    thousand: 1_000,
    m: 1_000_000,
    million: 1_000_000,
    b: 1_000_000_000,
    billion: 1_000_000_000
  };
  const PERCENT_USAGE_PATTERN = /(?:(\d{1,3}(?:\.\d+)?)\s*%\s*(used|usage|spent|consumed|remaining|left)\b|(used|usage|spent|consumed|remaining|left)\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%)/gi;

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').trim();
  }

  function firstCapture(text, patterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1] != null) {
        return match[1].trim();
      }
    }

    return null;
  }

  function parseQuantity(value) {
    if (value == null || value === '') {
      return null;
    }

    const normalized = String(value).replace(/,/g, '').trim();
    const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?$/i);
    if (!match) {
      return null;
    }

    const number = Number(match[1]);
    const factor = match[2] ? QUANTITY_FACTORS[match[2].toLowerCase()] : 1;
    const result = number * factor;
    return Number.isFinite(result) ? Math.round(result) : null;
  }

  function parsePercent(value) {
    const parsed = Number.parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : null;
  }

  function findPercentUsages(text) {
    const matches = [];
    const pattern = new RegExp(PERCENT_USAGE_PATTERN.source, PERCENT_USAGE_PATTERN.flags);
    let match;

    while ((match = pattern.exec(String(text || ''))) != null) {
      const amount = parsePercent(match[1] ?? match[4]);
      const kind = String(match[2] || match[3] || '').toLowerCase();
      if (amount != null) {
        matches.push({
          index: match.index,
          end: pattern.lastIndex,
          currentPercent: kind === 'remaining' || kind === 'left' ? 100 - amount : amount,
          labelPrefix: match[3] && kind === 'usage' ? ' usage' : ''
        });
      }

      if (pattern.lastIndex === match.index) {
        pattern.lastIndex += 1;
      }
    }

    return matches;
  }

  function resetStart(text, useLast = false) {
    const pattern = /\bresets?\b/gi;
    let match;
    let found = -1;
    while ((match = pattern.exec(String(text || ''))) != null) {
      found = match.index;
      if (!useLast) break;
    }
    return found;
  }

  function cleanMetricLabel(value, fallback) {
    const normalized = String(value || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
    const tail = normalizeWhitespace(normalized);
    const known = tail.match(/\b(current session|all models|weekly usage limit|daily usage limit|daily limit)\s*[:|\-–—]*$/i);
    if (known) {
      const key = known[1].toLowerCase();
      if (key === 'current session') return 'Current session';
      if (key === 'all models') return 'All models';
      if (key === 'weekly usage limit') return 'Weekly usage limit';
      if (key === 'daily usage limit') return 'Daily usage limit';
      return 'Daily limit';
    }

    const lines = normalized
      .split('\n')
      .map((line) => normalizeWhitespace(line).replace(/^[|•·:;\-–—]+|[|•·:;\-–—]+$/g, '').trim())
      .filter(Boolean);
    let candidate = lines.at(-1) || '';
    if (/^(?:usage|limits?|settings|overview|plan)$/i.test(candidate)) {
      candidate = '';
    }
    if (candidate && candidate.length <= 100) {
      return candidate;
    }

    return normalizeWhitespace(fallback || 'Provider quota').slice(0, 100);
  }

  function metricSlug(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  function metricIdentity(metricLabel, provider, hasExplicitLabel) {
    const label = normalizeWhitespace(metricLabel);
    const normalized = label.toLowerCase();

    if (/\bcurrent\s+session\b|^session$/.test(normalized)) {
      return { metricKey: 'session', cycleHours: 5 };
    }
    if (/\bdaily\b|\btoday\b/.test(normalized)) {
      return { metricKey: 'daily', cycleHours: 24 };
    }
    if (/\ball\s+models\b/.test(normalized)) {
      return { metricKey: 'weekly-all-models', cycleHours: 168 };
    }
    if (/\bweekly\b/.test(normalized)) {
      const subject = metricSlug(label
        .replace(new RegExp(`\\b${String(provider || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), '')
        .replace(/\b(?:weekly|usage|allowance|limit|quota|models?)\b/gi, ''));
      return {
        metricKey: subject ? `weekly-${subject}` : 'weekly',
        cycleHours: 168
      };
    }

    const slug = metricSlug(label);
    if (provider === 'Claude' && hasExplicitLabel) {
      return { metricKey: `weekly-${slug || 'quota'}`, cycleHours: 168 };
    }
    return { metricKey: slug || 'default', cycleHours: null };
  }

  function isGenericTimeframeControl(metric, provider) {
    if (provider !== 'OpenAI') return false;
    const label = normalizeWhitespace(metric?.metricLabel).toLowerCase();
    const key = normalizeWhitespace(metric?.metricKey).toLowerCase();
    return /^(?:day|week|month|year|hour)$/.test(label)
      && (!key || key === label);
  }

  function parseClock(value) {
    if (!value) {
      return null;
    }

    const match = normalizeWhitespace(value).toUpperCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
    if (!match) {
      return null;
    }

    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = match[3];

    if (minute > 59 || hour > (meridiem ? 12 : 23) || hour < 0 || (meridiem && hour === 0)) {
      return null;
    }

    if (meridiem === 'PM' && hour < 12) {
      hour += 12;
    } else if (meridiem === 'AM' && hour === 12) {
      hour = 0;
    }

    return hour + minute / 60;
  }

  function scheduleFromDate(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      return {};
    }

    return {
      resetDay: DAY_NAMES[date.getDay()],
      resetHour: date.getHours() + date.getMinutes() / 60,
      resetAt: date.toISOString()
    };
  }

  function nextWeekday(now, dayName, resetHour) {
    const targetDay = DAY_NAMES.findIndex((day) => day.toLowerCase() === String(dayName).toLowerCase());
    if (targetDay < 0 || resetHour == null) {
      return null;
    }

    const candidate = new Date(now.getTime());
    candidate.setSeconds(0, 0);
    candidate.setHours(Math.floor(resetHour), Math.round((resetHour % 1) * 60), 0, 0);

    let daysAhead = (targetDay - now.getDay() + 7) % 7;
    candidate.setDate(now.getDate() + daysAhead);
    if (candidate.getTime() <= now.getTime()) {
      daysAhead += 7;
      candidate.setDate(now.getDate() + daysAhead);
    }

    return candidate;
  }

  function parseResetSchedule(text, nowValue = Date.now()) {
    const body = normalizeWhitespace(text);
    const now = new Date(nowValue);
    if (!body || !Number.isFinite(now.getTime())) {
      return {};
    }

    const relative = body.match(/\bresets?\s+in\s+(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m)(?:\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m))?/i);
    if (relative) {
      function toMilliseconds(amount, unit) {
        const value = Number(amount);
        const normalizedUnit = unit.toLowerCase();
        if (normalizedUnit.startsWith('d')) return value * 24 * 60 * 60 * 1000;
        if (normalizedUnit.startsWith('h')) return value * 60 * 60 * 1000;
        return value * 60 * 1000;
      }

      const duration = toMilliseconds(relative[1], relative[2])
        + (relative[3] ? toMilliseconds(relative[3], relative[4]) : 0);
      return scheduleFromDate(new Date(now.getTime() + duration));
    }

    const weekday = body.match(/\bresets?(?:\s+on)?\s+(Sunday|Sun|Monday|Mon|Tuesday|Tues?|Wednesday|Wed|Thursday|Thu(?:rs?)?|Friday|Fri|Saturday|Sat)\.?\b(?:\s*(?:,|at)?\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?))?/i);
    if (weekday) {
      const abbreviatedDay = weekday[1].slice(0, 3).toLowerCase();
      const dayName = DAY_NAMES.find((day) => day.slice(0, 3).toLowerCase() === abbreviatedDay);
      const resetHour = parseClock(weekday[2]);
      const resetDate = nextWeekday(now, dayName, resetHour);
      return {
        resetDay: dayName,
        resetHour,
        ...(resetDate ? { resetAt: resetDate.toISOString() } : {})
      };
    }

    const absoluteDate = body.match(/\bresets?(?:\s+on)?\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?)(?:\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?))?/i);
    if (absoluteDate) {
      const hasYear = /\d{4}/.test(absoluteDate[1]);
      const dateText = hasYear ? absoluteDate[1] : `${absoluteDate[1]}, ${now.getFullYear()}`;
      const resetDate = new Date(`${dateText} ${absoluteDate[2] || '00:00'}`);
      if (!hasYear && Number.isFinite(resetDate.getTime()) && resetDate.getTime() <= now.getTime()) {
        resetDate.setFullYear(resetDate.getFullYear() + 1);
      }
      return scheduleFromDate(resetDate);
    }

    const isoDate = body.match(/\bresets?(?:\s+on)?\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}(?::\d{2})?\s*(?:AM|PM)?))?/i);
    if (isoDate) {
      return scheduleFromDate(new Date(`${isoDate[1]}T${isoDate[2] || '00:00'}`));
    }

    const timeOnly = body.match(/\bresets?(?:\s+at)?\s+(\d{1,2}(?::\d{2})\s*(?:AM|PM)?)/i);
    if (timeOnly) {
      const resetHour = parseClock(timeOnly[1]);
      if (resetHour != null) {
        const resetDate = new Date(now.getTime());
        resetDate.setHours(Math.floor(resetHour), Math.round((resetHour % 1) * 60), 0, 0);
        if (resetDate.getTime() <= now.getTime()) {
          resetDate.setDate(resetDate.getDate() + 1);
        }
        return scheduleFromDate(resetDate);
      }
    }

    return {};
  }

  function detectProvider(page, title, body) {
    let hostname = '';
    try {
      hostname = new URL(page).hostname.toLowerCase();
    } catch (error) {
      hostname = '';
    }

    for (const p of providers.PROVIDERS) {
      if (p.matchesHost(hostname)) return p.name;
    }

    const sample = `${title}\n${body.slice(0, 10_000)}`;
    for (const p of providers.PROVIDERS) {
      if (p.matchesText.test(sample)) return p.name;
    }
    return '';
  }

  function detectModelName(title, body, provider) {
    const explicit = firstCapture(body, [
      /(?:model|plan)\s*[:\-]\s*([^\n|]{2,80})/i,
      /([A-Za-z][A-Za-z0-9 ._\-]{1,60})\s+usage\b/i
    ]);
    if (explicit) {
      return normalizeWhitespace(explicit).slice(0, 80);
    }

    const cleanedTitle = normalizeWhitespace(title)
      .replace(/\s*[|–—-]\s*(?:usage|limits?|settings?)\s*$/i, '')
      .replace(/^\s*(?:usage|limits?)\s*[|–—-]\s*/i, '');
    return (cleanedTitle || provider || 'Provider quota').slice(0, 100);
  }

  function parseLegacyUsageSnapshot(snapshot, nowValue = Date.now()) {
    const body = String(snapshot?.body || '');
    const page = String(snapshot?.page || '');
    const title = String(snapshot?.title || '');
    const provider = detectProvider(page, title, body);

    const usedPercentText = firstCapture(body, [
      /(?:used|spent|consumed|usage)\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
      /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:used|usage|spent|consumed)\b/i
    ]);
    const remainingPercentText = firstCapture(body, [
      /(?:remaining|left)\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
      /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:remaining|left)\b/i
    ]);

    const usedPercent = parsePercent(usedPercentText);
    const remainingPercent = parsePercent(remainingPercentText);
    const currentPercent = usedPercent != null
      ? usedPercent
      : remainingPercent != null
        ? 100 - remainingPercent
        : null;

    let currentTokens = null;
    let budgetTokens = null;
    const tokenRatio = body.match(/([\d,.]+\s*(?:k|m|b|thousand|million|billion)?)\s*(?:\/|of)\s*([\d,.]+\s*(?:k|m|b|thousand|million|billion)?)\s*tokens?\b/i);
    if (tokenRatio) {
      currentTokens = parseQuantity(tokenRatio[1]);
      budgetTokens = parseQuantity(tokenRatio[2]);
    } else {
      currentTokens = parseQuantity(firstCapture(body, [
        /(?:tokens?\s+used|used\s+tokens?)\s*[:\-]?\s*([\d,.]+\s*(?:k|m|b|thousand|million|billion)?)/i,
        /([\d,.]+\s*(?:k|m|b|thousand|million|billion)?)\s*tokens?\s*(?:used|spent|consumed)\b/i
      ]));
      budgetTokens = parseQuantity(firstCapture(body, [
        /(?:token\s+)?(?:budget|cap|limit)\s*[:\-]?\s*([\d,.]+\s*(?:k|m|b|thousand|million|billion)?)\s*tokens?/i,
        /([\d,.]+\s*(?:k|m|b|thousand|million|billion)?)\s*tokens?\s*(?:budget|cap|limit)\b/i
      ]));
    }

    return {
      page,
      provider,
      modelName: detectModelName(title, body, provider),
      currentPercent,
      currentTokens,
      budgetTokens,
      ...parseResetSchedule(body, nowValue),
      scrapedAt: new Date(nowValue).toISOString()
    };
  }

  function parseUsageSnapshots(snapshot, nowValue = Date.now()) {
    const body = String(snapshot?.body || '');
    const legacy = parseLegacyUsageSnapshot(snapshot, nowValue);
    const percentUsages = findPercentUsages(body);

    if (!percentUsages.length) {
      const hasUsage = legacy.currentPercent != null || legacy.currentTokens != null;
      if (!hasUsage) return [];

      const metricLabel = legacy.modelName || legacy.provider || 'Provider quota';
      const identity = metricIdentity(metricLabel, legacy.provider, false);
      return [{
        ...legacy,
        metricKey: identity.metricKey,
        metricLabel,
        cycleHours: identity.cycleHours
      }];
    }

    const seenKeys = new Map();
    const metrics = percentUsages.map((usage, index) => {
      const previousEnd = index > 0 ? percentUsages[index - 1].end : 0;
      const nextStart = index + 1 < percentUsages.length ? percentUsages[index + 1].index : body.length;
      const prefix = `${body.slice(previousEnd, usage.index)}${usage.labelPrefix}`;

      // Walk the lines above the percentage, nearest first: the closest line
      // mentioning a reset is this metric's reset text, and the closest line that
      // does not is its label. Cutting the whole prefix at its last "resets"
      // instead discards the label whenever unrelated copy higher up mentions
      // one — an OpenAI page carries a "Your limit resets on ..." banner above
      // the quota cards, which swallowed every real label beneath it.
      const prefixLines = prefix
        .split('\n')
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);
      let labelText = '';
      let resetText = '';
      for (let cursor = prefixLines.length - 1; cursor >= 0; cursor -= 1) {
        const line = prefixLines[cursor];
        const marker = resetStart(line, true);
        if (marker < 0) {
          labelText = line;
          break;
        }

        if (!resetText) {
          resetText = line.slice(marker);
        }

        // A compact layout puts the label and its reset on one line, so only
        // keep walking when the whole line was reset text.
        const beforeMarker = line.slice(0, marker).trim();
        if (beforeMarker) {
          labelText = beforeMarker;
          break;
        }
      }

      if (!resetText) {
        const suffix = body.slice(usage.end, nextStart);
        const suffixResetStart = resetStart(suffix);
        if (suffixResetStart >= 0) {
          const beforeReset = normalizeWhitespace(suffix.slice(0, suffixResetStart))
            .replace(/^[|•·:;\-–—]+|[|•·:;\-–—]+$/g, '')
            .trim();
          if (!beforeReset) {
            resetText = normalizeWhitespace(suffix.slice(suffixResetStart).split(/\r?\n/)[0]);
          }
        }
      }

      labelText = labelText.replace(/^[|•·:;\-–—]+|[|•·:;\-–—]+$/g, '').trim();
      const hasExplicitLabel = Boolean(normalizeWhitespace(labelText));
      const metricLabel = cleanMetricLabel(labelText, legacy.modelName);
      const identity = metricIdentity(metricLabel, legacy.provider, hasExplicitLabel);
      if (isGenericTimeframeControl({
        metricLabel,
        metricKey: identity.metricKey
      }, legacy.provider)) {
        return null;
      }
      const duplicateCount = seenKeys.get(identity.metricKey) || 0;
      seenKeys.set(identity.metricKey, duplicateCount + 1);
      const metricKey = duplicateCount ? `${identity.metricKey}-${duplicateCount + 1}` : identity.metricKey;
      const resetMetadata = resetText
        ? parseResetSchedule(resetText, nowValue)
        : percentUsages.length === 1
          ? {
              ...(legacy.resetDay ? { resetDay: legacy.resetDay } : {}),
              ...(legacy.resetHour != null ? { resetHour: legacy.resetHour } : {}),
              ...(legacy.resetAt ? { resetAt: legacy.resetAt } : {})
            }
          : {};

      return {
        page: legacy.page,
        sourceUrl: legacy.page,
        provider: legacy.provider,
        modelName: metricLabel,
        metricKey,
        metricLabel,
        cycleHours: identity.cycleHours,
        currentPercent: usage.currentPercent,
        currentTokens: percentUsages.length === 1 ? legacy.currentTokens : null,
        budgetTokens: percentUsages.length === 1 ? legacy.budgetTokens : null,
        ...resetMetadata,
        ...(resetText ? { resetText } : {}),
        scrapedAt: legacy.scrapedAt
      };
    });
    return metrics.filter(Boolean);
  }

  return {
    parseQuantity,
    parseResetSchedule,
    parseUsageSnapshots
  };
});
