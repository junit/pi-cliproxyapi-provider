/**
 * Load a patched openai-codex-responses implementation for CLIProxyAPI.
 *
 * Differences from stock pi-ai:
 * - extractAccountId never throws; plain API keys are allowed
 * - chatgpt-account-id header is omitted when account id is unavailable
 * - provider id(s) are added to CODEX_TOOL_CALL_PROVIDERS for tool-call id handling
 * - model/message api id uses cliproxyapi-codex-responses
 *
 * The patched module is derived at runtime from the installed
 * @earendil-works/pi-ai openai-codex-responses implementation so we track
 * upstream protocol fixes without vendoring 1200+ lines.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { autoDetectProtocol, type ProtocolMode } from "./lib.ts";

export const CLIPROXYAPI_CODEX_API = "cliproxyapi-codex-responses" as const;

export type CliproxyCodexStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CliproxyCodexStreams = {
	streamSimple: CliproxyCodexStreamSimple;
	stream: CliproxyCodexStreamSimple;
	api: typeof CLIPROXYAPI_CODEX_API;
};

export interface CliproxyCodexStreamOptions {
	shouldUseFast?: (model: Model<Api>) => boolean;
}

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	return {
		...(payload as Record<string, unknown>),
		service_tier: "priority",
	};
}

/** Apply Fast before pi's shared payload hooks so later extensions retain final control. */
export async function applyFastPayloadHook(
	payload: unknown,
	model: Model<Api>,
	onPayload?: PayloadHook,
): Promise<unknown> {
	const fastPayload = withPriorityServiceTier(payload);
	const nextPayload = await onPayload?.(fastPayload, model);
	return nextPayload === undefined ? fastPayload : nextPayload;
}

export function wrapStreamSimpleForFast(
	streamSimple: CliproxyCodexStreamSimple,
	shouldUseFast?: (model: Model<Api>) => boolean,
): CliproxyCodexStreamSimple {
	return (model, context, streamOptions) => {
		if (!shouldUseFast?.(model)) {
			return streamSimple(model, context, streamOptions);
		}
		return streamSimple(model, context, {
			...streamOptions,
			onPayload: (payload, payloadModel) => applyFastPayloadHook(payload, payloadModel, streamOptions?.onPayload),
		});
	};
}

const EXTRACT_ACCOUNT_ID_PATCH = `function extractAccountId(token) {
    // CLIProxyAPI accepts plain API keys as well as ChatGPT JWTs.
    // Never throw: missing account id simply means no chatgpt-account-id header.
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return "";
        const payload = JSON.parse(atob(parts[1]));
        const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
        return typeof accountId === "string" && accountId.trim() ? accountId : "";
    }
    catch {
        return "";
    }
}`;

function rewriteRelativeImports(source: string, originalDir: string): string {
	return source.replace(/from\s+"((?:\.\.?\/)[^"]+)"/g, (_full, relPath: string) => {
		const absolute = pathToFileURL(join(originalDir, relPath)).href;
		return `from ${JSON.stringify(absolute)}`;
	});
}

