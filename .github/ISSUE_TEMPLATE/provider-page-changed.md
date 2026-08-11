---
name: Provider page changed / scan is broken
about: A usage page's layout, wording, or numbers no longer scan correctly
title: "[provider] usage page not scanning correctly"
labels: scraper
---

**Provider and page**
e.g. Claude, `claude.ai/settings/usage`

**What's wrong**
e.g. no cards appear, wrong percentage, missing a metric, wrong reset time

**Redacted page text — REQUIRED**

Copy the relevant portion of the quota text from the page, with your real numbers replaced by placeholders. For example, turn:

```
Current session
Resets in 3 hr 15 min
47% used
```

into:

```
Current session
Resets in N hr N min
NN% used
```

Do **not** paste a full page dump or your actual usage numbers — this becomes a public test fixture, and the shape of the text is what's needed, not your real data.

```
<paste redacted text here>
```

**Anything else notable about the layout** (e.g. this only happens on a specific plan tier, this is a newly added block, etc.)
