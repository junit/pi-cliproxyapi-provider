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

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

interface HostPiAiRuntime {
	buildModel?: (spec: Record<string, unknown>) => Model<Api>;
	streamSimple?: CliproxyCodexStreamSimple;
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

export function createHostCompatibleStreams(
	host: HostPiAiRuntime,
	hostApi: "openai-codex-responses" | "openai-responses",
	options: CliproxyCodexStreamOptions = {},
): CliproxyCodexStreams | undefined {
	if (typeof host.streamSimple !== "function" || typeof host.buildModel !== "function") return undefined;

	const buildModel = host.buildModel;
	const hostStreamSimple = host.streamSimple;
	const streamSimple: CliproxyCodexStreamSimple = (model, context, streamOptions) => {
		const {
			compat: _compat,
			compatConfig,
			...modelSpec
		} = model as Model<Api> & {
			compat?: unknown;
			compatConfig?: unknown;
		};
		const hostModel = buildModel({
			...modelSpec,
			api: hostApi,
			...(compatConfig === undefined ? {} : { compat: compatConfig }),
		});
		return hostStreamSimple(hostModel, context, streamOptions);
	};

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple: wrapStreamSimpleForFast(streamSimple, options.shouldUseFast),
		stream: streamSimple,
	};
}

export function isOmpRuntimeEntry(entryPath: string | undefined): boolean {
	if (!entryPath) return false;
	let resolved = entryPath;
	try {
		resolved = realpathSync(entryPath);
	} catch {
		// Tests and embedded runtimes may provide a non-filesystem entry label.
	}
	return resolved.replaceAll("\\", "/").includes("/node_modules/@oh-my-pi/pi-coding-agent/");
}

export function isBunEmbeddedRuntimeEntry(entryPath: string | undefined): boolean {
	return entryPath?.replaceAll("\\", "/").includes("/$bunfs/") ?? false;
}

interface EmbeddedBunBuildPluginBuilder {
	onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => { path: string }): void;
}

interface EmbeddedBunBuildOptions {
	entrypoints: string[];
	outdir: string;
	target: "bun";
	format: "esm";
	naming: string;
	write: false;
	plugins?: Array<{
		name: string;
		setup(build: EmbeddedBunBuildPluginBuilder): void;
	}>;
}

interface EmbeddedBunBuildResult {
	success: boolean;
	logs?: Array<{ message?: string } | string>;
	outputs?: Array<{ text(): Promise<string> }>;
}

type EmbeddedBunBuild = (options: EmbeddedBunBuildOptions) => Promise<EmbeddedBunBuildResult>;

export async function preparePatchedModuleForImport(options: {
	entryPath: string;
	outputPath: string;
	embeddedBun: boolean;
	build?: EmbeddedBunBuild;
}): Promise<string> {
	const { entryPath, outputPath, embeddedBun } = options;
	if (!embeddedBun) return pathToFileURL(entryPath).href;
	if (existsSync(outputPath)) return pathToFileURL(outputPath).href;

	const runtimeBun = (globalThis as unknown as { Bun?: { build?: EmbeddedBunBuild } }).Bun;
	const build = options.build ?? (runtimeBun?.build ? (buildOptions) => runtimeBun.build!(buildOptions) : undefined);
	if (!build) {
		throw new Error("embedded Bun runtime does not expose Bun.build");
	}

	// Bundling removes transitive bare imports that embedded Bun cannot resolve from physical package files.
	const result = await build({
		entrypoints: [entryPath],
		outdir: dirname(outputPath),
		target: "bun",
		format: "esm",
		naming: basename(outputPath),
		write: false,
		plugins: [
			{
				name: "physical-file-url",
				setup(builder) {
					builder.onResolve({ filter: /^file:/ }, (args) => ({ path: fileURLToPath(args.path) }));
				},
			},
		],
	});
	if (!result.success) {
		const details = result.logs
			?.map((log) => (typeof log === "string" ? log : log.message))
			.filter((message): message is string => Boolean(message))
			.join("; ");
		throw new Error(`failed to bundle patched module${details ? `: ${details}` : ""}`);
	}
	const bundledSource = await result.outputs?.[0]?.text();
	if (!bundledSource) throw new Error("embedded Bun build returned no output source");
	writeFileSync(outputPath, bundledSource, "utf8");
	// Load the first build in memory because Bun snapshots the temp directory after the first dynamic import.
	return `data:text/javascript;base64,${Buffer.from(bundledSource).toString("base64")}`;
}

