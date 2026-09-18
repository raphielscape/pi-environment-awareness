# Environment Awareness Extension for Pi

A Pi extension that injects host environment context into the system prompt
via XML, helping the LLM understand the runtime it's working in.

## Project Structure

```text
.
├── index.ts        # Extension entry point — hooks and command registration
├── detectors.ts    # Environment detection functions
├── tsconfig.json   # TypeScript config
└── CLAUDE.md       # This file
```

## How It Works

1. `session_start` — Detects environment, caches result, shows status in footer
2. `before_agent_start` — Injects `<host-environment>` XML block into system
   prompt
3. `session_shutdown` — Cleans up cached state

## What It Detects

| Category | Details |
|----------|---------|
| **System** | OS (distro name via `/etc/os-release` on Linux), architecture, version, shell, CPU model + thread count (cgroup-aware), cgroup memory limit |
| **Runtime** | WSL, Docker, CI/CD platform |
| **Security** | Root/admin user detection (only shown if root) |
| **Dev Tools** | Package manager (from lock files) |
| **Git** | Repo membership detected internally only — branch/status/commits are excluded (mid-session changes break prompt caching) |
| **Tools** | Available dev tools with versions (bun, node, python, go, rust, etc.) and modern CLI replacements (rg, ast-grep, fd, bat, eza, jq, delta, sd, difft, gh, tokei, yq, xh) |
| **Preferences** | Smart defaults (e.g., prefer bun over node, prefer uv over pip, prefer rg over grep, prefer ast-grep for structural code search) |
| **Locale** | Timezone, language |
| **Project Config** | Version files, test runner, linter, formatter, TypeScript version, monorepo, CI configs, editor config, npm scripts, databases, automation tools, .env.example, tsconfig strict |

## Design Decisions

- **No volatile data** — Memory/disk stats and git branch/status/commits are
  excluded because they change mid-session, which would break prompt caching.
  Git repo membership is still detected internally but never injected.
- **No network check** — If there's no internet, there's no Pi session;
  check is pointless
- **Conditional sections** — Security only shown when noteworthy (root); XDG
  base dirs only when set to non-default absolute paths
- **Compact XML** — Minimal token overhead

## Output Format

```xml
<host-environment>
<system>
<os>CachyOS Linux (x64)</os>
<shell>/bin/fish</shell>
</system>
<package-manager>bun</package-manager>
<tools>
  <tool name="bun" version="1.4.0"/>
  <tool name="node" version="22.0.0"/>
  <tool name="python3" version="3.12.0"/>
  <tool name="go" version="1.22.0"/>
</tools>
<project-config>
<version-files>.nvmrc, .python-version</version-files>
<test-runner>vitest</test-runner>
<linter>eslint</linter>
<formatter>prettier</formatter>
<typescript>^5.7.0</typescript>
<monorepo>true</monorepo>
<ci>github-actions, dockerfile</ci>
<editor-config>.editorconfig</editor-config>
<tsconfig-strict>true</tsconfig-strict>
<npm-scripts>dev, build, test, lint</npm-scripts>
<databases>postgresql, redis</databases>
<automation>make, just</automation>
<env-example>true</env-example>
</project-config>
<preferences>
  <prefer>prefer bun over node</prefer>
  <prefer>prefer uv over pip</prefer>
</preferences>
<locale>
<timezone>Asia/Tokyo</timezone>
<lang>en_US.UTF-8</lang>
</locale>
</host-environment>
```

## Commands

- `/env` — View current environment info
- `/env refresh` — Force re-detection

## Development

The extension is symlinked into `~/.pi/agent/extensions/environment-awareness`.
Changes here take effect on `/reload` or Pi restart.
