# Chrome Extension for Too Many Tokens

This Manifest V3 extension connects the local dashboard at `http://localhost:5074` to provider usage pages already open in Chrome. It discovers tabs, scans only the tabs selected in the tracker, and returns one normalized payload for every visible quota block.

## Install

1. Start the tracker from the repository root with `npm start`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the `chrome-extension` directory.
5. Refresh `http://localhost:5074` after loading or reloading the extension.

## Use from the tracker

1. Open the provider usage pages you want to monitor.
2. Open `http://localhost:5074`.
3. Select the dashboard's circular-arrows sync icon. On first use, every supported tab is selected and scanned automatically.
4. Open the dashboard's **Provider sync** page when you want to change the selected windows.
5. Optionally start auto-sync and choose its refresh interval; the dashboard asks the extension to refresh and rescan the current selection on that schedule.

Before scraping, the extension reloads each selected provider tab, waits for the page load and dynamic text to settle, then reads it. The tab does not need to be visible or focused, and one provider tab timing out does not prevent the others from returning results.

The **Setup** page controls each reading independently after extraction. For example, one Claude window can keep its session and weekly limits visible while its spend reading is hidden; later scans preserve that choice.

The extension toolbar button is a tracker launcher. It focuses an existing tracker tab when one is open and otherwise opens a new tracker tab. It does not copy scraped data to the clipboard.

## How communication works

1. `app.js` creates a request ID and posts a list-tabs or scan-selected-tabs request.
2. `content-script.js` accepts the request only from the tracker window and a fixed port-`5074` tracker origin (`localhost` or `127.0.0.1`).
3. The content script retains the request ID for correlation and forwards the requested operation to `background.js`.
4. The service worker lists scannable tabs or reloads each selected tab, revalidates its URL, waits for fresh content, and runs the scraper.
5. The response returns through the same bridge with the matching request ID.

The bridge reports validation, runtime, tab, and scrape errors explicitly. A failure is not converted into a successful response with an unexplained empty payload.

## Scraped values

The generic scraper recognizes common provider presentations, including:

- a percentage already **used**;
- a percentage **remaining**, converted to the equivalent used percentage;
- token ratios such as used tokens over a cycle limit;
- abbreviated token values using `K`, `M`, or `B` suffixes;
- reset day, time, or schedule text when exposed by the page;
- multiple labeled blocks on one page, including Claude's current session, all-model weekly limit, and named-model weekly limits;
- inferred five-hour session, 24-hour daily, and 168-hour weekly cycles;
- provider/model labels, a stable metric key, and a source URL used to identify later updates.

The tracker uses reset information to derive the current hour within a cycle when the schedule is sufficiently specific. A repeated scan matches the stable source URL **and metric key**, so several limits read from the same page remain separate and update correctly.

## Permissions and boundaries

- `scripting` is required to execute the scraper in tabs the user selects. Tab discovery uses `chrome.tabs.query`, which returns full `url`/`title` for tabs already covered by a host permission below, without needing the broader `tabs` permission.
- Host permissions are limited to the specific providers the scraper supports (`claude.ai`, `chatgpt.com`, `*.openai.com`), generated from `chrome-extension/providers.js` via `npm run sync-manifest` — not a wildcard over arbitrary origins. Data is processed locally.
- The content bridge is injected only for the tracker origin and validates both message source and origin.
- Internal browser pages and the tracker tab are not offered as provider scan targets.
- The extension does not persist scan results; tracker entries remain in the page's browser `localStorage` and no remote backend is used.

## Test changes

From the repository root, run:

```powershell
npm test
```

After changing extension files, reload the unpacked extension and refresh the tracker page.

## Troubleshooting

- **Extension unavailable:** reload the extension, then refresh the tracker so the content script is reinjected.
- **No tabs listed:** open the provider page in a normal web tab, then refresh the available-tab list.
- **One tab fails:** read the explicit error shown by the tracker; other selected-tab results can still be returned.
- **A provider tab keeps loading:** the refresh is bounded by a timeout, so it is reported as that tab's error while other selected tabs continue.
- **Values are incomplete:** provider markup and wording vary. Edit the tracker entry manually and update the scraper heuristic when the provider page changes.
