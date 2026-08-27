# Upstream Transport Compatibility PR Design

Date: 2026-08-27
Status: Approved for written-spec review
Submission policy: Local planning artifact; exclude from the upstream pull request

## Purpose

Prepare the first remaining core upstream pull request for
`router-for-me/pi-cliproxyapi-provider`. The pull request restores Pi's native
transport behavior and preserves WebSocket use in mixed CLIProxyAPI credential
pools without adding dual-protocol routing or OMP runtime loading changes.

## Context

The upstream provider patches Pi's `openai-codex-responses` implementation and
currently rewrites its transport logic to prevent WebSocket-to-SSE fallback.
That behavior overrides Pi's global `transport` setting and makes a downstream
WebSocket failure surface as a generic WebSocket error even when Pi could have
used the Codex SSE transport before response streaming began.

A CLIProxyAPI instance may expose one model name backed by a randomly or
round-robin selected credential pool. The selected credential may use upstream
Codex WebSocket, Codex HTTP, or an OpenAI-compatible HTTP executor. The Pi
provider cannot know which credential CLIProxyAPI will select and must not cache
a transport decision by model or base URL.

## Selected Approach

Use Pi's native transport implementation without an extension-owned adaptive
router.

- Remove only the source rewrite that forces WebSocket-only behavior.
- Preserve the provider-specific account-ID, API identifier, and Fast service
  tier patches.
- Register `X-Codex-Beta-Features: remote_compaction_v2` for provider requests.
- Let Pi interpret `auto`, `sse`, `websocket`, and `websocket-cached`.
- Let CLIProxyAPI select the upstream credential and its executor independently.
- Do not replay requests across `openai-codex` and `/v1/responses`.

This is preferred over model-level capability caching because a model can map to
different credential types on consecutive requests. It is preferred over
cross-protocol replay because replay can duplicate generations and misclassify
application errors as transport failures.

## Transport Boundary

The downstream and upstream transports are independent:

```text
Pi transport setting
  -> Pi connects to CLIProxyAPI through Codex WebSocket or Codex SSE
     -> CLIProxyAPI selects one credential
        -> WebSocket-capable Codex credential: upstream WebSocket
        -> Codex credential without WebSocket: upstream HTTP
        -> OpenAI-compatible credential: upstream HTTP
```

The provider must not infer upstream credential capability from the downstream
connection type.

## Required Behavior

| Pi setting | Required Pi-to-CLIProxyAPI behavior |
| --- | --- |
| `sse` | Use Codex SSE directly. |
| `websocket` | Prefer non-cached WebSocket and retain Pi's pre-stream Codex SSE fallback. |
| `websocket-cached` | Prefer cached WebSocket and retain Pi's pre-stream Codex SSE fallback. |
| `auto` | Defer selection and fallback behavior to the installed Pi runtime. |

The extension must not introduce a provider-specific transport configuration.

## Error Semantics

- A WebSocket setup failure before response events may use Pi's native Codex SSE
  fallback.
- A WebSocket failure after response events start must be surfaced without
  replaying the request.
- HTTP 401, 402, 403, 409, 429, and 5xx responses are application responses and
  must not trigger cross-protocol replay in this extension.
- Structured error messages must remain available to Pi.
- No model-level or base-URL-level sticky downgrade may be introduced.

## Code Scope

The upstream pull request may modify only:

- `extensions/codex-stream.ts`: remove the WebSocket-only source patch and keep
  the remaining Codex compatibility patches.
- `extensions/index.ts`: add the protocol-independent Codex capability header to
  provider registration.
- `test/fast.test.ts`: prove that the patched source retains Pi's native
  WebSocket-to-SSE fallback and no longer contains the extension retry rewrite.
- `test/pi-compat.test.ts`: prove provider registration contains the capability
  header.
- `README.md`: document Pi transport behavior and the downstream/upstream
  transport boundary.

The upstream pull request must not include:

- `openai-responses` protocol selection or dispatch;
- endpoint auto-detection or `CLIPROXYAPI_PROTOCOL`;
- OMP embedded Bun module resolution or bundling;
- changes to CLIProxyAPI;
- `CHANGELOG.md`, package versions, `.gitignore`, or `docs/superpowers`;
- user configuration or credentials.

## Test Strategy

The change requires a red-green regression cycle:

1. Update the Codex patch test to require Pi's fallback fragments and reject the
   extension's WebSocket retry fragments. Confirm it fails against upstream.
2. Add a provider-registration assertion for the capability header. Confirm it
   fails against upstream.
3. Remove the transport rewrite and add the header.
4. Run the focused transport and provider compatibility tests.
5. Run `npm run check` and `git diff --check`.
6. Inspect the final diff against the latest official `upstream/main`.

Integration verification should use the installed local provider with Pi's
`openai-codex` path and inspect redacted CLIProxyAPI logs. It must not print API
keys, authorization headers, complete request bodies, or session content.

## Pull Request Construction

- Branch from the latest official `upstream/main`, not the current 17-commit
  local branch.
- Reimplement or selectively reconstruct the behavior; do not copy the whole
  final-state directory.
- Use one production/test commit, with documentation included only if the final
  diff remains focused.
- Keep the worktree after opening the pull request for review revisions.
- Mention that dual-protocol and OMP embedded Bun support will follow as separate
  pull requests.

## Sequencing

Development of the dual-protocol and OMP pull requests may proceed in separate
worktrees while this pull request is under review. They should be opened in
stages because all three touch `extensions/codex-stream.ts`. Each later branch
must be reconstructed or rebased against the then-current official main before
submission.

## Success Criteria

- The provider no longer overrides Pi's transport preference.
- Pi's native pre-stream WebSocket-to-Codex-SSE fallback remains present.
- Mixed credential pools do not cause a model-wide SSE downgrade.
- Provider registration sends `X-Codex-Beta-Features: remote_compaction_v2`.
- Application errors are not replayed across protocols.
- The upstream pull request contains only the five scoped project files and one
  independently reviewable behavior change.
