'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDiscoverableProviderTab } = require('../chrome-extension/background.js');
const { tabSelectionProviderKey } = require('../app.js');
const providers = require('../chrome-extension/providers.js');

// Add every URL you can think of. Records ACTUAL current behaviour, not desired behaviour.
const CASES = [
  { url: 'https://claude.ai/settings/usage', discoverable: true, key: 'provider:claude:usage' },
  { url: 'https://claude.ai/#/settings/usage', discoverable: true, key: 'provider:claude:usage' },
  { url: 'https://claude.ai/chats', discoverable: false, key: '' },
  { url: 'https://chatgpt.com/codex/settings/usage', discoverable: true, key: 'provider:openai:codex-usage' },
  { url: 'https://chatgpt.com/codex/cloud/settings/analytics', discoverable: true, key: 'provider:openai:codex-usage' },
  { url: 'https://chatgpt.com/settings/usage', discoverable: true, key: 'provider:openai:chatgpt-usage' },
  { url: 'https://platform.openai.com/usage', discoverable: true, key: 'provider:openai:chatgpt-usage' },
  { url: 'https://platform.openai.com/usage/activity', discoverable: false, key: '' }, // was a mismatch (discoverable:true, key:'') before the registry made both layers use matchesRoute
  { url: 'https://api.openai.com/settings/usage', discoverable: true, key: 'provider:openai:chatgpt-usage' }, // was a mismatch (discoverable:false) before the registry made both layers use matchesRoute
  { url: 'https://example.com/usage', discoverable: false, key: '' }
];

test('provider route recognition is consistent between discovery and settings persistence', () => {
  for (const { url, discoverable, key } of CASES) {
    const tab = { id: 1, url, status: 'complete' };
    assert.equal(isDiscoverableProviderTab(tab), discoverable, `isDiscoverableProviderTab(${url})`);
    assert.equal(tabSelectionProviderKey(url), key, `tabSelectionProviderKey(${url})`);
  }
});

test('manifest host_permissions match the provider registry', () => {
  const manifest = require('../chrome-extension/manifest.json');
  assert.deepEqual([...manifest.host_permissions].sort(), providers.allOrigins());
});
