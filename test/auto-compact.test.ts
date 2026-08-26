import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	extractCompactionSettings,
	PROACTIVE_COMPACTION_ERROR_PREFIX,
	ProactiveCompactionController,
	safeReloadSettings,
	shouldScheduleProactiveCompaction,
} from "../extensions/auto-compact.ts";
import type { CliproxyCodexStreamSimple } from "../extensions/codex-stream.ts";

const CONTEXT_WINDOW = 372000;
const RESERVE_TOKENS = 65536;
const THRESHOLD = CONTEXT_WINDOW - RESERVE_TOKENS;

function assistantMessage(
	totalTokens: number,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content:
			stopReason === "toolUse"
				? [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }]
				: [{ type: "text", text: "done" }],
		api: "openai-codex-responses",
		provider: "cliproxyapi",
		model: "gpt-5.6-sol",
		usage: {
			input: 100,
			output: 20,
			cacheRead: Math.max(0, totalTokens - 120),
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("proactive compaction threshold", () => {
	it("schedules an over-threshold tool turn", () => {
		expect(
			shouldScheduleProactiveCompaction(assistantMessage(THRESHOLD + 1), THRESHOLD + 1, CONTEXT_WINDOW, {
				enabled: true,
				reserveTokens: RESERVE_TOKENS,
			}),
		).toBe(true);
	});

	it("uses the same strict threshold as pi", () => {
		expect(
			shouldScheduleProactiveCompaction(assistantMessage(THRESHOLD), THRESHOLD, CONTEXT_WINDOW, {
				enabled: true,
				reserveTokens: RESERVE_TOKENS,
			}),
		).toBe(false);
	});

	it("does not interrupt completed responses or disabled compaction", () => {
		expect(
			shouldScheduleProactiveCompaction(assistantMessage(THRESHOLD + 1, "stop"), THRESHOLD + 1, CONTEXT_WINDOW, {
				enabled: true,
				reserveTokens: RESERVE_TOKENS,
			}),
		).toBe(false);
		expect(
			shouldScheduleProactiveCompaction(assistantMessage(THRESHOLD + 1), THRESHOLD + 1, CONTEXT_WINDOW, {
				enabled: false,
				reserveTokens: RESERVE_TOKENS,
			}),
		).toBe(false);
	});
});

describe("proactive compaction controller", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function setup(enabled = true) {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-auto-compact-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-auto-compact-cwd-"));
		tempDirs.push(agentDir, cwd);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, `${JSON.stringify({ compaction: { enabled, reserveTokens: RESERVE_TOKENS } })}\n`);

		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const controller = new ProactiveCompactionController(agentDir, "cliproxyapi");
		controller.register(pi);

		const model = {
			id: "gpt-5.6-sol",
			provider: "cliproxyapi",
			api: "openai-codex-responses",
			contextWindow: CONTEXT_WINDOW,
		} as Model<Api>;
		const ctx = {
			cwd,
			model,
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: THRESHOLD + 1, contextWindow: CONTEXT_WINDOW, percent: 82.4 }),
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({}, ctx);

		const baseResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = () => baseResult;
		const wrapped = controller.wrapStreamSimple(baseStream);
		return { ctx, handlers, model, wrapped, baseResult, settingsPath };
	}

	it("injects one overflow before the next provider request", async () => {
		const { ctx, handlers, model, wrapped, baseResult } = setup();
		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);

		const proactiveStream = wrapped(model, { messages: [] });
		const error = await proactiveStream.result();
		expect(error.stopReason).toBe("error");
		expect(error.errorMessage).toBe(`${PROACTIVE_COMPACTION_ERROR_PREFIX} (${THRESHOLD + 1} > ${THRESHOLD})`);
		expect(isContextOverflow(error, CONTEXT_WINDOW)).toBe(true);
		expect(wrapped(model, { messages: [] })).toBe(baseResult);
	});

	it("reloads settings before scheduling", async () => {
		const { ctx, handlers, model, wrapped, baseResult, settingsPath } = setup();
		writeFileSync(
			settingsPath,
			`${JSON.stringify({ compaction: { enabled: false, reserveTokens: RESERVE_TOKENS } })}\n`,
		);

		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);
		expect(wrapped(model, { messages: [] })).toBe(baseResult);
	});

	it("ignores other providers", async () => {
		const { ctx, handlers, model, wrapped, baseResult } = setup();
		const message = { ...assistantMessage(THRESHOLD + 1), provider: "other" };

		await handlers.get("turn_end")?.({ message, toolResults: [{}] }, ctx);
		expect(wrapped(model, { messages: [] })).toBe(baseResult);
	});

	it("supports OMP environment where SettingsManager.create returns a Promise with reloadFromDisk", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-omp-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-omp-cwd-"));
		tempDirs.push(agentDir, cwd);

		let reloadFromDiskCalled = false;
		const ompSettingsState: Record<string, unknown> = {
			"compaction.enabled": true,
			"compaction.reserveTokens": RESERVE_TOKENS,
		};

		const mockOmpSettings = {
			get(key: string) {
				return ompSettingsState[key];
			},
			async reloadFromDisk() {
				reloadFromDiskCalled = true;
			},
		};

		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const controller = new ProactiveCompactionController(agentDir, "cliproxyapi");
		controller.register(pi);

		// Directly inject the OMP Promise simulation as if SettingsManager.create returned a Promise
		(controller as any).settingsManager = Promise.resolve(mockOmpSettings);

		const model = {
			id: "gpt-5.6-sol",
			provider: "cliproxyapi",
			api: "openai-codex-responses",
			contextWindow: CONTEXT_WINDOW,
		} as Model<Api>;
		const ctx = {
			cwd,
			model,
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: THRESHOLD + 1, contextWindow: CONTEXT_WINDOW, percent: 82.4 }),
		} as unknown as ExtensionContext;

		const baseResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = () => baseResult;
		const wrapped = controller.wrapStreamSimple(baseStream);

		// Trigger turn_end in OMP environment - must NOT throw TypeError: settingsManager.reload is not a function
		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);

		expect(reloadFromDiskCalled).toBe(true);
		expect(controller.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: RESERVE_TOKENS,
		});

		const proactiveStream = wrapped(model, { messages: [] });
		const error = await proactiveStream.result();
		expect(error.stopReason).toBe("error");
		expect(error.errorMessage).toBe(`${PROACTIVE_COMPACTION_ERROR_PREFIX} (${THRESHOLD + 1} > ${THRESHOLD})`);
	});

	it("gracefully handles missing or failing settings manager", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-fallback-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-fallback-cwd-"));
		tempDirs.push(agentDir, cwd);

		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const controller = new ProactiveCompactionController(agentDir, "cliproxyapi");
		controller.register(pi);

		(controller as any).settingsManager = undefined;

		const model = {
			id: "gpt-5.6-sol",
			provider: "cliproxyapi",
			api: "openai-codex-responses",
			contextWindow: CONTEXT_WINDOW,
		} as Model<Api>;
		const ctx = {
			cwd,
			model,
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: THRESHOLD + 1, contextWindow: CONTEXT_WINDOW, percent: 82.4 }),
		} as unknown as ExtensionContext;

		await handlers.get("turn_end")?.({ message: assistantMessage(THRESHOLD + 1), toolResults: [{}] }, ctx);
		expect(controller.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 16384,
		});
	});
});

