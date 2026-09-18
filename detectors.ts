/**
 * Environment Detection Module
 *
 * Gathers host environment information for coding agent context.
 * Each detector is independent and failures are gracefully handled.
 *
 * Best practices applied:
 * - Only show relevant info (skip empty/irrelevant sections)
 * - Keep output compact (avoid token bloat)
 * - No sensitive data (no env var values, no secrets)
 * - No volatile data (no memory/disk that changes constantly)
 * - Graceful degradation on failure
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join } from "node:path";

export interface EnvironmentInfo {
	os: {
		platform: string;
		arch: string;
		version: string;
		release: string;
	};
	// CPU model name from os.cpus()[0].model — stable hardware fact, safe
	// for prompt caching.
	cpu?: string;
	// Parallelism hint for build flags. On bare metal: os.cpus().length.
	// In containers: cgroup CPU quota (v2 cpu.max, v1 cfs_quota/period),
	// because os.cpus() reports host CPUs and would mislead.
	cpuThreads?: number;
	shell: string;
	isWSL: boolean;
	isDocker: boolean;
	isCI: boolean;
	ciPlatform?: string;
	packageManager?: string;
	// NOTE: isGitRepo is detected but not injected into the prompt — anything
	// git-derived (branch, dirty status) changes constantly and would bust
	// the prompt cache. It only feeds /env display and refresh logic.
	isGitRepo?: boolean;
	tools: ToolInfo[];
	preferences: string[];
	security: {
		isRoot: boolean;
	};
	timezone: string;
	locale: string;
	// XDG base directories, only populated when the env var is set to an
	// absolute path that differs from the spec default. Models default to
	// ~/.config etc.; emitting only non-default values corrects that without
	// adding noise on conventional setups.
	xdgDirs?: Record<string, string>;
	projectConfig?: {
		versionFiles: string[];
		testRunner?: string;
		linter?: string;
		formatter?: string;
		typescriptVersion?: string;
		isMonorepo: boolean;
		ciConfigs: string[];
		editorConfig?: string;
		npmScripts?: string[];
		databases?: string[];
		tsconfigStrict?: boolean;
		automationTools?: string[];
		envExample?: boolean;
	};
}

export interface ToolInfo {
	name: string;
	version: string;
}

/**
 * Safely execute a command, returning undefined on failure
 */
