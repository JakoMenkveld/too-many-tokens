(function attachProviders(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.UsageProviders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProviders() {
  'use strict';

  const PROVIDERS = [
    {
      name: 'Claude',
      key: 'provider:claude:usage',
      origins: ['https://claude.ai/*', 'https://*.claude.ai/*'],
      matchesHost: (h) => h === 'claude.ai' || h.endsWith('.claude.ai'),
      matchesRoute: (h, path, hash) =>
        (h === 'claude.ai' || h.endsWith('.claude.ai')) &&
        (path === '/settings/usage' || hash === '/settings/usage'),
      matchesText: /\b(?:Claude|Anthropic)\b/i
    },
    {
      name: 'OpenAI',
      key: 'provider:openai:codex-usage',
      origins: ['https://chatgpt.com/*'],
      matchesHost: (h) => h === 'chatgpt.com',
      matchesRoute: (h, path) =>
        h === 'chatgpt.com' &&
        /^\/codex\/(?:cloud\/)?settings\/(?:analytics|usage)$/u.test(path),
      matchesText: /\b(?:ChatGPT|OpenAI|GPT-[345])\b/i
    },
    {
      name: 'OpenAI',
      key: 'provider:openai:chatgpt-usage',
      origins: ['https://chatgpt.com/*', 'https://*.openai.com/*'],
      matchesHost: (h) => h === 'chatgpt.com' || h.endsWith('.openai.com'),
      matchesRoute: (h, path) =>
        (h === 'chatgpt.com' || h.endsWith('.openai.com')) &&
        /^\/(?:settings\/usage|usage)$/u.test(path),
      matchesText: /\b(?:ChatGPT|OpenAI|GPT-[345])\b/i
    }
  ];

  function allOrigins() {
    return [...new Set(PROVIDERS.flatMap((p) => p.origins))].sort();
  }

  return { PROVIDERS, allOrigins };
});
