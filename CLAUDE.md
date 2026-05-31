# Environment Awareness Extension for Pi

A Pi extension that injects host environment context into the system prompt via XML, helping the LLM understand the runtime it's working in.

## Project Structure

```
.
├── index.ts        # Extension entry point — hooks and command registration
├── detectors.ts    # Environment detection functions
├── tsconfig.json   # TypeScript config
└── CLAUDE.md       # This file
```

## How It Works

1. `session_start` — Detects environment, caches result, shows status in footer
2. `before_agent_start` — Injects `<host-environment>` XML block into system prompt
3. `session_shutdown` — Cleans up cached state

## What It Detects

| Category | Details |
|----------|---------|
| **System** | OS (distro name via `/etc/os-release` on Linux), architecture, version, shell |
| **Runtime** | WSL, Docker, CI/CD platform |
| **Security** | Root/admin user detection (only shown if root) |
| **Dev Tools** | Package manager (from lock files) |
| **Git** | Branch, default branch, dirty/clean status with file count, 3 recent commits |
| **Tools** | Available dev tools with versions (bun, node, python, go, rust, etc.) |
| **Preferences** | Smart defaults (e.g., prefer bun over node, prefer uv over pip) |
| **Locale** | Timezone, language |

## Design Decisions

- **No volatile data** — Memory/disk stats are excluded because they change constantly, which would break prompt caching
- **No network check** — If there's no internet, there's no Pi session; check is pointless
- **Conditional sections** — Security only shown when noteworthy (root)
- **Compact XML** — Minimal token overhead

## Output Format

```xml
<host-environment>
<system>
<os>CachyOS Linux (x64)</os>
<shell>/bin/fish</shell>
</system>
<package-manager>bun</package-manager>
<git>
<branch>main</branch>
<default>main</default>
<status>dirty (3 files)</status>
<recent-commits>
    <commit>abc1234 fix: auth flow</commit>
    <commit>def5678 feat: add login</commit>
    <commit>ghi9012 refactor: utils</commit>
</recent-commits>
</git>
<tools>
  <tool name="bun" version="1.4.0"/>
  <tool name="node" version="22.0.0"/>
  <tool name="python3" version="3.12.0"/>
  <tool name="go" version="1.22.0"/>
</tools>
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

The extension is symlinked into `~/.pi/agent/extensions/environment-awareness`. Changes here take effect on `/reload` or Pi restart.