async function loadHostCompatibleStreams(
	hostApi: "openai-codex-responses" | "openai-responses",
	options: CliproxyCodexStreamOptions,
): Promise<CliproxyCodexStreams | undefined> {
	if (!isOmpRuntimeEntry(process.argv[1])) return undefined;
	try {
		const host = (await import("@earendil-works/pi-ai")) as HostPiAiRuntime;
		if (typeof host.streamSimple !== "function") return undefined;

		const catalogSpecifier = "@oh-my-pi/pi-catalog/build";
		const catalog = (await import(catalogSpecifier)) as Pick<HostPiAiRuntime, "buildModel">;
		return createHostCompatibleStreams({ ...host, buildModel: catalog.buildModel }, hostApi, options);
	} catch {
		return undefined;
	}
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

function rewriteModuleImports(source: string, originalDir: string): string {
	const require = createRequire(pathToFileURL(join(originalDir, "__pi_ai_resolver__.cjs")));
	return source.replace(/from\s+(["'])([^"']+)\1/g, (full, _quote: string, specifier: string) => {
		if (specifier.startsWith("node:") || isBuiltin(specifier)) return full;
		const resolved = specifier.startsWith(".") ? join(originalDir, specifier) : require.resolve(specifier);
		return `from ${JSON.stringify(pathToFileURL(resolved).href)}`;
	});
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
	// Bun's embedded executable filesystem can block indefinitely in import.meta.resolve.
	// Its virtual entry cannot resolve packages anyway, so use deterministic filesystem probes.
	if (!isBunEmbeddedRuntimeEntry(process.argv[1])) {
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
	}

	// Build comprehensive search roots from process entry, cwd, execPath, homedir.
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
	hostApi: "openai-codex-responses" | "openai-responses";
	providerIds: string[];
	streamOptions: CliproxyCodexStreamOptions;
	patchSource: (source: string, providerIds: string[]) => string;
}): Promise<CliproxyCodexStreams> {
	const { fileName, hostApi, providerIds, streamOptions, patchSource } = options;
	const hostStreams = await loadHostCompatibleStreams(hostApi, streamOptions);
	if (hostStreams) return hostStreams;

	const moduleName = fileName.endsWith(".js") ? fileName.slice(0, -3) : fileName;
	const { path: originalPath, dir: originalDir } = resolvePhysicalPiAiModule(fileName);
	const originalSource = readFileSync(originalPath, "utf8");
	const patched = rewriteModuleImports(patchSource(originalSource, providerIds), originalDir);

	const hash = createHash("sha1").update(patched).digest("hex").slice(0, 16);
	const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
	mkdirSync(cacheDir, { recursive: true });
	const outPath = join(cacheDir, `${moduleName}-cpa-${hash}.mjs`);
	if (!existsSync(outPath)) writeFileSync(outPath, patched, "utf8");
	const importSpecifier = await preparePatchedModuleForImport({
		entryPath: outPath,
		outputPath: join(cacheDir, `${moduleName}-cpa-${hash}-bundled.mjs`),
		embeddedBun: isBunEmbeddedRuntimeEntry(process.argv[1]),
	});

	const mod = (await import(importSpecifier)) as {
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
		hostApi: "openai-codex-responses",
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
		hostApi: "openai-responses",
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
