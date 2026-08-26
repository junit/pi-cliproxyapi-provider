import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CliproxyCodexStreamSimple } from "./codex-stream.ts";

export const PROACTIVE_COMPACTION_ERROR_PREFIX = "context_length_exceeded: proactive compaction threshold reached";
export const DEFAULT_COMPACTION_ENABLED = true;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384;

export interface ProactiveCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
}

function normalizeCompactionSettings(settings?: {
	enabled?: unknown;
	reserveTokens?: unknown;
}): ProactiveCompactionSettings {
	return {
		enabled: typeof settings?.enabled === "boolean" ? settings.enabled : DEFAULT_COMPACTION_ENABLED,
		reserveTokens:
			typeof settings?.reserveTokens === "number" &&
			Number.isFinite(settings.reserveTokens) &&
			settings.reserveTokens >= 0
				? settings.reserveTokens
				: DEFAULT_COMPACTION_RESERVE_TOKENS,
	};
}

export function extractCompactionSettings(manager: unknown): ProactiveCompactionSettings {
	if (!manager || typeof manager !== "object") {
		return normalizeCompactionSettings();
	}

	// 1. Upstream Pi SettingsManager: manager.getCompactionSettings()
	if (
		"getCompactionSettings" in manager &&
		typeof (manager as { getCompactionSettings?: unknown }).getCompactionSettings === "function"
	) {
		try {
			const res = (
				manager as { getCompactionSettings: () => { enabled?: boolean; reserveTokens?: number } }
			).getCompactionSettings();
			return normalizeCompactionSettings(res);
		} catch {
			// fall through
		}
	}

	// 2. OMP Settings instance: manager.get("compaction.enabled"), manager.get("compaction.reserveTokens")
	if ("get" in manager && typeof (manager as { get?: unknown }).get === "function") {
		try {
			const getFn = (manager as { get: (key: string) => unknown }).get.bind(manager);
			const rawEnabled = getFn("compaction.enabled");
			const rawReserve = getFn("compaction.reserveTokens");
			return normalizeCompactionSettings({ enabled: rawEnabled, reserveTokens: rawReserve });
		} catch {
			// fall through
		}
	}

	// 3. Plain settings object: { compaction: { enabled, reserveTokens } }
	if (
		"compaction" in manager &&
		typeof (manager as { compaction?: unknown }).compaction === "object" &&
		(manager as { compaction?: unknown }).compaction !== null
	) {
		const compaction = (manager as { compaction: { enabled?: unknown; reserveTokens?: unknown } }).compaction;
		return normalizeCompactionSettings(compaction);
	}

	return normalizeCompactionSettings();
}

export async function safeReloadSettings(manager: unknown): Promise<void> {
	if (!manager || typeof manager !== "object") {
		return;
	}

	// Upstream Pi: manager.reload()
	if ("reload" in manager && typeof (manager as { reload?: unknown }).reload === "function") {
		try {
			await (manager as { reload: () => Promise<void> | void }).reload();
		} catch {
			// ignore reload errors
		}
		return;
	}

	// OMP: manager.reloadFromDisk()
	if ("reloadFromDisk" in manager && typeof (manager as { reloadFromDisk?: unknown }).reloadFromDisk === "function") {
		try {
			await (manager as { reloadFromDisk: () => Promise<void> | void }).reloadFromDisk();
		} catch {
			// ignore reload errors
		}
		return;
	}
}

export function shouldScheduleProactiveCompaction(
	message: AssistantMessage,
	contextTokens: number,
	contextWindow: number,
	settings: ProactiveCompactionSettings,
): boolean {
	if (!settings.enabled || message.stopReason !== "toolUse") {
		return false;
	}
	if (!message.content.some((block) => block.type === "toolCall")) {
		return false;
	}
	if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
		return false;
	}
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return false;
	}
	if (!Number.isFinite(settings.reserveTokens) || settings.reserveTokens < 0) {
		return false;
	}

	return contextTokens > contextWindow - settings.reserveTokens;
}

