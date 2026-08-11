# Contributing

## Setup

- Node.js 22 or newer.
- `npm install`
- `npm start` runs the dashboard at `http://localhost:5074`.

Before opening a PR:

```powershell
npm run check
npm test
```

`npm test` uses Node's built-in test runner (`node --test`) — there are no external test dependencies.

## Adding a provider

Provider knowledge lives in exactly one place: [`chrome-extension/providers.js`](chrome-extension/providers.js). Every other file that needs to recognise a provider — the scraper's `detectProvider`, the extension's tab-discovery filter, the dashboard's settings-key lookup, and the extension manifest's `host_permissions` — reads from that registry instead of hardcoding its own copy. This used to be five separate, silently drifting lists; if you're adding a provider, please don't reintroduce a sixth one somewhere else.

To add a provider:

1. Add an entry to the `PROVIDERS` array in `chrome-extension/providers.js`: a hostname matcher, a discoverable-route matcher, a settings key, and the origin(s) to request.
2. Run `npm run sync-manifest` to regenerate `chrome-extension/manifest.json`'s `host_permissions` from the registry.
3. Add a realistic (redacted) parser fixture to `test/scraper.test.js`.
4. Add a row to `test/provider-routes.test.js` covering at least one discoverable URL and one URL that should be rejected.

That's the whole surface — one registry entry plus a sync command plus two test additions. But it is not a complete, working provider until all four steps are done: a provider the parser recognises but the manifest doesn't grant access to (or that discovery doesn't offer) will silently fail for users, not error loudly. `npm test` includes a test that fails if the manifest and the registry disagree, so step 2 is enforced; steps 3 and 4 are not, so please don't skip them.

## Reporting a broken provider

The single most common issue on a project like this is "provider changed their page, my gauges are empty." Fixing it needs to see roughly what the page's quota text looks like now.

**Please redact your numbers before pasting anything.** Replace `47% used` with `NN% used`, replace real dates with placeholders, and so on — the shape of the text is what we need, not your actual usage. See the issue template, which asks for this explicitly.

## Code style

The repository is a genuine mix: `app.js`, `styles.css`, `serve.js`, and `index.html` use tabs; `tracker-core.js`, everything under `chrome-extension/`, and `test/` use two spaces. Match whatever the file you're editing already uses — don't reformat a file as part of an unrelated change.
