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

import { exec, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

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
	// Cgroup memory limit in bytes, only set when the cgroup enforces one.
	// Emitted as a LIMIT, never as "available memory" — the model must not
	// suggest heap sizes or in-memory workloads that exceed it.
	memoryLimitBytes?: number;
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
		// Node version pin source: content of .nvmrc/.node-version, or the
		// `engines.node` range from package.json
		nodeVersion?: string;
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
 * Async counterpart of safeExec for concurrent tool probes
 */
const execAsync = promisify(exec);

async function safeExecAsync(command: string, cwd?: string): Promise<string | undefined> {
	try {
		const { stdout } = await execAsync(command, {
			encoding: "utf-8",
			timeout: 5000,
			cwd,
		});
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Strip // and /* *​/ comments plus trailing commas from JSON-derived config
 * content so JSON.parse succeeds on JSONC dialects (tsconfig allows both).
 * Underscore-escape the comment terminator in this doc comment only.
 */
function stripJsonc(content: string): string {
	// Replace comments with spaces to keep string offsets stable
	let out = "";
	let i = 0;
	let inString = false;
	while (i < content.length) {
		const ch = content[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				// copy escaped char verbatim
				if (i + 1 < content.length) out += content[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && content[i + 1] === "/") {
			// line comment: keep a placeholder so offsets stay aligned
			while (i < content.length && content[i] !== "\n") {
				out += " ";
				i++;
			}
			continue;
		}
		if (ch === "/" && content[i + 1] === "*") {
			while (i < content.length) {
				const c = content[i];
				out += " ";
				i++;
				if (c === "*" && content[i] === "/") {
					out += " ";
					i++;
					break;
				}
			}
			continue;
		}
		out += ch;
		i++;
	}
	// Trailing commas: ",}" or ",]" (whitespace tolerated)
	return out.replace(/,(\s*[}\]])/g, "$1");
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

// cgroup v1 reports this sentinel-ish value when no memory limit is set.
// 2 ** 60, not 1 << 60: bitwise ops coerce to int32, so 1 << 60 === 1 << 28.
const CGROUP_V1_MEM_UNLIMITED = 2 ** 60;

/**
 * Pure parsers for cgroup values — exported for tests. Filesystem probing
 * lives in the cgroup*Limit() wrappers so tests never touch /sys/fs/cgroup.
 */
export function parseCpuQuotaV2(content: string): number | undefined {
	const [quota, period] = content.trim().split(/\s+/);
	if (quota === "max") return undefined;
	const q = Number(quota);
	const p = Number(period);
	// Math.floor so we never suggest more parallelism than the quota allows
	if (q > 0 && p > 0) return Math.max(1, Math.floor(q / p));
	return undefined;
}

export function parseCpuQuotaV1(quotaRaw: string, periodRaw: string): number | undefined {
	const quota = Number(quotaRaw.trim());
	const period = Number(periodRaw.trim());
	if (quota > 0 && period > 0) return Math.max(1, Math.floor(quota / period));
	return undefined;
}

export function parseMemoryLimitV2(content: string): number | undefined {
	const v = content.trim();
	if (v === "max") return undefined;
	const bytes = Number(v);
	return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

export function parseMemoryLimitV1(content: string): number | undefined {
	const bytes = Number(content.trim());
	if (Number.isFinite(bytes) && bytes > 0 && bytes < CGROUP_V1_MEM_UNLIMITED) {
		return bytes;
	}
	return undefined;
}

/** Format a byte count as KiB/MiB/GiB for the prompt */
export function formatBytes(bytes: number): string {
	const mib = bytes / (1024 * 1024);
	if (mib >= 1024) {
		const gib = mib / 1024;
		return `${Number.isInteger(gib) ? gib : gib.toFixed(1)}GiB`;
	}
	if (mib >= 1) return `${Math.round(mib)}MiB`;
	// Sub-MiB limits exist (tiny CI containers) — don't round them up
	if (bytes >= 1024) return `${Math.round(bytes / 1024)}KiB`;
	return `${bytes}B`;
}

/**
 * Read the cgroup CPU quota in whole CPUs, if a quota is set.
 * Handles cgroup v2 (cpu.max) and v1 (cpu.cfs_quota_us/cpu.cfs_period_us).
 * Returns undefined when no quota applies ("max", -1, unreadable files).
 */
function cgroupCpuLimit(): number | undefined {
	// cgroup v2: if the file exists, its content decides — don't fall through
	// to v1 on a v2 hierarchy with no quota set
	try {
		return parseCpuQuotaV2(readFileSync("/sys/fs/cgroup/cpu.max", "utf-8"));
	} catch {
		// not v2, try v1
	}
	try {
		return parseCpuQuotaV1(
			readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf-8"),
			readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf-8"),
		);
	} catch {
		// no cgroup v1 cpu controller either
	}
	return undefined;
}

/**
 * Read the cgroup memory limit in bytes, if one is enforced.
 * Same v2/v1 split as cgroupCpuLimit. Returns undefined when unlimited.
 */
function cgroupMemoryLimit(): number | undefined {
	try {
		return parseMemoryLimitV2(readFileSync("/sys/fs/cgroup/memory.max", "utf-8"));
	} catch {
		// not v2, try v1
	}
	try {
		return parseMemoryLimitV1(readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf-8"));
	} catch {
		// no cgroup v1 memory controller either
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
 * Detect if running inside WSL (Windows Subsystem for Linux)
 */
function detectWSL(): boolean {
	if (process.platform !== "linux") return false;
	try {
		const release = readFileSync("/proc/sys/kernel/osrelease", "utf-8").toLowerCase();
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
		// /.dockerenv: Docker; /run/.containerenv: Podman
		if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) {
			return true;
		}
		// OCI runtimes (podman, systemd-nspawn) set $container inside the guest;
		// on cgroup v2 hosts /proc/1/cgroup is just "0::/" with no marker
		if (process.env.container) return true;
		const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
		return (
			cgroup.includes("docker") ||
			cgroup.includes("containerd") ||
			cgroup.includes("kubepods") ||
			cgroup.includes("libpod")
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
		if (process.env.GITHUB_ACTIONS) return { isCI: true, platform: "GitHub Actions" };
		if (process.env.GITLAB_CI) return { isCI: true, platform: "GitLab CI" };
		if (process.env.CIRCLECI) return { isCI: true, platform: "CircleCI" };
		if (process.env.TRAVIS) return { isCI: true, platform: "Travis CI" };
		if (process.env.JENKINS_URL) return { isCI: true, platform: "Jenkins" };
		if (process.env.AZURE_PIPELINES) return { isCI: true, platform: "Azure Pipelines" };
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
		["deno.lock", "deno"],
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

	// packageManager field is the project's own declaration and wins over
	// lockfile inference (lock files can be stale after a pm switch)
	const pkgJsonPath = join(cwd, "package.json");
	// Static membership table for managers this extension knows how to
	// recommend; unknown declared names fall through to lockfile inference
	const IS_SUPPORTED_PM: Record<string, true> = {
		npm: true,
		pnpm: true,
		yarn: true,
		bun: true,
	};
	let declaredPackageManager: string | undefined;
	if (existsSync(pkgJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
			if (typeof pkg.packageManager === "string") {
				// "pnpm@9.1.0" -> "pnpm"; keep the name only
				const name = pkg.packageManager.split("@")[0];
				if (IS_SUPPORTED_PM[name]) {
					declaredPackageManager = name;
				}
			}
		} catch {
			// Invalid package.json, fall through to lockfile inference
		}
	}

	if (declaredPackageManager === "bun") {
		context.js_runtime = "bun";
		context.pm_source = "declared";
	} else if (declaredPackageManager) {
		context.js_runtime = "node";
		context.js_package_manager = declaredPackageManager;
		context.pm_source = "declared";
	} else if (
		existsSync(join(cwd, "deno.json")) ||
		existsSync(join(cwd, "deno.jsonc")) ||
		existsSync(join(cwd, "deno.lock"))
	) {
		context.js_runtime = "deno";
	} else if (
		existsSync(join(cwd, "bun.lockb")) ||
		existsSync(join(cwd, "bun.lock")) ||
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
	} else if (existsSync(pkgJsonPath)) {
		context.js_runtime = "node";
	}

	if (existsSync(join(cwd, "uv.lock")) || existsSync(join(cwd, "pyproject.toml"))) {
		context.python_tool = "uv";
	} else if (existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "setup.py"))) {
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
	let nodeVersion: string | undefined;
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
	if (existsSync(join(cwd, ".node-version"))) versionFiles.push(".node-version");
	if (existsSync(join(cwd, ".tool-versions"))) versionFiles.push(".tool-versions");
	if (existsSync(join(cwd, ".python-version"))) versionFiles.push(".python-version");
	if (existsSync(join(cwd, ".ruby-version"))) versionFiles.push(".ruby-version");
	if (existsSync(join(cwd, ".go-version"))) versionFiles.push(".go-version");
	if (existsSync(join(cwd, "rust-toolchain.toml"))) versionFiles.push("rust-toolchain.toml");

	// Test runners (check package.json and config files)
	const pkgJsonPath = join(cwd, "package.json");

	// Node version pin: file takes precedence over package.json engines
	for (const pinFile of [".nvmrc", ".node-version"]) {
		const pinPath = join(cwd, pinFile);
		if (existsSync(pinPath)) {
			try {
				const pin = readFileSync(pinPath, "utf-8").trim();
				// Only meaningful pins; skip comment-only or empty files
				if (pin && !pin.startsWith("#")) {
					nodeVersion = pin;
					break;
				}
			} catch {
				// unreadable pin file, keep trying others
			}
		}
	}

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

			// Node version range from engines when no pin file was found
			if (!nodeVersion && typeof pkg.engines?.node === "string" && pkg.engines.node) {
				nodeVersion = pkg.engines.node;
			}

			// Monorepo detection
			if (pkg.workspaces) isMonorepo = true;

			// npm scripts (common ones that help the model). Cap the list so a
			// script-heavy package.json cannot bloat the prompt; the omitted
			// count keeps the model aware there are more.
			if (pkg.scripts && typeof pkg.scripts === "object") {
				const scriptNames = Object.keys(pkg.scripts);
				if (scriptNames.length > 0) {
					const MAX_NPM_SCRIPTS = 20;
					if (scriptNames.length > MAX_NPM_SCRIPTS) {
						npmScripts = [
							...scriptNames.slice(0, MAX_NPM_SCRIPTS),
							`+${scriptNames.length - MAX_NPM_SCRIPTS} more`,
						];
					} else {
						npmScripts = scriptNames;
					}
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

	if (!formatter && existsSync(join(cwd, ".prettierrc"))) formatter = "prettier";
	if (!formatter && existsSync(join(cwd, ".prettierrc.json"))) formatter = "prettier";
	if (!formatter && existsSync(join(cwd, ".prettierrc.js"))) formatter = "prettier";
	if (!formatter && existsSync(join(cwd, "prettier.config.js"))) formatter = "prettier";
	if (!formatter && existsSync(join(cwd, "biome.json"))) formatter = "biome";
	if (!formatter && existsSync(join(cwd, "biome.jsonc"))) formatter = "biome";

	// Monorepo detection (other patterns)
	if (existsSync(join(cwd, "pnpm-workspace.yaml"))) isMonorepo = true;
	if (existsSync(join(cwd, "nx.json"))) isMonorepo = true;
	if (existsSync(join(cwd, "turbo.json"))) isMonorepo = true;
	if (existsSync(join(cwd, "lerna.json"))) isMonorepo = true;

	// CI config files
	if (existsSync(join(cwd, ".github", "workflows"))) ciConfigs.push("github-actions");
	if (existsSync(join(cwd, ".gitlab-ci.yml"))) ciConfigs.push("gitlab-ci");
	if (existsSync(join(cwd, "Jenkinsfile"))) ciConfigs.push("jenkins");
	if (existsSync(join(cwd, ".circleci", "config.yml"))) ciConfigs.push("circleci");
	if (existsSync(join(cwd, ".travis.yml"))) ciConfigs.push("travis");
	if (existsSync(join(cwd, "azure-pipelines.yml"))) ciConfigs.push("azure-pipelines");
	if (existsSync(join(cwd, ".buildkite", "pipeline.yml"))) ciConfigs.push("buildkite");
	if (existsSync(join(cwd, "Dockerfile"))) ciConfigs.push("dockerfile");

	// Docker-compose: check for CI config AND database services in one pass
	const dcFiles = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
	for (const dcFile of dcFiles) {
		const dcPath = join(cwd, dcFile);
		if (!existsSync(dcPath)) continue;
		ciConfigs.push("docker-compose");
		try {
			const content = readFileSync(dcPath, "utf-8").toLowerCase();
			if (!databases) databases = [];
			if (content.includes("postgres") && !databases.includes("postgresql"))
				databases.push("postgresql");
			if (content.includes("mysql") && !databases.includes("mysql")) databases.push("mysql");
			if (content.includes("mongo") && !databases.includes("mongodb")) databases.push("mongodb");
			if (content.includes("redis") && !databases.includes("redis")) databases.push("redis");
			if (content.includes("sqlite") && !databases.includes("sqlite")) databases.push("sqlite");
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
			// tsconfig allows comments and trailing commas (JSONC dialect)
			const tsconfig = JSON.parse(stripJsonc(readFileSync(tsconfigPath, "utf-8")));
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
		nodeVersion ||
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
		nodeVersion,
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
 * All probes run concurrently (Promise.all over the whole list): the version
 * call itself proves PATH presence, so no separate `which` pass is needed
 * and total wall time is the slowest probe instead of the sum.
 */
async function detectTools(cwd: string): Promise<{
	tools: ToolInfo[];
	preferences: string[];
}> {
	const toolDefs: Array<{
		name: string;
		cmd: string;
		versionArg?: string;
		versionToStderr?: boolean;
	}> = [
		{ name: "bun", cmd: "bun", versionArg: "--version" },
		{ name: "node", cmd: "node", versionArg: "--version" },
		// python and python3 are probed concurrently; the version-match
		// post-filter below keeps both only when they differ
		{ name: "python3", cmd: "python3", versionArg: "--version" },
		{ name: "python", cmd: "python", versionArg: "--version" },
		{ name: "deno", cmd: "deno", versionArg: "--version" },
		{ name: "go", cmd: "go", versionArg: "version" },
		{ name: "rustc", cmd: "rustc", versionArg: "--version" },
		// java prints its version banner to stderr, not stdout
		{
			name: "java",
			cmd: "java",
			versionArg: "-version",
			versionToStderr: true,
		},
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
		{ name: "fzf", cmd: "fzf", versionArg: "--version" },
		{ name: "shellcheck", cmd: "shellcheck", versionArg: "--version" },
		{ name: "delta", cmd: "delta", versionArg: "--version" },
		{ name: "sd", cmd: "sd", versionArg: "--version" },
		{ name: "difft", cmd: "difft", versionArg: "--version" },
		{ name: "gh", cmd: "gh", versionArg: "--version" },
		{ name: "yq", cmd: "yq", versionArg: "--version" },
		{ name: "xh", cmd: "xh", versionArg: "--version" },
	];

	const probed = await Promise.all(
		toolDefs.map(async (tool) => {
			const rawVersion = await safeExecAsync(
				`${tool.cmd} ${tool.versionArg || "--version"}${tool.versionToStderr ? " 2>&1" : ""}`,
			);
			if (!rawVersion) return undefined;

			// Extract version number (e.g., "bun 1.1.4" -> "1.1.4", "node v22.0.0" -> "22.0.0")
			// Char class includes ":" so toolchain build metadata is preserved
			// (e.g., "go version go1.27.1-X:nodwarf5" -> "1.27.1-X:nodwarf5")
			const versionMatch = rawVersion.match(/(\d+\.\d+\.\d+[\w.:-]*)/);
			const version = versionMatch?.[1] || rawVersion;

			// Report the probed command name, not the version banner's product
			// name: the tools list tells the model what is invocable on PATH, and
			// a shimmed command (e.g. jq -> jaq) is still invoked as `jq`.
			return { name: tool.name, version };
		}),
	);

	// Promise.all preserves toolDefs order, so output is stable for prompt
	// caching. Drop `python` only when `python3` reported the same version:
	// both names exist as separate binaries in some setups (e.g. a venv-only
	// `python`), and then both entries carry information.
	const python3 = probed.find((p) => p?.name === "python3");
	const tools: ToolInfo[] = probed.filter(
		(p): p is ToolInfo =>
			p !== undefined && !(p.name === "python" && python3 && python3.version === p.version),
	);

	// Source-driven preferences: project context > global availability
	const preferences: string[] = [];
	const has = (name: string) => tools.some((t) => t.name === name);
	const projectCtx = detectProjectContext(cwd);

	// JavaScript runtime preference: branch on what the project needs first,
	// then say whether the toolchain to run it is actually present.
	// Prohibitive phrasing is deliberate: guides for coding agents recommend
	// stating what NOT to use as clearly as what to use, because a bare
	// package.json otherwise pulls models toward `npm install` defaults.
	if (projectCtx.js_runtime === "bun") {
		if (has("bun")) {
			preferences.push(
				projectCtx.pm_source === "declared"
					? "use bun for JS deps and scripts (declared in package.json packageManager); do not use node/npm/yarn here"
					: "use bun for JS deps and scripts (project has bun lockfile); do not use node/npm/yarn here",
			);
		} else {
			preferences.push("this is a bun project but bun is not installed on PATH");
		}
	} else if (projectCtx.js_runtime === "deno") {
		if (has("deno")) {
			preferences.push("use deno (project has deno.json or deno.lock); do not use node/npm here");
		} else {
			preferences.push("this is a Deno project but deno is not installed on PATH");
		}
	} else if (projectCtx.js_runtime === "node") {
		const pm = projectCtx.js_package_manager || "npm";
		const nodeOk = has("node");
		const pmOk = pm === "npm" ? nodeOk : has(pm);
		const others = ["npm", "pnpm", "yarn"].filter((m) => m !== pm).join(" or ");
		if (nodeOk && pmOk) {
			preferences.push(
				projectCtx.pm_source === "declared"
					? `use node with ${pm} for JS deps and scripts (declared in package.json packageManager); do not use ${others} here`
					: `use node with ${pm} for JS deps and scripts (project lockfile detected); do not use ${others} here`,
			);
		} else if (!nodeOk) {
			preferences.push(`this project needs node and ${pm} but node is not installed on PATH`);
		} else {
			preferences.push(
				`node is installed but ${pm} is not on PATH; install it before running install scripts`,
			);
		}
	} else if (has("bun") && has("node")) {
		preferences.push("prefer bun over node");
	} else if (has("bun")) {
		preferences.push("use bun");
	}

	// Python tool preference
	if (projectCtx.python_tool === "uv" && has("uv")) {
		preferences.push(
			"use uv for Python deps and envs (project has pyproject.toml); do not use bare pip here",
		);
	} else if (projectCtx.python_tool === "pip") {
		preferences.push(
			"use pip for Python deps (project has requirements.txt); do not use uv/poetry here",
		);
	} else if (has("uv") && has("pip")) {
		preferences.push("prefer uv over pip");
	} else if (has("uv")) {
		preferences.push("use uv");
	}

	// Modern CLI preferences: role-scoped directives with the caveats that
	// matter for agent execution. Emitted only when the tool is actually
	// available; the classic tool remains valid when the modern one is not
	// (the "instead of" phrasing is scoped to the named role, not a blanket
	// ban on the classic command's other uses).
	const modernPrefs: Array<[string, string, string]> = [
		[
			"rg",
			"grep",
			"text search (recursive, respects .gitignore); pass an explicit path or file list to avoid stdin fallback in sandboxed environments",
		],
		["fd", "find", "file and directory lookup (respects .gitignore)"],
		["bat", "cat", "reading files (syntax-highlighted, paged)"],
		["eza", "ls", "directory listing (icons, git status columns)"],
		["sd", "sed", "find-and-replace on text"],
	];
	for (const [modern, classic, role] of modernPrefs) {
		if (has(modern)) {
			preferences.push(`use ${modern} instead of ${classic} for ${role}`);
		}
	}
	if (has("ast-grep")) {
		preferences.push(
			"use ast-grep instead of grep/sed for structural code search and refactor (pattern syntax: 'console.log($MSG)'); exit code 1 means no matches, not failure",
		);
	}
	if (has("jq")) {
		preferences.push("use jq instead of grep/sed for JSON processing");
	}
	if (has("fzf")) {
		preferences.push(
			"use fzf only in non-interactive mode with `--filter=QUERY` (add `--no-sort` when input order matters); never invoke interactive fzf in agent commands — it waits on a TTY that is not there and hangs",
		);
	}
	if (has("shellcheck")) {
		preferences.push(
			"run shellcheck on any shell script you write or edit before considering it done; agent-authored shell is a common source of quoting and word-splitting bugs",
		);
	}
	if (has("delta")) {
		preferences.push(
			"use delta instead of raw git diff output (set it as the core.pager or use `git diff | delta`)",
		);
	}
	if (has("difft")) {
		preferences.push("use difft instead of plain diff for structural code diffs");
	}
	if (has("gh")) {
		preferences.push("use gh instead of raw API calls for GitHub operations");
	}
	if (has("yq")) {
		preferences.push("use yq instead of sed/awk for YAML/TOML/XML processing");
	}
	if (has("xh")) {
		preferences.push(
			"use xh instead of curl for JSON API requests (add --check-status; print body only with --print=b)",
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
 * formatEnvironment applies it to every interpolated value: sources include
 * user-controlled env vars (SHELL, LANG, XDG vars), /etc/os-release, and
 * package.json fields — raw `&`, `<`, or quotes would produce malformed XML.
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
export async function gatherEnvironment(cwd: string): Promise<EnvironmentInfo> {
	const ci = detectCI();
	const { tools, preferences } = await detectTools(cwd);
	const cpu = detectCpu();

	return {
		os: detectOS(),
		cpu: cpu.model,
		cpuThreads: cpu.threads,
		memoryLimitBytes: cgroupMemoryLimit(),
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

	const systemLines = [`<os>${xmlEscape(osDisplay)} (${info.os.arch})</os>`];
	if (info.cpu) {
		const threads = info.cpuThreads ? `, ${info.cpuThreads} threads` : "";
		systemLines.push(`<cpu>${xmlEscape(info.cpu)}${threads}</cpu>`);
	}
	// Explicitly labeled as a LIMIT so the model doesn't read it as
	// available/free memory
	if (info.memoryLimitBytes) {
		systemLines.push(
			`<memory-limit>${formatBytes(info.memoryLimitBytes)} (cgroup limit)</memory-limit>`,
		);
	}

	// Special environments
	const envTags: string[] = [];
	if (info.isWSL) envTags.push("WSL");
	if (info.isDocker) envTags.push("Docker");
	if (info.isCI) envTags.push(`CI:${info.ciPlatform}`);
	if (envTags.length > 0) {
		systemLines.push(`<runtime-environment>${xmlEscape(envTags.join(","))}</runtime-environment>`);
	}

	sections.push(`<system>\n${systemLines.join("\n")}\n</system>`);

	// Security (only if root)
	if (info.security.isRoot) {
		sections.push(`<security>\n<user>root</user>\n</security>`);
	}

	// Package Manager (if detected)
	if (info.packageManager) {
		sections.push(`<package-manager>${xmlEscape(info.packageManager)}</package-manager>`);
	}

	// Git repo membership is detected but intentionally not injected —
	// see the isGitRepo note in EnvironmentInfo.

	// Tools (available dev tools with versions)
	if (info.tools.length > 0) {
		const toolLines = info.tools
			.map((t) => `  <tool name="${xmlEscape(t.name)}" version="${xmlEscape(t.version)}"/>`)
			.join("\n");
		sections.push(`<tools>\n${toolLines}\n</tools>`);
	}

	// Preferences (based on available tools)
	if (info.preferences.length > 0) {
		const prefLines = info.preferences.map((p) => `  <prefer>${xmlEscape(p)}</prefer>`).join("\n");
		sections.push(`<preferences>\n${prefLines}\n</preferences>`);
	}

	// Project Config (version files, test runner, linter, etc.)
	if (info.projectConfig) {
		const configLines: string[] = [];

		if (info.projectConfig.versionFiles.length > 0) {
			configLines.push(
				`<version-files>${xmlEscape(info.projectConfig.versionFiles.join(", "))}</version-files>`,
			);
		}
		if (info.projectConfig.nodeVersion) {
			configLines.push(`<node-version>${xmlEscape(info.projectConfig.nodeVersion)}</node-version>`);
		}
		if (info.projectConfig.testRunner) {
			configLines.push(`<test-runner>${xmlEscape(info.projectConfig.testRunner)}</test-runner>`);
		}
		if (info.projectConfig.linter) {
			configLines.push(`<linter>${xmlEscape(info.projectConfig.linter)}</linter>`);
		}
		if (info.projectConfig.formatter) {
			configLines.push(`<formatter>${xmlEscape(info.projectConfig.formatter)}</formatter>`);
		}
		if (info.projectConfig.typescriptVersion) {
			configLines.push(
				`<typescript>${xmlEscape(info.projectConfig.typescriptVersion)}</typescript>`,
			);
		}
		if (info.projectConfig.isMonorepo) {
			configLines.push("<monorepo>true</monorepo>");
		}
		if (info.projectConfig.ciConfigs.length > 0) {
			configLines.push(`<ci>${xmlEscape(info.projectConfig.ciConfigs.join(", "))}</ci>`);
		}
		if (info.projectConfig.editorConfig) {
			configLines.push(
				`<editor-config>${xmlEscape(info.projectConfig.editorConfig)}</editor-config>`,
			);
		}
		if (info.projectConfig.tsconfigStrict) {
			configLines.push("<tsconfig-strict>true</tsconfig-strict>");
		}
		if (info.projectConfig.npmScripts && info.projectConfig.npmScripts.length > 0) {
			configLines.push(
				`<npm-scripts>${xmlEscape(info.projectConfig.npmScripts.join(", "))}</npm-scripts>`,
			);
		}
		if (info.projectConfig.databases && info.projectConfig.databases.length > 0) {
			configLines.push(
				`<databases>${xmlEscape(info.projectConfig.databases.join(", "))}</databases>`,
			);
		}
		if (info.projectConfig.automationTools && info.projectConfig.automationTools.length > 0) {
			configLines.push(
				`<automation>${xmlEscape(info.projectConfig.automationTools.join(", "))}</automation>`,
			);
		}
		if (info.projectConfig.envExample) {
			configLines.push("<env-example>true</env-example>");
		}

		if (configLines.length > 0) {
			sections.push(`<project-config>\n${configLines.join("\n")}\n</project-config>`);
		}
	}

	// Locale
	sections.push(
		`<locale>\n<timezone>${xmlEscape(info.timezone)}</timezone>\n<lang>${xmlEscape(info.locale)}</lang>\n</locale>`,
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
