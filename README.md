![banner](assets/wellington.png)

# pi-environment-awareness

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that injects
host environment context into the system prompt, helping the LLM understand the
runtime it's working in.

## Features

| Category | Detected Info |
|----------|---------------|
| **System** | OS (distro name on Linux), architecture, version, CPU model, thread count (cgroup-aware), cgroup memory limit |
| **Runtime** | WSL, Docker, Podman, other OCI containers, CI/CD platform |
| **Security** | Root/admin user detection (only shown when noteworthy) |
| **Dev Tools** | Package manager (from lock files) |
| **Tools** | Available dev tools with versions (bun, node, deno, python, go, rust, java, etc., incl. modern CLI replacements like rg, ast-grep, fd, fzf, shellcheck, eza) |
| **Preferences** | Smart defaults (e.g., prefer bun over node, prefer uv over pip) |
| **Locale** | Timezone, language |
| **Project Config** | Version files, node version pin (`.nvmrc`, `.node-version`, `engines.node`), test runner, linter, formatter, monorepo, CI configs, npm scripts (capped), databases, automation tools |
| **XDG** | Base dirs, only when set to non-default absolute paths |

## Installation

### Pi

```bash
pi install npm:pi-environment-awareness
```

```bash
pi install git:github.com/raphielscape/pi-environment-awareness@v1
```

### OMP (Oh My Pi)

OMP reads the same package manifest — `omp.extensions`, with the legacy
`pi.extensions` key still accepted — so the same package covers both hosts:

```bash
# from the package directory (or a path to it); user scope by default
omp plugin install .
# project scope instead
omp plugin install . --scope=project
```

Or link it for live development (changes take effect on `/reload`):

```bash
omp plugin link /path/to/pi-environment-awareness
```

Manage the installation with `omp plugin list`, `omp plugin doctor`, and
`omp plugin uninstall`.

### From local path (development, Pi)

```bash
# Or symlink for live development
ln -s /path/to/pi-environment-awareness ~/.pi/agent/extensions/environment-awareness
```

Then reload the agent or run `/reload`.

## Usage

The extension automatically:

1. Detects your environment on session start
2. Injects `<host-environment>` XML into the system prompt
3. Shows WSL, Docker, or CI in the footer when detected

### Commands

- `/env` — View current environment info
- `/env refresh` — Force re-detection

## Output Format

```xml
<host-environment>
<system>
<os>CachyOS (x64)</os>
<cpu>AMD Ryzen 9 7950X 16-Core Processor, 32 threads</cpu>
</system>
<package-manager>bun</package-manager>
<tools>
  <tool name="bun" version="1.4.0"/>
  <tool name="node" version="22.0.0"/>
  <tool name="python3" version="3.12.0"/>
  <tool name="go" version="1.22.0"/>
</tools>
<preferences>
  <prefer>use bun for JS deps and scripts (project has bun lockfile); do not use node/npm/yarn here</prefer>
  <prefer>use uv for Python deps and envs (project has pyproject.toml); do not use bare pip here</prefer>
</preferences>
<locale>
<timezone>Asia/Tokyo</timezone>
<lang>en_US.UTF-8</lang>
</locale>
</host-environment>
```

## How Preferences Work

