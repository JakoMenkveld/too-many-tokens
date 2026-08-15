'use strict';

(function initTrackerOrigins(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TrackerOrigins = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTrackerOrigins() {
  // The origins the extension will talk to. The first entry is what the toolbar
  // button opens. Self-hosting? Add your origin here, then run `npm run sync-manifest`
  // to regenerate the manifest's content-script matches.
  const TRACKERS = Object.freeze([
    Object.freeze({
      url: 'http://localhost:5074/',
      matchPattern: 'http://localhost:5074/*'
    }),
    Object.freeze({
      url: 'http://127.0.0.1:5074/',
      matchPattern: 'http://127.0.0.1:5074/*'
    })
  ]);
  const trustedOrigins = new Set(TRACKERS.map(({ url }) => new URL(url).origin));

  function matchesUrl(value) {
    try {
      return trustedOrigins.has(new URL(value).origin);
    } catch (error) {
      return false;
    }
  }

  function allMatchPatterns() {
    return TRACKERS.map(({ matchPattern }) => matchPattern);
  }

  return Object.freeze({
    DEFAULT_TRACKER_URL: TRACKERS[0].url,
    TRACKERS,
    allMatchPatterns,
    matchesUrl
  });
});