function patchWebSocketOnlyTransport(source: string): string {
	const sessionIdExpression = String.raw`(?:options\?\.sessionId|cacheSessionId)`;
	const disabledForSession = new RegExp(
		String.raw`const websocketDisabledForSession\s*=\s*transport !== "sse" && isWebSocketSseFallbackActive\(${sessionIdExpression}\);`,
	);
	const retryVariables = /let retriedWebSocketConnectionLimit\s*=\s*false;/;
	const connectionLimitRetry =
		/if \(!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit\) \{\s*retriedWebSocketConnectionLimit = true;\s*continue;\s*\}/;
	const websocketFailureHandling = new RegExp(
		String.raw`if \(aborted \|\| \(isCodexNonTransportError\(error\) && !connectionLimitBeforeStart\)\) \{[\s\S]*?recordWebSocketFailure\((${sessionIdExpression}), error\);[\s\S]*?recordWebSocketSseFallback\(\1\);\s*break;`,
	);
	const fallbackSessionRecord = "websocketSseFallbackSessions.add(sessionId);";
	const fallbackActiveRecord = "stats.websocketFallbackActive = true;";

	for (const fragment of [fallbackSessionRecord, fallbackActiveRecord]) {
		if (!source.includes(fragment)) {
			throw new Error("openai-codex-responses source no longer supports the WebSocket-only transport patch");
		}
	}
	for (const pattern of [disabledForSession, retryVariables, connectionLimitRetry, websocketFailureHandling]) {
		if (!pattern.test(source)) {
			throw new Error("openai-codex-responses source no longer supports the WebSocket-only transport patch");
		}
	}

	return source
		.replace(disabledForSession, "const websocketDisabledForSession = false;")
		.replace(
			retryVariables,
			`let websocketRetries = 0;
                const maxWebSocketRetries = Number.isFinite(options?.maxRetries)
                    ? Math.min(Math.max(0, Math.floor(options.maxRetries)), 5)
                    : 3;`,
		)
		.replace(connectionLimitRetry, "")
		.replace(
			websocketFailureHandling,
			(
				_match,
				activeSessionId: string,
			) => `if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
                            throw error;
                        }
                        if (!websocketStarted && websocketRetries < maxWebSocketRetries) {
                            websocketRetries++;
                            continue;
                        }
                        appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("provider_transport_failure", error, {
                            configuredTransport: transport,
                            fallbackTransport: undefined,
                            eventsEmitted: websocketStarted,
                            phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
                            requestBytes: new TextEncoder().encode(bodyJson).byteLength,
                        }));
                        recordWebSocketFailure(${activeSessionId}, error);
                        throw error;`,
		)
		.replace(fallbackSessionRecord, "")
		.replace(fallbackActiveRecord, "stats.websocketFallbackActive = false;");
}

