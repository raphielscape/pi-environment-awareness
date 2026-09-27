import { describe, expect, it } from "bun:test";
import { formatEnvironment, gatherEnvironment } from "./detectors";
import environmentAwareness from "./index";

type Handler = (
	event: { systemPrompt: unknown },
	ctx: { cwd: string; hasUI: boolean },
) => Promise<{ systemPrompt: unknown }>;

function loadHandler(): Handler {
	let handler: Handler | undefined;
	const fakePi = {
		on: (name: string, h: Handler) => {
			if (name === "before_agent_start") handler = h;
		},
		registerCommand: () => {},
	};
	environmentAwareness(fakePi as never);
	if (!handler) throw new Error("before_agent_start handler not registered");
	return handler;
}

describe("before_agent_start host compatibility", () => {
	const handler = loadHandler();
	const ctx = { cwd: import.meta.dir, hasUI: false };

	it("appends the env block as an array section for OMP (systemPrompt: string[])", async () => {
		const result = await handler({ systemPrompt: ["SECTION A", "SECTION B"] }, ctx);

		expect(Array.isArray(result.systemPrompt)).toBe(true);
		const sections = result.systemPrompt as string[];
		expect(sections.length).toBe(3);
		// Prior sections must be preserved unmodified (chaining contract)
		expect(sections[0]).toBe("SECTION A");
		expect(sections[1]).toBe("SECTION B");
		// Last section is the environment block: assert the wrapping contract
		// and payload, not the exact header copy
		const env = formatEnvironment(await gatherEnvironment(ctx.cwd));
		expect(sections[2].startsWith("<host-environment>\n")).toBe(true);
		expect(sections[2].endsWith("\n</host-environment>")).toBe(true);
		expect(sections[2]).toContain(env);
	});

	it("returns a scalar prompt for Pi (systemPrompt: string) with the legacy wrapping", async () => {
		const result = await handler({ systemPrompt: "BASE PROMPT" }, ctx);

		expect(typeof result.systemPrompt).toBe("string");
		const prompt = result.systemPrompt as string;
		const env = formatEnvironment(await gatherEnvironment(ctx.cwd));
		// Legacy wrapping: base + blank line + wrapped block + trailing newline
		expect(prompt.startsWith("BASE PROMPT\n\n<host-environment>\n")).toBe(true);
		expect(prompt.endsWith("</host-environment>\n")).toBe(true);
		expect(prompt).toContain(env);
	});
});