export function createProactiveCompactionStream(model: Model<Api>, contextTokens: number, threshold: number) {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: `${PROACTIVE_COMPACTION_ERROR_PREFIX} (${contextTokens} > ${threshold})`,
		timestamp: Date.now(),
	};

	queueMicrotask(() => {
		stream.push({ type: "start", partial: output });
		stream.push({ type: "error", reason: "error", error: output });
		stream.end();
	});

	return stream;
}

export class ProactiveCompactionController {
	private settingsManager: unknown | undefined;
	private cachedCompactionSettings: ProactiveCompactionSettings | undefined;
	private pending: { modelKey: string; contextTokens: number; threshold: number } | undefined;

	constructor(
		private readonly agentDir: string,
		private readonly providerId: string,
	) {}

	register(pi: ExtensionAPI): void {
		pi.on("session_start", async (_event, ctx) => {
			this.pending = undefined;
			try {
				if (typeof SettingsManager?.create === "function") {
					const created = SettingsManager.create(ctx.cwd, this.agentDir, {
						projectTrusted: ctx.isProjectTrusted(),
					});
					const resolved = created instanceof Promise ? await created : created;
					this.settingsManager = resolved;
					this.cachedCompactionSettings = extractCompactionSettings(resolved);
				} else {
					this.settingsManager = undefined;
					this.cachedCompactionSettings = {
						enabled: DEFAULT_COMPACTION_ENABLED,
						reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
					};
				}
			} catch {
				this.settingsManager = undefined;
				this.cachedCompactionSettings = {
					enabled: DEFAULT_COMPACTION_ENABLED,
					reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
				};
			}
		});

		pi.on("session_shutdown", () => {
			this.settingsManager = undefined;
			this.cachedCompactionSettings = undefined;
			this.pending = undefined;
		});

		pi.on("session_compact", () => {
			this.pending = undefined;
		});

		pi.on("agent_settled", () => {
			this.pending = undefined;
		});

		pi.on("turn_end", async (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || message.provider !== this.providerId) {
				return;
			}
			if (!ctx.model || ctx.model.provider !== this.providerId || ctx.model.id !== message.model) {
				return;
			}

			let settingsManager = this.settingsManager;
			if (settingsManager instanceof Promise) {
				try {
					settingsManager = await settingsManager;
					this.settingsManager = settingsManager;
				} catch {
					settingsManager = undefined;
				}
			}

			if (settingsManager) {
				await safeReloadSettings(settingsManager);
			}
			this.cachedCompactionSettings = extractCompactionSettings(settingsManager);

			const settings = this.cachedCompactionSettings;
			const contextTokens = ctx.getContextUsage()?.tokens;
			if (contextTokens === null || contextTokens === undefined) {
				return;
			}
			if (!shouldScheduleProactiveCompaction(message, contextTokens, ctx.model.contextWindow, settings)) {
				return;
			}

			this.pending = {
				modelKey: this.modelKey(ctx.model),
				contextTokens,
				threshold: ctx.model.contextWindow - settings.reserveTokens,
			};
		});
	}

	getCompactionSettings(): ProactiveCompactionSettings | undefined {
		if (this.settingsManager && !(this.settingsManager instanceof Promise)) {
			return extractCompactionSettings(this.settingsManager);
		}
		return this.cachedCompactionSettings ?? extractCompactionSettings(undefined);
	}

	wrapStreamSimple(streamSimple: CliproxyCodexStreamSimple): CliproxyCodexStreamSimple {
		return (model, context, options) => {
			const pending = this.pending;
			if (!pending || pending.modelKey !== this.modelKey(model)) {
				return streamSimple(model, context, options);
			}

			this.pending = undefined;
			return createProactiveCompactionStream(model, pending.contextTokens, pending.threshold);
		};
	}

	private modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
		return `${model.provider}/${model.id}`;
	}
}
