# pi-environment-awareness

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that injects host environment context into the system prompt, helping the LLM understand the runtime it's working in.

## Features

| Category | Detected Info |
|----------|---------------|
| **System** | OS (distro name on Linux), architecture, version, shell |
| **Runtime** | WSL, Docker, CI/CD platform |
| **Security** | Root/admin user detection (only shown when noteworthy) |
| **Dev Tools** | Package manager (from lock files) |
| **Git** | Branch, default branch, dirty/clean status with file count, recent commits |
| **Tools** | Available dev tools with versions (bun, node, python, go, rust, etc.) |
| **Preferences** | Smart defaults (e.g., prefer bun over node, prefer uv over pip) |
| **Locale** | Timezone, language |

## Installation

### From npm (when published)
```bash
pi install npm:pi-environment-awareness
```

### From GitHub
```bash
pi install git:github.com/YOUR_USERNAME/pi-environment-awareness@v1
```

### From local path (development)
```bash
# Add to settings directly
pi install /path/to/pi-environment-awareness

# Or symlink for live development
ln -s /path/to/pi-environment-awareness ~/.pi/agent/extensions/environment-awareness
```

Then reload Pi or run `/reload`.

## Usage

The extension automatically:
1. Detects your environment on session start
2. Injects `<host-environment>` XML into the system prompt
3. Shows status in the footer (e.g., `Linux/x64`)

### Commands

- `/env` — View current environment info
- `/env refresh` — Force re-detection

## Output Format

```xml
<host-environment>
<system>
<os>CachyOS (x64)</os>
<shell>/bin/fish</shell>
</system>
<package-manager>bun</package-manager>
<git>
<branch>feature-x</branch>
<default>main</default>
<status>dirty (3 files)</status>
<recent-commits>
    <commit>abc1234 fix: auth flow</commit>
    <commit>def5678 feat: add login</commit>
</recent-commits>
</git>
<tools>
  <tool name="bun" version="1.4.0"/>
  <tool name="node" version="22.0.0"/>
  <tool name="python3" version="3.12.0"/>
  <tool name="go" version="1.22.0"/>
</tools>
<preferences>
  <prefer>use bun (project has bun.lockb)</prefer>
  <prefer>use uv (project has pyproject.toml)</prefer>
</preferences>
<locale>
<timezone>Asia/Tokyo</timezone>
<lang>en_US.UTF-8</lang>
</locale>
</host-environment>
```

## How Preferences Work

Preferences are **source-driven**: project files take precedence over global tool availability.

| Project File | Preference |
|--------------|------------|
| `bun.lockb` / `bunfig.toml` | `use bun (project has bun.lockb)` |
| `pnpm-lock.yaml` | `use node with pnpm (project lockfile detected)` |
| `yarn.lock` | `use node with yarn (project lockfile detected)` |
| `package-lock.json` | `use node with npm (project lockfile detected)` |
| `pyproject.toml` / `uv.lock` | `use uv (project has pyproject.toml)` |
| `requirements.txt` | `use pip (project has requirements.txt)` |
| *none* | Falls back to `prefer bun over node` / `prefer uv over pip` |

## Design Decisions

- **No volatile data** — Memory/disk stats excluded (breaks prompt caching)
- **No network check** — No internet = no Pi session; check is pointless
- **Conditional sections** — Security only shown when noteworthy (root)
- **Compact XML** — Minimal token overhead

## Development

```bash
# Test output
bun -e "import { gatherEnvironment, formatEnvironment } from './detectors.ts'; console.log(formatEnvironment(gatherEnvironment(process.cwd())));"
```

## License

MIT
