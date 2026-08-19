'use strict';

const STORAGE_KEY = 'llmRunRateTracker.models';
const PREFERENCES_STORAGE_KEY = 'llmRunRateTracker.preferences';
const PREFERENCES_SCHEMA_VERSION = 6;
const LEGACY_PREFERENCES_SCHEMA_VERSIONS = Object.freeze([1, 2, 3, 4, 5]);
const EXTENSION_BRIDGE_CHANNEL = 'llm-run-rate-tracker';

// Page-side half of the extension trace. The extension's own log.js is not part
// of the server's asset allow-list, so this is a local helper rather than a
// shared file. console.debug is hidden unless DevTools includes Verbose.
function bridgeLog(message, detail) {
	if (detail === undefined) console.debug('%c[TMT page]', 'color:#8b7fff;font-weight:600', message);
	else console.debug('%c[TMT page]', 'color:#8b7fff;font-weight:600', message, detail);
}
// Refreshes are a bounded run the user starts, not a background loop. A run is
// at most REFRESH_COUNT_MAX reloads spaced at least REFRESH_INTERVAL_MIN_SECONDS
// apart, and it stops on its own. Nothing here re-arms itself.
//
// These bounds are the page's half of the limit. The extension enforces its own
// 5-minute floor per page in chrome-extension/background.js and does not trust
// these numbers, because the page is the part an edited script could change.
// Going faster than this is meant to require editing both.
const REFRESH_INTERVAL_DEFAULT_SECONDS = 15 * 60;
const REFRESH_INTERVAL_MIN_SECONDS = 5 * 60;
const REFRESH_INTERVAL_MAX_SECONDS = 60 * 60;
const REFRESH_INTERVAL_CHOICES = Object.freeze([300, 600, 900, 1800, 3600]);
const REFRESH_COUNT_DEFAULT = 5;
const REFRESH_COUNT_MIN = 1;
const REFRESH_COUNT_MAX = 10;
const SCAN_REQUEST_TIMEOUT_MS = 45_000;
const CHART_COLORS = ['violet', 'cyan', 'mint', 'amber', 'rose', 'blue'];
const PAGE_CONFIG = Object.freeze({
	overview: { title: 'Overview' },
	setup: { title: 'Setup' }
});
const APP_TITLE = 'Too Many Tokens';
const DEFAULT_HEADLINE_SCOPE = 'overall';
const HEADLINE_SCOPE_PATTERN = /^(?:overall|provider:.+|tracker:.+)$/;
const CHROME_TICK_MS = 1000;
const ICON_PATHS = Object.freeze({
	refresh: '<path d="M20 7v5h-5"></path><path d="M4 17v-5h5"></path><path d="M6.1 8.5A7 7 0 0 1 18.8 7L20 12"></path><path d="M18 15.5A7 7 0 0 1 5.2 17L4 12"></path>',
	duplicate: '<rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>',
	settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"></path>',
	chevron: '<path d="m7 10 5 5 5-5"></path>',
	check: '<path d="m7 12 3 3 7-7"></path>',
	plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>'
});
const trackerCore = globalThis.TrackerCore
	|| (typeof require === 'function' ? require('./tracker-core.js') : null);
const providers = globalThis.UsageProviders
	|| (typeof require === 'function' ? require('./chrome-extension/providers.js') : null);
const {
	DAY_NAMES,
	DEFAULT_MODEL,
	computeModel,
	mergeScrapedPayload,
	normalizeSourceUrl
} = trackerCore;

let autoScanTimer = null;
let chromeTicker = null;
let nextAutoSyncAt = null;
let lastSyncedAt = null;
let rateLimitedUntil = null;
let autoScanStatus = typeof document !== 'undefined' ? 'Finding provider tabs…' : 'Ready';
let availableTabs = [];
let selectedTabIds = [];
let scanInProgress = false;
let tabDiscoveryInProgress = typeof document !== 'undefined';
let pendingSettingsId = null;
const expandedSettings = new Set();
let preferences = defaultPreferences();
let renderedPage = '';

function defaultRefreshPlan() {
	return {
		intervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
		totalRefreshes: REFRESH_COUNT_DEFAULT,
		remaining: 0,
		nextAt: null
	};
}

function defaultPreferences() {
	return {
		schemaVersion: PREFERENCES_SCHEMA_VERSION,
		overviewPaceView: 'bars',
		showHeadlineIndicator: true,
		headlineScope: DEFAULT_HEADLINE_SCOPE,
		refreshPlan: defaultRefreshPlan(),
		providerTabs: {
			initialized: false,
			selectedTabs: []
		}
	};
}

function normalizeHeadlineScope(value) {
	const scope = String(value ?? '').trim();
	return HEADLINE_SCOPE_PATTERN.test(scope) ? scope : DEFAULT_HEADLINE_SCOPE;
}

function normalizeRefreshIntervalSeconds(value) {
	const seconds = Number(value);
	if (!Number.isFinite(seconds)) return REFRESH_INTERVAL_DEFAULT_SECONDS;
	return clamp(Math.round(seconds), REFRESH_INTERVAL_MIN_SECONDS, REFRESH_INTERVAL_MAX_SECONDS);
}

function normalizeRefreshCount(value) {
	const count = Number(value);
	if (!Number.isFinite(count)) return REFRESH_COUNT_DEFAULT;
	return clamp(Math.round(count), REFRESH_COUNT_MIN, REFRESH_COUNT_MAX);
}

function formatRefreshInterval(value) {
	const seconds = normalizeRefreshIntervalSeconds(value);
	if (seconds < 60) return `${seconds}s`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function refreshIntervalMilliseconds(value) {
	return normalizeRefreshIntervalSeconds(value) * 1000;
}

// A run is only live when it still has refreshes left AND a scheduled time. Any
// stored shape that loses either half reads as stopped, so a corrupted or
// hand-edited preference can never resurrect an unbounded loop.
function sanitizeRefreshPlan(value, legacyIntervalSeconds) {
	const intervalSeconds = normalizeRefreshIntervalSeconds(
		value?.intervalSeconds ?? legacyIntervalSeconds
	);
	const totalRefreshes = normalizeRefreshCount(value?.totalRefreshes);
	const nextAt = Number(value?.nextAt);
	const remaining = clamp(Math.round(Number(value?.remaining) || 0), 0, totalRefreshes);
	const scheduled = remaining > 0 && Number.isFinite(nextAt) && nextAt > 0;
	return {
		intervalSeconds,
		totalRefreshes,
		remaining: scheduled ? remaining : 0,
		nextAt: scheduled ? nextAt : null
	};
}

function isRefreshPlanRunning(plan = preferences.refreshPlan) {
	return Number(plan?.remaining) > 0 && plan?.nextAt != null;
}

function stableTabUrl(value) {
	return normalizeSourceUrl(value);
}

function tabSelectionProviderKey(value) {
	try {
		const url = new URL(String(value || '').trim());
		const hostname = url.hostname.toLowerCase();
		const pathname = url.pathname.replace(/\/+$/, '') || '/';
		const hashPath = url.hash.replace(/^#\/?/, '/').replace(/\/+$/, '');
		const normalizedPathname = pathname.toLowerCase();
		const normalizedHashPath = hashPath.toLowerCase();

		const hit = providers.PROVIDERS.find((p) => p.matchesRoute(hostname, normalizedPathname, normalizedHashPath));
		return hit ? hit.key : '';
	} catch (error) {
		return '';
	}
}

function providerKeyMatchesUrl(providerKey, value) {
	try {
		const hostname = new URL(String(value || '').trim()).hostname.toLowerCase();
		const provider = providers.PROVIDERS.find((p) => p.key === providerKey);
		return provider ? provider.matchesHost(hostname) : false;
	} catch (error) {
		return false;
	}
}

function tabSelectionDescriptor(value) {
	const rawUrl = typeof value === 'string' ? value : value?.url;
	const url = stableTabUrl(rawUrl);
	if (!url) return null;
	const detectedProviderKey = tabSelectionProviderKey(rawUrl);
	const claimedProviderKey = typeof value === 'object' ? String(value?.providerKey || '') : '';
	const providerKey = detectedProviderKey
		|| (providerKeyMatchesUrl(claimedProviderKey, rawUrl) ? claimedProviderKey : '');
	return { url, providerKey };
}

function sanitizePreferences(value) {
	if (!value || ![...LEGACY_PREFERENCES_SCHEMA_VERSIONS, PREFERENCES_SCHEMA_VERSION].includes(value.schemaVersion)) {
		return defaultPreferences();
	}
	const rawSelections = value.schemaVersion === 1
		? (Array.isArray(value.providerTabs?.selectedUrls) ? value.providerTabs.selectedUrls : [])
		: (Array.isArray(value.providerTabs?.selectedTabs) ? value.providerTabs.selectedTabs : []);
	const selectedTabs = [];
	const seenSelections = new Set();
	rawSelections.forEach((selection) => {
		const descriptor = tabSelectionDescriptor(selection);
		if (!descriptor) return;
		const identity = `${descriptor.url}\u0000${descriptor.providerKey}`;
		if (seenSelections.has(identity)) return;
		seenSelections.add(identity);
		selectedTabs.push(descriptor);
	});
	// autoSyncEnabled from schema <= 5 is deliberately dropped rather than
	// translated into a running plan. That switch meant "poll forever"; silently
	// turning it into a live run would start reloading provider pages on upgrade
	// without anyone asking. Its interval is kept as the default for the next run.
	return {
		schemaVersion: PREFERENCES_SCHEMA_VERSION,
		overviewPaceView: ['graph', 'runway'].includes(value.overviewPaceView) ? value.overviewPaceView : 'bars',
		showHeadlineIndicator: value.showHeadlineIndicator !== false,
		headlineScope: normalizeHeadlineScope(value.headlineScope),
		refreshPlan: sanitizeRefreshPlan(value.refreshPlan, value.autoSyncIntervalSeconds),
		providerTabs: {
			initialized: value.providerTabs?.initialized === true,
			selectedTabs
		}
	};
}

function loadPreferences(storage = globalThis.localStorage) {
	try {
		return sanitizePreferences(JSON.parse(storage?.getItem(PREFERENCES_STORAGE_KEY) || 'null'));
	} catch (error) {
		return defaultPreferences();
	}
}

function savePreferences(value, storage = globalThis.localStorage) {
	const sanitized = sanitizePreferences(value);
	storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(sanitized));
	return sanitized;
}

function replacePreferences(value) {
	preferences = savePreferences(value);
	return preferences;
}

function reconcileTabSelections(tabs, value = preferences) {
	const sanitized = sanitizePreferences(value);
	const validTabs = (Array.isArray(tabs) ? tabs : [])
		.filter((tab) => Number.isInteger(tab?.id) && stableTabUrl(tab?.url));
	const descriptors = sanitized.providerTabs.selectedTabs.map((descriptor) => ({ ...descriptor }));
	const unusedTabIndexes = new Set(validTabs.map((tab, index) => index));
	const unmatchedDescriptorIndexes = new Set(descriptors.map((descriptor, index) => index));
	const matches = [];

	function assign(descriptorIndex, tabIndex) {
		const tab = validTabs[tabIndex];
		const current = tabSelectionDescriptor(tab);
		if (current) descriptors[descriptorIndex] = current;
		unusedTabIndexes.delete(tabIndex);
		unmatchedDescriptorIndexes.delete(descriptorIndex);
		matches.push({ descriptorIndex, tabId: tab.id });
	}

	for (const descriptorIndex of [...unmatchedDescriptorIndexes]) {
		const descriptor = descriptors[descriptorIndex];
		const candidateTabs = [...unusedTabIndexes].filter((index) => {
			if (stableTabUrl(validTabs[index].url) !== descriptor.url) return false;
			return !descriptor.providerKey
				|| tabSelectionProviderKey(validTabs[index].url) === descriptor.providerKey;
		});
		if (candidateTabs.length === 1) assign(descriptorIndex, candidateTabs[0]);
	}

	for (const descriptorIndex of [...unmatchedDescriptorIndexes]) {
		const descriptor = descriptors[descriptorIndex];
		if (!descriptor.providerKey) continue;
		const sameKeyDescriptors = [...unmatchedDescriptorIndexes]
			.filter((index) => descriptors[index].providerKey === descriptor.providerKey);
		const candidateTabs = [...unusedTabIndexes]
			.filter((index) => tabSelectionProviderKey(validTabs[index].url) === descriptor.providerKey);
		if (sameKeyDescriptors.length === 1 && candidateTabs.length === 1) {
			assign(descriptorIndex, candidateTabs[0]);
		}
	}

	matches.sort((left, right) => left.descriptorIndex - right.descriptorIndex);
	return {
		selectedTabIds: matches.map((match) => match.tabId),
		matches,
		preferences: {
			...sanitized,
			providerTabs: {
				...sanitized.providerTabs,
				selectedTabs: descriptors
			}
		}
	};
}

function selectedTabIdsForPreferences(tabs, value = preferences) {
	return reconcileTabSelections(tabs, value).selectedTabIds;
}

function toggleTabSelectionPreference(tabs, value, tabId) {
	const tab = (Array.isArray(tabs) ? tabs : []).find((entry) => entry?.id === tabId);
	const descriptor = tabSelectionDescriptor(tab);
	if (!descriptor) return { changed: false, ...reconcileTabSelections(tabs, value) };
	const reconciliation = reconcileTabSelections(tabs, value);
	const existingMatch = reconciliation.matches.find((match) => match.tabId === tabId);
	const selectedTabs = reconciliation.preferences.providerTabs.selectedTabs
		.filter((selection, index) => index !== existingMatch?.descriptorIndex);
	if (!existingMatch) selectedTabs.push(descriptor);
	const nextPreferences = sanitizePreferences({
		...reconciliation.preferences,
		providerTabs: {
			initialized: true,
			selectedTabs
		}
	});
	return { changed: true, ...reconcileTabSelections(tabs, nextPreferences) };
}

function hasRememberedTabSelections(value = preferences) {
	return sanitizePreferences(value).providerTabs.selectedTabs.length > 0;
}

function isOpenAiUsageSurface(value) {
	const providerKey = tabSelectionProviderKey(value);
	return providerKey === 'provider:openai:codex-usage'
		|| providerKey === 'provider:openai:chatgpt-usage';
}

// A quota block names what it limits. When the only text a provider puts beside
// a percentage is another reading — "$0.00 spent", "1.2M tokens" — there is no
// named quota there, just a figure that would become a tracker title and then go
// stale. Claude's usage-credits promo does exactly this.
function isValueOnlyMetricLabel(label) {
	const text = String(label || '').trim();
	if (!text) return false;
	const remainder = text
		.replace(/\p{Sc}/gu, ' ')
		.replace(/[\d,.]+\s*(?:k|m|b|thousand|million|billion)?/gi, ' ')
		.replace(
			/\b(?:percent|tokens?|credits?|requests?|messages?|words?|spent|used|remaining|left|of|out)\b/gi,
			' '
		)
		.replace(/[^\p{L}]+/gu, ' ')
		.trim();
	return remainder === '';
}

function isValueOnlyLabelPayloadArtifact(payload) {
	return isValueOnlyMetricLabel(payload?.metricLabel);
}

// Mirrors isAutoScrapedOpenAiDayArtifact: only removes entries this app scraped
// itself, never a tracker the user typed in by hand.
function isAutoScrapedValueOnlyLabelArtifact(model) {
	if (!isValueOnlyMetricLabel(model?.metricLabel)) return false;
	const sourceUrl = stableTabUrl(model?.sourceUrl);
	if (!sourceUrl) return false;
	try {
		const evidence = String(model?.description || '').trim().match(/^Scraped from\s+(.+)$/i);
		const lastUpdatedAt = new Date(model?.lastUpdatedAt);
		return Boolean(evidence)
			&& Number.isFinite(lastUpdatedAt.getTime())
			&& stableTabUrl(evidence[1]) === sourceUrl;
	} catch (error) {
		return false;
	}
}

function isOpenAiDayPayloadArtifact(payload) {
	return String(payload?.provider || '').trim().toLowerCase() === 'openai'
		&& String(payload?.modelName || '').trim().toLowerCase() === 'day'
		&& /^day(?:-\d+)?$/u.test(String(payload?.metricKey || '').trim().toLowerCase())
		&& String(payload?.metricLabel || '').trim().toLowerCase() === 'day'
		&& isOpenAiUsageSurface(payload?.sourceUrl || payload?.page);
}

function isAutoScrapedOpenAiDayArtifact(model) {
	if (String(model?.provider || '').trim().toLowerCase() !== 'openai'
		|| String(model?.model || '').trim().toLowerCase() !== 'day'
		|| !/^day(?:-\d+)?$/u.test(String(model?.metricKey || '').trim().toLowerCase())
		|| String(model?.metricLabel || '').trim().toLowerCase() !== 'day'
		|| Number(model?.daysInCycle) !== 7
		|| Number(model?.hoursPerDay) !== 24) {
		return false;
	}
	const sourceUrl = stableTabUrl(model?.sourceUrl);
	if (!isOpenAiUsageSurface(sourceUrl)) return false;
	try {
		const evidence = String(model?.description || '').trim().match(/^Scraped from\s+(.+)$/i);
		const lastUpdatedAt = new Date(model?.lastUpdatedAt);
		return Boolean(evidence)
			&& Number.isFinite(lastUpdatedAt.getTime())
			&& stableTabUrl(evidence[1]) === sourceUrl;
	} catch (error) {
		return false;
	}
}

function migrateStoredModels(models) {
	const source = Array.isArray(models) ? models : [];
	const migrated = source.filter((model) => !isAutoScrapedOpenAiDayArtifact(model)
		&& !isAutoScrapedValueOnlyLabelArtifact(model));
	return { models: migrated, changed: migrated.length !== source.length };
}

function loadModels() {
	try {
		const models = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
		if (!Array.isArray(models)) return [];
		const migrated = migrateStoredModels(models);
		if (migrated.changed) saveModels(migrated.models);
		return migrated.models;
	} catch (error) {
		return [];
	}
}

function saveModels(models) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
}

