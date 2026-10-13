# Verification boundaries

R5 preparation checks are recorded separately from historical evidence. The original `test-results/.last-run.json` says `status: passed` with an empty failed-test list; it contains no test count, code revision or proof of a current real-site test, so it is not promoted to a full release validation.

R5 runs a bounded in-memory replay of the **existing exact-search unit test file** using the installed TypeScript transpiler and Node assertions. This checks the parser and exact matcher over the existing synthetic fixtures without executing ChatGPT requests. It is not a full Vitest, browser, IndexedDB, scheduler or live-site run. R5 also checks TypeScript syntax and JavaScript syntax without emitting compiled output.

The existing exact-search replay passed **11 tests**; syntax checks passed for **37 TypeScript files**. These counts describe the selected R5 checks only.

Full dependency install, build, browser E2E and live ChatGPT verification: **NOT_RUN** in R5. Mock fixtures do not prove compatibility with the provider's current production DOM or API.
