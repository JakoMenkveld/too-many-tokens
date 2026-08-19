'use strict';

// Tracing for the extension. There is deliberately no on/off switch and no
// stored log: routine lines go to console.debug, which Chrome hides unless the
// DevTools log level includes Verbose, so the trace costs nothing until someone
// opens the console looking for it. Failures use warn/error and show at the
// default level.
//
// Nothing here records page text, quota values, or anything scraped -- only what
// happened, where, and why it stopped. Read the console, not this file, to find
// out what the worker is busy with.
(function initTrackerLog(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TrackerLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTrackerLog(root) {
  const PREFIX_STYLE = 'color:#8b7fff;font-weight:600';

  // Silent outside a real extension, so `node --test` output stays readable.
  function isEnabled() {
    return Boolean(root.chrome?.runtime?.id);
  }

  function createLogger(scope) {
    const prefix = `%c[TMT ${scope}]`;

    function write(method, message, detail) {
      if (!isEnabled()) return;
      const console = root.console;
      if (typeof console?.[method] !== 'function') return;
      if (detail === undefined) console[method](prefix, PREFIX_STYLE, message);
      else console[method](prefix, PREFIX_STYLE, message, detail);
    }

    return Object.freeze({
      debug: (message, detail) => write('debug', message, detail),
      warn: (message, detail) => write('warn', message, detail),
      error: (message, detail) => write('error', message, detail)
    });
  }

  return Object.freeze({ createLogger });
});
