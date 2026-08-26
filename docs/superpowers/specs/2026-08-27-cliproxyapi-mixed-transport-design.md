# Mixed-Pool Transport Compatibility Design

Date: 2026-08-27
Status: Approved for planning

## Context

The `cliproxyapi` provider can target one CLIProxyAPI instance whose scheduler selects credentials randomly or by round robin for the same model name. The pool may contain:

- official Codex credentials with upstream WebSocket enabled;
- official Codex credentials using HTTP fallback;
- OpenAI-compatible relay credentials that only support HTTP streaming;
- OpenAI-compatible relay credentials that also expose WebSocket support.

The Pi extension cannot know which credential CLIProxyAPI will select before a request starts. A protocol decision cached by model or base URL therefore cannot represent the selected credential.

The temporary local setting `protocol: "openai-responses"` avoids downstream WebSocket failures, but forces every request through HTTP SSE. That unnecessarily removes WebSocket transport for official Codex credentials and capable relays in the same pool.

CLIProxyAPI 7.2.140 already provides the required per-credential transport boundary. Pi may connect to CLIProxyAPI over its Responses WebSocket endpoint, while CLIProxyAPI selects the credential and then chooses the upstream transport:

- Codex auth with WebSocket enabled uses the upstream Codex WebSocket executor.
- Codex auth without WebSocket enabled uses the Codex HTTP executor.
- OpenAI-compatible auth uses the HTTP streaming executor.

The extension should preserve that boundary rather than trying to predict the selected credential.

## Goals

- Keep Pi-to-CLIProxyAPI WebSocket as the preferred transport for a local/default CLIProxyAPI endpoint.
- Preserve upstream WebSocket for selected credentials that support it.
- Allow CLIProxyAPI to translate the same downstream WebSocket request to upstream HTTP for credentials that do not support WebSocket.
- Send the relay-required Codex capability header in both supported protocol modes.
- Preserve Pi's transport-level WebSocket-to-SSE fallback when the downstream CLIProxyAPI WebSocket cannot be established.
- Keep explicit `openai-responses` support for direct relay endpoints and operator overrides.
- Surface application errors without replaying them across protocols.

## Non-Goals

- Predicting which credential CLIProxyAPI will select.
- Caching protocol capability by model, because one model maps to mixed credentials.
- Changing CLIProxyAPI source code, credential scheduling, cooldown classification, or upstream routing.
- Retrying a failed application request through another protocol or credential.
- Detecting upstream relay WebSocket support from Pi.

## Protocol Selection

The extension remains dual protocol.

### `openai-codex`

This is the preferred/default mode for a root or `/backend-api` CLIProxyAPI URL. Pi uses CLIProxyAPI's Codex/Responses WebSocket transport first. Pi's existing transport fallback may use HTTP SSE against the same Codex endpoint if the downstream WebSocket fails before response events begin.

CLIProxyAPI remains responsible for selecting the credential and choosing its upstream WebSocket or HTTP executor.

### `openai-responses`

This remains an explicit mode and the auto-detected mode for URLs ending in `/v1`. It uses the standard `/v1/responses` HTTP SSE API. It is intended for direct third-party relay endpoints or environments where the operator deliberately disables the Codex transport.

### Local Configuration

The local CLIProxyAPI configuration should no longer force `openai-responses`. It should either omit `protocol` and rely on root-URL auto-detection or explicitly use `openai-codex`.

The configuration resolution order remains unchanged:

1. `CLIPROXYAPI_PROTOCOL`
2. `cliproxyapi.json` `protocol`
3. base URL auto-detection

## Compatibility Header

The registered provider must send:

```http
X-Codex-Beta-Features: remote_compaction_v2
```

in both `openai-codex` and `openai-responses` modes.

CLIProxyAPI propagates this header into Codex upstream requests, and OpenAI-compatible executor requests can also receive downstream custom headers. The header fixes the observed relay rejection while allowing CLIProxyAPI to keep its per-credential transport decision.

The extension must not inject `X-OpenAI-Internal-Codex-Responses-Lite`; testing showed that header did not resolve the relay rejection.

## Request Flow

For the default local CLIProxyAPI setup:

```text
Pi
  -> CLIProxyAPI Responses WebSocket
     -> CLIProxyAPI selects one credential
        -> Codex credential with websockets=true: upstream WebSocket
        -> Codex credential without WebSocket: upstream HTTP streaming
        -> OpenAI-compatible credential: upstream HTTP streaming
```

If Pi cannot establish the downstream WebSocket before any response event, Pi may use its native Codex SSE fallback. This is a transport fallback to the same CLIProxyAPI protocol, not a replay from `openai-codex` to `/v1/responses`.

## Error Handling

Transport failures and application failures must remain distinct.

- A downstream WebSocket connection failure before response events may trigger Pi's native Codex SSE fallback.
- A WebSocket failure after response events have started must be surfaced and must not replay the request.
- Structured upstream errors delivered through CLIProxyAPI must retain their message.
- HTTP 401, 402, 403, 409, 429, and 5xx application responses must not trigger cross-protocol replay in the extension.
- The extension must not infer that every 403 or 503 means insufficient balance.
- CLIProxyAPI's existing 402/403 cooldown classification is a separate server concern and remains unchanged.

This avoids duplicate generations, continuation corruption, accidental credential rotation, and repeated cooldown activation.

## Runtime Isolation

Official Pi and OMP may load different physical `pi-ai` runtimes. Host runtime reuse must remain restricted to the OMP entrypoint. Official Pi must continue loading the physical Pi module through the patched stream loader to avoid runtime identity conflicts.

This requirement is independent of transport selection but is retained because it protects the same startup and streaming path.

## Test Strategy

Automated tests must cover:

- provider registration includes `X-Codex-Beta-Features` in `openai-codex` mode;
- provider registration includes the same header in `openai-responses` mode;
- root CLIProxyAPI URLs default to `openai-codex`;
- `/v1` URLs still select `openai-responses`;
- the patched Codex stream preserves Pi's native WebSocket-to-SSE fallback;
- no model- or base-URL-level sticky downgrade is introduced;
- official Pi does not reuse the OMP host runtime.

Integration verification must include:

- a real Pi request using the installed local extension with `openai-codex`;
- confirmation in CLIProxyAPI logs that the downstream request used the Responses WebSocket endpoint;
- repeated requests until logs demonstrate both an upstream WebSocket-capable credential and an HTTP/OpenAI-compatible credential, when the local pool makes both available;
- successful streamed completion for both selected credential types;
- no new 403, 503, or `payment_required` event caused by the compatibility header change;
- a complete `npm run check` pass.

Credentials, authorization headers, session content, and complete request payloads must be redacted from reported evidence.

## Rollout

1. Add regression tests for header registration in both modes.
2. Make compatibility header registration protocol-independent.
3. Restore the local configuration to `openai-codex` or remove the explicit protocol field.
4. Run focused tests and the full project check.
5. Run real Pi requests through the installed local extension and inspect redacted CLIProxyAPI transport logs.
6. Keep `openai-responses` available as an explicit fallback for direct relay installations.

## Success Criteria

- Official Codex credentials selected from the mixed pool retain upstream WebSocket operation.
- Non-WebSocket relay credentials selected from the same model pool complete through CLIProxyAPI's HTTP executor without forcing the entire Pi provider to SSE.
- The previously observed relay request succeeds with the Codex capability header.
- Pi no longer reports a generic WebSocket failure for the reproduced compatibility-header case.
- No request is automatically replayed across `openai-codex` and `openai-responses` after an application error.
