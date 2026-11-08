# World document browser regression

From the repository root, run `node apps/web/test/world-document/run.mjs` after installing workspace dependencies. It starts Vite on localhost port 5189, runs this suite and the SDK world-document message-portal, and document-theme fixtures in headless Chrome, prints each result, and exits nonzero on failure. On systems without Chrome at the macOS default path, set `CHROME_PATH` to a Chrome/Chromium executable. The runner uses a temporary browser profile and removes it after the run.

These checks exercise mixed Markdown/HTML, explicit nested Markdown, full-document handling, CSS sanitization, dangerous URLs and active content, and message slot filtering in a real browser. They do not replace visual, keyboard, iframe resizing, or cross-device interaction testing.