Preferences are **source-driven**: the `packageManager` field in
`package.json` (the project's own declaration) takes precedence, then
project lock files, then global tool availability. When a project needs a
tool that is missing from PATH, the preferences say so explicitly instead
of staying silent.

Runtime preferences are **prohibitive**: they state which tool to use and
which alternatives to avoid, because a bare `package.json` otherwise pulls
models toward `npm install` defaults (a documented failure mode in coding
agent guides). Modern CLI directives follow the same pattern, scoped to
each tool's role: `use rg instead of grep for text search (recursive,
respects .gitignore)`, `use fd instead of find for file and directory
lookup`, `use fzf only in non-interactive mode with '--filter=QUERY'`
(agents have no TTY, so interactive fzf would hang), etc.

| Source | Preference |
|--------|------------|
| `packageManager: "bun"` | `use bun for JS deps and scripts (declared in package.json packageManager); do not use node/npm/yarn here` |
| `packageManager: "pnpm"` etc. | `use node with pnpm for JS deps and scripts (declared in package.json packageManager); do not use npm or yarn here` |
| `bun.lockb` / `bun.lock` / `bunfig.toml` | `use bun for JS deps and scripts (project has bun lockfile); do not use node/npm/yarn here` |
| `deno.json` / `deno.jsonc` / `deno.lock` | `use deno (project has deno.json or deno.lock); do not use node/npm here` |
| `pnpm-lock.yaml` | `use node with pnpm for JS deps and scripts (project lockfile detected); do not use npm or yarn here` |
| `yarn.lock` | `use node with yarn for JS deps and scripts (project lockfile detected); do not use npm or pnpm here` |
| `package-lock.json` | `use node with npm for JS deps and scripts (project lockfile detected); do not use pnpm or yarn here` |
| `pyproject.toml` / `uv.lock` | `use uv for Python deps and envs (project has pyproject.toml); do not use bare pip here` |
| `requirements.txt` | `use pip for Python deps (project has requirements.txt); do not use uv/poetry here` |
| *none* | Falls back to `prefer bun over node` / `prefer uv over pip` |
| *project needs a missing tool* | e.g. `this is a bun project but bun is not installed on PATH` |

Unsupported or unrecognized `packageManager` values fall back to lockfile
inference.

## Prompt-Cache Alignment

The `<host-environment>` block is designed for provider prompt caching
([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)):
cache keys are byte-for-byte prefix matches, and dynamic content must come
after the cached prefix. The extension therefore:

- Gathers the environment once per session and injects the identical block
  on every turn (no per-turn re-detection)
- Excludes volatile data entirely: git branch/status, memory/disk stats,
  timestamps (they would bust the byte-exact prefix every turn)
- Appends the block as the last prompt section, keeping the host's static
  instructions and tool definitions ahead of it
- Re-detects only on `session_compact` (the cache is already invalidated
  by compaction) or explicit `/env refresh`

The block is compact by design (typically well under 1k tokens, comparable
to the budget Aider uses for its [repo map](https://aider.chat/docs/repomap.html)).

## Preference Precedence and Evidence

The injected preferences are **advisory defaults scoped to the host
environment**. Per the [AGENTS.md convention](https://agents.md/), the
closest project instruction wins and explicit user chat prompts override
everything; these preferences never outrank a project's AGENTS.md/CLAUDE.md
or the user's direct instructions.

Research on context files is mixed, so treat the preference set as a
starting point, not a proven win:

- The ETH Zurich evaluation ([arXiv:2602.11988](https://arxiv.org/abs/2602.11988))
  found context files did not generally improve task success while
  increasing inference cost by over 20% on average; instructions were
  followed, but redundant content (repository overviews) added cost
  without value.
- A separate efficiency study ([arXiv:2601.20404](https://arxiv.org/abs/2601.20404))
  measured 28.64% lower median runtime and 16.58% fewer output tokens with
  curated context files across 10 repositories / 124 PRs.

What this extension injects sits in the non-redundant category both papers
point to as valuable: environmental facts and non-obvious tool constraints
agents cannot infer from the repo (which interpreters exist, what is on
PATH, which tool a project declares, hang hazards). Each directive names
its role and escape hatches (e.g. rg's `--no-ignore`/`--hidden` flags
remain available when .gitignore-aware defaults are unwanted).

## Design Decisions

- **No volatile data** — Memory/disk stats and git branch/status/commits
  are excluded: they change mid-session and break prompt caching. Git repo
  membership is still detected internally, but never injected.
- **No network check** — No internet = no Pi session; check is pointless
- **Conditional sections** — Security only shown when noteworthy (root);
  XDG base dirs only when set to non-default absolute paths
- **Compact XML** — Minimal token overhead

## Development

```bash
# Run tests
bun test

# Test output
bun run test
```

## License

MIT