export function patchCodexSource(source: string, providerIds: string[]): string {
	let src = source;

	if (!/function extractAccountId\(token\) \{/.test(src)) {
		throw new Error("openai-codex-responses source no longer contains extractAccountId(token)");
	}
	src = src.replace(/function extractAccountId\(token\) \{[\s\S]*?\n\}/, EXTRACT_ACCOUNT_ID_PATCH);

	if (!src.includes(`headers.set("chatgpt-account-id", accountId);`)) {
		throw new Error("openai-codex-responses source no longer sets chatgpt-account-id");
	}
	src = src.replace(
		`headers.set("chatgpt-account-id", accountId);`,
		`if (accountId) {\n        headers.set("chatgpt-account-id", accountId);\n    }`,
	);

	const providersMatch = src.match(/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/);
	if (!providersMatch) {
		throw new Error("openai-codex-responses source no longer defines CODEX_TOOL_CALL_PROVIDERS");
	}
	const existing = providersMatch[1];
	const extras = providerIds
		.filter((id) => id.trim())
		.map((id) => JSON.stringify(id.trim()))
		.join(", ");
	src = src.replace(
		/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/,
		`const CODEX_TOOL_CALL_PROVIDERS = new Set([${existing}${extras ? `, ${extras}` : ""}]);`,
	);

	// Keep assistant message api metadata aligned with the registered custom api id.
	src = src.replaceAll(`api: "openai-codex-responses"`, `api: ${JSON.stringify(CLIPROXYAPI_CODEX_API)}`);

	// CLIProxyAPI needs a persistent WebSocket transport. Reconnect before the
	// response starts and surface a failure rather than silently switching to SSE.
	src = patchWebSocketOnlyTransport(src);

	// The generated module lives outside the original source map directory.
	src = src.replace(/^\/\/# sourceMappingURL=.*$/gm, "");

	return src;
}

const PI_AI_PACKAGE_VARIANTS = [
	join("@earendil-works", "pi-ai"),
	join("@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai"),
	join("@earendil-works", "pi", "node_modules", "@earendil-works", "pi-ai"),
	join("@mariozechner", "pi-ai"),
	join("@mariozechner", "pi-coding-agent", "node_modules", "@mariozechner", "pi-ai"),
	join("@mariozechner", "pi", "node_modules", "@mariozechner", "pi-ai"),
];

const PI_AI_FILE_VARIANTS = (fileName: string): string[] => [
	join("dist", "api", fileName),
	join("api", fileName),
	join("dist", fileName),
	fileName,
];

function collectAncestorModuleRoots(path: string): string[] {
	const roots: string[] = [];
	let current = dirname(path);
	for (let i = 0; i < 6; i++) {
		roots.push(current, join(current, "node_modules"));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return roots;
}

function findPiAiModule(searchRoots: Iterable<string>, fileName: string): string | undefined {
	const relativeFiles = PI_AI_FILE_VARIANTS(fileName);
	for (const root of searchRoots) {
		for (const packagePath of PI_AI_PACKAGE_VARIANTS) {
			for (const relativeFile of relativeFiles) {
				const candidate = join(root, packagePath, relativeFile);
				if (existsSync(candidate)) return candidate;
			}
		}
	}
	return undefined;
}

export function resolveCodexModuleFromNodeEntry(
	entryPath: string,
	fileName = "openai-codex-responses.js",
): string | undefined {
	try {
		const real = realpathSync(entryPath);
		const require = createRequire(pathToFileURL(real));
		const searchRoots = [
			...(require.resolve.paths("@earendil-works/pi-ai") ?? []),
			...collectAncestorModuleRoots(real),
		];
		return findPiAiModule(searchRoots, fileName);
	} catch {
		// Ignore invalid or unavailable runtime entrypoints.
	}
	return undefined;
}

export function resolvePhysicalPiAiModule(fileName: string): { path: string; dir: string } {
	// 1. Try native import.meta.resolve subpath & package main
	try {
		const subpath = import.meta.resolve(`@earendil-works/pi-ai/api/${fileName}`);
		const subpathFile = fileURLToPath(subpath);
		if (existsSync(subpathFile)) {
			return { path: subpathFile, dir: dirname(subpathFile) };
		}
	} catch {
		// ignore
	}

	try {
		const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
		const distDir = dirname(main);
		for (const rel of [join("api", fileName), fileName]) {
			const candidate = join(distDir, rel);
			if (existsSync(candidate)) {
				return { path: candidate, dir: dirname(candidate) };
			}
		}
	} catch {
		// ignore
	}

	// 2. Build comprehensive search roots from process entry, cwd, execPath, homedir
	const searchRoots = new Set<string>();

	// Process entrypoint (e.g. pi CLI entry point)
	if (process.argv[1]) {
		try {
			const candidate = resolveCodexModuleFromNodeEntry(process.argv[1], fileName);
			if (candidate && existsSync(candidate)) {
				return { path: candidate, dir: dirname(candidate) };
			}
			const real = realpathSync(process.argv[1]);
			for (const root of collectAncestorModuleRoots(real)) searchRoots.add(root);
		} catch {
			// ignore
		}
	}

	// Node executable path (e.g. ~/.nvm/versions/node/vX.Y.Z/bin/node -> ../lib/node_modules)
	try {
		const execDir = dirname(process.execPath);
		searchRoots.add(execDir);
		searchRoots.add(join(execDir, "..", "lib", "node_modules"));
		searchRoots.add(join(execDir, "..", "node_modules"));
	} catch {
		// ignore
	}

	// Module directory from import.meta.url
	try {
		for (const root of collectAncestorModuleRoots(fileURLToPath(import.meta.url))) searchRoots.add(root);
	} catch {
		// ignore
	}

	// Current working directory
	try {
		searchRoots.add(process.cwd());
		searchRoots.add(join(process.cwd(), "node_modules"));
	} catch {
		// ignore
	}

	// User plugin / agent directories
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home) {
		searchRoots.add(join(home, ".pi", "agent", "npm", "node_modules"));
		searchRoots.add(join(home, ".omp", "plugins", "node_modules"));
		searchRoots.add(join(home, ".bun", "install", "cache"));
		searchRoots.add(join(home, ".npm"));
	}

	// Common global install locations
	searchRoots.add("/usr/local/lib/node_modules");
	searchRoots.add("/opt/homebrew/lib/node_modules");

	const candidate = findPiAiModule(searchRoots, fileName);
	if (candidate) return { path: candidate, dir: dirname(candidate) };

	const rootsSample = Array.from(searchRoots).slice(0, 10).join(", ");
	throw new Error(`Cannot resolve ${fileName} (scanned roots: ${rootsSample || "none"})`);
}

async function loadPatchedPiAiStreams(options: {
	fileName: string;
	providerIds: string[];
	streamOptions: CliproxyCodexStreamOptions;
	patchSource: (source: string, providerIds: string[]) => string;
}): Promise<CliproxyCodexStreams> {
	const { fileName, providerIds, streamOptions, patchSource } = options;
	const moduleName = fileName.endsWith(".js") ? fileName.slice(0, -3) : fileName;
	const { path: originalPath, dir: originalDir } = resolvePhysicalPiAiModule(fileName);
	const originalSource = readFileSync(originalPath, "utf8");
	const patched = rewriteRelativeImports(patchSource(originalSource, providerIds), originalDir);

	const hash = createHash("sha1").update(patched).digest("hex").slice(0, 16);
	const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
	mkdirSync(cacheDir, { recursive: true });
	const outPath = join(cacheDir, `${moduleName}-cpa-${hash}.mjs`);
	if (!existsSync(outPath)) writeFileSync(outPath, patched, "utf8");

	const mod = (await import(pathToFileURL(outPath).href)) as {
		streamSimple?: CliproxyCodexStreamSimple;
		stream?: CliproxyCodexStreamSimple;
	};
	if (typeof mod.streamSimple !== "function" || typeof mod.stream !== "function") {
		throw new Error(`patched ${moduleName} module missing streamSimple/stream exports`);
	}

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple: wrapStreamSimpleForFast(mod.streamSimple, streamOptions.shouldUseFast),
		stream: mod.stream,
	};
}

export async function loadCliproxyCodexStreams(
	providerIds: string[] = ["cliproxyapi"],
	options: CliproxyCodexStreamOptions = {},
): Promise<CliproxyCodexStreams> {
	return loadPatchedPiAiStreams({
		fileName: "openai-codex-responses.js",
		providerIds,
		streamOptions: options,
		patchSource: patchCodexSource,
	});
}

export function patchResponsesSource(source: string, providerIds: string[]): string {
	const providersMatch = source.match(/const OPENAI_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/);
	if (!providersMatch) {
		throw new Error("openai-responses source no longer defines OPENAI_TOOL_CALL_PROVIDERS");
	}
	const existing = providersMatch[1];
	const extras = providerIds
		.filter((id) => id.trim())
		.map((id) => JSON.stringify(id.trim()))
		.join(", ");
	let src = source.replace(
		/const OPENAI_TOOL_CALL_PROVIDERS = new Set\(\[([^\]]*)\]\);/,
		`const OPENAI_TOOL_CALL_PROVIDERS = new Set([${existing}${extras ? `, ${extras}` : ""}]);`,
	);
	src = src.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
	return src;
}

