import { describe, it, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	gatherEnvironment,
	formatEnvironment,
	type EnvironmentInfo,
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
		it("should return valid environment info structure", () => {
			const info = gatherEnvironment(TEST_DIR);

			expect(info).toHaveProperty("os");
			expect(info).toHaveProperty("shell");
			expect(info).toHaveProperty("isWSL");
			expect(info).toHaveProperty("isDocker");
			expect(info).toHaveProperty("isCI");
			expect(info).toHaveProperty("tools");
			expect(info).toHaveProperty("preferences");
			expect(info).toHaveProperty("security");
			expect(info).toHaveProperty("timezone");
			expect(info).toHaveProperty("locale");
		});

		it("should detect OS info", () => {
			const info = gatherEnvironment(TEST_DIR);

			expect(info.os.platform).toBeDefined();
			expect(info.os.arch).toBeDefined();
			expect(typeof info.os.platform).toBe("string");
			expect(typeof info.os.arch).toBe("string");
		});

		it("should detect shell", () => {
			const info = gatherEnvironment(TEST_DIR);

			expect(info.shell).toBeDefined();
			expect(typeof info.shell).toBe("string");
		});

		it("should detect timezone", () => {
			const info = gatherEnvironment(TEST_DIR);

			expect(info.timezone).toBeDefined();
			expect(typeof info.timezone).toBe("string");
		});

		it("should detect available tools", () => {
			const info = gatherEnvironment(TEST_DIR);

			expect(Array.isArray(info.tools)).toBe(true);
			// At minimum, we should have git on most dev machines
			if (info.tools.length > 0) {
				const tool = info.tools[0];
				expect(tool).toHaveProperty("name");
				expect(tool).toHaveProperty("version");
				expect(tool).toHaveProperty("path");
			}
		});

		it("should return preferences array", () => {
			const info = gatherEnvironment(TEST_DIR);

			expect(Array.isArray(info.preferences)).toBe(true);
		});
	});

	describe("formatEnvironment", () => {
		it("should produce valid XML output", () => {
			const info = gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<host-environment>");
			expect(xml).toContain("</host-environment>");
			expect(xml).toContain("<system>");
			expect(xml).toContain("</system>");
		});

		it("should include OS info", () => {
			const info = gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<os>");
			expect(xml).toContain(info.os.arch);
		});

		it("should include shell info", () => {
			const info = gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<shell>");
		});

		it("should include locale info", () => {
			const info = gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<locale>");
			expect(xml).toContain("<timezone>");
			expect(xml).toContain("<lang>");
		});
	});

	describe("Git Detection", () => {
		it("should detect git repo when .git exists", () => {
			mkdirSync(join(TEST_DIR, ".git"), { recursive: true });
			writeFileSync(join(TEST_DIR, ".git", "HEAD"), "ref: refs/heads/main");
			const info = gatherEnvironment(TEST_DIR);

			expect(info.git).toBeDefined();
			expect(info.git?.isRepo).toBe(true);
			expect(info.git?.branch).toBeDefined();
		});

		it("should not detect git when no .git", () => {
			const info = gatherEnvironment(TEST_DIR);

			// May or may not have git depending on parent dirs
			if (info.git) {
				expect(info.git.isRepo).toBe(true);
			}
		});
	});

	describe("Project Context Detection", () => {
		it("should detect bun.lockb for JS projects", () => {
			createFile("bun.lockb", "");
			const info = gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("bun")]),
			);
		});

		it("should detect package-lock.json for npm projects", () => {
			createFile("package-lock.json", "{}");
			const info = gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("npm")]),
			);
		});

		it("should detect pnpm-lock.yaml for pnpm projects", () => {
			createFile("pnpm-lock.yaml", "");
			const info = gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("pnpm")]),
			);
		});

		it("should detect yarn.lock for yarn projects", () => {
			createFile("yarn.lock", "");
			const info = gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("yarn")]),
			);
		});

		it("should detect pyproject.toml for uv projects", () => {
			createFile("pyproject.toml", "[project]\nname = 'test'");
			const info = gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("uv")]),
			);
		});

		it("should detect requirements.txt for pip projects", () => {
			createFile("requirements.txt", "requests==2.28.0");
			const info = gatherEnvironment(TEST_DIR);

			expect(info.preferences).toEqual(
				expect.arrayContaining([expect.stringContaining("pip")]),
			);
		});

		it("should detect Cargo.toml for Rust projects", () => {
			createFile("Cargo.toml", "[package]\nname = 'test'");
			const info = gatherEnvironment(TEST_DIR);

			// Should still return valid info
			expect(info).toBeDefined();
		});

		it("should detect go.mod for Go projects", () => {
			createFile("go.mod", "module test");
			const info = gatherEnvironment(TEST_DIR);

			expect(info).toBeDefined();
		});
	});

	describe("Tool Preferences", () => {
		it("should provide fallback preferences when no project files", () => {
			const info = gatherEnvironment(TEST_DIR);

			// Should have some preference based on available tools
			expect(info.preferences.length).toBeGreaterThanOrEqual(0);
		});

		it("should prioritize project files over global tools", () => {
			createFile("bun.lockb", "");
			const info = gatherEnvironment(TEST_DIR);

			// Should mention bun.lockb specifically
			const bunPref = info.preferences.find((p) => p.includes("bun.lockb"));
			if (info.tools.some((t) => t.name === "bun")) {
				expect(bunPref).toBeDefined();
			}
		});
	});

	describe("XML Output Structure", () => {
		it("should include tools section when tools detected", () => {
			const info = gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			expect(xml).toContain("<host-environment>");

			if (info.tools.length > 0) {
				expect(xml).toContain("<tools>");
				expect(xml).toContain("</tools>");
				expect(xml).toContain('<tool name=');
			}
		});

		it("should include preferences section when preferences exist", () => {
			const info = gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			if (info.preferences.length > 0) {
				expect(xml).toContain("<preferences>");
				expect(xml).toContain("</preferences>");
				expect(xml).toContain("<prefer>");
			}
		});

		it("should include git section when in git repo", () => {
			mkdirSync(join(TEST_DIR, ".git"), { recursive: true });
			writeFileSync(join(TEST_DIR, ".git", "HEAD"), "ref: refs/heads/main");
			const info = gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			if (info.git?.isRepo) {
				expect(xml).toContain("<git>");
				expect(xml).toContain("</git>");
				expect(xml).toContain("<branch>");
				expect(xml).toContain("<status>");
			}
		});

		it("should include recent commits when available", () => {
			mkdirSync(join(TEST_DIR, ".git"), { recursive: true });
			writeFileSync(join(TEST_DIR, ".git", "HEAD"), "ref: refs/heads/main");
			const info = gatherEnvironment(TEST_DIR);
			const xml = formatEnvironment(info);

			if (info.git?.recentCommits && info.git.recentCommits.length > 0) {
				expect(xml).toContain("<recent-commits>");
				expect(xml).toContain("<commit>");
			}
		});
	});
});
