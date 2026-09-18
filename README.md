![banner](assets/wellington.png)

# pi-environment-awareness

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that injects
host environment context into the system prompt, helping the LLM understand the
runtime it's working in.

## Features

| Category | Detected Info |
|----------|---------------|
| **System** | OS (distro name on Linux), architecture, version, shell, CPU model, thread count (cgroup-aware) |
| **Runtime** | WSL, Docker, CI/CD platform |
| **Security** | Root/admin user detection (only shown when noteworthy) |
| **Dev Tools** | Package manager (from lock files) |
| **Tools** | Available dev tools with versions (bun, node, python, go, rust, etc., incl. modern CLI replacements like rg, ast-grep, fd, eza) |
| **Preferences** | Smart defaults (e.g., prefer bun over node, prefer uv over pip) |
| **Locale** | Timezone, language |
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
`pi.extensions` key still accepted — so the same install covers both hosts:

```bash
omp install /path/to/pi-environment-awareness
```

Or drop the extension into OMP's discovery roots directly:

```bash
# user-level (~/.omp/agent/extensions)
ln -s /path/to/pi-environment-awareness ~/.omp/agent/extensions/environment-awareness

# project-level (<repo>/.omp/extensions)
ln -s /path/to/pi-environment-awareness .omp/extensions/environment-awareness
```

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
<shell>/bin/fish</shell>
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

Preferences are **source-driven**: project files take precedence over
global tool availability.

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