export async function loadCliproxyResponsesStreams(
	providerIds: string[] = ["cliproxyapi"],
	options: CliproxyCodexStreamOptions = {},
): Promise<CliproxyCodexStreams> {
	return loadPatchedPiAiStreams({
		fileName: "openai-responses.js",
		providerIds,
		streamOptions: options,
		patchSource: patchResponsesSource,
	});
}

export function detectProtocolFromBaseUrl(baseUrl: string | undefined): ProtocolMode {
	return autoDetectProtocol(baseUrl ?? "");
}

export function createProtocolStreamDispatcher(
	codexStreamSimple: CliproxyCodexStreamSimple,
	responsesStreamSimple?: CliproxyCodexStreamSimple,
	responsesUnavailableError?: unknown,
): CliproxyCodexStreamSimple {
	return (model, context, options) => {
		if (detectProtocolFromBaseUrl(model.baseUrl) !== "openai-responses") {
			return codexStreamSimple(model, context, options);
		}
		if (!responsesStreamSimple) {
			const reason =
				responsesUnavailableError === undefined
					? ""
					: `: ${responsesUnavailableError instanceof Error ? responsesUnavailableError.message : String(responsesUnavailableError)}`;
			throw new Error(`openai-responses protocol is unavailable for this runtime${reason}`, {
				cause: responsesUnavailableError,
			});
		}
		return responsesStreamSimple(model, context, options);
	};
}
