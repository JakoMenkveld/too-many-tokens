# Security Policy

This is a browser extension with permission to read pages on `claude.ai` and OpenAI's usage domains, plus a local HTTP server serving a static dashboard that can also be self-hosted. If you find a way for a malicious page to abuse the extension bridge, exfiltrate scanned data, or otherwise break the boundaries described in the README's [Permissions and safety boundaries](README.md#permissions-and-safety-boundaries) section, please report it privately rather than as a public issue.

## Reporting

**Preferred: GitHub private vulnerability reporting.** Use the "Report a vulnerability" button under this repository's Security tab. This keeps the report private to the maintainer until a fix is out, with no separate contact channel to maintain.

## Scope

In scope:

- The extension's content-script/background bridge (`chrome-extension/content-script.js`, `chrome-extension/background.js`)
- The local server's request handling and asset allow-list (`serve.js`)
- The deployment package's asset allow-list and security headers (`scripts/build-static.js`)
- Anything that would let a page other than the tracker itself read or influence scanned data

Out of scope:

- Provider usage pages changing their layout and breaking the scraper's heuristics — that's a regular bug, please file it as a normal issue with a redacted fixture (see [CONTRIBUTING.md](CONTRIBUTING.md))
- Issues that require an already-compromised browser or OS

## What to expect

This is a personal open-source project maintained in spare time. There's no SLA, but security reports get priority over feature work.
