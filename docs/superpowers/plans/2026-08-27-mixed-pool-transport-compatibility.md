# Mixed-Pool Transport Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve WebSocket for official Codex credentials and capable relays in a mixed CLIProxyAPI pool while retaining HTTP execution for credentials that do not support upstream WebSocket.

**Architecture:** Pi will prefer the existing `openai-codex` downstream WebSocket connection to CLIProxyAPI. The provider will always send the relay-required Codex capability header, and CLIProxyAPI will keep responsibility for selecting a credential and choosing that credential's upstream WebSocket or HTTP executor. The extension will not cache transport capability by model and will not replay application failures across protocols.

**Tech Stack:** TypeScript 6, Pi extension API, `@earendil-works/pi-ai` 0.84.3, Vitest 4, Biome 2, CLIProxyAPI 7.2.140 runtime logs.

---

## File Structure

- Modify `test/pi-compat.test.ts`: lock down the compatibility header in the default `openai-codex` registration path; the existing configured test continues covering `openai-responses`.
- Modify `extensions/index.ts`: make `X-Codex-Beta-Features` registration independent of protocol selection.
- Modify `README.md`: document the downstream/upstream transport boundary for mixed credential pools.
- Modify `CHANGELOG.md`: record the mixed-pool WebSocket preservation fix.
- Modify local user configuration `/Users/wifibaby4u/.pi/agent/cliproxyapi.json`: restore `openai-codex` for this local CLIProxyAPI instance. This file is not committed.

### Task 1: Register the Compatibility Header in Both Protocol Modes

**Files:**
- Modify: `test/pi-compat.test.ts:88-108`
- Modify: `extensions/index.ts:378-389`

- [ ] **Step 1: Write the failing default-protocol assertion**

In the existing test named `registers oauth login and /fast without a dedicated /cliproxyapi command`, extend the expected provider registration to include the compatibility header:

```ts
expect(pi.registerProvider).toHaveBeenCalledWith(
	"cliproxyapi",
	expect.objectContaining({
		name: "CLIProxyAPI",
		oauth: expect.any(Object),
		headers: {
			"X-Codex-Beta-Features": "remote_compaction_v2",
		},
	}),
);
```

This test uses the default root URL and no protocol override, so it exercises `openai-codex`. The existing `loads configured models without registering /cliproxyapi` test continues to assert the same header with `protocol: "openai-responses"`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk npm test -- test/pi-compat.test.ts
```

Expected: one assertion fails because the default `openai-codex` registration does not contain `headers`; the configured `openai-responses` assertion still passes.

- [ ] **Step 3: Make header registration protocol-independent**

In `registerProvider()` in `extensions/index.ts`, replace the conditional spread:

```ts
...(proto === "openai-responses" ? { headers: { "X-Codex-Beta-Features": "remote_compaction_v2" } } : {}),
```

with the direct provider field:

```ts
headers: { "X-Codex-Beta-Features": "remote_compaction_v2" },
```

Keep `proto` for endpoint resolution. Do not add `X-OpenAI-Internal-Codex-Responses-Lite`, protocol retry logic, or model-level capability state.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
rtk npm test -- test/pi-compat.test.ts
```

Expected: all tests in `test/pi-compat.test.ts` pass, including the default `openai-codex` and configured `openai-responses` header assertions.

- [ ] **Step 5: Run transport regression tests**

Run:

```bash
rtk npm test -- test/fast.test.ts test/codex-stream.test.ts test/lib.test.ts
```

Expected: all tests pass. In particular, the Codex transport patch still contains Pi's native WebSocket-to-SSE fallback and does not restore the removed WebSocket-only retry patch.

- [ ] **Step 6: Commit the tested behavior change**

```bash
rtk git add extensions/index.ts test/pi-compat.test.ts
rtk git commit -m "fix(pi): preserve WebSocket for mixed credential pools"
```

### Task 2: Document the Mixed-Pool Transport Boundary

**Files:**
- Modify: `README.md:124-136`
- Modify: `CHANGELOG.md:17-25`

- [ ] **Step 1: Clarify protocol guidance in README**

Replace the introductory protocol text with:

