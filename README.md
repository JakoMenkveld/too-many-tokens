# Too Many Tokens

Know on Tuesday whether you're going to blow through your Claude or ChatGPT weekly limit by Thursday.

![Too Many Tokens overview](assets/screenshot.png)

## What this is

A browser-only dashboard for tracking LLM usage against session, daily, and weekly limits. A Chrome extension reads the usage pages already open in your signed-in browser, discovers every quota block on each page, and configures the corresponding dashboard entries automatically.

- **Local by default.** The tracker runs at `http://localhost:5074`. Configuration and usage data live in that origin's browser `localStorage`.
- **No application backend.** There is no account and no telemetry. Nothing you scan leaves your browser.
- **No clipboard access.** Scanned values travel only through a request-correlated bridge between the page and the extension.

The dashboard is a set of static files, so you can also [host your own copy](#deploy-your-own-copy) if you want the same tracker on more than one machine.

Use the same tracker address every time you reopen the dashboard. Browsers isolate `localStorage` by origin, so `localhost`, `127.0.0.1`, and any host you deploy to each have separate tracker data.

## Requirements

- Node.js 22 or newer to run the dashboard locally or build it for deployment.
- A Chromium-based browser if you want automatic provider-tab scanning.

## Run

From the repository root:

```powershell
npm start
```

Then open:

```text
http://localhost:5074
```

The server listens only on `127.0.0.1`. It exposes five browser assets: `index.html`, `styles.css`, `app.js`, `tracker-core.js`, and `providers.js`. Other repository files are not served.

## Install the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository's `chrome-extension` directory.
5. Start the tracker and refresh `http://localhost:5074` so its content bridge is present.

See [chrome-extension/README.md](chrome-extension/README.md) for permissions, communication, and troubleshooting details.

## Use

1. Open one or more provider usage pages in Chrome (currently Claude and OpenAI/ChatGPT — see [Supported providers](#supported-providers)).
2. On the dashboard, select the circular-arrows sync icon. The first sync selects every supported open tab, reloads the selected provider pages, waits for their current content, and scans them.
3. Review the generated pace rows on Overview. Each row's label, used percentage, ideal-by-now percentage, and reset countdown are filled from the provider page.
4. Open **Setup** to select provider tabs, choose an auto-sync refresh interval, and show or hide individual readings. These choices survive hard refreshes and page closes; auto-sync resumes when the dashboard opens again.
5. Use **Manual Overrides** only when a provider changes its wording or you want a custom tracker.

For the Claude layout shown in the project requirements, a single sync creates three independent trackers: the five-hour current session, the all-model weekly limit, and the named-model weekly limit. Text such as `82% remaining` is stored and displayed as `18% used`.

OpenAI page controls such as **Day** are ignored unless they are part of an actual named quota. Older auto-scraped `OpenAI · Day` artifacts created by the previous parser are removed narrowly on load; manual `Day` trackers and genuine daily limits are preserved.

Clicking the extension toolbar icon opens the tracker, or focuses its existing tab. It does not scrape into, read from, or write to the clipboard.

## Supported providers

The scraper's provider knowledge lives in one file, [`chrome-extension/providers.js`](chrome-extension/providers.js), which is also what the extension's `host_permissions` are generated from. Right now that's Claude (`claude.ai`) and OpenAI (`chatgpt.com`, `platform.openai.com`, and other `*.openai.com` usage routes).

The extension only asks Chrome for access to those specific sites — not to every page you visit. See [Permissions](#permissions-and-safety-boundaries) below.

## Features

- Dark responsive dashboard with remembered bar, graph, and animated 3D runway views of actual-versus-ideal quota pace and projected time to depletion, grouped by provider. The runway view brakes safely when the quota survives until reset and stages a stylized overrun when depletion is projected first.
- Two focused pages: Overview for actual-versus-ideal pace, and Setup for provider connections, tracker visibility, and manual overrides.
- Multi-metric extraction: one Claude page can produce separate **Current session**, **All models**, and model-specific weekly limits.
- Percent-based and token-based run-rate calculations.
- Cycle pacing, remaining budget, token projection, and cost projection.
- Chrome tab discovery, explicit tab selection, one-off scans, and configurable auto-sync. Loading provider tabs remain visible while discovery is in progress. Each scan reloads the selected provider pages before reading them, including background tabs.
- Correlated extension requests using request IDs and explicit error responses.
- Scraper normalization for used or remaining percentages, token ratios, numeric suffixes such as `K`, `M`, and `B`, and reset schedules.
- Stable update identity based on the source URL plus quota metric, so several limits from one page remain independent and repeated scans update the right entry.
- Automatic session/daily/weekly cycle setup and cycle-hour derivation from parsed reset information.
- Bounded local usage history with five-minute sample coalescing for actual-pace graphs.
- Durable local preferences for tracker visibility, manual edits, Overview display mode, selected provider tabs, and auto-sync. Known Claude and OpenAI usage routes survive provider redirects without selecting unrelated tabs; auto-sync resumes after a hard refresh or page reopen and waits for temporarily closed provider tabs to return.

## Permissions and safety boundaries

- The page-to-extension bridge accepts messages only from the tracker origins listed in [`chrome-extension/tracker-origins.js`](chrome-extension/tracker-origins.js) — by default the fixed port-`5074` loopback origins (`localhost` and `127.0.0.1`). Origins are matched exactly, so a lookalike host cannot reach the bridge.
- Requests and responses carry matching request IDs, allowing overlapping operations to be correlated safely.
- Invalid requests, unavailable extension contexts, tab failures, and scrape failures return explicit errors rather than silently looking like empty results.
- Host permissions are limited to the specific providers the scraper supports, not every site you visit — see [Supported providers](#supported-providers). One tab's access being withheld does not stop the others from being scanned.
- The local Node server binds to loopback and uses a fixed asset allow-list; it is not a general-purpose static file server. The deployment package is generated from that same allow-list.

## Deploy your own copy

The dashboard is static files with no backend, so it can be hosted anywhere. Build the deployment package with:

```powershell
npm run build
```

The `dist` directory contains only the five public browser assets plus a `staticwebapp.config.json` for Azure Static Web Apps. Both the asset list and the security headers are read directly from `serve.js`, so a deployed copy serves exactly what the local server does, with the same no-store, content-security-policy, permissions-policy, referrer-policy, MIME-sniffing, and frame-denial headers. On a host other than Azure, apply those headers using whatever mechanism it provides.

To let the extension talk to your deployed origin, add it to `TRACKERS` in [`chrome-extension/tracker-origins.js`](chrome-extension/tracker-origins.js), then regenerate the manifest:

```powershell
npm run sync-manifest
```

Serve it over HTTPS. The bridge trusts every listed origin, so anything you add there can drive the extension on your machine.

## Test

Run the automated regression suite from the repository root:

```powershell
npm test
npm run check
```

## Scraping limitations

Provider usage pages are not standardized and can change without notice. The scraper uses text and metadata heuristics, so a scan can occasionally require a correction. Manual setup remains available as a collapsed fallback; it is not required for recognized session, daily, or weekly layouts.

Scraping a provider's usage page may sit awkwardly with that provider's terms of service. This tool only reads pages you are already signed into, locally, and sends nothing anywhere — but whether that's fine for your account is a call you should make yourself.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a provider, run the tests, and what a good bug report looks like. Security issues go to [SECURITY.md](SECURITY.md) instead of a public issue.

## License

[MIT](LICENSE)