describe("extractCompactionSettings and safeReloadSettings helpers", () => {
	it("extracts settings from upstream Pi SettingsManager-like object", () => {
		const manager = {
			getCompactionSettings() {
				return { enabled: true, reserveTokens: 32000, keepRecentTokens: 10000 };
			},
		};
		expect(extractCompactionSettings(manager)).toEqual({
			enabled: true,
			reserveTokens: 32000,
		});
	});

	it("extracts settings from OMP Settings-like object with .get()", () => {
		const manager = {
			get(key: string) {
				if (key === "compaction.enabled") return false;
				if (key === "compaction.reserveTokens") return 40000;
				return undefined;
			},
		};
		expect(extractCompactionSettings(manager)).toEqual({
			enabled: false,
			reserveTokens: 40000,
		});
	});

	it("extracts settings from plain settings object", () => {
		const manager = {
			compaction: {
				enabled: false,
				reserveTokens: 24000,
			},
		};
		expect(extractCompactionSettings(manager)).toEqual({
			enabled: false,
			reserveTokens: 24000,
		});
	});

	it("falls back to default settings for null, undefined, or invalid objects", () => {
		expect(extractCompactionSettings(null)).toEqual({
			enabled: true,
			reserveTokens: 16384,
		});
		expect(extractCompactionSettings(undefined)).toEqual({
			enabled: true,
			reserveTokens: 16384,
		});
		expect(extractCompactionSettings({})).toEqual({
			enabled: true,
			reserveTokens: 16384,
		});
		expect(extractCompactionSettings({ compaction: { reserveTokens: "invalid" } })).toEqual({
			enabled: true,
			reserveTokens: 16384,
		});
	});

	it("safeReloadSettings calls reload or reloadFromDisk when present, and ignores errors", async () => {
		let reloadCalled = false;
		await safeReloadSettings({
			async reload() {
				reloadCalled = true;
			},
		});
		expect(reloadCalled).toBe(true);

		let reloadFromDiskCalled = false;
		await safeReloadSettings({
			async reloadFromDisk() {
				reloadFromDiskCalled = true;
			},
		});
		expect(reloadFromDiskCalled).toBe(true);

		// Does not throw when method throws or is missing
		await expect(
			safeReloadSettings({
				reload() {
					throw new Error("disk error");
				},
			}),
		).resolves.toBeUndefined();

		await expect(safeReloadSettings(null)).resolves.toBeUndefined();
		await expect(safeReloadSettings({})).resolves.toBeUndefined();
	});
});
