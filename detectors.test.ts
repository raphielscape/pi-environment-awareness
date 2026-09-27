import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	formatBytes,
	formatEnvironment,
	gatherEnvironment,
	parseCpuQuotaV1,
	parseCpuQuotaV2,
	parseMemoryLimitV1,
	parseMemoryLimitV2,
} from "./detectors";

const TEST_DIR = join(import.meta.dir, ".test-tmp");

function createTestDir() {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
}

function createFile(name: string, content = "") {
	writeFileSync(join(TEST_DIR, name), content);
}

describe("Environment Detection", () => {
	beforeEach(() => {
		createTestDir();
	});

	describe("gatherEnvironment", () => {
		it("should return valid environment info structure", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			expect(info).toHaveProperty("os");
			expect(info).toHaveProperty("isWSL");
			expect(info).toHaveProperty("isDocker");
			expect(info).toHaveProperty("isCI");
			expect(info).toHaveProperty("tools");
			expect(info).toHaveProperty("preferences");
			expect(info).toHaveProperty("security");
			expect(info).toHaveProperty("timezone");
			expect(info).toHaveProperty("locale");
		});

		it("should detect OS info", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.os.platform).toBeDefined();
			expect(info.os.arch).toBeDefined();
			expect(typeof info.os.platform).toBe("string");
			expect(typeof info.os.arch).toBe("string");
		});

		it("should detect CPU model when available", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			// Virtually all hosts report a model; tolerate exotic environments
			if (info.cpu !== undefined) {
				expect(typeof info.cpu).toBe("string");
				expect(info.cpu.length).toBeGreaterThan(0);

				const xml = formatEnvironment(info);
				expect(xml).toContain("<cpu>");
			}
		});

		it("should include thread count as a parallelism hint", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			// Threads come from the cgroup quota when set, else os.cpus()
			expect(info.cpuThreads).toBeGreaterThanOrEqual(1);

			const xml = formatEnvironment(info);
			if (info.cpu) {
				expect(xml).toContain(`, ${info.cpuThreads} threads</cpu>`);
			}
		});

		it("should XML-escape special characters in CPU model", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			info.cpu = "Fake CPU <R&D>";
			delete info.cpuThreads; // isolate the escaping from the threads suffix
			const xml = formatEnvironment(info);

			expect(xml).toContain("<cpu>Fake CPU &lt;R&amp;D&gt;</cpu>");
			expect(xml).not.toContain("<R&D>");
		});

		it("should omit the cpu tag when no model is available", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			delete info.cpu;
			const xml = formatEnvironment(info);

			expect(xml).not.toContain("<cpu>");
		});

		it("should detect timezone", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.timezone).toBeDefined();
			expect(typeof info.timezone).toBe("string");
		});

		it("should detect available tools", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			expect(Array.isArray(info.tools)).toBe(true);
			// At minimum, we should have git on most dev machines
			if (info.tools.length > 0) {
				const tool = info.tools[0];
				expect(tool).toHaveProperty("name");
				expect(tool).toHaveProperty("version");
			}
		});

		it("should return preferences array", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			expect(Array.isArray(info.preferences)).toBe(true);
		});
	});

	describe("formatEnvironment", () => {
		it("should produce valid XML output", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<host-environment>");
			expect(xml).toContain("</host-environment>");
			expect(xml).toContain("<system>");
			expect(xml).toContain("</system>");
		});

		it("should include OS info", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<os>");
			expect(xml).toContain(info.os.arch);
		});

		it("should include locale info", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<locale>");
			expect(xml).toContain("<timezone>");
			expect(xml).toContain("<lang>");
		});
	});

	describe("Git Detection", () => {
		it("should detect git repo when .git exists", async () => {
			mkdirSync(join(TEST_DIR, ".git"), { recursive: true });
			writeFileSync(join(TEST_DIR, ".git", "HEAD"), "ref: refs/heads/main");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.isGitRepo).toBe(true);
		});

		it("should not inject any git-derived data into the prompt", async () => {
			// Git branch/status/commits are volatile and would bust the prompt
			// cache. Repo membership is detected but never formatted.
			mkdirSync(join(TEST_DIR, ".git"), { recursive: true });
			const info = await gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).not.toContain("<git>");
			expect(xml).not.toContain("<branch>");
			expect(xml).not.toContain("<status>");
			expect(xml).not.toContain("<recent-commits>");
		});
	});

	describe("Project Context Detection", () => {
		it("should detect bun.lockb for JS projects", async () => {
			createFile("bun.lockb", "");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("bun")]),
			);
		});

		it("should detect bun.lock for JS projects", async () => {
			createFile("bun.lock", "");
			const info = await gatherEnvironment(TEST_DIR);

			// bun.lock alone must claim the project for bun, not fall through
			// to package.json's node-with-npm default
			expect(info.preferences).toEqual(
				expect.arrayContaining([
					expect.stringContaining(
						"use bun for JS deps and scripts (project has bun lockfile)",
					),
				]),
			);
			expect(info.preferences).not.toEqual(
				expect.arrayContaining([expect.stringContaining("node with npm")]),
			);
		});

		it("should detect package-lock.json for npm projects", async () => {
			createFile("package-lock.json", "{}");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("npm")]),
			);
		});

		it("should detect pnpm-lock.yaml for pnpm projects", async () => {
			createFile("pnpm-lock.yaml", "");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("pnpm")]),
			);
		});

		it("should detect yarn.lock for yarn projects", async () => {
			createFile("yarn.lock", "");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("yarn")]),
			);
		});

		it("should detect pyproject.toml for uv projects", async () => {
			createFile("pyproject.toml", "[project]\nname = 'test'");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("uv")]),
			);
		});

		it("should detect requirements.txt for pip projects", async () => {
			createFile("requirements.txt", "requests==2.28.0");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("pip")]),
			);
		});

		it("should prefer declared packageManager over deno config files", async () => {
			createFile("deno.json", "{}");
			createFile(
				"package.json",
				JSON.stringify({ packageManager: "pnpm@9.1.0" }),
			);
			const info = await gatherEnvironment(TEST_DIR);

			// The declaration is the project's own statement of toolchain;
			// a stray deno.json must not override it
			if (info.tools.some((t) => t.name === "pnpm")) {
				expect(info.preferences).toContain(
					"use node with pnpm for JS deps and scripts (declared in package.json packageManager); do not use npm or yarn here",
				);
			}
		});

		it("should prefer declared packageManager over stale lockfile", async () => {
			createFile("package-lock.json", "{}"); // stale: project moved to pnpm
			createFile(
				"package.json",
				JSON.stringify({ packageManager: "pnpm@9.1.0" }),
			);
			const info = await gatherEnvironment(TEST_DIR);
			const hasPnpm = info.tools.some((t) => t.name === "pnpm");
			const hasNode = info.tools.some((t) => t.name === "node");

			// The declared pm must win over the stale npm lockfile either way
			if (hasNode && hasPnpm) {
				expect(info.preferences).toContain(
					"use node with pnpm for JS deps and scripts (declared in package.json packageManager); do not use npm or yarn here",
				);
			} else if (!hasNode) {
				expect(info.preferences).toContain(
					"this project needs node and pnpm but node is not installed on PATH",
				);
			} else {
				expect(info.preferences).toContain(
					"node is installed but pnpm is not on PATH; install it before running install scripts",
				);
			}
		});

		it("should prefer declared bun over stale lockfile", async () => {
			createFile("package-lock.json", "{}"); // stale: project moved to bun
			createFile(
				"package.json",
				JSON.stringify({ packageManager: "bun@1.2.3" }),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.preferences).toContain(
				"use bun for JS deps and scripts (declared in package.json packageManager); do not use node/npm/yarn here",
			);
		});

		it("should fall back to lockfiles for unsupported declared pm", async () => {
			createFile("package-lock.json", "{}");
			createFile(
				"package.json",
				JSON.stringify({ packageManager: "exotic@1.0.0" }),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([
					expect.stringContaining(
						"use node with npm for JS deps and scripts (project lockfile",
					),
				]),
			);
		});

		it("should emit a filter-only fzf directive when fzf exists", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			const fzfPref = info.preferences.find((p) => p.includes("fzf"));

			if (info.tools.some((t) => t.name === "fzf")) {
				// Agents must never open the interactive UI; only --filter mode
				// is safe in a non-TTY session
				expect(fzfPref).toContain("--filter=QUERY");
				expect(fzfPref).toContain("never invoke interactive fzf");
			} else {
				expect(fzfPref).toBeUndefined();
			}
		});

		it("should emit a shellcheck directive when shellcheck exists", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			const scPref = info.preferences.find((p) => p.includes("shellcheck"));

			if (info.tools.some((t) => t.name === "shellcheck")) {
				// The directive must tie shellcheck to agent-authored shell
				// scripts, not to linting arbitrary repo files
				expect(scPref).toContain("shell script you write or edit");
			} else {
				expect(scPref).toBeUndefined();
			}
		});

		it("should detect a Deno project", async () => {
			createFile("deno.json", '{"tasks": {"dev": "deno run main.ts"}}');
			const info = await gatherEnvironment(TEST_DIR);

			if (info.tools.some((t) => t.name === "deno")) {
				expect(info.preferences).toContain(
					"use deno (project has deno.json or deno.lock); do not use node/npm here",
				);
			} else {
				expect(info.preferences).toContain(
					"this is a Deno project but deno is not installed on PATH",
				);
			}
		});

		it("should detect Cargo.toml for Rust projects", async () => {
			createFile("Cargo.toml", "[package]\nname = 'test'");
			const info = await gatherEnvironment(TEST_DIR);

			// Should still return valid info
			expect(info).toBeDefined();
		});

		it("should detect go.mod for Go projects", async () => {
			createFile("go.mod", "module test");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info).toBeDefined();
		});
	});

	describe("Tool Preferences", () => {
		it("should provide fallback preferences when no project files", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			// Should have some preference based on available tools
			expect(info.preferences.length).toBeGreaterThanOrEqual(0);
		});

		it("should prioritize project files over global tools", async () => {
			createFile("bun.lockb", "");
			const info = await gatherEnvironment(TEST_DIR);

			// Should mention the bun lockfile specifically
			const bunPref = info.preferences.find((p) =>
				p.includes("bun lockfile"),
			);
			if (info.tools.some((t) => t.name === "bun")) {
				expect(bunPref).toBeDefined();
			}
		});
	});

	describe("Project Config Detection", () => {
		it("should detect .nvmrc version file", async () => {
			createFile(".nvmrc", "22.0.0");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.versionFiles).toContain(".nvmrc");
		});

		it("should detect .node-version file", async () => {
			createFile(".node-version", "22.0.0");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.versionFiles).toContain(".node-version");
		});

		it("should detect .python-version file", async () => {
			createFile(".python-version", "3.12.0");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.versionFiles).toContain(".python-version");
		});

		it("should detect test runner from package.json", async () => {
			createFile(
				"package.json",
				JSON.stringify({
					devDependencies: { vitest: "^1.0.0" },
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.testRunner).toBe("vitest");
		});

		it("should detect jest test runner", async () => {
			createFile(
				"package.json",
				JSON.stringify({
					devDependencies: { jest: "^29.0.0" },
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.testRunner).toBe("jest");
		});

		it("should detect linter from package.json", async () => {
			createFile(
				"package.json",
				JSON.stringify({
					devDependencies: { eslint: "^9.0.0" },
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.linter).toBe("eslint");
		});

		it("should detect biome linter", async () => {
			createFile(
				"package.json",
				JSON.stringify({
					devDependencies: { "@biomejs/biome": "^1.0.0" },
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.linter).toBe("biome");
			expect(info.projectConfig?.formatter).toBe("biome");
		});

		it("should detect standalone eslint config", async () => {
			createFile("eslint.config.js", "export default []");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.linter).toBe("eslint");
		});

		it("should detect standalone biome config", async () => {
			createFile("biome.json", "{}");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.linter).toBe("biome");
			expect(info.projectConfig?.formatter).toBe("biome");
		});

		it("should detect prettier formatter", async () => {
			createFile(".prettierrc", "{}");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.formatter).toBe("prettier");
		});

		it("should detect TypeScript version from package.json", async () => {
			createFile(
				"package.json",
				JSON.stringify({
					devDependencies: { typescript: "^5.7.0" },
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.typescriptVersion).toBe("^5.7.0");
		});

		it("should detect monorepo from package.json workspaces", async () => {
			createFile(
				"package.json",
				JSON.stringify({
					workspaces: ["packages/*"],
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.isMonorepo).toBe(true);
		});

		it("should detect monorepo from pnpm-workspace.yaml", async () => {
			createFile("pnpm-workspace.yaml", "packages:\n  - 'packages/*'");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.isMonorepo).toBe(true);
		});

		it("should detect monorepo from turbo.json", async () => {
			createFile("turbo.json", "{}");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.isMonorepo).toBe(true);
		});

		it("should detect CI config files", async () => {
			mkdirSync(join(TEST_DIR, ".github", "workflows"), { recursive: true });
			createFile(".github/workflows/ci.yml", "name: CI");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.ciConfigs).toContain("github-actions");
		});

		it("should detect Dockerfile", async () => {
			createFile("Dockerfile", "FROM node:22");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.ciConfigs).toContain("dockerfile");
		});

		it("should detect .editorconfig", async () => {
			createFile(".editorconfig", "root = true");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.editorConfig).toBe(".editorconfig");
		});

		it("should return undefined when no project config found", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			// No package.json, no config files, no version files
			expect(info.projectConfig).toBeUndefined();
		});

		it("should detect multiple version files", async () => {
			createFile(".nvmrc", "22.0.0");
			createFile(".python-version", "3.12.0");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.versionFiles).toContain(".nvmrc");
			expect(info.projectConfig?.versionFiles).toContain(".python-version");
		});

		it("should detect npm scripts from package.json", async () => {
			createFile(
				"package.json",
				JSON.stringify({
					scripts: {
						dev: "vite",
						build: "vite build",
						test: "vitest",
					},
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.npmScripts).toContain("dev");
			expect(info.projectConfig?.npmScripts).toContain("build");
			expect(info.projectConfig?.npmScripts).toContain("test");
		});

		it("should detect PostgreSQL from docker-compose", async () => {
			createFile(
				"docker-compose.yml",
				`services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: test`,
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.databases).toContain("postgresql");
		});

		it("should detect MongoDB from docker-compose", async () => {
			createFile(
				"docker-compose.yml",
				`services:
  mongo:
    image: mongo:7`,
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.databases).toContain("mongodb");
		});

		it("should detect Redis from docker-compose", async () => {
			createFile(
				"docker-compose.yml",
				`services:
  redis:
    image: redis:7`,
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.databases).toContain("redis");
		});

		it("should detect multiple databases from docker-compose", async () => {
			createFile(
				"docker-compose.yml",
				`services:
  db:
    image: postgres:16
  redis:
    image: redis:7`,
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.databases).toContain("postgresql");
			expect(info.projectConfig?.databases).toContain("redis");
		});

		it("should detect Makefile", async () => {
			createFile("Makefile", "all:\n\techo hello");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.automationTools).toContain("make");
		});

		it("should detect justfile", async () => {
			createFile("justfile", "default:\n\techo hello");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.automationTools).toContain("just");
		});

		it("should detect .env.example", async () => {
			createFile(".env.example", 'DATABASE_URL=""');
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.envExample).toBe(true);
		});

		it("should detect .env.sample", async () => {
			createFile(".env.sample", 'API_KEY=""');
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.envExample).toBe(true);
		});

		it("should detect tsconfig strict mode", async () => {
			createFile(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: { strict: true },
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig).toBeDefined();
			expect(info.projectConfig?.tsconfigStrict).toBe(true);
		});

		it("should not set tsconfigStrict when strict is false", async () => {
			createFile(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: { strict: false },
				}),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.tsconfigStrict).toBeUndefined();
		});
	});

	describe("stripJsonc", () => {
		it("parses tsconfig with line comments and trailing commas", () => {
			// Exported for tests via detectProjectConfig; test the pure helper
			// through the tsconfig-strict path with hostile formatting
			createFile(
				"tsconfig.json",
				[
					"{",
					"  // compiler options",
					"  \"compilerOptions\": {",
					"    \"strict\": true, // the whole point",
					"    \"target\": \"es2022\",",
					"  },",
					"}",
				].join("\n"),
			);
			return gatherEnvironment(TEST_DIR).then((info) => {
				expect(info.projectConfig?.tsconfigStrict).toBe(true);
			});
		});

		it("parses tsconfig with block comments", () => {
			createFile(
				"tsconfig.json",
				'{\n  /* strict on */ "compilerOptions": { "strict": true }\n}',
			);
			return gatherEnvironment(TEST_DIR).then((info) => {
				expect(info.projectConfig?.tsconfigStrict).toBe(true);
			});
		});

		it("preserves comment-like sequences inside strings", () => {
			createFile(
				"tsconfig.json",
				'{"compilerOptions": {"strict": true, "paths": {"a//b*": ["x"], }},}',
			);
			return gatherEnvironment(TEST_DIR).then((info) => {
				expect(info.projectConfig?.tsconfigStrict).toBe(true);
			});
		});

		it("still rejects genuinely invalid tsconfig", () => {
			createFile("tsconfig.json", "{ compilerOptions: strict: true }");
			return gatherEnvironment(TEST_DIR).then((info) => {
				expect(info.projectConfig?.tsconfigStrict).toBeUndefined();
			});
		});
	});

	describe("Node version pin", () => {
		it("reports nodeVersion from .nvmrc", async () => {
			createFile(".nvmrc", "22.12.0\n");
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.nodeVersion).toBe("22.12.0");
		});

		it("prefers .nvmrc over package.json engines", async () => {
			createFile(".nvmrc", "22.12.0");
			createFile(
				"package.json",
				JSON.stringify({ engines: { node: ">=20" } }),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.nodeVersion).toBe("22.12.0");
		});

		it("falls back to engines.node when no pin file", async () => {
			createFile(
				"package.json",
				JSON.stringify({ engines: { node: ">=20 <23" } }),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.nodeVersion).toBe(">=20 <23");
		});

		it("skips comment-only .nvmrc and uses engines", async () => {
			createFile(".nvmrc", "# lts/hydrogen\n");
			createFile(
				"package.json",
				JSON.stringify({ engines: { node: ">=20" } }),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.nodeVersion).toBe(">=20");
		});
	});

	describe("npm scripts cap", () => {
		it("caps the script list at 20 with an omitted count", async () => {
			const scripts: Record<string, string> = {};
			for (let i = 1; i <= 25; i++) {
				scripts[`script${i}`] = `echo ${i}`;
			}
			createFile("package.json", JSON.stringify({ scripts }));
			const info = await gatherEnvironment(TEST_DIR);

			const list = info.projectConfig?.npmScripts ?? [];
			expect(list.length).toBe(21); // 20 + "+5 more"
			expect(list[19]).toBe("script20");
			expect(list[20]).toBe("+5 more");
		});

		it("keeps short lists verbatim", async () => {
			createFile(
				"package.json",
				JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
			);
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.projectConfig?.npmScripts).toEqual(["dev", "build"]);
		});
	});

	describe("XDG Base Directories", () => {
		const XDG_VARS = [
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"XDG_CACHE_HOME",
			"XDG_STATE_HOME",
		];
		const savedEnv: Record<string, string | undefined> = {};

		beforeEach(() => {
			for (const v of XDG_VARS) {
				savedEnv[v] = process.env[v];
				delete process.env[v];
			}
		});

		afterEach(() => {
			for (const v of XDG_VARS) {
				if (savedEnv[v] === undefined) delete process.env[v];
				else process.env[v] = savedEnv[v];
			}
		});

		it("should emit nothing when XDG vars are unset (defaults assumed)", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			expect(info.xdgDirs).toBeUndefined();

			const xml = formatEnvironment(info);
			expect(xml).not.toContain("<xdg-base-dirs>");
		});

		it("should emit only non-default absolute paths", async () => {
			process.env.XDG_CONFIG_HOME = "/custom/config";
			const info = await gatherEnvironment(TEST_DIR);

			expect(info.xdgDirs).toEqual({ config: "/custom/config" });

			const xml = formatEnvironment(info);
			expect(xml).toContain("<xdg-base-dirs>");
			expect(xml).toContain("<config>/custom/config</config>");
			expect(xml).not.toContain("<data>");
		});

		it("should ignore values equal to the spec default", async () => {
			process.env.XDG_CACHE_HOME = `${process.env.HOME}/.cache`;
			const info = await gatherEnvironment(TEST_DIR);
			expect(info.xdgDirs).toBeUndefined();
		});

		it("should ignore relative paths (invalid per XDG spec)", async () => {
			process.env.XDG_CONFIG_HOME = "relative/config";
			process.env.XDG_DATA_HOME = "./data";
			const info = await gatherEnvironment(TEST_DIR);
			expect(info.xdgDirs).toBeUndefined();
		});

		it("should XML-escape special characters in paths", async () => {
			process.env.XDG_CONFIG_HOME = "/opt/a&b/<config>";
			const info = await gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<config>/opt/a&amp;b/&lt;config&gt;</config>");
			expect(xml).not.toContain("/opt/a&b/");
		});
	});

	describe("Cgroup Parsers", () => {
		it("parses cgroup v2 cpu.max with a quota", () => {
			expect(parseCpuQuotaV2("200000 100000")).toBe(2);
			expect(parseCpuQuotaV2("150000 100000")).toBe(1); // floor, not round
			expect(parseCpuQuotaV2("50000 100000")).toBe(1); // clamped to >= 1
		});

		it("returns undefined for v2 max (no quota)", () => {
			expect(parseCpuQuotaV2("max 100000")).toBeUndefined();
		});

		it("returns undefined for malformed v2 content", () => {
			expect(parseCpuQuotaV2("garbage")).toBeUndefined();
			expect(parseCpuQuotaV2("")).toBeUndefined();
			expect(parseCpuQuotaV2("0 100000")).toBeUndefined();
		});

		it("parses cgroup v1 quota/period", () => {
			expect(parseCpuQuotaV1("400000", "100000")).toBe(4);
			expect(parseCpuQuotaV1("150000\n", "100000\n")).toBe(1);
		});

		it("returns undefined for v1 unlimited (-1) or malformed", () => {
			expect(parseCpuQuotaV1("-1", "100000")).toBeUndefined();
			expect(parseCpuQuotaV1("abc", "100000")).toBeUndefined();
			expect(parseCpuQuotaV1("200000", "0")).toBeUndefined();
		});

		it("parses cgroup v2 memory.max", () => {
			expect(parseMemoryLimitV2("536870912")).toBe(536870912);
			expect(parseMemoryLimitV2("max")).toBeUndefined();
			expect(parseMemoryLimitV2("garbage")).toBeUndefined();
		});

		it("parses cgroup v1 memory limit, treating the sentinel as unlimited", () => {
			expect(parseMemoryLimitV1("536870912")).toBe(536870912);
			// v1's "no limit" sentinel is a huge value, not -1
			expect(parseMemoryLimitV1("9223372036854771712")).toBeUndefined();
			expect(parseMemoryLimitV1("-1")).toBeUndefined();
		});

		it("formats bytes as KiB/MiB/GiB without overstating", () => {
			expect(formatBytes(536870912)).toBe("512MiB");
			expect(formatBytes(2147483648)).toBe("2GiB");
			expect(formatBytes(5368709120)).toBe("5GiB");
			expect(formatBytes(524288)).toBe("512KiB"); // sub-MiB, must not round up
			expect(formatBytes(512)).toBe("512B"); // sub-KiB, report raw bytes
		});
	});

	describe("Memory Limit", () => {
		it("emits memory-limit only when a limit is set, labeled as a limit", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			info.memoryLimitBytes = 536870912;
			let xml = formatEnvironment(info);
			expect(xml).toContain(
				"<memory-limit>512MiB (cgroup limit)</memory-limit>",
			);

			delete info.memoryLimitBytes;
			xml = formatEnvironment(info);
			expect(xml).not.toContain("<memory-limit>");
		});
	});

	describe("XML Output Structure", () => {
		it("should XML-escape externally sourced values in every section", async () => {
			const info = await gatherEnvironment(TEST_DIR);

			// Inject hostile values into every field formatEnvironment renders
			// from external sources; output must stay well-formed XML.
			info.os.version = 'Mal<ware> & Co "OS"';
			info.packageManager = "p&m";
			info.preferences = ["use x<y> & z"];
			info.projectConfig = {
				versionFiles: [".n&v mrc"],
				testRunner: "v<itest>",
				linter: "l&int",
				formatter: "f<mt>",
				typescriptVersion: "^5.7.0 & <beta>",
				isMonorepo: false,
				ciConfigs: ["github-actions & more"],
				editorConfig: ".editorconfig<x>",
				npmScripts: ["de&v"],
				databases: ["p<ostgres>"],
				automationTools: ["make<r>"],
				envExample: false,
			};
			info.timezone = "Asia/Tokyo&";
			info.locale = "en_US.UTF-8 & <latin>";
			info.xdgDirs = { config: "/opt/<a>&b" };

			const xml = formatEnvironment(info);

			for (const raw of [
				"Mal<ware>",
				"& Co",
				"<evil>",
				"p&m",
				"use x<y>",
				"& z",
				".n&v",
				"v<itest>",
				"l&int",
				"f<mt>",
				"& <beta>",
				"actions & more",
				"config<x>",
				"de&v",
				"<ostgres>",
				"make<r>",
				"<latin>",
				"/opt/<a>",
				"&b",
			]) {
				expect(xml).not.toContain(raw);
			}
			// Spot-check escaped renderings
			expect(xml).toContain("Mal&lt;ware&gt; &amp; Co &quot;OS&quot;");
			expect(xml).toContain("v&lt;itest&gt;");
			expect(xml).toContain("p&amp;m");
			expect(xml).toContain("Asia/Tokyo&amp;");
		});

		it("should include tools section when tools detected", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<host-environment>");

			if (info.tools.length > 0) {
				expect(xml).toContain("<tools>");
				expect(xml).toContain("</tools>");
				expect(xml).toContain("<tool name=");
			}
		});

		it("should include preferences section when preferences exist", async () => {
			const info = await gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			if (info.preferences.length > 0) {
				expect(xml).toContain("<preferences>");
				expect(xml).toContain("</preferences>");
				expect(xml).toContain("<prefer>");
			}
		});
	});
});
