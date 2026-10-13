# ChatGPT Deep Search

A Microsoft Edge Manifest V3 extension for local exact search over up to 200 accessible ChatGPT conversations. This is an independent extension, not an OpenAI product.

## Problem and approach

Keep a bounded local index of conversation titles and user/assistant messages, then search original text rather than relying on semantic similarity. A same-origin ChatGPT adapter, resumable work queue, IndexedDB checkpoints, worker lease and backoff isolate acquisition from the exact-search engine.

Features include continuous Chinese substring matching, AND, `|` OR, exclusions, quoted phrases, `title:`, `user:`, `assistant:`, `after:` and `before:` filters. Results provide text highlights and navigation to the original conversation. The content script adds a sidebar entry and a search panel; the background service worker schedules indexing.

## Quick start

Requirements: a recent Node.js release, npm, Microsoft Edge, and your own signed-in ChatGPT session.

```sh
npm ci
npm run build
```

In `edge://extensions`, enable Developer mode, select **Load unpacked**, and choose `dist/`. Refresh `https://chatgpt.com/`, open the sidebar search entry, or use `Alt + Shift + F`. The source manifest is version `0.0.0`; no store release is claimed. Set `EXTENSION_VERSION` in your own build process if packaging a release.

To stop indexing and remove the extension, remove it from Edge's Extensions page. The extension does not provide an export of your conversation data.

## Privacy and permissions

The declared permissions are `storage`, `alarms` and access to `https://chatgpt.com/*`. No cookies permission is requested. Conversation contents are stored in the extension's local IndexedDB; no third-party search or analytics endpoint is configured. Session authentication is handled at runtime by the signed-in page, not by bundled credentials. Review the code before allowing access to private conversations. Removing the extension removes its local extension storage; this is not a promise about the provider's own records.

## Development and tests

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

The end-to-end test configuration builds the extension and serves a **local mock** ChatGPT page. Fixtures are authored synthetic conversation records, not exported personal chat history. See [verification](docs/VERIFICATION.md) for preparation checks and historical evidence. These commands are for a future developer; preparation did not install packages, rebuild the extension or contact a signed-in account.

## Structure

- `src/background`: scheduler, lease, retry and diagnostics.
- `src/chatgpt`: same-origin list/detail adapter and normalization.
- `src/content`: sidebar, panel, current-chat observation and navigation.
- `src/data`: IndexedDB persistence, queues and retention.
- `src/search`: query parser and exact matcher.
- `tests`: unit tests and mock-only browser tests.

## Limitations

ChatGPT's internal endpoints and DOM are not a stable public API. Provider changes, unavailable conversations, network failures and account restrictions can prevent indexing or navigation. The 200-conversation cap is deliberate. The preparation checks do not establish current real-site compatibility, Store approval, complete browser coverage or permission to automate a service beyond its applicable terms.

## License

Original project software and associated documentation are available under the [MIT License](LICENSE). Development dependencies and external services retain their own terms; see [third-party scope](THIRD_PARTY.md).
