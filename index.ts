/**
 * Environment Awareness Extension for Pi
 *
 * Injects host environment context into the system prompt via XML
 * so the LLM understands the runtime environment it's working in.
 *
 * Features:
 * - OS, architecture, and version detection
 * - Shell detection
 * - Container/VM detection (Docker, WSL)
 * - CI/CD environment detection
 * - Security context (root detection)
 * - Package manager detection (from lock files)
 * - Git repo membership (repo yes/no only — branch/status are excluded as cache-unstable)
 * - Dev tool detection with versions (incl. modern CLI replacements)
 * - Project config detection (test runner, linter, monorepo, CI configs)
 * - Locale and timezone
 *
 * Usage:
 *   ~/.pi/agent/extensions/environment-awareness/index.ts
 *
 * The extension automatically injects a <host-environment> XML block
 * into the system prompt before each agent turn.
 */

import type { BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatEnvironment, gatherEnvironment } from "./detectors";

export default function environmentAwareness(pi: ExtensionAPI) {
	// Cache environment info for the session (re-detect on session start)
	let cachedEnv: string | null = null;

	// Detect environment on session start
	pi.on("session_start", async (_event, ctx) => {
		try {
			const info = await gatherEnvironment(ctx.cwd);
			cachedEnv = formatEnvironment(info);

			// Only show the footer status when something noteworthy is detected;
			// plain OS/arch (e.g. "Linux/x64") is noise.
			if (ctx.hasUI) {
				const extras: string[] = [];
				if (info.isWSL) extras.push("WSL");
				if (info.isDocker) extras.push("Docker");
				if (info.isCI) extras.push("CI");

				// Clear any stale status from a previous session state
				ctx.ui.setStatus("env", extras.length > 0 ? extras.join(", ") : undefined);
			}
		} catch (err) {
			// Don't break pi if detection fails
			console.error("[environment-awareness] Detection failed:", err);
			cachedEnv = null;
		}
	});

	// Inject environment context into system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		// Re-detect if not cached (shouldn't happen, but safety net)
		if (!cachedEnv) {
			try {
				const info = await gatherEnvironment(ctx.cwd);
				cachedEnv = formatEnvironment(info);
			} catch {
				return; // Skip injection if detection fails
			}
		}

		// Hosts disagree on the systemPrompt contract: Pi uses a scalar string
		// (dist/core/extensions/types.d.ts:740), OMP uses an array of prompt
		// sections (dist/types/extensibility/extensions/types.d.ts:796). Branch
		// on the runtime shape so one build serves both.
		const block = `<host-environment>
The following is information about the host machine and development environment.
Use this context to write correct commands, paths, and configurations for this system.

${cachedEnv}
</host-environment>`;

		if (Array.isArray(event.systemPrompt)) {
			// OMP: append as a chained prompt section. OMP types systemPrompt
			// as string[] while Pi (the local types here) types it as string,
			// so cast only at this boundary.
			return {
				systemPrompt: [...event.systemPrompt, block],
			} as unknown as BeforeAgentStartEventResult;
		}

		// Pi: scalar replacement prompt
		return {
			systemPrompt: `${event.systemPrompt}\n\n${block}\n`,
		} satisfies BeforeAgentStartEventResult;
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		cachedEnv = null;
		if (ctx.hasUI) {
			ctx.ui.setStatus("env", undefined);
		}
	});

	// Refresh after compaction — tool versions may be stale after upgrades
	// ponytail: compaction already busts the conversation cache, so re-detection is free
	pi.on("session_compact", async (_event, ctx) => {
		try {
			const info = await gatherEnvironment(ctx.cwd);
			cachedEnv = formatEnvironment(info);
		} catch {
			// Don't break pi if detection fails
		}
	});

	// Register a command to view or refresh environment info
	pi.registerCommand("env", {
		description: "Show or refresh host environment info",
		handler: async (args, ctx) => {
			const action = args?.trim().toLowerCase();

			if (action === "refresh") {
				// Force re-detection
				try {
					const info = await gatherEnvironment(ctx.cwd);
					cachedEnv = formatEnvironment(info);
				} catch (err) {
					console.error("[environment-awareness] Detection failed:", err);
					ctx.ui.notify(
						cachedEnv
							? "Environment detection failed; showing cached info"
							: "Environment detection failed; no cached info",
						"warning",
					);
					return;
				}
				ctx.ui.notify("Environment info refreshed", "info");
				return;
			}

			// Show current environment info
			if (!cachedEnv) {
				try {
					const info = await gatherEnvironment(ctx.cwd);
					cachedEnv = formatEnvironment(info);
				} catch (err) {
					console.error("[environment-awareness] Detection failed:", err);
					ctx.ui.notify("No environment info available", "warning");
					return;
				}
			}

			ctx.ui.notify(cachedEnv || "No environment info available", "info");
		},
	});
}