function safeExec(command: string, cwd?: string): string | undefined {
	try {
		return execSync(command, {
			encoding: "utf-8",
			timeout: 5000,
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
}

/**
 * Detect OS information
 * On Linux, reads /etc/os-release for distro name (e.g. "CachyOS", "Ubuntu 24.04")
 * Falls back to os.release() kernel string if unavailable
 */
function detectOS(): EnvironmentInfo["os"] {
	let version = os.version();
	const release = os.release();

	if (process.platform === "linux") {
		try {
			const osRelease = readFileSync("/etc/os-release", "utf-8");
			const prettyName = osRelease.match(/^PRETTY_NAME="(.+)"/m)?.[1];
			if (prettyName) {
				version = prettyName;
				// Keep release as kernel version for reference
			}
		} catch {
			// /etc/os-release missing or unreadable, keep defaults
		}
	}

	return {
		platform: process.platform,
		arch: process.arch,
		version,
		release,
	};
}

/**
 * Detect the CPU model name. Omitted when unavailable rather than reported
/**
 * Read the cgroup CPU quota in whole CPUs, if a quota is set.
 * Handles cgroup v2 (cpu.max) and v1 (cpu.cfs_quota_us/cpu.cfs_period_us).
 * Returns undefined when no quota applies ("max", -1, unreadable files).
 */
function cgroupCpuLimit(): number | undefined {
	// cgroup v2: "<quota|max> <period>", period in microseconds
	try {
		const [quota, period] = readFileSync(
			"/sys/fs/cgroup/cpu.max",
			"utf-8",
		).split(/\s+/);
		if (quota !== "max") {
			const q = Number(quota);
			const p = Number(period);
			if (q > 0 && p > 0) return Math.max(1, Math.floor(q / p));
		}
		return undefined; // v2 mounted, no quota — don't fall through to v1
	} catch {
		// not v2, try v1
	}

	// cgroup v1: cfs_quota_us / cfs_period_us, -1 means no limit
	try {
		const quota = Number(
			readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf-8"),
		);
		const period = Number(
			readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf-8"),
		);
		if (quota > 0 && period > 0) return Math.max(1, Math.floor(quota / period));
	} catch {
		// no cgroup v1 cpu controller either
	}
	return undefined;
}

/**
 * Detect the CPU model name and an honest parallelism hint.
 *
 * Thread count comes from the cgroup CPU quota when one is set (containers),
 * otherwise from os.cpus().length (bare metal / unlimited). This avoids the
 * classic container bug where os.cpus() reports host CPUs and the model
 * suggests -j<host-cores> inside a 2-core cgroup.
 *
 * Model is omitted when unavailable rather than reported as "unknown".
 */
function detectCpu(): { model?: string; threads?: number } {
	const model = os.cpus()[0]?.model.trim() || undefined;
	const threads = cgroupCpuLimit() ?? (os.cpus().length || undefined);
	return { model, threads };
}

/**
 * Detect the user's default shell
 */
function detectShell(): string {
	if (process.platform === "win32") {
		return process.env.COMSPEC || "cmd.exe";
	}
	return process.env.SHELL || "/bin/sh";
}

/**
 * Detect if running inside WSL (Windows Subsystem for Linux)
 */
function detectWSL(): boolean {
	if (process.platform !== "linux") return false;
	try {
		const release = readFileSync(
			"/proc/sys/kernel/osrelease",
			"utf-8",
		).toLowerCase();
		return release.includes("microsoft") || release.includes("wsl");
	} catch {
		return false;
	}
}

/**
 * Detect if running inside a Docker container
 */
function detectDocker(): boolean {
	try {
		if (existsSync("/.dockerenv")) return true;
		const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
		return (
			cgroup.includes("docker") ||
			cgroup.includes("containerd") ||
			cgroup.includes("kubepods")
		);
	} catch {
		return false;
	}
}

/**
 * Detect CI/CD environment
 */
function detectCI(): { isCI: boolean; platform?: string } {
	if (process.env.CI === "true" || process.env.CI === "1") {
		if (process.env.GITHUB_ACTIONS)
			return { isCI: true, platform: "GitHub Actions" };
		if (process.env.GITLAB_CI) return { isCI: true, platform: "GitLab CI" };
		if (process.env.CIRCLECI) return { isCI: true, platform: "CircleCI" };
		if (process.env.TRAVIS) return { isCI: true, platform: "Travis CI" };
		if (process.env.JENKINS_URL) return { isCI: true, platform: "Jenkins" };
		if (process.env.AZURE_PIPELINES)
			return { isCI: true, platform: "Azure Pipelines" };
		if (process.env.BUILDKITE) return { isCI: true, platform: "Buildkite" };
		return { isCI: true, platform: "Unknown" };
	}
	return { isCI: false };
}

/**
 * Detect package manager from lock files in the given directory
 */
function detectPackageManager(cwd: string): string | undefined {
	const lockFiles: [string, string][] = [
		["bun.lockb", "bun"],
		["bun.lock", "bun"],
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["package-lock.json", "npm"],
		["Cargo.lock", "cargo"],
		["poetry.lock", "poetry"],
		["Pipfile.lock", "pipenv"],
		["go.sum", "go"],
		["Gemfile.lock", "bundler"],
		["composer.lock", "composer"],
		["requirements.txt", "pip"],
		["pyproject.toml", "uv/pip"],
	];

	for (const [file, manager] of lockFiles) {
		if (existsSync(join(cwd, file))) {
			return manager;
		}
	}

	return undefined;
}

/**
 * Detect whether the cwd is inside a git repository.
 * Repo membership is stable, but no git-derived fields (branch, dirty
 * status) are returned or injected — see the isGitRepo note above.
 */
function detectGitRepo(cwd: string): boolean {
	if (existsSync(join(cwd, ".git"))) return true;
	return safeExec("git rev-parse --git-dir", cwd) !== undefined;
}

/**
 * Detect project context from config/lock files
 * Source-driven detection: project files take precedence over global tool availability
 */
function detectProjectContext(cwd: string): Record<string, string> {
	const context: Record<string, string> = {};

	if (
		existsSync(join(cwd, "bun.lockb")) ||
		existsSync(join(cwd, "bunfig.toml"))
	) {
		context.js_runtime = "bun";
	} else if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
		context.js_runtime = "node";
		context.js_package_manager = "pnpm";
	} else if (existsSync(join(cwd, "yarn.lock"))) {
		context.js_runtime = "node";
		context.js_package_manager = "yarn";
	} else if (existsSync(join(cwd, "package-lock.json"))) {
		context.js_runtime = "node";
		context.js_package_manager = "npm";
	} else if (existsSync(join(cwd, "package.json"))) {
		context.js_runtime = "node";
	}

	if (
		existsSync(join(cwd, "uv.lock")) ||
		existsSync(join(cwd, "pyproject.toml"))
	) {
		context.python_tool = "uv";
	} else if (
		existsSync(join(cwd, "requirements.txt")) ||
		existsSync(join(cwd, "setup.py"))
	) {
		context.python_tool = "pip";
	}

	return context;
}

/**
 * Detect project configuration files
 * All detections are based on static config files — no volatile data
 */
function detectProjectConfig(cwd: string): EnvironmentInfo["projectConfig"] {
	const versionFiles: string[] = [];
	let testRunner: string | undefined;
	let linter: string | undefined;
	let formatter: string | undefined;
	let typescriptVersion: string | undefined;
	let isMonorepo = false;
	const ciConfigs: string[] = [];
	let editorConfig: string | undefined;
	let npmScripts: string[] | undefined;
	let databases: string[] | undefined;
	let tsconfigStrict: boolean | undefined;
	let automationTools: string[] | undefined;
	let envExample: boolean | undefined;

	// Version files
	if (existsSync(join(cwd, ".nvmrc"))) versionFiles.push(".nvmrc");
	if (existsSync(join(cwd, ".node-version")))
		versionFiles.push(".node-version");
	if (existsSync(join(cwd, ".tool-versions")))
		versionFiles.push(".tool-versions");
	if (existsSync(join(cwd, ".python-version")))
		versionFiles.push(".python-version");
	if (existsSync(join(cwd, ".ruby-version")))
		versionFiles.push(".ruby-version");
	if (existsSync(join(cwd, ".go-version"))) versionFiles.push(".go-version");
	if (existsSync(join(cwd, "rust-toolchain.toml")))
		versionFiles.push("rust-toolchain.toml");

	// Test runners (check package.json and config files)
	const pkgJsonPath = join(cwd, "package.json");
	if (existsSync(pkgJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
			const allDeps = {
				...pkg.dependencies,
				...pkg.devDependencies,
			};
			if (allDeps.vitest) testRunner = "vitest";
			else if (allDeps.jest) testRunner = "jest";
			else if (allDeps.mocha) testRunner = "mocha";
			else if (allDeps["@playwright/test"]) testRunner = "playwright";
			else if (allDeps.cypress) testRunner = "cypress";
			else if (allDeps.ava) testRunner = "ava";
			else if (allDeps.tape) testRunner = "tape";

			// Linters
			if (allDeps.eslint) linter = "eslint";
			else if (allDeps["@biomejs/biome"]) linter = "biome";
			else if (allDeps.oxlint) linter = "oxlint";

			// Formatters
			if (allDeps.prettier) formatter = "prettier";
			else if (allDeps["@biomejs/biome"]) formatter = "biome";

			// TypeScript version
			if (allDeps.typescript) {
				typescriptVersion = allDeps.typescript;
			}

			// Monorepo detection
			if (pkg.workspaces) isMonorepo = true;

			// npm scripts (common ones that help the model)
			if (pkg.scripts && typeof pkg.scripts === "object") {
				const scriptNames = Object.keys(pkg.scripts);
				if (scriptNames.length > 0) {
					npmScripts = scriptNames;
				}
			}
		} catch {
			// Invalid package.json, skip
		}
	}

	// Standalone config files for linters/formatters
	if (!linter && existsSync(join(cwd, "eslint.config.js"))) linter = "eslint";
	if (!linter && existsSync(join(cwd, "eslint.config.mjs"))) linter = "eslint";
	if (!linter && existsSync(join(cwd, ".eslintrc.js"))) linter = "eslint";
	if (!linter && existsSync(join(cwd, ".eslintrc.json"))) linter = "eslint";
	if (!linter && existsSync(join(cwd, "biome.json"))) linter = "biome";
	if (!linter && existsSync(join(cwd, "biome.jsonc"))) linter = "biome";
	if (!linter && existsSync(join(cwd, ".oxlintrc.json"))) linter = "oxlint";

	if (!formatter && existsSync(join(cwd, ".prettierrc")))
		formatter = "prettier";
	if (!formatter && existsSync(join(cwd, ".prettierrc.json")))
		formatter = "prettier";
	if (!formatter && existsSync(join(cwd, ".prettierrc.js")))
		formatter = "prettier";
	if (!formatter && existsSync(join(cwd, "prettier.config.js")))
		formatter = "prettier";
	if (!formatter && existsSync(join(cwd, "biome.json"))) formatter = "biome";
	if (!formatter && existsSync(join(cwd, "biome.jsonc"))) formatter = "biome";

	// Monorepo detection (other patterns)
	if (existsSync(join(cwd, "pnpm-workspace.yaml"))) isMonorepo = true;
	if (existsSync(join(cwd, "nx.json"))) isMonorepo = true;
	if (existsSync(join(cwd, "turbo.json"))) isMonorepo = true;
	if (existsSync(join(cwd, "lerna.json"))) isMonorepo = true;

	// CI config files
	if (existsSync(join(cwd, ".github", "workflows")))
		ciConfigs.push("github-actions");
	if (existsSync(join(cwd, ".gitlab-ci.yml"))) ciConfigs.push("gitlab-ci");
	if (existsSync(join(cwd, "Jenkinsfile"))) ciConfigs.push("jenkins");
	if (existsSync(join(cwd, ".circleci", "config.yml")))
		ciConfigs.push("circleci");
	if (existsSync(join(cwd, ".travis.yml"))) ciConfigs.push("travis");
	if (existsSync(join(cwd, "azure-pipelines.yml")))
		ciConfigs.push("azure-pipelines");
	if (existsSync(join(cwd, ".buildkite", "pipeline.yml")))
		ciConfigs.push("buildkite");
	if (existsSync(join(cwd, "Dockerfile"))) ciConfigs.push("dockerfile");

	// Docker-compose: check for CI config AND database services in one pass
	const dcFiles = [
		"docker-compose.yml",
		"docker-compose.yaml",
		"compose.yml",
		"compose.yaml",
	];
	for (const dcFile of dcFiles) {
		const dcPath = join(cwd, dcFile);
		if (!existsSync(dcPath)) continue;
		ciConfigs.push("docker-compose");
		try {
			const content = readFileSync(dcPath, "utf-8").toLowerCase();
			if (!databases) databases = [];
			if (content.includes("postgres") && !databases.includes("postgresql"))
				databases.push("postgresql");
			if (content.includes("mysql") && !databases.includes("mysql"))
				databases.push("mysql");
			if (content.includes("mongo") && !databases.includes("mongodb"))
				databases.push("mongodb");
			if (content.includes("redis") && !databases.includes("redis"))
				databases.push("redis");
			if (content.includes("sqlite") && !databases.includes("sqlite"))
				databases.push("sqlite");
		} catch {
			// Invalid docker-compose, skip DB detection
		}
		break; // Only process first matching docker-compose file
	}

	// Editor config
	if (existsSync(join(cwd, ".editorconfig"))) editorConfig = ".editorconfig";

	// tsconfig strict mode
	const tsconfigPath = join(cwd, "tsconfig.json");
	if (existsSync(tsconfigPath)) {
		try {
			const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
			if (tsconfig.compilerOptions?.strict === true) {
				tsconfigStrict = true;
			}
		} catch {
			// Invalid tsconfig, skip
		}
	}

	// Automation tools
	if (existsSync(join(cwd, "Makefile"))) {
		if (!automationTools) automationTools = [];
		automationTools.push("make");
	}
	if (existsSync(join(cwd, "justfile"))) {
		if (!automationTools) automationTools = [];
		automationTools.push("just");
	}
	if (existsSync(join(cwd, "Taskfile.yml"))) {
		if (!automationTools) automationTools = [];
		automationTools.push("task");
	}
	if (existsSync(join(cwd, "Rakefile"))) {
		if (!automationTools) automationTools = [];
		automationTools.push("rake");
	}

	// .env.example existence
	if (existsSync(join(cwd, ".env.example"))) envExample = true;
	if (existsSync(join(cwd, ".env.sample"))) envExample = true;
	if (existsSync(join(cwd, ".env.template"))) envExample = true;

	// Check if any data was found
	const hasData =
		versionFiles.length > 0 ||
		testRunner ||
		linter ||
		formatter ||
		typescriptVersion ||
		isMonorepo ||
		ciConfigs.length > 0 ||
		editorConfig ||
		npmScripts ||
		databases ||
		tsconfigStrict ||
		automationTools ||
		envExample;

	if (!hasData) return undefined;

	return {
		versionFiles,
		testRunner,
		linter,
		formatter,
		typescriptVersion,
		isMonorepo,
		ciConfigs,
		editorConfig,
		npmScripts,
		databases,
		tsconfigStrict,
		automationTools,
		envExample,
	};
}

/**
 * Detect available development tools and their versions
 *
 * Probes run serially (2 execSync spawns per tool), so detection cost grows
 * linearly with the tool list. Acceptable at session start (~0.5s for ~25
 * tools on a typical Linux box); revisit with async probes only if slow PATH
 * environments (Windows, network mounts) make this measurable in practice.
 */
function detectTools(cwd: string): {
	tools: ToolInfo[];
	preferences: string[];
} {
	const toolDefs: Array<{ name: string; cmd: string; versionArg?: string }> = [
		{ name: "bun", cmd: "bun", versionArg: "--version" },
		{ name: "node", cmd: "node", versionArg: "--version" },
		{ name: "python3", cmd: "python3", versionArg: "--version" },
		{ name: "python", cmd: "python", versionArg: "--version" },
		{ name: "go", cmd: "go", versionArg: "version" },
		{ name: "rustc", cmd: "rustc", versionArg: "--version" },
		{ name: "java", cmd: "java", versionArg: "-version" },
		{ name: "cargo", cmd: "cargo", versionArg: "--version" },
		{ name: "uv", cmd: "uv", versionArg: "--version" },
		{ name: "pip", cmd: "pip", versionArg: "--version" },
		{ name: "docker", cmd: "docker", versionArg: "--version" },
		{ name: "git", cmd: "git", versionArg: "--version" },
		// Modern CLI replacements — faster/better alternatives to classic Unix commands
		{ name: "rg", cmd: "rg", versionArg: "--version" },
		{ name: "ast-grep", cmd: "ast-grep", versionArg: "--version" },
		{ name: "fd", cmd: "fd", versionArg: "--version" },
		{ name: "bat", cmd: "bat", versionArg: "--version" },
		{ name: "eza", cmd: "eza", versionArg: "--version" },
		{ name: "jq", cmd: "jq", versionArg: "--version" },
		{ name: "delta", cmd: "delta", versionArg: "--version" },
		{ name: "sd", cmd: "sd", versionArg: "--version" },
		{ name: "difft", cmd: "difft", versionArg: "--version" },
		{ name: "gh", cmd: "gh", versionArg: "--version" },
		{ name: "tokei", cmd: "tokei", versionArg: "--version" },
		{ name: "yq", cmd: "yq", versionArg: "--version" },
		{ name: "xh", cmd: "xh", versionArg: "--version" },
	];

	const tools: ToolInfo[] = [];

	for (const tool of toolDefs) {
		const path = safeExec(`which ${tool.cmd}`);
		if (!path) continue;

		const rawVersion = safeExec(
			`${tool.cmd} ${tool.versionArg || "--version"}`,
		);
		if (!rawVersion) continue;

		// Extract version number (e.g., "bun 1.1.4" -> "1.1.4", "node v22.0.0" -> "22.0.0")
		// Char class includes ":" so toolchain build metadata is preserved
		// (e.g., "go version go1.27.1-X:nodwarf5" -> "1.27.1-X:nodwarf5")
		const versionMatch = rawVersion.match(/(\d+\.\d+\.\d+[\w.:-]*)/);
		const version = versionMatch?.[1] || rawVersion;

		// Report the probed command name, not the version banner's product
		// name: the tools list tells the model what is invocable on PATH, and
		// a shimmed command (e.g. jq -> jaq) is still invoked as `jq`.
		tools.push({ name: tool.name, version });
	}

	// Source-driven preferences: project context > global availability
	const preferences: string[] = [];
	const has = (name: string) => tools.some((t) => t.name === name);
	const projectCtx = detectProjectContext(cwd);

	// JavaScript runtime preference
	if (projectCtx.js_runtime === "bun" && has("bun")) {
		preferences.push("use bun (project has bun.lockb)");
	} else if (projectCtx.js_runtime === "node") {
		const pm = projectCtx.js_package_manager || "npm";
		preferences.push(`use node with ${pm} (project lockfile detected)`);
	} else if (has("bun") && has("node")) {
		preferences.push("prefer bun over node");
	} else if (has("bun")) {
		preferences.push("use bun");
	}

	// Python tool preference
	if (projectCtx.python_tool === "uv" && has("uv")) {
		preferences.push("use uv (project has pyproject.toml)");
	} else if (projectCtx.python_tool === "pip") {
		preferences.push("use pip (project has requirements.txt)");
	} else if (has("uv") && has("pip")) {
		preferences.push("prefer uv over pip");
	} else if (has("uv")) {
		preferences.push("use uv");
	}

	// Modern CLI preferences: prefer modern replacements over classic Unix commands
	// These tools are faster, more user-friendly, and produce better output
	// Only emit when the modern tool is actually available
	const modernPrefs: Array<[string, string]> = [
		["rg", "grep"],
		["fd", "find"],
		["bat", "cat"],
		["eza", "ls"],
		["sd", "sed"],
	];
	for (const [modern, classic] of modernPrefs) {
		if (has(modern)) {
			preferences.push(`prefer ${modern} over ${classic}`);
		}
	}
	if (has("ast-grep")) {
		preferences.push(
			"prefer ast-grep for structural code search/refactor (pattern syntax: 'console.log($MSG)')",
		);
	}
	if (has("jq")) {
		preferences.push("use jq for JSON processing");
	}
	if (has("delta")) {
		preferences.push("use delta for git diff output");
	}
	if (has("difft")) {
		preferences.push("use difft for structural code diffs");
	}
	if (has("gh")) {
		preferences.push("use gh CLI for GitHub operations");
	}
	if (has("yq")) {
		preferences.push("use yq for YAML/TOML/XML processing");
	}
	if (has("xh")) {
		preferences.push(
			"prefer xh over curl for JSON API requests (use --check-status; output body only with --print=b)",
		);
	}

	return { tools, preferences };
}

/**
 * Detect security context
 */
function detectSecurity(): EnvironmentInfo["security"] {
	const isRoot =
		process.getuid?.() === 0 ||
		(process.platform === "win32" && process.env.USERNAME === "Administrator");
	return { isRoot: !!isRoot };
}

/**
 * Detect XDG base directories that differ from their spec defaults.
 *
 * Per the XDG Base Directory spec, values must be absolute paths; relative
 * or empty values are invalid and ignored. Unset variables fall back to the
 * default ($HOME/.config etc.) and are also omitted — the model already
 * assumes the default, so emitting it would be pure noise.
 */
function detectXdgDirs(): Record<string, string> | undefined {
	const home = os.homedir();
	const vars: Array<[string, string, string]> = [
		["XDG_CONFIG_HOME", "config", join(home, ".config")],
		["XDG_DATA_HOME", "data", join(home, ".local", "share")],
		["XDG_CACHE_HOME", "cache", join(home, ".cache")],
		["XDG_STATE_HOME", "state", join(home, ".local", "state")],
	];

	let dirs: Record<string, string> | undefined;
	for (const [envVar, key, defaultPath] of vars) {
		const value = process.env[envVar];
		if (!value || !isAbsolute(value) || value === defaultPath) continue;
		if (!dirs) dirs = {};
		dirs[key] = value;
	}
	return dirs;
}

/**
 * Escape a string for embedding in XML text or attribute content.
 * Values like XDG paths are user-controlled env vars — raw `&` or `<`
 * would produce malformed XML.
 */
function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Gather all environment information
 */
export function gatherEnvironment(cwd: string): EnvironmentInfo {
	const ci = detectCI();
	const { tools, preferences } = detectTools(cwd);
	const cpu = detectCpu();

	return {
		os: detectOS(),
		cpu: cpu.model,
		cpuThreads: cpu.threads,
		shell: detectShell(),
		isWSL: detectWSL(),
		isDocker: detectDocker(),
		isCI: ci.isCI,
		ciPlatform: ci.platform,
		packageManager: detectPackageManager(cwd),
		isGitRepo: detectGitRepo(cwd),
		tools,
		preferences,
		security: detectSecurity(),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
		locale: process.env.LANG || process.env.LC_ALL || "unknown",
		xdgDirs: detectXdgDirs(),
		projectConfig: detectProjectConfig(cwd),
	};
}

/**
 * Format environment info as XML for system prompt injection
 * Only includes relevant sections to minimize token usage
 */
export function formatEnvironment(info: EnvironmentInfo): string {
	const sections: string[] = [];

	// System — use distro name from os-release on Linux, platform label elsewhere
	const platformLabel = {
		darwin: "macOS",
		win32: "Windows",
	}[info.os.platform];

	// On Linux, info.os.version is the distro name (e.g. "CachyOS Linux")
	// On other platforms, use the platform label + kernel release
	const osDisplay =
		info.os.platform === "linux"
			? info.os.version
			: `${platformLabel || info.os.platform} ${info.os.release}`;

	const systemLines = [
		`<os>${osDisplay} (${info.os.arch})</os>`,
		`<shell>${xmlEscape(info.shell)}</shell>`,
	];
	if (info.cpu) {
		const threads = info.cpuThreads ? `, ${info.cpuThreads} threads` : "";
		systemLines.push(`<cpu>${xmlEscape(info.cpu)}${threads}</cpu>`);
	}

	// Special environments
	const envTags: string[] = [];
	if (info.isWSL) envTags.push("WSL");
	if (info.isDocker) envTags.push("Docker");
	if (info.isCI) envTags.push(`CI:${info.ciPlatform}`);
	if (envTags.length > 0) {
		systemLines.push(
			`<runtime-environment>${envTags.join(",")}</runtime-environment>`,
		);
	}

	sections.push(`<system>\n${systemLines.join("\n")}\n</system>`);

	// Security (only if root)
	if (info.security.isRoot) {
		sections.push(`<security>\n<user>root</user>\n</security>`);
	}

	// Package Manager (if detected)
	if (info.packageManager) {
		sections.push(`<package-manager>${info.packageManager}</package-manager>`);
	}

	// Git repo membership is detected but intentionally not injected —
	// see the isGitRepo note in EnvironmentInfo.

	// Tools (available dev tools with versions)
	if (info.tools.length > 0) {
		const toolLines = info.tools
			.map(
				(t) =>
					`  <tool name="${xmlEscape(t.name)}" version="${xmlEscape(t.version)}"/>`,
			)
			.join("\n");
		sections.push(`<tools>\n${toolLines}\n</tools>`);
	}

	// Preferences (based on available tools)
	if (info.preferences.length > 0) {
		const prefLines = info.preferences
			.map((p) => `  <prefer>${p}</prefer>`)
			.join("\n");
		sections.push(`<preferences>\n${prefLines}\n</preferences>`);
	}

	// Project Config (version files, test runner, linter, etc.)
	if (info.projectConfig) {
		const configLines: string[] = [];

		if (info.projectConfig.versionFiles.length > 0) {
			configLines.push(
				`<version-files>${info.projectConfig.versionFiles.join(", ")}</version-files>`,
			);
		}
		if (info.projectConfig.testRunner) {
			configLines.push(
				`<test-runner>${info.projectConfig.testRunner}</test-runner>`,
			);
		}
		if (info.projectConfig.linter) {
			configLines.push(`<linter>${info.projectConfig.linter}</linter>`);
		}
		if (info.projectConfig.formatter) {
			configLines.push(
				`<formatter>${info.projectConfig.formatter}</formatter>`,
			);
		}
		if (info.projectConfig.typescriptVersion) {
			configLines.push(
				`<typescript>${info.projectConfig.typescriptVersion}</typescript>`,
			);
		}
		if (info.projectConfig.isMonorepo) {
			configLines.push("<monorepo>true</monorepo>");
		}
		if (info.projectConfig.ciConfigs.length > 0) {
			configLines.push(`<ci>${info.projectConfig.ciConfigs.join(", ")}</ci>`);
		}
		if (info.projectConfig.editorConfig) {
			configLines.push(
				`<editor-config>${info.projectConfig.editorConfig}</editor-config>`,
			);
		}
		if (info.projectConfig.tsconfigStrict) {
			configLines.push("<tsconfig-strict>true</tsconfig-strict>");
		}
		if (
			info.projectConfig.npmScripts &&
			info.projectConfig.npmScripts.length > 0
		) {
			configLines.push(
				`<npm-scripts>${info.projectConfig.npmScripts.join(", ")}</npm-scripts>`,
			);
		}
		if (
			info.projectConfig.databases &&
			info.projectConfig.databases.length > 0
		) {
			configLines.push(
				`<databases>${info.projectConfig.databases.join(", ")}</databases>`,
			);
		}
		if (
			info.projectConfig.automationTools &&
			info.projectConfig.automationTools.length > 0
		) {
			configLines.push(
				`<automation>${info.projectConfig.automationTools.join(", ")}</automation>`,
			);
		}
		if (info.projectConfig.envExample) {
			configLines.push("<env-example>true</env-example>");
		}

		if (configLines.length > 0) {
			sections.push(
				`<project-config>\n${configLines.join("\n")}\n</project-config>`,
			);
		}
	}

	// Locale
	sections.push(
		`<locale>\n<timezone>${info.timezone}</timezone>\n<lang>${info.locale}</lang>\n</locale>`,
	);

	// XDG base directories (only non-default values — defaults are assumed)
	if (info.xdgDirs && Object.keys(info.xdgDirs).length > 0) {
		const xdgLines = Object.entries(info.xdgDirs)
			.map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`)
			.join("\n");
		sections.push(`<xdg-base-dirs>\n${xdgLines}\n</xdg-base-dirs>`);
	}

	return `<host-environment>\n${sections.join("\n")}\n</host-environment>`;
}
