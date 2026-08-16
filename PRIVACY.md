# Privacy

LongChat Perf is local-only.

The extension:

- makes no network requests
- has no analytics
- has no backend
- does not transmit chat content
- stores only extension settings via `chrome.storage.sync`

The content script reads only the DOM structure and geometry of the
conversation (message elements, message ids, bounding rects, scroll position,
and DOM mutations). It does not read message text content, and no content ever
leaves your browser.