function id() {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value, minimum, maximum) {
	return Math.min(maximum, Math.max(minimum, value));
}

function formatPercent(value, digits = 0) {
	return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function asValidDate(value) {
	const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

function effectiveResetDate(model, now = new Date()) {
	const reset = asValidDate(model?.resetAt);
	if (!reset) return null;
	const totalHours = Number(model?.totalHours) || Number(model?.daysInCycle) * Number(model?.hoursPerDay);
	const cycleMs = totalHours * 60 * 60 * 1000;
	if (reset <= now && Number.isFinite(cycleMs) && cycleMs > 0) {
		reset.setTime(reset.getTime() + (Math.floor((now.getTime() - reset.getTime()) / cycleMs) + 1) * cycleMs);
	}
	return reset;
}

function formatCountdown(resetAt, now = new Date()) {
	const reset = asValidDate(resetAt);
	if (!reset) return 'Reset time pending';
	const difference = Math.max(0, reset.getTime() - now.getTime());
	const totalMinutes = Math.ceil(difference / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days) return `${days}d ${hours}h`;
	if (hours) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function formatResetDateTime(resetAt) {
	const reset = asValidDate(resetAt);
	if (!reset) return 'Reset time pending';
	const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const time = `${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`;
	return `${weekdays[reset.getDay()]}, ${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()} at ${time}`;
}

function formatDurationHours(value) {
	const hoursValue = Number(value);
	if (!Number.isFinite(hoursValue)) return '—';
	if (hoursValue <= 0) return 'Now';
	const totalMinutes = Math.max(1, Math.ceil(hoursValue * 60));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
	if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

function formatSyncCountdown(milliseconds) {
	const value = Number(milliseconds);
	if (!Number.isFinite(value)) return '—';
	const seconds = Math.max(0, Math.ceil(value / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatSyncedAgo(timestamp, now = Date.now()) {
	// asValidDate(null) is the epoch, not an error — an unsynced dashboard must
	// not claim it last synced in 1970.
	const at = timestamp == null || timestamp === '' ? null : asValidDate(timestamp)?.getTime();
	if (!Number.isFinite(at) || at <= 0) return 'Never synced';
	const seconds = Math.max(0, Math.round((Number(now) - at) / 1000));
	if (seconds < 10) return 'Synced just now';
	if (seconds < 60) return `Synced ${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `Synced ${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `Synced ${hours}h ago`;
	return `Synced ${Math.floor(hours / 24)}d ago`;
}

function syncCountdownState(
	enabled = isRefreshPlanRunning(),
	nextAt = nextAutoSyncAt,
	syncing = scanInProgress,
	now = Date.now()
) {
	if (syncing) return { state: 'syncing', label: 'syncing now' };
	const target = nextAt == null ? NaN : Number(nextAt);
	if (!enabled || !Number.isFinite(target)) return { state: 'idle', label: '' };
	return { state: 'counting', label: `next in ${formatSyncCountdown(target - Number(now))}` };
}

// "Last synced" is derived from the newest tracker timestamp rather than a
// separately persisted clock, so it survives a reload and can never claim a
// sync the stored numbers do not actually reflect.
function latestModelUpdate(models) {
	const newest = (Array.isArray(models) ? models : []).reduce((latest, model) => {
		const at = asValidDate(model?.lastUpdatedAt)?.getTime();
		return Number.isFinite(at) && at > latest ? at : latest;
	}, 0);
	return newest > 0 ? newest : null;
}

function metricLabel(model) {
	return String(model?.metricLabel || model?.quotaLabel || model?.model || 'Usage limit').trim();
}

function cycleLabel(model) {
	const hours = Number(model?.totalHours) || Number(model?.daysInCycle) * Number(model?.hoursPerDay);
	if (hours <= 6) return `${Math.round(hours)}-hour session`;
	if (hours === 24) return 'Daily limit';
	if (hours === 168) return 'Weekly limit';
	if (hours > 0 && hours % 24 === 0) return `${Math.round(hours / 24)}-day limit`;
	return hours > 0 ? `${Math.round(hours)}-hour limit` : 'Cycle pending';
}

function providerInitials(provider) {
	const words = String(provider || 'LLM').trim().split(/\s+/).filter(Boolean);
	return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'LL';
}

function icon(name, className = '') {
	const paths = ICON_PATHS[name];
	if (!paths) return '';
	return `<svg class="ui-icon${className ? ` ${className}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function paceDeltaContext(actualValue, idealValue) {
	const actual = clamp(Number(actualValue) || 0, 0, 1);
	const ideal = clamp(Number(idealValue) || 0, 0, 1);
	const points = Math.round((actual - ideal) * 100);
	if (Math.abs(points) < 1) return { label: 'On ideal pace', shortLabel: '0%', tone: 'steady' };
	return points > 0
		? { label: `+${points} points above ideal`, shortLabel: `+${points}%`, tone: 'warning' }
		: { label: `${Math.abs(points)} points below ideal`, shortLabel: `−${Math.abs(points)}%`, tone: 'healthy' };
}

function cycleWeightHours(model) {
	const hours = Number(model?.totalHours)
		|| Number(model?.daysInCycle) * Number(model?.hoursPerDay);
	return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

// Weighted by cycle length: a 168-hour weekly cap at 60% is far more of the
// month's budget than a 5-hour session window at 60%, so a plain mean would let
// a burnt session drag the headline around while a burnt week barely moved it.
function overallPaceSummary(models) {
	const entries = (Array.isArray(models) ? models : [])
		.map((model) => ({
			weight: cycleWeightHours(model),
			actual: clamp(Number(model?.actualCum) || 0, 0, 1),
			ideal: clamp(Number(model?.flatCum) || 0, 0, 1)
		}))
		.filter((entry) => entry.weight > 0);
	const weightHours = entries.reduce((total, entry) => total + entry.weight, 0);
	if (!entries.length || weightHours <= 0) {
		return { available: false, count: 0, weightHours: 0, actual: 0, ideal: 0, delta: 0 };
	}
	const actual = entries.reduce((total, entry) => total + entry.weight * entry.actual, 0) / weightHours;
	const ideal = entries.reduce((total, entry) => total + entry.weight * entry.ideal, 0) / weightHours;
	return { available: true, count: entries.length, weightHours, actual, ideal, delta: actual - ideal };
}

function providerScopeKey(model) {
	return `provider:${String(model?.provider || 'Provider').trim().toLocaleLowerCase() || 'provider'}`;
}

function trackerScopeKey(model) {
	return `tracker:${String(model?.id ?? '')}`;
}

function headlineScopeOptions(models) {
	const shown = (Array.isArray(models) ? models : []).filter((model) => cycleWeightHours(model) > 0);
	const providers = [];
	const seenProviders = new Set();
	groupModelsByProvider(shown).forEach((group) => {
		const value = providerScopeKey(group.models[0]);
		if (seenProviders.has(value)) return;
		seenProviders.add(value);
		providers.push({ value, label: group.provider, count: group.models.length });
	});
	return {
		overall: { value: DEFAULT_HEADLINE_SCOPE, label: 'Overall', count: shown.length },
		providers,
		trackers: sortTrackersAlphabetically(shown)
			.map((model) => ({ value: trackerScopeKey(model), label: trackerDisplayLabel(model), count: 1 }))
	};
}

// An unresolvable scope — a deleted tracker, a provider whose last tracker was
// hidden — falls back to Overall rather than blanking the headline, and reports
// that it did so, so the settings selector can show what is actually in use.
function resolveHeadlineScope(models, scope = preferences.headlineScope) {
	const shown = (Array.isArray(models) ? models : []).filter((model) => cycleWeightHours(model) > 0);
	const requested = normalizeHeadlineScope(scope);
	const overall = {
		scope: DEFAULT_HEADLINE_SCOPE,
		requested,
		resolved: requested === DEFAULT_HEADLINE_SCOPE,
		label: 'Overall',
		models: shown
	};
	if (requested === DEFAULT_HEADLINE_SCOPE) return overall;

	if (requested.startsWith('provider:')) {
		const matches = shown.filter((model) => providerScopeKey(model) === requested);
		if (!matches.length) return overall;
		return {
			scope: requested,
			requested,
			resolved: true,
			label: String(matches[0].provider || 'Provider').trim() || 'Provider',
			models: matches
		};
	}

	const tracker = shown.find((model) => trackerScopeKey(model) === requested);
	if (!tracker) return overall;
	return {
		scope: requested,
		requested,
		resolved: true,
		label: trackerDisplayLabel(tracker),
		models: [tracker]
	};
}

// The Overview panel is always the overall average -- it sits above every
// tracker on the page, so narrowing it to one of them would misrepresent what
// the reader is looking at. Only the browser tab title, which has room for a
// single number and is read while the page is not visible, follows the scope.
function headlinePaceContext(models, value = preferences, { scoped = true } = {}) {
	const settings = sanitizePreferences(value);
	const scope = resolveHeadlineScope(models, scoped ? settings.headlineScope : DEFAULT_HEADLINE_SCOPE);
	const summary = overallPaceSummary(scope.models);
	return {
		enabled: settings.showHeadlineIndicator,
		available: settings.showHeadlineIndicator && summary.available,
		scope,
		summary,
		delta: paceDeltaContext(summary.actual, summary.ideal)
	};
}

function documentTitle(models, value = preferences) {
	const headline = headlinePaceContext(models, value);
	return headline.available ? `${headline.delta.shortLabel} — ${APP_TITLE}` : APP_TITLE;
}

function visualStatus(model) {
	const actual = clamp(Number(model?.actualCum) || 0, 0, 1);
	const ideal = clamp(Number(model?.flatCum) || 0, 0, 1);
	const threshold = Math.max(0.01, Number(model?.paceThreshold) || 0.02);
	const difference = actual - ideal;
	if (actual >= 0.9) return { tone: 'danger', label: 'Nearly spent' };
	if (difference > threshold) return { tone: 'warning', label: 'Burning fast' };
	if (difference < -threshold) return { tone: 'healthy', label: 'Room to spend' };
	return { tone: 'steady', label: 'On track' };
}

function normalizedHistory(model) {
	const history = Array.isArray(model?.usageHistory)
		? model.usageHistory
		: Array.isArray(model?.history) ? model.history : [];
	return history.map((sample) => {
		const date = asValidDate(sample?.timestamp || sample?.at);
		let used = Number(sample?.usedPercent ?? sample?.actualCum);
		if (used > 1) used /= 100;
		return { at: date?.getTime(), used: clamp(used, 0, 1) };
	}).filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.used))
		.sort((left, right) => left.at - right.at);
}

function trendSeriesIdentity(model) {
	return [
		model?.provider,
		model?.sourceUrl,
		model?.metricKey || metricLabel(model),
		model?.id
	].map((value) => String(value || '').trim().toLocaleLowerCase()).join('|');
}

function trendSeriesStyleSeed(model) {
	const identity = trendSeriesIdentity(model);
	let hash = 2166136261;
	for (let index = 0; index < identity.length; index += 1) {
		hash ^= identity.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % CHART_COLORS.length;
}

function assignTrendSeriesStyles(entries) {
	const assignments = new Map();
	const used = new Set();
	[...entries]
		.sort((left, right) => trendSeriesIdentity(left.model).localeCompare(trendSeriesIdentity(right.model)))
		.forEach((entry) => {
			let colorIndex = trendSeriesStyleSeed(entry.model);
			while (used.has(colorIndex) && used.size < CHART_COLORS.length) {
				colorIndex = (colorIndex + 1) % CHART_COLORS.length;
			}
			used.add(colorIndex);
			assignments.set(entry.model, colorIndex);
		});
	return entries.map((entry) => ({ ...entry, colorIndex: assignments.get(entry.model) ?? 0 }));
}

function trendChangeContext(points) {
	if (!Array.isArray(points) || points.length < 2) {
		return { label: '—', tone: 'neutral', resetDrop: false };
	}
	const change = (points.at(-1).used - points[0].used) * 100;
	const rounded = Math.round(change * 10) / 10;
	const magnitude = Math.abs(rounded).toLocaleString(undefined, { maximumFractionDigits: 1 });
	const label = rounded > 0 ? `+${magnitude}%` : rounded < 0 ? `−${magnitude}%` : '0%';
	const resetDrop = points.some((point, index) => index > 0 && points[index - 1].used - point.used >= 0.05);
	return {
		label,
		tone: resetDrop ? 'reset' : rounded > 0 ? 'increase' : rounded < 0 ? 'decrease' : 'steady',
		resetDrop
	};
}

function trendTimeFormatOptions(spanMs) {
	if (spanMs <= 24 * 60 * 60 * 1000) return { hour: 'numeric', minute: '2-digit' };
	if (spanMs <= 7 * 24 * 60 * 60 * 1000) return { weekday: 'short', hour: 'numeric' };
	if (spanMs <= 370 * 24 * 60 * 60 * 1000) return { month: 'short', day: 'numeric' };
	return { month: 'short', year: 'numeric' };
}

function formatTrendTime(timestamp, spanMs) {
	return new Intl.DateTimeFormat(undefined, trendTimeFormatOptions(spanMs)).format(new Date(timestamp));
}

function formatTrendRange(minimumTime, maximumTime) {
	const spanMs = Math.max(0, maximumTime - minimumTime);
	const options = spanMs <= 24 * 60 * 60 * 1000
		? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
		: spanMs <= 370 * 24 * 60 * 60 * 1000
			? { month: 'short', day: 'numeric' }
			: { month: 'short', year: 'numeric' };
	const formatter = new Intl.DateTimeFormat(undefined, options);
	if (minimumTime === maximumTime) return formatter.format(new Date(maximumTime));
	return `${formatter.format(new Date(minimumTime))} – ${formatter.format(new Date(maximumTime))}`;
}

function pageFromHash(value) {
	const page = String(value || '').replace(/^#\/?/, '').split(/[/?]/)[0].toLowerCase();
	if (['limits'].includes(page)) return 'overview';
	if (['sources', 'settings'].includes(page)) return 'setup';
	return Object.hasOwn(PAGE_CONFIG, page) ? page : 'overview';
}

function currentPage() {
	return pageFromHash(typeof window !== 'undefined' ? window.location.hash : '');
}

function isTrackerEnabled(model) {
	return model?.dashboardEnabled !== false;
}

function groupTrackers(models) {
	const groups = new Map();
	(Array.isArray(models) ? models : []).forEach((model) => {
		const sourceUrl = String(model?.sourceUrl || '').trim();
		const provider = String(model?.provider || 'Provider').trim() || 'Provider';
		const key = sourceUrl || `manual:${provider.toLowerCase()}`;
		if (!groups.has(key)) {
			let sourceLabel = 'Manual trackers';
			if (sourceUrl) {
				try {
					const url = new URL(sourceUrl);
					sourceLabel = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
				} catch (error) {
					sourceLabel = sourceUrl;
				}
			}
			groups.set(key, { key, provider, sourceUrl, sourceLabel, models: [] });
		}
		groups.get(key).models.push(model);
	});
	return [...groups.values()];
}

function groupModelsByProvider(models) {
	const groups = new Map();
	(Array.isArray(models) ? models : []).forEach((model) => {
		const provider = String(model?.provider || 'Provider').trim() || 'Provider';
		const key = provider.toLocaleLowerCase();
		if (!groups.has(key)) groups.set(key, { key, provider, models: [] });
		groups.get(key).models.push(model);
	});
	return [...groups.values()];
}

function titleCaseLabel(value) {
	return String(value || '').replace(/\b([a-z])([a-z]*)/giu, (word, first, rest) => `${first.toLocaleUpperCase()}${rest.toLocaleLowerCase()}`);
}

function trackerDisplayLabel(model) {
	const provider = String(model?.provider || 'Provider').trim() || 'Provider';
	return `${provider} - ${titleCaseLabel(metricLabel(model))}`;
}

function sortTrackersAlphabetically(models) {
	return [...(Array.isArray(models) ? models : [])].sort((left, right) => (
		trackerDisplayLabel(left).localeCompare(trackerDisplayLabel(right), undefined, { sensitivity: 'base' })
		|| String(left?.id || '').localeCompare(String(right?.id || ''), undefined, { sensitivity: 'base' })
	));
}

function render() {
	const container = document.getElementById('app');
	if (!container) return;
	const models = loadModels().map(computeModel);
	const enabledModels = models.filter(isTrackerEnabled);
	const page = currentPage();
	const existingView = container.querySelector('.page-view');
	const canPatch = renderedPage === page && existingView && container.querySelector('.dashboard-header');
	if (canPatch) {
		updateDashboardChrome(container);
		const pageHtml = renderPage(page, models, enabledModels);
		if (existingView.innerHTML !== pageHtml) {
			existingView.innerHTML = pageHtml;
			bindDashboardEvents(existingView);
		}
	} else {
		container.innerHTML = renderDashboard(models, enabledModels, page);
		bindDashboardEvents(container);
	}
	renderedPage = page;
	updateNavigation(page);
	updateDocumentTitle(enabledModels);
	if (page === 'setup' && pendingSettingsId) revealPendingSettings(container);
	settleRunwayCards(container);
}

function updateDocumentTitle(models) {
	if (typeof document === 'undefined') return;
	document.title = documentTitle(models);
}

function updateDashboardChrome(container = document.getElementById('app')) {
	if (!container) return;
	const status = container.querySelector('[data-header-status]');
	if (status) status.innerHTML = renderHeaderStatus();
	const syncButton = container.querySelector('.header-sync-button');
	if (syncButton) {
		const limit = rateLimitState();
		const syncLabel = scanInProgress
			? 'Refreshing and scanning provider tabs'
			: limit.limited ? limit.label : 'Sync provider tabs';
		syncButton.classList.toggle('is-syncing', scanInProgress);
		syncButton.disabled = scanInProgress || limit.limited;
		syncButton.setAttribute('aria-label', syncLabel);
		syncButton.title = syncLabel;
	}
}

function autoSyncBadgeState(
	plan = preferences.refreshPlan,
	timerActive = Boolean(autoScanTimer),
	selectedCount = selectedTabIds.length
) {
	if (!isRefreshPlanRunning(plan)) return { state: 'off', label: 'Refreshes off' };
	const progress = `${plan.remaining} of ${normalizeRefreshCount(plan.totalRefreshes)} left`;
	if (!timerActive || !selectedCount) return { state: 'waiting', label: `Refreshes paused · ${progress}` };
	return { state: 'on', label: `Refreshing · ${progress}` };
}

function renderHeaderStatus(now = Date.now()) {
	const autoSync = autoSyncBadgeState();
	const countdown = syncCountdownState(isRefreshPlanRunning(), nextAutoSyncAt, scanInProgress, now);
	const syncedAgo = formatSyncedAgo(lastSyncedAt, now);
	const limit = rateLimitState(rateLimitedUntil, now);
	return `
		<span class="live-pill ${autoSync.state === 'on' ? 'is-live' : ''}" data-auto-sync-state="${autoSync.state}" title="${escapeHtml(countdown.label ? `${autoSync.label} · ${countdown.label}` : autoSync.label)}"><i></i><span class="pill-label">${escapeHtml(autoSync.label)}</span>${countdown.label ? `<em class="pill-countdown" data-sync-countdown="${countdown.state}">${escapeHtml(countdown.label)}</em>` : ''}</span>
		<span class="live-pill sync-age-pill" data-sync-age title="Time since the trackers last received fresh numbers">${escapeHtml(syncedAgo)}</span>
		${limit.limited ? `<span class="live-pill rate-limit-pill" data-rate-limit title="The extension refuses to reload the same provider page too soon. No request was sent.">${escapeHtml(limit.label)}</span>` : ''}
	`;
}

function renderDashboard(models, enabledModels, page) {
	const pageConfig = PAGE_CONFIG[page] || PAGE_CONFIG.overview;
	const syncLabel = scanInProgress ? 'Refreshing and scanning provider tabs' : 'Sync provider tabs';
	return `
		<header class="dashboard-header">
			<div class="mobile-brand"><span class="brand-mark">TMT</span><strong>Too Many Tokens</strong></div>
			<h1>${escapeHtml(pageConfig.title)}</h1>
			<div class="header-actions control-row">
				<div class="header-status" data-header-status>${renderHeaderStatus()}</div>
				<button class="header-sync-button ${scanInProgress ? 'is-syncing' : ''}" data-action="connect-scan" aria-label="${syncLabel}" title="${syncLabel}" ${scanInProgress ? 'disabled' : ''}>${icon('refresh')}</button>
			</div>
		</header>

		${renderMobileNavigation(page)}
		<div class="page-view page-${escapeHtml(page)}">${renderPage(page, models, enabledModels)}</div>
	`;
}

function renderMobileNavigation(page) {
	return `<nav class="mobile-tabs" aria-label="Dashboard pages">${Object.entries(PAGE_CONFIG).map(([key, config]) => `<a href="#/${key}" data-page="${key}" class="${key === page ? 'active' : ''}">${escapeHtml(config.title)}</a>`).join('')}</nav>`;
}

function renderPage(page, models, enabledModels) {
	if (page === 'setup') return renderSetupPage(models);
	const paceView = preferences.overviewPaceView === 'graph'
		? renderPaceGraphs(enabledModels)
		: preferences.overviewPaceView === 'runway'
			? renderRunwayView(enabledModels)
			: renderComparisonChart(enabledModels);
	return `${renderHeadlinePanel(enabledModels)}${renderRefreshPlanPanel()}<section class="overview-pace" aria-label="Quota pace">${paceView}</section>`;
}

function renderRefreshPlanPanel(plan = preferences.refreshPlan, now = Date.now()) {
	const running = isRefreshPlanRunning(plan);
	const total = normalizeRefreshCount(plan.totalRefreshes);
	const interval = normalizeRefreshIntervalSeconds(plan.intervalSeconds);
	const done = total - plan.remaining;
	const countdown = running ? formatSyncCountdown(plan.nextAt - now) : '';
	const status = running
		? `Refresh ${Math.min(total, done + 1)} of ${total} · next in ${countdown}`
		: `Stopped · ${total} refresh${total === 1 ? '' : 'es'} every ${formatRefreshInterval(interval)} when started`;
	const intervalOptions = REFRESH_INTERVAL_CHOICES
		.map((seconds) => `<option value="${seconds}" ${seconds === interval ? 'selected' : ''}>${escapeHtml(formatRefreshInterval(seconds))}</option>`)
		.join('');
	const countOptions = Array.from({ length: REFRESH_COUNT_MAX }, (unused, index) => index + 1)
		.map((count) => `<option value="${count}" ${count === total ? 'selected' : ''}>${count}</option>`)
		.join('');
	return `
		<section class="panel refresh-plan-panel ${running ? 'is-running' : ''}" aria-label="Scheduled refreshes">
			<div class="refresh-plan-headline">
				<div>
					<h2>Scheduled refreshes</h2>
					<p class="refresh-plan-status" data-refresh-status>${escapeHtml(status)}</p>
				</div>
				<div class="control-row refresh-plan-actions">
					${running
						? `<button data-action="refresh-plan-reset" class="secondary compact">Restart</button><button data-action="refresh-plan-stop" class="danger-button compact">Stop</button>`
						: `<button data-action="refresh-plan-start" ${selectedTabIds.length ? '' : 'disabled'}>Start refreshes</button>`}
				</div>
			</div>
			<div class="refresh-plan-controls control-row">
				<label class="refresh-field"><span>Every</span><select data-refresh-interval>${intervalOptions}</select></label>
				<label class="refresh-field"><span>How many</span><select data-refresh-count>${countOptions}</select></label>
				${running ? '<span class="refresh-plan-hint">Changing either restarts the run.</span>' : ''}
			</div>
			<p class="refresh-plan-note">Each refresh reloads your provider tabs and reads them. A run stops on its own after the count above — nothing repeats in the background. Press Sync in the header for a single reading now. ${selectedTabIds.length ? '' : 'Select provider tabs on Setup before starting.'}</p>
		</section>
	`;
}

function headlineScopeCaption(headline) {
	const { scope, summary } = headline;
	const trackers = `${summary.count} tracker${summary.count === 1 ? '' : 's'}`;
	const weight = `${Math.round(summary.weightHours).toLocaleString()}h of quota`;
	if (scope.scope === DEFAULT_HEADLINE_SCOPE) {
		return `Every shown tracker, weighted by cycle length · ${trackers} · ${weight}`;
	}
	if (summary.count === 1) return `Single tracker · ${weight}`;
	return `Weighted by cycle length · ${trackers} · ${weight}`;
}

function renderHeadlinePanel(models) {
	const headline = headlinePaceContext(models, preferences, { scoped: false });
	if (!headline.available) return '';
	const { delta, summary, scope } = headline;
	const idealMarker = clamp(summary.ideal * 100, 1, 99);
	const description = `${scope.label}: ${formatPercent(summary.actual)} used, ${formatPercent(summary.ideal)} ideal by now, ${delta.label}`;
	return `
		<section class="panel headline-panel" aria-label="Headline quota pace">
			<div class="headline-primary">
				<div class="headline-identity">
					<span class="headline-eyebrow">${escapeHtml(scope.label)}</span>
					<strong class="headline-delta ${delta.tone}">${escapeHtml(delta.shortLabel)}</strong>
				</div>
				<p class="headline-note">${escapeHtml(delta.label)}<span>${escapeHtml(headlineScopeCaption(headline))}</span></p>
			</div>
			<svg class="headline-track" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(description)}">
				<title>${escapeHtml(description)}</title>
				<rect class="pace-track" x="0" y="3" width="100" height="4" rx="2" />
				<rect class="pace-value headline-value ${delta.tone}" x="0" y="3" width="${summary.actual * 100}" height="4" rx="2" />
				<line class="ideal-marker" x1="${idealMarker}" y1="0.5" x2="${idealMarker}" y2="9.5" />
			</svg>
			<dl class="headline-metrics">
				<div><dt>Used</dt><dd>${formatPercent(summary.actual)}</dd></div>
				<div><dt>Ideal now</dt><dd>${formatPercent(summary.ideal)}</dd></div>
				<div><dt>Trackers</dt><dd>${summary.count}</dd></div>
			</dl>
		</section>
	`;
}

function renderPaceViewToggle(activeView = preferences.overviewPaceView) {
	return `
		<div class="pace-view-toggle" role="group" aria-label="Pace display">
			<button type="button" class="${activeView === 'bars' ? 'active' : ''}" data-action="pace-view" data-pace-view="bars" aria-pressed="${activeView === 'bars'}">Bars</button>
			<button type="button" class="${activeView === 'graph' ? 'active' : ''}" data-action="pace-view" data-pace-view="graph" aria-pressed="${activeView === 'graph'}">Graphs</button>
			<button type="button" class="${activeView === 'runway' ? 'active' : ''}" data-action="pace-view" data-pace-view="runway" aria-pressed="${activeView === 'runway'}">Runway</button>
		</div>
	`;
}

function renderEmptyPacePanel(activeView) {
	return `
		<article class="panel chart-panel empty-chart">
			<div class="panel-heading"><h2>Actual vs Ideal Pace</h2>${renderPaceViewToggle(activeView)}</div>
			<div class="empty-visual chart" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
		</article>
	`;
}

function renderComparisonChart(models) {
	const ordered = sortTrackersAlphabetically(models).slice(0, 6);
	if (!ordered.length) {
		return renderEmptyPacePanel('bars');
	}
	const rows = ordered.map((model) => {
		const actual = clamp(Number(model.actualCum) || 0, 0, 1);
		const ideal = clamp(Number(model.flatCum) || 0, 0, 1);
		const delta = paceDeltaContext(actual, ideal);
		const depletion = projectedDepletionContext(model);
		const reset = effectiveResetDate(model);
		const resetContext = reset ? `resets ${formatResetDateTime(reset)} · in ${formatCountdown(reset)}` : 'reset pending';
		const idealMarker = clamp(ideal * 100, 1, 99);
		const colorIndex = Math.max(0, ordered.indexOf(model)) % CHART_COLORS.length;
		return `
				<div class="pace-row">
					<div class="pace-identity">
						<strong title="${escapeHtml(trackerDisplayLabel(model))}">${escapeHtml(trackerDisplayLabel(model))}</strong>
						<span>${escapeHtml(cycleLabel(model))} · ${escapeHtml(resetContext)}</span>
					</div>
					<svg class="pace-row-track" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${formatPercent(actual)} used, ${formatPercent(ideal)} ideal by now">
						<title>${escapeHtml(trackerDisplayLabel(model))}: ${formatPercent(actual)} used; ${formatPercent(ideal)} ideal by now; ${escapeHtml(delta.label)}</title>
						<rect class="pace-track" x="0" y="3" width="100" height="4" rx="2" />
						<rect class="pace-value series-${colorIndex}" x="0" y="3" width="${actual * 100}" height="4" rx="2" />
						<line class="ideal-marker" x1="${idealMarker}" y1="0.5" x2="${idealMarker}" y2="9.5" />
					</svg>
					<div class="pace-row-metrics">
						<div><small>Used</small><strong>${formatPercent(actual)}</strong></div>
						<div><small>Ideal now</small><strong>${formatPercent(ideal)}</strong></div>
						<div class="pace-delta ${delta.tone}" title="${escapeHtml(delta.label)}"><small>Δ pace</small><strong>${escapeHtml(delta.shortLabel)}</strong></div>
						<div class="pace-depletion ${depletion.tone}" title="${escapeHtml(depletion.label)}"><small>Projected depletion</small><strong>${escapeHtml(depletion.value)}<em>${escapeHtml(depletion.note)}</em></strong></div>
					</div>
				</div>
			`;
	}).join('');
	return `
		<article class="panel chart-panel">
			<div class="panel-heading">
				<h2>Actual vs Ideal Pace</h2>
				<div class="pace-heading-actions">${renderPaceViewToggle('bars')}<div class="chart-legend"><span><i class="legend-actual"></i>Used quota</span><span><i class="legend-ideal"></i>Even-pace marker</span></div></div>
			</div>
			<div class="comparison-list">${rows}</div>
		</article>
	`;
}

function paceCurveData(model, nowValue = Date.now()) {
	const totalHours = Math.max(1, Number(model?.totalHours) || (Number(model?.daysInCycle) || 7) * (Number(model?.hoursPerDay) || 24));
	const cycleMs = totalHours * 60 * 60 * 1000;
	const idealNow = clamp(Number(model?.flatCum) || 0, 0, 1);
	const actualNow = clamp(Number(model?.actualCum) || 0, 0, 1);
	const updatedAt = new Date(model?.lastUpdatedAt || '').getTime();
	const history = normalizedHistory(model).slice(-30);
	const anchorAt = Number.isFinite(updatedAt) ? updatedAt : (history.at(-1)?.at || Number(nowValue) || Date.now());
	const points = history.map((point) => ({
		x: idealNow - ((anchorAt - point.at) / cycleMs),
		y: point.used
	})).filter((point) => point.x >= 0 && point.x <= 1);
	const last = points.at(-1);
	if (!last || Math.abs(last.x - idealNow) > 0.002 || Math.abs(last.y - actualNow) > 0.002) {
		points.push({ x: idealNow, y: actualNow });
	}
	return { actualNow, idealNow, points };
}

function renderPaceGraphs(models) {
	const ordered = sortTrackersAlphabetically(models).slice(0, 6);
	if (!ordered.length) return renderEmptyPacePanel('graph');
	const cards = ordered.map((model) => {
		const data = paceCurveData(model);
		const delta = paceDeltaContext(data.actualNow, data.idealNow);
		const depletion = projectedDepletionContext(model);
		const reset = effectiveResetDate(model);
		const resetContext = reset ? `Resets ${formatResetDateTime(reset)}` : 'Reset time pending';
		const left = 34;
		const right = 306;
		const top = 14;
		const bottom = 146;
		const xFor = (value) => left + clamp(value, 0, 1) * (right - left);
		const yFor = (value) => bottom - clamp(value, 0, 1) * (bottom - top);
		const coordinates = data.points.map((point) => [xFor(point.x), yFor(point.y)]);
		const actualPath = coordinates.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
		const currentX = xFor(data.idealNow);
		const currentY = yFor(data.actualNow);
		const colorIndex = Math.max(0, ordered.indexOf(model)) % CHART_COLORS.length;
		return `
				<article class="pace-curve-card">
					<header class="pace-curve-header">
						<div><strong>${escapeHtml(trackerDisplayLabel(model))}</strong><span>${escapeHtml(cycleLabel(model))} · ${escapeHtml(resetContext)}</span></div>
						<dl><div><dt>Used</dt><dd>${formatPercent(data.actualNow)}</dd></div><div><dt>Ideal Now</dt><dd>${formatPercent(data.idealNow)}</dd></div><div><dt>Δ Pace</dt><dd class="${delta.tone}">${escapeHtml(delta.shortLabel)}</dd></div><div class="pace-depletion ${depletion.tone}" title="${escapeHtml(depletion.label)}"><dt>Projected depletion</dt><dd>${escapeHtml(depletion.value)}<em>${escapeHtml(depletion.note)}</em></dd></div></dl>
					</header>
					<svg class="pace-curve" viewBox="0 0 320 176" role="img" aria-label="${escapeHtml(trackerDisplayLabel(model))}: actual ${formatPercent(data.actualNow)}, ideal ${formatPercent(data.idealNow)} at the current point in the cycle">
						<title>${escapeHtml(trackerDisplayLabel(model))}: ${escapeHtml(delta.label)}</title>
						${[0, 0.5, 1].map((value) => `<line class="pace-curve-grid" x1="${left}" y1="${yFor(value)}" x2="${right}" y2="${yFor(value)}"></line><text class="pace-curve-axis" x="28" y="${yFor(value) + 3}" text-anchor="end">${Math.round(value * 100)}%</text>`).join('')}
						<line class="pace-curve-ideal" x1="${left}" y1="${bottom}" x2="${right}" y2="${top}"></line>
						<line class="pace-curve-now" x1="${currentX}" y1="${top}" x2="${currentX}" y2="${bottom}"></line>
						${coordinates.length > 1 ? `<path class="pace-curve-actual series-${colorIndex}" d="${actualPath}"></path>` : ''}
						<circle class="pace-curve-dot series-${colorIndex}" cx="${currentX}" cy="${currentY}" r="4"></circle>
						<text class="pace-curve-axis" x="${left}" y="166" text-anchor="start">Start</text><text class="pace-curve-axis pace-now-label" x="${currentX}" y="166" text-anchor="middle">Now</text><text class="pace-curve-axis" x="${right}" y="166" text-anchor="end">Reset</text>
					</svg>
				</article>
			`;
	}).join('');
	return `
		<article class="panel chart-panel pace-graphs-panel">
			<div class="panel-heading">
				<h2>Actual vs Ideal Pace</h2>
				<div class="pace-heading-actions">${renderPaceViewToggle('graph')}<div class="chart-legend"><span><i class="legend-actual"></i>Actual</span><span><i class="legend-ideal"></i>Ideal</span></div></div>
			</div>
			<div class="pace-curve-grid-layout">${cards}</div>
		</article>
	`;
}

// The runway is the quota you have left; the distance you must cover before you
// are allowed to stop is the time to the reset. You land safely when the quota
// outlasts the cycle. Every number the scene draws with comes off that one
// ratio, so the picture moves continuously with severity instead of flipping
// between two pre-baked outcomes.
const RUNWAY_PERSPECTIVE = 0.55;
// Where the parked aircraft sits, as a percentage down the strip. 0 is the
// horizon, 100 is directly under the camera, so larger is nearer.
const RUNWAY_STOP_DEPTH = 88;
const RUNWAY_HORIZON_DEPTH = 4;
// How much surplus (margin - 1) fills the whole visible strip, and how much
// shortfall reads as a total loss. Both are display spans, not thresholds.
const RUNWAY_SURPLUS_SPAN = 1.5;
const RUNWAY_DROP_SPAN = 0.5;
const RUNWAY_MIN_GHOST_GAP_MS = 60_000;
// Last settled scene geometry per tracker, so a re-render can transition from
// where the scene already was instead of snapping. Keyed by tracker id.
const runwaySettled = new Map();

function runwayDepth(fraction) {
	// Ground-plane projection: near distance spreads out, far distance
	// compresses toward the horizon. Without this a runway drawn from linear
	// numbers reads as a bar tipped on its side rather than as a surface.
	const value = clamp(Number(fraction) || 0, 0, 1);
	const screen = (value * (1 + RUNWAY_PERSPECTIVE)) / (value + RUNWAY_PERSPECTIVE);
	// The gate never quite reaches the horizon, so even an ample runway shows
	// the threshold it is measured against rather than trailing off to nothing.
	return RUNWAY_HORIZON_DEPTH + (RUNWAY_STOP_DEPTH - RUNWAY_HORIZON_DEPTH) * (1 - screen);
}

// Shared by projectedDepletionContext and the runway scene. The two disagreed
// about nothing yet, but they were deriving the same five numbers side by side,
// which is exactly how the provider registry drifted in the first place.
function runwayTiming(model) {
	const actual = clamp(Number(model?.actualCum) || 0, 0, 1);
	const totalHours = Math.max(0, Number(model?.totalHours) || Number(model?.daysInCycle) * Number(model?.hoursPerDay) || 0);
	const inferredCurrentHour = totalHours * clamp(Number(model?.flatCum) || 0, 0, 1);
	const currentHour = clamp(Number.isFinite(Number(model?.currentHour)) ? Number(model.currentHour) : inferredCurrentHour, 0, totalHours);
	const remainingHours = Math.max(0, Number.isFinite(Number(model?.remainingHours))
		? Number(model.remainingHours)
		: totalHours - currentHour);
	const averageUsagePerHour = Number.isFinite(Number(model?.averageUsagePerHour))
		? Math.max(0, Number(model.averageUsagePerHour))
		: currentHour > 0 ? actual / currentHour : 0;
	const hasProjectedHours = model?.projectedHoursToDepletion !== null
		&& model?.projectedHoursToDepletion !== ''
		&& Number.isFinite(Number(model?.projectedHoursToDepletion));
	const projectedHours = hasProjectedHours
		? Math.max(0, Number(model.projectedHoursToDepletion))
		: actual >= 1 ? 0 : averageUsagePerHour > 0 ? (1 - actual) / averageUsagePerHour : null;
	return { actual, totalHours, currentHour, remainingHours, averageUsagePerHour, projectedHours };
}

function projectedDepletionContext(model) {
	const { projectedHours, remainingHours } = runwayTiming(model);
	if (projectedHours === null) {
		return { value: '—', note: 'not enough data', tone: 'steady', label: 'Projected depletion is unavailable until usage has increased' };
	}
	if (projectedHours <= 0) {
		return { value: 'Now', note: 'quota depleted', tone: 'warning', label: 'Quota is already depleted' };
	}
	const withinCycle = projectedHours <= remainingHours;
	const value = formatDurationHours(projectedHours);
	return {
		value: withinCycle ? value : '—',
		note: withinCycle ? 'before reset' : 'not before reset',
		tone: withinCycle ? 'warning' : 'healthy',
		label: withinCycle
			? `At the current average usage rate, depletion is projected in ${value}, before the reset`
			: 'Quota is not projected to deplete before the reset'
	};
}

// Bands exist only to name and colour a point on a continuous scale. Nothing in
// the scene geometry branches on them -- adding a band changes the wording, not
// the picture.
function runwayBand(margin) {
	if (margin >= 1.5) return { state: 'ample', status: 'Ample runway' };
	if (margin >= 1.15) return { state: 'comfortable', status: 'Comfortable margin' };
	if (margin >= 1) return { state: 'marginal', status: 'Stops on the numbers' };
	if (margin >= 0.85) return { state: 'overrun', status: 'Overrun projected' };
	return { state: 'off-end', status: 'Off the end' };
}

// Second channel: how hard the approach is, independent of whether it ends well.
// A tracker well above ideal pace should look fast even when it still stops in
// time, because that is the part still worth acting on.
function runwayApproachSpeed(paceDelta) {
	return clamp(1 + (Number(paceDelta) || 0) * 2.5, 0.35, 2.4);
}

// Third channel: is the burn rate itself rising or falling? Positive is braking.
function runwayBrake(model) {
	const history = normalizedHistory(model).slice(-12);
	if (history.length < 4) return 0;
	const middle = Math.floor(history.length / 2);
	const rateBetween = (from, to) => {
		const hours = (to.at - from.at) / 3_600_000;
		return hours > 0 ? (to.used - from.used) / hours : null;
	};
	const earlier = rateBetween(history[0], history[middle]);
	const recent = rateBetween(history[middle], history.at(-1));
	if (earlier === null || recent === null || earlier <= 0) return 0;
	return clamp((earlier - recent) / earlier, -1, 1);
}

// Where the runway end sat at the previous reading, recomputed from the stored
// history rather than persisted. Nothing new has to be written to localStorage,
// and the ghost cannot go stale against a cleared or migrated preference.
function runwayGhost(model, timing) {
	const history = normalizedHistory(model);
	if (history.length < 2) return null;
	const anchor = history.at(-1);
	const previous = [...history].reverse().find((sample) => anchor.at - sample.at >= RUNWAY_MIN_GHOST_GAP_MS);
	// A drop in usage means the cycle reset between the two samples, so the
	// earlier reading describes a different runway and comparing them says
	// nothing.
	if (!previous || previous.used <= 0 || previous.used > anchor.used) return null;
	const elapsedHours = (anchor.at - previous.at) / 3_600_000;
	const currentHour = timing.currentHour - elapsedHours;
	const remainingHours = timing.remainingHours + elapsedHours;
	if (currentHour <= 0 || remainingHours <= 0) return null;
	const rate = previous.used / currentHour;
	if (!(rate > 0)) return null;
	const rollHours = (1 - previous.used) / rate;
	return {
		margin: rollHours / remainingHours,
		marginHours: rollHours - remainingHours,
		elapsedHours
	};
}

function runwayPhysics(model) {
	const timing = runwayTiming(model);
	const ideal = clamp(Number(model?.flatCum) || 0, 0, 1);
	const paceDelta = timing.actual - ideal;
	const shared = {
		paceDelta,
		speed: runwayApproachSpeed(paceDelta),
		brake: runwayBrake(model),
		rollHours: timing.projectedHours,
		runwayHours: timing.remainingHours,
		depletion: projectedDepletionContext(model),
		ghost: null
	};

	// No measurable rate is not the same thing as a safe landing, and used to
	// render as one. It gets its own state and no verdict.
	if (timing.projectedHours === null) {
		return {
			...shared,
			state: 'holding',
			status: 'Holding — no rate yet',
			detail: 'Usage has not moved yet, so there is no burn rate to project a stopping distance from.',
			margin: null,
			marginHours: null,
			severity: 0,
			surplus: RUNWAY_SURPLUS_SPAN,
			drop: 0
		};
	}
	if (timing.projectedHours <= 0) {
		return {
			...shared,
			state: 'exhausted',
			status: 'Runway exhausted',
			detail: 'The quota is already depleted; nothing is left to spend before the reset.',
			margin: 0,
			marginHours: -timing.remainingHours,
			severity: 1,
			surplus: -RUNWAY_DROP_SPAN,
			drop: 1
		};
	}

	// A reset that has just landed leaves no distance still to cover, which is a
	// safe stop rather than a division by zero.
	const runwayHours = Math.max(timing.remainingHours, 1 / 60);
	const margin = timing.projectedHours / runwayHours;
	const marginHours = timing.projectedHours - timing.remainingHours;
	const band = runwayBand(margin);
	const surplus = clamp(margin - 1, -RUNWAY_DROP_SPAN, RUNWAY_SURPLUS_SPAN);
	return {
		...shared,
		state: band.state,
		status: band.status,
		detail: runwayDetail(band.state, marginHours),
		margin,
		marginHours,
		severity: clamp((1.5 - margin) / 0.8, 0, 1),
		surplus,
		drop: surplus < 0 ? clamp(-surplus / RUNWAY_DROP_SPAN, 0, 1) : 0,
		ghost: runwayGhost(model, timing)
	};
}

function runwayDetail(state, marginHours) {
	const span = formatDurationHours(Math.abs(marginHours));
	if (state === 'ample') return `The quota outlasts this reset by ${span}.`;
	if (state === 'comfortable') return `The quota clears this reset with ${span} to spare.`;
	if (state === 'marginal') return `Only ${span} of quota sits beyond the reset — a small rate increase overruns it.`;
	if (state === 'overrun') return `The quota runs dry ${span} before the reset.`;
	return `The quota runs dry ${span} before the reset, well short of it.`;
}

// Screen geometry, kept apart from the physics so the mapping from a margin to a
// picture is one readable function rather than arithmetic sprinkled through the
// template.
function runwayScene(physics) {
	const endDepth = physics.drop > 0
		? RUNWAY_STOP_DEPTH + physics.drop * 9
		: runwayDepth(Math.max(physics.surplus, 0) / RUNWAY_SURPLUS_SPAN);
	const ghost = physics.ghost;
	const ghostSurplus = ghost ? clamp(ghost.margin - 1, -RUNWAY_DROP_SPAN, RUNWAY_SURPLUS_SPAN) : null;
	const ghostDepth = ghostSurplus === null
		? null
		: ghostSurplus < 0
			? RUNWAY_STOP_DEPTH + clamp(-ghostSurplus / RUNWAY_DROP_SPAN, 0, 1) * 9
			: runwayDepth(ghostSurplus / RUNWAY_SURPLUS_SPAN);
	return { endDepth, ghostDepth };
}

function runwayGhostNote(physics) {
	if (!physics.ghost || physics.marginHours === null) return '';
	const change = physics.marginHours - physics.ghost.marginHours;
	const ago = formatDurationHours(physics.ghost.elapsedHours);
	if (Math.abs(change) * 60 < 6) return `Unchanged over the last ${ago}.`;
	const amount = formatDurationHours(Math.abs(change));
	return change < 0 ? `${amount} worse than ${ago} ago.` : `${amount} better than ${ago} ago.`;
}

function runwayHudReadout(physics) {
	const points = Math.round(Math.abs(physics.paceDelta) * 100);
	const sign = points === 0 ? '' : physics.paceDelta > 0 ? '+' : '−';
	const margin = physics.marginHours === null
		? '—'
		: `${physics.marginHours < 0 ? '−' : '+'}${formatDurationHours(Math.abs(physics.marginHours))}`;
	const rate = Math.abs(physics.brake) < 0.08
		? 'STEADY'
		: physics.brake > 0
			? `BRAKING ${Math.round(physics.brake * 100)}%`
			: `BUILDING ${Math.round(-physics.brake * 100)}%`;
	return { pace: `${sign}${points}%`, margin, rate };
}

// Kept as the named entry point the overview and the tests already use. It is a
// thin band-and-wording view over runwayPhysics.
function runwayOutcome(model) {
	const physics = runwayPhysics(model);
	return {
		state: physics.state,
		status: physics.status,
		detail: physics.detail,
		margin: physics.margin,
		marginHours: physics.marginHours,
		severity: physics.severity,
		depletion: physics.depletion
	};
}

function renderRunwayView(models) {
	const ordered = sortTrackersAlphabetically(models).slice(0, 6);
	if (!ordered.length) return renderEmptyPacePanel('runway');
	const cards = ordered.map((model) => {
		const physics = runwayPhysics(model);
		const scene = runwayScene(physics);
		const hud = runwayHudReadout(physics);
		const ghostNote = runwayGhostNote(physics);
		const reset = effectiveResetDate(model);
		const resetDateTime = reset ? formatResetDateTime(reset) : 'pending';
		const resetCountdown = reset ? `in ${formatCountdown(reset)}` : '';
		const actual = clamp(Number(model.actualCum) || 0, 0, 1);
		const marginLabel = physics.marginHours === null
			? 'not projectable yet'
			: physics.marginHours < 0
				? `${formatDurationHours(-physics.marginHours)} short`
				: `${formatDurationHours(physics.marginHours)} spare`;
		const gateLabel = physics.rollHours === null
			? 'no rate yet'
			: physics.rollHours <= 0 ? 'quota dry' : `${formatDurationHours(physics.rollHours)} to dry`;
		const sceneLabel = `${trackerDisplayLabel(model)}: ${physics.status}. ${physics.detail}${ghostNote ? ` ${ghostNote}` : ''} Pace ${hud.pace} against ideal, burn rate ${hud.rate.toLowerCase()}.`;
		// The resting geometry is the measurement, so it is written into the
		// style attribute and is correct with no script at all. The from-values
		// only let settleRunwayCards() supply frames between two correct states.
		const previous = runwaySettled.get(String(model.id ?? ''));
		return `
			<article class="runway-card runway-${physics.state}"
				style="--runway-end: ${scene.endDepth.toFixed(2)}; --runway-drop: ${physics.drop.toFixed(3)}; --runway-severity: ${physics.severity.toFixed(3)}; --runway-speed: ${physics.speed.toFixed(3)}; --runway-brake: ${physics.brake.toFixed(3)}; --runway-ghost: ${(scene.ghostDepth ?? scene.endDepth).toFixed(2)}"
				data-runway-id="${escapeHtml(String(model.id ?? ''))}"
				data-runway-end="${scene.endDepth.toFixed(2)}"
				data-runway-drop="${physics.drop.toFixed(3)}"${previous ? `\n\t\t\t\tdata-runway-from="${previous.end.toFixed(2)},${previous.drop.toFixed(3)}"` : ''}>
				<header class="runway-card-header">
					<div><strong>${escapeHtml(trackerDisplayLabel(model))}</strong><span>${escapeHtml(cycleLabel(model))} · ${formatPercent(actual)} used</span></div>
					<span class="runway-outcome"><i></i>${escapeHtml(physics.status)}</span>
				</header>
				<div class="runway-stage" role="img" aria-label="${escapeHtml(sceneLabel)}">
					<div class="runway-sky" aria-hidden="true"><i></i><i></i><i></i></div>
					<div class="runway-horizon" aria-hidden="true"></div>
					<div class="runway-abyss" aria-hidden="true"></div>
					<div class="runway-strip" aria-hidden="true">
						<div class="runway-pavement">
							<div class="runway-centerline"></div>
						</div>
						${scene.ghostDepth === null ? '' : '<div class="runway-ghost-line"></div>'}
						<div class="runway-end">
							<div class="runway-drop-face"></div>
							<div class="runway-threshold"><span></span><span></span><span></span><span></span><span></span></div>
						</div>
					</div>
					<div class="runway-gate-label" aria-hidden="true"><span>${escapeHtml(gateLabel)}</span></div>
					<div class="runway-brake-glow" aria-hidden="true"></div>
					<div class="runway-heat" aria-hidden="true"></div>
					<div class="aircraft-rig" aria-hidden="true">
						<div class="aircraft-main">
							<i class="aircraft-shadow"></i>
							<i class="aircraft-wing aircraft-wing-left"></i>
							<i class="aircraft-wing aircraft-wing-right"></i>
							<i class="aircraft-tailplane aircraft-tailplane-left"></i>
							<i class="aircraft-tailplane aircraft-tailplane-right"></i>
							<i class="aircraft-fuselage"></i>
							<i class="aircraft-nose"></i>
							<i class="aircraft-cockpit"></i>
							<i class="aircraft-fin"></i>
						</div>
						<div class="aircraft-fragments"><i></i><i></i><i></i><i></i><i></i><i></i></div>
					</div>
					<div class="runway-impact" aria-hidden="true"><i></i><i></i><i></i></div>
					<div class="runway-hud" aria-hidden="true"><span>Δ PACE ${escapeHtml(hud.pace)}</span><span>${escapeHtml(hud.rate)}</span><span class="runway-hud-margin">${escapeHtml(hud.margin)}</span></div>
				</div>
				<footer class="runway-card-footer">
					<p>${escapeHtml(physics.detail)}${ghostNote ? ` <em>${escapeHtml(ghostNote)}</em>` : ''}</p>
					<dl><div><dt>Margin at reset</dt><dd>${escapeHtml(marginLabel)}<em>${escapeHtml(physics.depletion.note)}</em></dd></div><div><dt>Reset</dt><dd>${escapeHtml(resetDateTime)}${resetCountdown ? `<em>${escapeHtml(resetCountdown)}</em>` : ''}</dd></div></dl>
				</footer>
			</article>
		`;
	}).join('');
	return `
		<article class="panel chart-panel runway-panel">
			<div class="panel-heading">
				<div><h2>Quota Runway</h2><p class="runway-intro">The runway is the quota you have left. The distance to cover is the time to reset. The gate ahead is where the quota runs dry.</p></div>
				<div class="pace-heading-actions">${renderPaceViewToggle('runway')}<div class="runway-legend"><span class="runway-legend-scale"><i></i>Ample → off the end</span><span><i class="runway-ghost-key"></i>Previous reading</span></div></div>
			</div>
			<div class="runway-grid-layout">${cards}</div>
		</article>
	`;
}

// Moves each scene from where it last settled to where the new numbers put it.
// Both ends are values the markup renders statically on its own; this only
// supplies the frames in between, so a refresh reads as the runway shortening
// rather than as a scene rebuilding itself.
function settleRunwayCards(root) {
	if (!root || typeof root.querySelectorAll !== 'function') return;
	root.querySelectorAll('.runway-card[data-runway-end]').forEach((card) => {
		const end = Number(card.getAttribute('data-runway-end'));
		const drop = Number(card.getAttribute('data-runway-drop'));
		if (!Number.isFinite(end) || !Number.isFinite(drop)) return;
		runwaySettled.set(card.getAttribute('data-runway-id') || '', { end, drop });
		const from = (card.getAttribute('data-runway-from') || '').split(',').map(Number);
		if (from.length !== 2 || !from.every(Number.isFinite)) return;
		if (Math.abs(from[0] - end) < 0.01 && Math.abs(from[1] - drop) < 0.001) return;
		if (typeof requestAnimationFrame !== 'function') return;
		card.style.setProperty('--runway-end', from[0].toFixed(2));
		card.style.setProperty('--runway-drop', from[1].toFixed(3));
		void card.offsetWidth;
		requestAnimationFrame(() => {
			card.style.setProperty('--runway-end', end.toFixed(2));
			card.style.setProperty('--runway-drop', drop.toFixed(3));
		});
	});
}

function renderTrendChart(models) {
	const availableSeries = models.map((model) => ({
		model,
		points: normalizedHistory(model).slice(-30)
	})).filter((entry) => entry.points.length);
	const series = assignTrendSeriesStyles(availableSeries.slice(0, 6));
	if (!series.length) {
		return renderEmptyPanel('Usage history', 'trend');
	}
	const allTimes = series.flatMap((entry) => entry.points.map((point) => point.at));
	const dataMinimumTime = Math.min(...allTimes);
	const dataMaximumTime = Math.max(...allTimes);
	const minimumTime = dataMinimumTime === dataMaximumTime ? dataMaximumTime - 60 * 60 * 1000 : dataMinimumTime;
	const maximumTime = dataMaximumTime;
	const timeSpan = maximumTime - minimumTime;
	const left = 46;
	const right = 704;
	const top = 16;
	const bottom = 204;
	const xFor = (time) => left + ((time - minimumTime) / timeSpan) * (right - left);
	const yFor = (used) => bottom - used * (bottom - top);
	const horizontalGrid = [0, 0.25, 0.5, 0.75, 1].map((value) => {
		const y = yFor(value);
		return `<line class="grid-line" x1="${left}" y1="${y}" x2="${right}" y2="${y}" /><text class="axis-label trend-y-label" x="36" y="${y + 4}" text-anchor="end">${Math.round(value * 100)}%</text>`;
	}).join('');
	const tickCount = timeSpan <= 6 * 60 * 60 * 1000 ? 5 : 4;
	const timeTicks = Array.from({ length: tickCount }, (_, index) => minimumTime + (timeSpan * index) / (tickCount - 1));
	const verticalGrid = timeTicks.map((timestamp, index) => {
		const x = xFor(timestamp);
		const anchor = index === 0 ? 'start' : index === timeTicks.length - 1 ? 'end' : 'middle';
		return `<line class="grid-line grid-line-vertical" x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" /><text class="axis-label trend-x-label" x="${x}" y="229" text-anchor="${anchor}">${escapeHtml(formatTrendTime(timestamp, timeSpan))}</text>`;
	}).join('');
	const paths = series.map((entry) => {
		const coordinates = entry.points.map((point) => [xFor(point.at), yFor(point.used)]);
		const path = coordinates.map(([x, y], pointIndex) => `${pointIndex ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
		return coordinates.length > 1 ? `<path class="trend-line series-${entry.colorIndex}" d="${path}" />` : '';
	}).join('');
	const seriesByModel = new Map(series.map((entry) => [entry.model, entry]));
	const summaryGroups = groupModelsByProvider(series.map((entry) => entry.model));
	const summaries = summaryGroups.map((group, groupIndex) => {
		const rows = group.models.map((model) => {
			const entry = seriesByModel.get(model);
			const current = entry.points.at(-1).used;
			const change = trendChangeContext(entry.points);
			const changeDescription = change.label === '—'
				? 'No earlier sample'
				: `${change.label} across displayed samples${change.resetDrop ? '; reset or correction drop detected' : ''}`;
			return `
				<article class="trend-summary-row">
					<div class="trend-summary-metric"><i class="trend-series-swatch series-bg-${entry.colorIndex}" aria-hidden="true"></i><strong>${escapeHtml(metricLabel(model))}</strong></div>
					<dl>
						<div><dt>Current</dt><dd>${formatPercent(current)}</dd></div>
						<div><dt>Change</dt><dd class="trend-change ${change.tone}" aria-label="${escapeHtml(changeDescription)}">${escapeHtml(change.label)}${change.resetDrop ? '<small>Reset/drop</small>' : ''}</dd></div>
					</dl>
				</article>
			`;
		}).join('');
		return `<section class="trend-provider-summary" aria-labelledby="trend-provider-${groupIndex}"><h3 id="trend-provider-${groupIndex}">${escapeHtml(group.provider)}</h3><div class="trend-summary-list">${rows}</div></section>`;
	}).join('');
	const sampleCount = series.reduce((total, entry) => total + entry.points.length, 0);
	return `
		<article class="panel chart-panel">
			<div class="panel-heading">
				<h2>Usage trend</h2>
				<div class="trend-meta" aria-label="Chart coverage"><span>${series.length} of ${availableSeries.length} shown</span><span>${sampleCount} sample${sampleCount === 1 ? '' : 's'}</span><span>Local · ${escapeHtml(formatTrendRange(dataMinimumTime, dataMaximumTime))}</span></div>
			</div>
			<svg class="trend-chart" viewBox="0 0 720 240" aria-hidden="true" focusable="false">
				${horizontalGrid}${verticalGrid}${paths}
			</svg>
			<div class="trend-summary" aria-label="Usage trend details">${summaries}</div>
		</article>
	`;
}

function renderEmptyPanel(title, kind) {
	return `
		<article class="panel chart-panel empty-chart">
			<div class="panel-heading"><h2>${escapeHtml(title)}</h2></div>
			<div class="empty-visual ${escapeHtml(kind)}" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
		</article>
	`;
}

function renderSourcesPanel() {
	const rememberedCount = preferences.providerTabs.selectedTabs.length;
	const running = isRefreshPlanRunning();
	return `
		<section class="panel sources-panel" id="provider-connections">
			<div class="section-heading sources-heading"><h2>Provider Connections</h2><div class="tracker-counts"><span>${selectedTabIds.length} connected</span><span>${rememberedCount} remembered</span></div></div>
			<div class="sync-toolbar">
				<div class="sync-status"><span class="sync-orb ${scanInProgress || tabDiscoveryInProgress ? 'spinning' : ''}">${icon('refresh')}</span><p>${escapeHtml(autoScanStatus)}</p></div>
				<div class="control-row">
					<button class="secondary" data-action="refresh-tabs" ${scanInProgress || tabDiscoveryInProgress ? 'disabled' : ''}>Refresh Tabs</button>
					<button data-action="scan-selected" ${!selectedTabIds.length || scanInProgress || tabDiscoveryInProgress ? 'disabled' : ''}>${scanInProgress ? 'Refreshing…' : 'Scan Selected'}</button>
					${running ? `<button class="danger-button" data-action="refresh-plan-stop">Stop Refreshes</button>` : ''}
				</div>
			</div>
			<p class="sources-note">Scheduled refreshes are started from <a href="#/overview">Overview</a>. Each one reloads these tabs, and the extension refuses to reload the same page more than once every 5 minutes.</p>
			${renderTabList()}
		</section>
	`;
}

function renderTabList() {
	if (tabDiscoveryInProgress) {
		return `<div class="tab-list tab-list-loading" role="status" aria-live="polite"><div class="tab-row-skeleton"><i></i><span></span></div><div class="tab-row-skeleton"><i></i><span></span></div><p>Finding provider tabs…</p></div>`;
	}
	if (!availableTabs.length) {
		const rememberedCount = preferences.providerTabs.selectedTabs.length;
		const message = rememberedCount
			? `Waiting for ${rememberedCount} remembered provider tab${rememberedCount === 1 ? '' : 's'} to become available.`
			: 'No provider tabs are available yet.';
		return `<div class="tab-list empty-tabs"><p>${escapeHtml(message)}</p></div>`;
	}
	return `<div class="tab-list">${availableTabs.map((tab) => `
		<label class="tab-row">
			<input type="checkbox" data-tab-id="${Number(tab.id)}" ${selectedTabIds.includes(tab.id) ? 'checked' : ''}>
			<span class="tab-check" aria-hidden="true">${icon('check')}</span>
			<span class="tab-meta"><span class="tab-title-line"><a class="tab-title" href="${escapeHtml(tab.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tab.title || tab.url)}</a>${tab.status === 'loading' ? '<span class="tab-state">Loading</span>' : ''}</span><small class="tab-url">${escapeHtml(tab.url)}</small></span>
		</label>
	`).join('')}</div>`;
}

function renderSetupPage(models) {
	const groups = groupTrackers(models);
	const enabledCount = models.filter(isTrackerEnabled).length;
	const hiddenCount = models.length - enabledCount;
	return `
		<section class="setup-page" id="setup">
			${renderSourcesPanel()}
			<article class="panel tracker-manager">
				<div class="section-heading tracker-manager-heading">
					<h2>Dashboard Trackers</h2>
					<div class="tracker-counts"><span>${enabledCount} shown</span><span>${hiddenCount} hidden</span></div>
				</div>
				${renderHeadlineSettings(models.filter(isTrackerEnabled))}
				${groups.length
					? `<div class="tracker-groups">${groups.map(renderTrackerGroup).join('')}</div>`
					: `<div class="setup-empty"><strong>No Trackers</strong><button data-action="connect-scan">Scan Provider Tabs</button></div>`}
			</article>
			${renderSettingsPanel(models)}
		</section>
	`;
}

function renderHeadlineSettings(enabledModels) {
	const enabled = preferences.showHeadlineIndicator;
	const scope = resolveHeadlineScope(enabledModels, preferences.headlineScope);
	const options = headlineScopeOptions(enabledModels);
	const option = (entry) => `<option value="${escapeHtml(entry.value)}" ${entry.value === scope.scope ? 'selected' : ''}>${escapeHtml(entry.label)}</option>`;
	const fellBack = scope.requested !== scope.scope;
	return `
		<div class="headline-settings">
			<div class="tracker-control ${enabled ? '' : 'is-hidden'}">
				<div class="tracker-control-identity">
					<strong>Headline indicator</strong>
					<span>Weighted Δ pace shown above the Overview charts and in the browser tab title</span>
				</div>
				<button class="tracker-toggle" type="button" role="switch" aria-checked="${enabled}" aria-label="${enabled ? 'Hide' : 'Show'} the headline indicator" data-action="toggle-headline">
					<span class="switch-track" aria-hidden="true"><span></span></span>
					<span class="switch-label">${enabled ? 'Shown' : 'Hidden'}</span>
				</button>
			</div>
			<div class="tracker-control ${enabled ? '' : 'is-hidden'}">
				<div class="tracker-control-identity">
					<strong>Browser tab title</strong>
					<span>${fellBack
						? 'The saved selection is no longer available — the title is falling back to Overall'
						: 'Which quota the title shows. The Overview panel always averages them all.'}</span>
				</div>
				<label class="headline-scope">
					<span class="visually-hidden">Browser tab title source</span>
					<select data-headline-scope ${enabled ? '' : 'disabled'}>
						${option(options.overall)}
						${options.providers.length ? `<optgroup label="Provider">${options.providers.map(option).join('')}</optgroup>` : ''}
						${options.trackers.length ? `<optgroup label="Tracker">${options.trackers.map(option).join('')}</optgroup>` : ''}
					</select>
				</label>
			</div>
		</div>
	`;
}

function renderTrackerGroup(group, groupIndex) {
	const shown = group.models.filter(isTrackerEnabled).length;
	return `
		<section class="tracker-group">
			<header class="tracker-group-header">
				<div class="quota-identity">
					<span class="provider-mark series-bg-${groupIndex % CHART_COLORS.length}">${escapeHtml(providerInitials(group.provider))}</span>
					<div><h3>${escapeHtml(group.provider)}</h3><small title="${escapeHtml(group.sourceLabel)}">${escapeHtml(group.sourceLabel)}</small></div>
				</div>
				<span class="group-count">${shown} of ${group.models.length} shown</span>
			</header>
			<div class="tracker-list">${group.models.map(renderTrackerControl).join('')}</div>
		</section>
	`;
}

function renderTrackerControl(model) {
	const enabled = isTrackerEnabled(model);
	const reset = effectiveResetDate(model);
	return `
		<div class="tracker-control ${enabled ? '' : 'is-hidden'}">
			<div class="tracker-control-identity">
				<strong>${escapeHtml(metricLabel(model))}</strong>
				<span>${escapeHtml(cycleLabel(model))} · ${formatPercent(clamp(Number(model.actualCum) || 0, 0, 1))} used · ${reset ? `resets in ${escapeHtml(formatCountdown(reset))}` : 'reset pending'}</span>
			</div>
			<button class="tracker-toggle" type="button" role="switch" aria-checked="${enabled}" aria-label="${enabled ? 'Hide' : 'Show'} ${escapeHtml(metricLabel(model))} on the dashboard" data-action="toggle-tracker" data-model-id="${escapeHtml(model.id)}">
				<span class="switch-track" aria-hidden="true"><span></span></span>
				<span class="switch-label">${enabled ? 'Shown' : 'Hidden'}</span>
			</button>
		</div>
	`;
}

function renderSettingsPanel(models) {
	return `
		<details class="panel settings-panel" id="advanced-settings">
			<summary><strong>Manual Overrides</strong><span class="summary-chevron">${icon('chevron')}</span></summary>
			<div class="settings-content">
				<div class="settings-intro"><button class="secondary compact" data-action="add-model">${icon('plus', 'button-icon')}Add Tracker</button></div>
				${models.length ? models.map(renderModelSettings).join('') : '<p class="muted">No Trackers</p>'}
			</div>
		</details>
	`;
}

function renderModelSettings(model) {
	const actualPercent = clamp(Number(model.actualCum) || 0, 0, 1) * 100;
	return `
		<details class="quota-settings" data-settings-id="${escapeHtml(model.id)}" ${expandedSettings.has(String(model.id)) ? 'open' : ''}>
			<summary><span><strong>${escapeHtml(model.provider)} · ${escapeHtml(metricLabel(model))}</strong><small>${model.sourceUrl ? 'Auto-detected' : 'Manual limit'}</small></span><span class="summary-chevron">${icon('chevron')}</span></summary>
			<div class="settings-body">
				<div class="grid config-grid">
					${renderInput(model, 'provider', 'Provider', 'text', model.provider)}
					${renderInput(model, 'metricLabel', 'Display name', 'text', metricLabel(model))}
					${renderInput(model, 'model', 'Model / scope', 'text', model.model)}
					${renderInput(model, 'actualCumUsedPercent', 'Usage used (%)', 'number', actualPercent, { min: 0, max: 100, step: 0.1, kind: 'percent' })}
					${renderInput(model, 'daysInCycle', 'Days in cycle', 'number', model.daysInCycle, { min: 1, step: 1 })}
					${renderInput(model, 'hoursPerDay', 'Hours per day', 'number', model.hoursPerDay, { min: 1, step: 1 })}
					${renderDaySelect(model)}
					${renderInput(model, 'startHour', 'Start hour', 'number', model.startHour, { min: 0, max: 23, step: 1 })}
					${renderInput(model, 'paceThreshold', 'Pace alert (%)', 'number', (Number(model.paceThreshold) || 0) * 100, { min: 0, max: 100, step: 0.5, kind: 'percent' })}
				</div>
				<div class="settings-actions"><span>${model.sourceUrl ? `Source: ${escapeHtml(shorten(model.sourceUrl, 64))}` : 'No provider source attached'}</span><div class="control-row"><button class="secondary compact" data-action="duplicate-model" data-model-id="${escapeHtml(model.id)}">Duplicate</button><button class="danger-button compact" data-action="delete-model" data-model-id="${escapeHtml(model.id)}">Delete limit</button></div></div>
			</div>
		</details>
	`;
}

function renderInput(model, name, label, type, value, attributes = {}) {
	const inputId = `${model.id}-${name}`;
	const attrs = Object.entries(attributes).filter(([key]) => key !== 'kind')
		.map(([key, attrValue]) => `${key}="${escapeHtml(attrValue)}"`).join(' ');
	return `<div class="field"><label for="${escapeHtml(inputId)}">${escapeHtml(label)}</label><input id="${escapeHtml(inputId)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}" data-model-id="${escapeHtml(model.id)}" data-field="${escapeHtml(name)}" ${attributes.kind ? `data-kind="${escapeHtml(attributes.kind)}"` : ''} ${attrs}></div>`;
}

function renderDaySelect(model) {
	const inputId = `${model.id}-startDay`;
	return `<div class="field"><label for="${escapeHtml(inputId)}">Cycle start day</label><select id="${escapeHtml(inputId)}" data-model-id="${escapeHtml(model.id)}" data-field="startDay">${DAY_NAMES.map((day) => `<option value="${day}" ${day === model.startDay ? 'selected' : ''}>${day}</option>`).join('')}</select></div>`;
}

function bindDashboardEvents(container) {
	container.querySelectorAll('[data-action]').forEach((button) => {
		button.addEventListener('click', async (event) => {
			const action = event.currentTarget.dataset.action;
			const modelId = event.currentTarget.dataset.modelId;
			if (action === 'refresh-tabs') await refreshTabList();
			if (action === 'scan-selected') await scanSelectedTabs();
			if (action === 'connect-scan') await connectAndScan();
			if (action === 'refresh-plan-start' || action === 'refresh-plan-reset') {
				startRefreshPlan();
				render();
			}
			if (action === 'refresh-plan-stop') {
				stopRefreshPlan();
				render();
			}
			if (action === 'pace-view') {
				const requestedView = event.currentTarget.dataset.paceView;
				const nextView = ['graph', 'runway'].includes(requestedView) ? requestedView : 'bars';
				replacePreferences({ ...preferences, overviewPaceView: nextView });
				render();
			}
			if (action === 'open-settings') {
				expandedSettings.add(String(modelId));
				pendingSettingsId = String(modelId);
				navigateTo('setup');
			}
			if (action === 'toggle-headline') {
				replacePreferences({
					...preferences,
					showHeadlineIndicator: event.currentTarget.getAttribute('aria-checked') !== 'true'
				});
				render();
			}
			if (action === 'toggle-tracker') {
				setTrackerEnabled(modelId, event.currentTarget.getAttribute('aria-checked') !== 'true');
			}
			if (action === 'add-model') addModel();
			if (action === 'duplicate-model') duplicateModel(modelId);
			if (action === 'delete-model') deleteModel(modelId);
		});
	});

	container.querySelectorAll('[data-tab-id]').forEach((checkbox) => {
		checkbox.addEventListener('change', () => toggleTabSelection(Number(checkbox.dataset.tabId)));
	});

	// Changing either control while a run is live re-arms it from now with the new
	// values, rather than silently reinterpreting a run already in progress.
	container.querySelectorAll('[data-refresh-interval], [data-refresh-count]').forEach((select) => {
		select.addEventListener('change', () => {
			const intervalSeconds = select.dataset.refreshInterval !== undefined
				? select.value
				: preferences.refreshPlan.intervalSeconds;
			const totalRefreshes = select.dataset.refreshCount !== undefined
				? select.value
				: preferences.refreshPlan.totalRefreshes;
			if (isRefreshPlanRunning()) {
				startRefreshPlan({ intervalSeconds, totalRefreshes });
			} else {
				writeRefreshPlan({
					intervalSeconds: normalizeRefreshIntervalSeconds(intervalSeconds),
					totalRefreshes: normalizeRefreshCount(totalRefreshes)
				});
			}
			render();
		});
	});

	container.querySelectorAll('[data-headline-scope]').forEach((select) => {
		select.addEventListener('change', () => {
			replacePreferences({ ...preferences, headlineScope: select.value });
			render();
		});
	});

	container.querySelectorAll('[data-field]').forEach((input) => {
		input.addEventListener('input', () => persistModelInput(input, false));
		input.addEventListener('change', () => persistModelInput(input, true));
	});

	container.querySelectorAll('[data-settings-id]').forEach((details) => {
		details.addEventListener('toggle', () => {
			const modelId = String(details.dataset.settingsId);
			details.open ? expandedSettings.add(modelId) : expandedSettings.delete(modelId);
		});
	});
}

function persistModelInput(input, shouldRender) {
	let value = input.value;
	if (input.type === 'number') value = input.value === '' ? '' : Number(input.value);
	if (input.dataset.kind === 'percent' && value !== '') value = Number(value) / 100;
	return updateModelField(input.dataset.modelId, input.dataset.field, value, shouldRender);
}

function cssEscape(value) {
	return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function updateNavigation(page) {
	document.querySelectorAll('.nav-item[data-page]').forEach((link) => {
		const isActive = link.dataset.page === page;
		link.classList.toggle('active', isActive);
		if (isActive) link.setAttribute('aria-current', 'page');
		else link.removeAttribute('aria-current');
	});
}

function navigateTo(page) {
	const targetPage = Object.hasOwn(PAGE_CONFIG, page) ? page : 'overview';
	const targetHash = `#/${targetPage}`;
	if (typeof window === 'undefined') return;
	if (window.location.hash !== targetHash) {
		window.location.hash = targetHash;
		return;
	}
	render();
	window.scrollTo({ top: 0, behavior: 'smooth' });
}

function revealPendingSettings(container) {
	const modelId = pendingSettingsId;
	pendingSettingsId = null;
	const panel = document.getElementById('advanced-settings');
	if (panel) panel.open = true;
	const details = container.querySelector(`[data-settings-id="${cssEscape(modelId)}"]`);
	if (!details) return;
	details.open = true;
	requestAnimationFrame(() => details.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

function addModel() {
	const models = loadModels();
	const modelId = id();
	models.unshift({ ...DEFAULT_MODEL, id: modelId, metricLabel: 'Custom limit', dashboardEnabled: true });
	expandedSettings.add(String(modelId));
	pendingSettingsId = String(modelId);
	saveModels(models);
	navigateTo('setup');
}

function duplicateModel(modelId) {
	const models = loadModels();
	const source = models.find((entry) => String(entry.id) === String(modelId));
	if (!source) return;
	const newId = id();
	models.unshift({ ...source, id: newId, sourceUrl: '', metricKey: '', metricLabel: `${metricLabel(source)} copy`, dashboardEnabled: true });
	expandedSettings.add(String(newId));
	pendingSettingsId = String(newId);
	saveModels(models);
	navigateTo('setup');
}

function deleteModel(modelId) {
	const models = loadModels().filter((entry) => String(entry.id) !== String(modelId));
	expandedSettings.delete(String(modelId));
	saveModels(models);
	render();
}

function updateModelField(modelId, fieldName, value, shouldRender = true) {
	const models = loadModels();
	const index = models.findIndex((entry) => String(entry.id) === String(modelId));
	if (index < 0) return false;
	models[index] = { ...models[index], [fieldName]: value };
	saveModels(models);
	if (shouldRender && typeof document !== 'undefined') render();
	return true;
}

function setTrackerEnabled(modelId, enabled) {
	const models = loadModels();
	const index = models.findIndex((entry) => String(entry.id) === String(modelId));
	if (index < 0) return false;
	models[index] = { ...models[index], dashboardEnabled: Boolean(enabled) };
	saveModels(models);
	if (typeof document !== 'undefined') render();
	return true;
}

function toggleTabSelection(tabId) {
	const update = toggleTabSelectionPreference(availableTabs, preferences, tabId);
	if (!update.changed) return false;
	replacePreferences(update.preferences);
	selectedTabIds = update.selectedTabIds;
	if (!hasRememberedTabSelections() && isRefreshPlanRunning()) stopRefreshPlan();
	render();
	return true;
}

async function connectAndScan() {
	const found = await refreshTabList(false);
	if (found && selectedTabIds.length) await scanSelectedTabs();
}

async function refreshTabList(shouldRender = true) {
	if (scanInProgress) return false;
	tabDiscoveryInProgress = true;
	autoScanStatus = 'Finding tabs…';
	if (shouldRender && typeof document !== 'undefined') render();
	else if (typeof document !== 'undefined') updateDashboardChrome();
	const response = await sendExtensionRequest('EXTENSION_LIST_TABS');
	if (!response?.ok || !Array.isArray(response.tabs)) {
		autoScanStatus = response?.error
			? `Extension error: ${response.error}`
			: 'Extension not available. Reload the unpacked extension, then refresh this page.';
		availableTabs = [];
		selectedTabIds = [];
		tabDiscoveryInProgress = false;
		if (typeof document !== 'undefined') render();
		return false;
	}
	availableTabs = response.tabs.filter((tab) => Number.isInteger(tab?.id) && stableTabUrl(tab?.url));
	if (!preferences.providerTabs.initialized && availableTabs.length) {
		replacePreferences({
			...preferences,
			providerTabs: {
				initialized: true,
				selectedTabs: availableTabs.map(tabSelectionDescriptor).filter(Boolean)
			}
		});
	}
	const reconciliation = reconcileTabSelections(availableTabs, preferences);
	preferences = savePreferences(reconciliation.preferences);
	selectedTabIds = reconciliation.selectedTabIds;
	if (isRefreshPlanRunning() && !selectedTabIds.length) {
		autoScanStatus = hasRememberedTabSelections()
			? 'Refreshes scheduled · waiting for selected tab'
			: 'Refreshes scheduled · waiting for provider tabs';
	} else {
		autoScanStatus = availableTabs.length
			? `${availableTabs.length} supported tab${availableTabs.length === 1 ? '' : 's'}`
			: 'No supported tabs';
	}
	tabDiscoveryInProgress = false;
	if (typeof document !== 'undefined' && (shouldRender || currentPage() === 'setup')) render();
	else if (typeof document !== 'undefined') updateDashboardChrome();
	return true;
}

// A refusal by the extension's own rate limit used to be invisible on Overview,
// where the scan status is not rendered at all: the Sync button span and nothing
// changed. Surface when it can be retried instead.
function rateLimitRetryAt(failures, now = Date.now()) {
	const longest = (Array.isArray(failures) ? failures : [])
		.map((failure) => Number(failure?.retryAfterMs))
		.filter((value) => Number.isFinite(value) && value > 0)
		.reduce((slowest, value) => Math.max(slowest, value), 0);
	return longest > 0 ? now + longest : null;
}

function rateLimitState(until = rateLimitedUntil, now = Date.now()) {
	const at = Number(until);
	if (!Number.isFinite(at) || at <= now) return { limited: false, label: '' };
	return { limited: true, label: `Rate limited · retry in ${formatSyncCountdown(at - now)}` };
}

// A partly successful scan used to report only a count, so the one thing that
// explains an empty tracker — why that tab produced nothing — was discarded.
// Name the tab and say why.
function describeScanFailures(failures) {
	const [first] = failures;
	const tab = availableTabs.find((candidate) => candidate.id === first.tabId);
	const name = tab?.title ? String(tab.title).trim().slice(0, 40) : `tab ${first.tabId}`;
	const others = failures.length > 1 ? ` (+${failures.length - 1} more)` : '';
	return `${failures.length} failed — ${name}: ${first.message}${others}`;
}

async function scanSelectedTabs() {
	if (scanInProgress) return;
	if (!selectedTabIds.length) {
		autoScanStatus = 'Select a tab';
		if (typeof document !== 'undefined') render();
		return;
	}
	scanInProgress = true;
	autoScanStatus = 'Refreshing provider tabs…';
	if (typeof document !== 'undefined' && currentPage() === 'setup') render();
	else if (typeof document !== 'undefined') updateDashboardChrome();
	try {
		const response = await sendExtensionRequest(
			'EXTENSION_SCAN_TABS',
			{ tabIds: selectedTabIds },
			SCAN_REQUEST_TIMEOUT_MS
		);
		if (!response?.ok || !Array.isArray(response.results)) {
			autoScanStatus = response?.error
				? `Extension error: ${response.error}`
				: 'The extension did not return usage data.';
			return;
		}
		const failures = Array.isArray(response.errors) ? response.errors : [];
		if (!response.results.length) {
			rateLimitedUntil = rateLimitRetryAt(failures);
			autoScanStatus = failures.length
				? `No data: ${failures[0].message}`
				: 'No quota data found';
			return;
		}
		const updatedCount = applyScrapedPayloads(response.results);
		if (updatedCount) lastSyncedAt = Date.now();
		rateLimitedUntil = rateLimitRetryAt(failures);
		const failureSuffix = failures.length ? ` · ${describeScanFailures(failures)}` : '';
		autoScanStatus = `${updatedCount} quota${updatedCount === 1 ? '' : 's'} synced${failureSuffix}`;
	} finally {
		scanInProgress = false;
		if (typeof document !== 'undefined') render();
	}
}

function mergePayloadIntoModels(models, payload) {
	const scrapedAt = payload?.scrapedAt ? new Date(payload.scrapedAt) : new Date();
	return mergeScrapedPayload(models, payload, {
		now: Number.isFinite(scrapedAt.getTime()) ? scrapedAt : new Date(),
		idFactory: id
	});
}

function applyScrapedPayloads(payloads) {
	let models = loadModels();
	let updatedCount = 0;
	(Array.isArray(payloads) ? payloads : [])
		.filter((payload) => !isOpenAiDayPayloadArtifact(payload)
			&& !isValueOnlyLabelPayloadArtifact(payload))
		.forEach((payload) => {
			const merged = mergePayloadIntoModels(models, payload);
			if (merged.updated) {
				models = merged.models;
				updatedCount += 1;
			}
		});
	if (updatedCount) saveModels(models);
	return updatedCount;
}

function applyScrapedPayload(payload) {
	return applyScrapedPayloads([payload]) === 1;
}

// The extension's popup asks the page to run its own refresh rather than
// scanning separately. Accepting this grants the extension nothing new -- the
// page can already start a scan whenever it likes.
function isExtensionRefreshCommand(event) {
	return event?.source === window
		&& event.origin === window.location.origin
		&& event.data?.channel === EXTENSION_BRIDGE_CHANNEL
		&& event.data?.direction === 'command'
		&& event.data?.type === 'EXTENSION_REFRESH_NOW';
}

function handleExtensionCommand(event) {
	if (!isExtensionRefreshCommand(event)) return false;
	void connectAndScan();
	return true;
}

async function sendExtensionRequest(type, details = {}, timeoutMs = 15_000) {
	return new Promise((resolve) => {
		const responseType = `${type}_RESPONSE`;
		const requestId = globalThis.crypto?.randomUUID?.() || id();
		let timer;
		function finish(payload) {
			window.removeEventListener('message', onMessage);
			clearTimeout(timer);
			resolve(payload);
		}
		function onMessage(event) {
			if (
				event.source !== window
				|| event.origin !== window.location.origin
				|| event.data?.channel !== EXTENSION_BRIDGE_CHANNEL
				|| event.data?.direction !== 'response'
				|| event.data?.type !== responseType
				|| event.data?.requestId !== requestId
			) return;
			bridgeLog(`Reply for ${type}`, { requestId, ok: event.data.payload?.ok, error: event.data.payload?.error });
			finish(event.data.payload);
		}
		window.addEventListener('message', onMessage);
		bridgeLog(`Requesting ${type}`, { requestId, details, timeoutMs });
		window.postMessage({
			channel: EXTENSION_BRIDGE_CHANNEL,
			direction: 'request',
			type,
			requestId,
			details
		}, window.location.origin);
		timer = setTimeout(() => {
			// Nothing answered at all. If no '[TMT content]' line appeared above,
			// the content script is not running on this origin and the request was
			// never picked up -- the service worker never saw it either.
			console.warn(
				'%c[TMT page]',
				'color:#8b7fff;font-weight:600',
				`${type} timed out after ${timeoutMs} ms with no reply from the extension bridge`,
				{ requestId, origin: window.location.origin }
			);
			finish({ ok: false, error: 'Extension request timed out.' });
		}, timeoutMs);
	});
}

async function pollOpenTabs() {
	if (scanInProgress) return;
	const found = await refreshTabList(false);
	if (!found) return;
	if (!selectedTabIds.length) {
		autoScanStatus = hasRememberedTabSelections()
			? 'Scheduled refresh skipped · waiting for selected tab'
			: 'Scheduled refresh skipped · waiting for provider tabs';
		if (typeof document !== 'undefined' && currentPage() === 'setup') render();
		else if (typeof document !== 'undefined') updateDashboardChrome();
		return;
	}
	await scanSelectedTabs();
}

function writeRefreshPlan(changes) {
	const plan = sanitizeRefreshPlan({ ...preferences.refreshPlan, ...changes });
	replacePreferences({ ...preferences, refreshPlan: plan });
	nextAutoSyncAt = plan.nextAt;
	return plan;
}

// setTimeout, not setInterval: each refresh schedules at most one successor, and
// only while refreshes remain. There is no repeating timer to leak or forget.
function scheduleNextRefresh() {
	if (autoScanTimer) {
		clearTimeout(autoScanTimer);
		autoScanTimer = null;
	}
	const plan = preferences.refreshPlan;
	if (!isRefreshPlanRunning(plan) || typeof document === 'undefined') return;
	autoScanTimer = setTimeout(runScheduledRefresh, Math.max(0, plan.nextAt - Date.now()));
}

async function runScheduledRefresh() {
	autoScanTimer = null;
	const plan = preferences.refreshPlan;
	if (!isRefreshPlanRunning(plan)) return;

	// Decremented and persisted before the scan, so a crash or a closed tab can
	// only ever shorten the run, never extend it.
	const remaining = Math.max(0, plan.remaining - 1);
	writeRefreshPlan({
		remaining,
		nextAt: remaining > 0 ? Date.now() + refreshIntervalMilliseconds(plan.intervalSeconds) : null
	});
	await pollOpenTabs();
	scheduleNextRefresh();
	if (typeof document !== 'undefined') render();
}

function startRefreshPlan({ intervalSeconds, totalRefreshes } = {}) {
	const interval = normalizeRefreshIntervalSeconds(
		intervalSeconds ?? preferences.refreshPlan.intervalSeconds
	);
	const total = normalizeRefreshCount(totalRefreshes ?? preferences.refreshPlan.totalRefreshes);
	writeRefreshPlan({
		intervalSeconds: interval,
		totalRefreshes: total,
		remaining: total,
		nextAt: Date.now() + interval * 1000
	});
	autoScanStatus = `${total} refresh${total === 1 ? '' : 'es'} scheduled · every ${formatRefreshInterval(interval)}`;
	scheduleNextRefresh();
	return preferences.refreshPlan;
}

function stopRefreshPlan() {
	if (autoScanTimer) {
		clearTimeout(autoScanTimer);
		autoScanTimer = null;
	}
	writeRefreshPlan({ remaining: 0, nextAt: null });
	autoScanStatus = 'Scheduled refreshes stopped';
	return preferences.refreshPlan;
}

function startChromeTicker() {
	if (chromeTicker || typeof document === 'undefined') return;
	chromeTicker = setInterval(() => updateDashboardChrome(), CHROME_TICK_MS);
}

async function restoreProviderSync() {
	const found = await refreshTabList(false);
	// A run in progress resumes with whatever count it had left. It cannot
	// outlive that count, so resuming can never turn into an unbounded loop.
	if (!isRefreshPlanRunning()) return found;
	nextAutoSyncAt = preferences.refreshPlan.nextAt;
	scheduleNextRefresh();
	if (typeof document !== 'undefined') render();
	return found;
}

function shorten(value, maximum) {
	const text = String(value ?? '');
	return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function escapeHtml(text) {
	return String(text ?? '').replace(/[&<>"']/g, (match) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[match]));
}

if (typeof document !== 'undefined') {
	preferences = loadPreferences();
	lastSyncedAt = latestModelUpdate(loadModels());
	startChromeTicker();
	window.addEventListener('message', handleExtensionCommand);
	if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
	window.addEventListener('hashchange', () => {
		render();
		window.scrollTo({ top: 0 });
	});
	render();
	void restoreProviderSync();
	requestAnimationFrame(() => window.scrollTo({ top: 0 }));
}

if (typeof module === 'object' && module.exports) {
	module.exports = {
		applyScrapedPayload,
		applyScrapedPayloads,
		autoSyncBadgeState,
		documentTitle,
		formatRefreshInterval,
		handleExtensionCommand,
		isExtensionRefreshCommand,
		isRefreshPlanRunning,
		rateLimitRetryAt,
		rateLimitState,
		normalizeRefreshCount,
		normalizeRefreshIntervalSeconds,
		refreshIntervalMilliseconds,
		renderRefreshPlanPanel,
		sanitizeRefreshPlan,
		formatResetDateTime,
		formatSyncCountdown,
		formatSyncedAgo,
		groupModelsByProvider,
		headlinePaceContext,
		headlineScopeOptions,
		groupTrackers,
		isAutoScrapedOpenAiDayArtifact,
		isAutoScrapedValueOnlyLabelArtifact,
		isOpenAiDayPayloadArtifact,
		isValueOnlyLabelPayloadArtifact,
		isValueOnlyMetricLabel,
		isTrackerEnabled,
		loadModels,
		loadPreferences,
		mergePayloadIntoModels,
		migrateStoredModels,
		latestModelUpdate,
		normalizedHistory,
		overallPaceSummary,
		pageFromHash,
		paceDeltaContext,
		paceCurveData,
		projectedDepletionContext,
		renderDashboard,
		renderHeadlinePanel,
		renderPage,
		renderPaceGraphs,
		renderRunwayView,
		renderTrendChart,
		reconcileTabSelections,
		resolveHeadlineScope,
		savePreferences,
		syncCountdownState,
		selectedTabIdsForPreferences,
		setTrackerEnabled,
		sendExtensionRequest,
		stableTabUrl,
		sortTrackersAlphabetically,
		tabSelectionDescriptor,
		tabSelectionProviderKey,
		trackerDisplayLabel,
		runwayOutcome,
		runwayPhysics,
		runwayScene,
		runwayBand,
		runwayBrake,
		runwayApproachSpeed,
		runwayGhostNote,
		runwayHudReadout,
		runwayTiming,
		settleRunwayCards,
		toggleTabSelectionPreference,
		trendChangeContext,
		updateModelField,
		visualStatus
	};
}
