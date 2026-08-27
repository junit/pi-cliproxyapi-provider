import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Context, Model, SimpleStreamOptions, Transport } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	applyFastPayloadHook,
	type CliproxyCodexStreamSimple,
	createHostCompatibleStreams,
	createProtocolStreamDispatcher,
	detectProtocolFromBaseUrl,
	isOmpRuntimeEntry,
	loadCliproxyCodexStreams,
	loadCliproxyResponsesStreams,
	patchResponsesSource,
	resolvePhysicalPiAiModule,
	withPriorityServiceTier,
} from "../extensions/codex-stream.ts";

const testContext = { messages: [] } as Context;

function testModel(baseUrl: string): Model<Api> {
	return { id: "test", provider: "cliproxyapi", baseUrl } as Model<Api>;
}

describe("isOmpRuntimeEntry", () => {
	it("only enables host stream reuse for the OMP package entry", () => {
		expect(isOmpRuntimeEntry("/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(true);
		expect(isOmpRuntimeEntry("/opt/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")).toBe(false);
		expect(isOmpRuntimeEntry(undefined)).toBe(false);
	});
});

describe("detectProtocolFromBaseUrl", () => {
	it("detects openai-responses from /v1 baseUrl", () => {
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/v1")).toBe("openai-responses");
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/v1/")).toBe("openai-responses");
		expect(detectProtocolFromBaseUrl("https://relay.proxy.com/api/v1")).toBe("openai-responses");
		expect(detectProtocolFromBaseUrl("relay.proxy.com:8317/v1")).toBe("openai-responses");
	});

	it("defaults to openai-codex for non-v1 baseUrl", () => {
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/backend-api/")).toBe("openai-codex");
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/")).toBe("openai-codex");
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317")).toBe("openai-codex");
		expect(detectProtocolFromBaseUrl(undefined)).toBe("openai-codex");
		expect(detectProtocolFromBaseUrl("")).toBe("openai-codex");
	});
});

describe("withPriorityServiceTier", () => {
	it("injects service_tier: priority into objects", () => {
		expect(withPriorityServiceTier({ model: "test" })).toEqual({
			model: "test",
			service_tier: "priority",
		});
	});

	it("leaves non-objects unchanged", () => {
		expect(withPriorityServiceTier("string")).toBe("string");
		expect(withPriorityServiceTier(null)).toBeNull();
		expect(withPriorityServiceTier([1, 2])).toEqual([1, 2]);
	});
});

describe("patchResponsesSource", () => {
	it("injects provider ids into OPENAI_TOOL_CALL_PROVIDERS", () => {
		const fakeSource =
			'const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex"]);\n//# sourceMappingURL=test.js.map';
		const patched = patchResponsesSource(fakeSource, ["cliproxyapi", "custom-cpa"]);
		expect(patched).toContain(
			'const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "cliproxyapi", "custom-cpa"]);',
		);
		expect(patched).not.toContain("sourceMappingURL");
	});

	it("throws if OPENAI_TOOL_CALL_PROVIDERS is missing", () => {
		expect(() => patchResponsesSource("const foo = 1;", ["cliproxyapi"])).toThrow(/OPENAI_TOOL_CALL_PROVIDERS/);
	});
});

describe("runtime module loading", () => {
	it("uses a compatible host stream without importing a second pi-ai runtime", () => {
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		let receivedModel: Model<Api> | undefined;
		const streams = createHostCompatibleStreams(
			{
				buildModel: (spec) => ({ ...spec, compat: { supportsImageDetailOriginal: true } }) as unknown as Model<Api>,
				streamSimple: (model) => {
					receivedModel = model;
					return streamResult;
				},
			},
			"openai-codex-responses",
		);
		const model = {
			...testModel("http://127.0.0.1:8317/backend-api"),
			api: "cliproxyapi-codex-responses",
		} as Model<Api>;

		expect(streams?.streamSimple(model, testContext)).toBe(streamResult);
		expect(receivedModel?.api).toBe("openai-codex-responses");
		expect(receivedModel?.compat).toEqual({ supportsImageDetailOriginal: true });
		expect(model.api).toBe("cliproxyapi-codex-responses");
	});

	it.each([
		"sse",
		"websocket",
		"websocket-cached",
		"auto",
	] satisfies Transport[])("preserves Pi transport preference %s through provider dispatch", (transport) => {
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		let receivedOptions: SimpleStreamOptions | undefined;
		const streams = createHostCompatibleStreams(
			{
				buildModel: (spec) => spec as unknown as Model<Api>,
				streamSimple: (_model, _context, options) => {
					receivedOptions = options;
					return streamResult;
				},
			},
			"openai-codex-responses",
		);
		if (!streams) throw new Error("host-compatible streams unavailable");

		const dispatcher = createProtocolStreamDispatcher(streams.streamSimple);
		const options = { transport, sessionId: "transport-forwarding-test" } satisfies SimpleStreamOptions;
		const result = dispatcher(testModel("http://127.0.0.1:8317/backend-api/"), testContext, options);

		expect(result).toBe(streamResult);
		expect(receivedOptions).toBe(options);
		expect(receivedOptions?.transport).toBe(transport);
	});

	it("falls back unless the host exposes both streamSimple and buildModel", () => {
		expect(createHostCompatibleStreams({}, "openai-responses")).toBeUndefined();
		expect(createHostCompatibleStreams({ streamSimple: () => ({}) as never }, "openai-responses")).toBeUndefined();
	});

	it("loads patched codex stream module successfully", async () => {
		const streams = await loadCliproxyCodexStreams(["cliproxyapi"]);
		expect(streams).toBeDefined();
		expect(typeof streams.streamSimple).toBe("function");
		expect(typeof streams.stream).toBe("function");
		expect(streams.api).toBe("cliproxyapi-codex-responses");
	});

	it("loads patched responses stream module successfully", async () => {
		const streams = await loadCliproxyResponsesStreams(["cliproxyapi"]);
		expect(streams).toBeDefined();
		expect(typeof streams.streamSimple).toBe("function");
		expect(typeof streams.stream).toBe("function");
		expect(streams.api).toBe("cliproxyapi-codex-responses");
	});

	it("loads the patched responses module from a standalone Node process", async () => {
		const marker = `cliproxyapi-standalone-node-test-${process.pid}-${Date.now()}`;
		await loadCliproxyResponsesStreams([marker]);

		const cacheDir = join(tmpdir(), "pi-cliproxyapi-provider");
		const generatedPath = readdirSync(cacheDir)
			.filter((name) => name.startsWith("openai-responses-cpa-") && name.endsWith(".mjs"))
			.map((name) => join(cacheDir, name))
			.find((path) => readFileSync(path, "utf8").includes(marker));
		expect(generatedPath).toBeDefined();

		try {
			expect(() =>
				execFileSync(
					process.execPath,
					["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(generatedPath!).href)});`],
					{
						cwd: tmpdir(),
						stdio: "pipe",
					},
				),
			).not.toThrow();
		} finally {
			if (generatedPath) unlinkSync(generatedPath);
		}
	});

	it("applies fast payload hook correctly", async () => {
		const payload = { model: "gpt-4o" };
		const model = { id: "gpt-4o", provider: "cliproxyapi" } as Model<Api>;
		const next = await applyFastPayloadHook(payload, model);
		expect(next).toEqual({ model: "gpt-4o", service_tier: "priority" });
	});

	it("dispatches between codex and responses through the production dispatcher", () => {
		let lastUsed = "";
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const codexSS: CliproxyCodexStreamSimple = () => {
			lastUsed = "codex";
			return streamResult;
		};
		const responsesSS: CliproxyCodexStreamSimple = () => {
			lastUsed = "responses";
			return streamResult;
		};
		const dispatcher = createProtocolStreamDispatcher(codexSS, responsesSS);

		dispatcher(testModel("http://127.0.0.1:8317/v1/"), testContext);
		expect(lastUsed).toBe("responses");

		dispatcher(testModel("http://127.0.0.1:8317/backend-api/"), testContext);
		expect(lastUsed).toBe("codex");
	});

	it("fails clearly instead of routing responses requests through codex when the responses stream is unavailable", () => {
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const loaderError = new Error("patched source is incompatible");
		const dispatcher = createProtocolStreamDispatcher(() => streamResult, undefined, loaderError);

		let thrown: unknown;
		try {
			dispatcher(testModel("https://relay.example/v1/"), testContext);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			message: expect.stringMatching(/openai-responses protocol is unavailable.*patched source is incompatible/),
			cause: loaderError,
		});
	});
});

describe("resolvePhysicalPiAiModule", () => {
	it("resolves physical openai-codex-responses.js file", () => {
		const resolved = resolvePhysicalPiAiModule("openai-codex-responses.js");
		expect(resolved).toBeDefined();
		expect(resolved.path).toContain("openai-codex-responses.js");
		expect(resolved.dir).toBeDefined();
	});

	it("resolves physical openai-responses.js file", () => {
		const resolved = resolvePhysicalPiAiModule("openai-responses.js");
		expect(resolved).toBeDefined();
		expect(resolved.path).toContain("openai-responses.js");
		expect(resolved.dir).toBeDefined();
	});

	it("throws with descriptive message when module cannot be found", () => {
		expect(() => resolvePhysicalPiAiModule("non-existent-module-xyz.js")).toThrow(
			/Cannot resolve non-existent-module-xyz\.js/,
		);
	});
});