```markdown
The plugin supports two downstream protocols. For a local CLIProxyAPI instance, `openai-codex` keeps Pi's WebSocket transport while CLIProxyAPI selects the credential and independently chooses that credential's upstream WebSocket or HTTP executor. Direct third-party relay endpoints can use `openai-responses` when they only expose the standard `/v1/responses` API.

- **`openai-codex`** (default for `host:port` or `/backend-api`): Uses the CLIProxyAPI Codex backend protocol (`/backend-api/codex/responses`) with WebSocket and Codex SSE fallback. A downstream WebSocket does not require every selected upstream credential to support WebSocket; CLIProxyAPI performs per-credential transport selection.
- **`openai-responses`** (auto-detected for URLs ending in `/v1`): Uses the standard OpenAI Responses API protocol (`/v1/responses`) over HTTP SSE. Use it for direct relay endpoints or an explicit operator override, not as a model-wide capability cache for a mixed CLIProxyAPI pool.
```

Keep the existing endpoint table unchanged.

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]` -> `### Fixed`, add:

```markdown
- **Mixed Credential Pool Transport**: Preserved Pi-to-CLIProxyAPI WebSocket operation for official Codex and WebSocket-capable credentials while allowing CLIProxyAPI to use its HTTP executor for non-WebSocket relay credentials selected under the same model name.
```

- [ ] **Step 3: Run the complete project check**

Run:

```bash
rtk npm run check
```

Expected:

```text
tsc --noEmit: exit 0
biome check .: no errors
vitest: 9 test files pass, at least 130 tests pass
```

- [ ] **Step 4: Commit the documentation**

```bash
rtk git add README.md CHANGELOG.md
rtk git commit -m "docs: clarify mixed-pool transport routing"
```

### Task 3: Restore WebSocket-Preferred Local Configuration and Verify Both Upstream Paths

**Files:**
- Modify outside Git: `/Users/wifibaby4u/.pi/agent/cliproxyapi.json`
- Inspect: `/Users/wifibaby4u/.cli-proxy-api/logs/main.log`

- [ ] **Step 1: Restore the local provider protocol**

Change only the protocol field in `/Users/wifibaby4u/.pi/agent/cliproxyapi.json`:

```diff
-  "protocol": "openai-responses",
+  "protocol": "openai-codex",
```

Do not alter or print the stored API key.

- [ ] **Step 2: Verify the redacted local configuration**

Run:

```bash
rtk jq '{baseUrl, providerId, providerName, protocol, fast}' /Users/wifibaby4u/.pi/agent/cliproxyapi.json
```

Expected:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "providerId": "cliproxyapi",
  "providerName": "CLIProxyAPI",
  "protocol": "openai-codex",
  "fast": false
}
```

- [ ] **Step 3: Run a real installed-extension Pi request**

Run:

```bash
rtk pi --provider cliproxyapi --model gpt-5.6-sol --thinking medium --no-session --no-tools --no-skills --no-prompt-templates --no-context-files -p 'Reply only with OK.'
```

Expected: Pi returns `OK`. Run at most 12 invocations, stopping once the logs show one upstream-WebSocket session and one successful HTTP-executor session. Do not add `--no-extensions` or explicit `-e` flags; this verifies the user's installed local package path.

- [ ] **Step 4: Confirm downstream WebSocket and redact transport logs**

Run:

```bash
rtk tail -n 3000 /Users/wifibaby4u/.cli-proxy-api/logs/main.log | rtk rg 'responses websocket: client connected|responses websocket: upstream execution session closed|codex websockets: upstream connected|POST    "/v1/responses"| 403 | 503 |payment_required' | rtk sed -E 's/(auth=)[^ ]+/\1<REDACTED>/g; s#(url=)[^ ]+#\1<REDACTED>#g'
```

Expected evidence:

- each `openai-codex` Pi request creates a `responses websocket: client connected` session;
- at least one successful session has a matching `codex websockets: upstream connected session=<id>` entry, proving the upstream WebSocket path;
- at least one successful downstream WebSocket session completes without a matching upstream-WebSocket entry, proving CLIProxyAPI used an HTTP executor for that selected credential;
- no new 403, 503, or `payment_required` entry is associated with these verification requests.

If 12 invocations do not hit both credential types, report that limitation rather than changing routing or forcing a credential.

- [ ] **Step 5: Run final verification**

Run:

```bash
rtk npm run check
```

Expected: typecheck, Biome, and all Vitest files pass.

Run:

```bash
rtk git status --short
```

Expected: clean worktree. The user configuration change is outside the repository and does not appear in Git status.
