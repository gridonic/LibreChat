# Gridonic MCP recovery backport

The image branch starts at the deployed v0.8.8 source, `7b24072904c180288d1b5343290f4a86cb5fa8ed`.
It retains LC-005 and LC-006 and adapts the reviewed changes from LibreChat PRs
17300 and 17302 and agents PR 632 to that release.

The frontend still owns streaming state in `useStepHandler`, so the OAuth suffix,
flow identity, active response routing, closure cleanup and question-pause ordering
are backported there rather than importing the newer chat workspace.

`agents-4.0.1-mcp-recovery.json` patches exactly SDK 4.0.1. It adds only the two
MCP failure classifications, their fixed messages, and the callback plumbing
through Run, graphs, nested and detached executors. It does not upgrade the SDK.
Source, CJS, ESM and public declarations are patched together. The installer
checks version and every input/output hash before writing and is idempotent.
Normal `npm ci` and both Docker dependency stages apply it through postinstall.
An SDK upgrade must remove or deliberately regenerate this patch; never bypass
the guard. Remove the patch when a released SDK provides equivalent behavior.

Run `node --test scripts/test-agents-patch.cjs` after a clean install. Browser
acceptance against the built image uses synthetic credentials, a disposable
MongoDB and test fixtures, with no production mounts or secrets:

```sh
LIBRECHAT_TEST_IMAGE=gridonic/librechat:<candidate-tag> \
E2E_BASE_URL=http://127.0.0.1:3101 \
npx playwright test --config=e2e/playwright.config.image.ts --project=chromium
```

This tests the image's actual frontend and backend as UID/GID 1001:1001.
It does not establish real-provider OAuth expiry, Vela grant compatibility,
or survival of paused executions across API restarts.
