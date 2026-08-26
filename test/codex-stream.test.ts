import { describe, expect, it } from "vitest";
import {
	applyFastPayloadHook,
	detectProtocolFromBaseUrl,
	loadCliproxyCodexStreams,
	loadCliproxyResponsesStreams,
	patchResponsesSource,
	resolvePhysicalPiAiModule,
	withPriorityServiceTier,
} from "../extensions/codex-stream.ts";

describe("detectProtocolFromBaseUrl", () => {
	it("detects openai-responses from /v1 baseUrl", () => {
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/v1")).toBe("openai-responses");
		expect(detectProtocolFromBaseUrl("http://127.0.0.1:8317/v1/")).toBe("openai-responses");
		expect(detectProtocolFromBaseUrl("https://relay.proxy.com/api/v1")).toBe("openai-responses");
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

	it("applies fast payload hook correctly", async () => {
		const payload = { model: "gpt-4o" };
		const next = await applyFastPayloadHook(payload, { id: "gpt-4o", provider: "cliproxyapi" } as any);
		expect(next).toEqual({ model: "gpt-4o", service_tier: "priority" });
	});

	it("dispatches between codex and responses based on baseUrl", () => {
		let lastUsed = "";
		const codexSS = () => {
			lastUsed = "codex";
			return {} as any;
		};
		const responsesSS = () => {
			lastUsed = "responses";
			return {} as any;
		};

		const dispatcher = (model: { baseUrl?: string }) => {
			if (responsesSS && detectProtocolFromBaseUrl(model.baseUrl) === "openai-responses") {
				return responsesSS();
			}
			return codexSS();
		};

		dispatcher({ baseUrl: "http://127.0.0.1:8317/v1/" });
		expect(lastUsed).toBe("responses");

		dispatcher({ baseUrl: "http://127.0.0.1:8317/backend-api/" });
		expect(lastUsed).toBe("codex");
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
