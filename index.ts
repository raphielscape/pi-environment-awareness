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
 * - Hardware resources (CPU, RAM, disk)
 * - Network status (connectivity, proxy)
 * - Security context (root detection)
 * - Package manager detection (from lock files)
 * - Git branch and status
 * - Locale and timezone
 *
 * Usage:
 *   ~/.pi/agent/extensions/environment-awareness/index.ts
 *
 * The extension automatically injects a <host-environment> XML block
 * into the system prompt before each agent turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gatherEnvironment, formatEnvironment } from "./detectors";

export default function environmentAwareness(pi: ExtensionAPI) {
	// Cache environment info for the session (re-detect on session start)
	let cachedEnv: string | null = null;

	// Detect environment on session start
	pi.on("session_start", async (_event, ctx) => {
		try {
			const info = gatherEnvironment(ctx.cwd);
			cachedEnv = formatEnvironment(info);

			// Show a brief status in the footer
			if (ctx.hasUI) {
				const osName =
					{
						darwin: "macOS",
						linux: "Linux",
						win32: "Windows",
					}[info.os.platform] || info.os.platform;

				const extras: string[] = [];
				if (info.isWSL) extras.push("WSL");
				if (info.isDocker) extras.push("Docker");
				if (info.isCI) extras.push("CI");

				const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
				ctx.ui.setStatus("env", `${osName}/${info.os.arch}${suffix}`);
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
				const info = gatherEnvironment(ctx.cwd);
				cachedEnv = formatEnvironment(info);
			} catch {
				return; // Skip injection if detection fails
			}
		}

		return {
			systemPrompt: `${event.systemPrompt}

<host-environment>
The following is information about the host machine and development environment.
Use this context to write correct commands, paths, and configurations for this system.

${cachedEnv}
</host-environment>
`,
		};
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		cachedEnv = null;
		if (ctx.hasUI) {
			ctx.ui.setStatus("env", undefined);
		}
	});

	// Register a command to view or refresh environment info
	pi.registerCommand("env", {
		description: "Show or refresh host environment info",
		handler: async (args, ctx) => {
			const action = args?.trim().toLowerCase();

			if (action === "refresh") {
				// Force re-detection
				const info = gatherEnvironment(ctx.cwd);
				cachedEnv = formatEnvironment(info);
				ctx.ui.notify("Environment info refreshed", "info");
				return;
			}

			// Show current environment info
			if (!cachedEnv) {
				const info = gatherEnvironment(ctx.cwd);
				cachedEnv = formatEnvironment(info);
			}

			ctx.ui.notify(cachedEnv || "No environment info available", "info");
		},
	});
}
