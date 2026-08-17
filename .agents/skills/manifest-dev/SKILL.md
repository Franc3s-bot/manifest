---
name: manifest-dev
description: Manage the Manifest Prod/Staging/Worktree multi-stack setup (prod 2099 / staging 2100 / worktrees 2100+N). Use when the user asks to switch between prod and staging/dev models, snapshot the database, check stack status, rebuild containers, manage worktree stacks, or anything related to the dev environment protocol.
---

# Manifest Dev & Staging Protocol

Two permanent Manifest instances run side-by-side on the host, plus on-demand isolated worktree stacks:

| Stack | Port | Healer | DB Volume | Docker Project | Managed by |
|-------|------|--------|-----------|----------------|------------|
| Prod | 2099 | 3100 | `manifest_pgdata` | `mnfst` | `switch-manifest.sh` |
| Staging (Dev) | 2100 | 3101 | `manifest_dev_pgdata` | `mnfst-dev` | `switch-manifest.sh` |
| Feature worktree | 2100+N | 3100+N | `manifest_wt_<slug>_pgdata` | `mnfst-wt-<slug>` | `worktree-stack.sh` |

- **Prod 2099** — released `main` branch image (`manifest:latest`), untouched by feature work.
- **Staging 2100** — the always-on test bed running the `staging` branch image (`manifest:staging`).
- **Feature worktrees** — every feature worktree gets its own disposable, isolated stack with automatic port allocation and prod DB snapshot baseline.

---

## 1. Quick Model & Provider Switching (Prod ↔ Staging)

When you want to test the staging version in your everyday workflow with OpenCode and Paseo:

```bash
# Switch ALL models and sub-agents to STAGING (port 2100):
./scripts/switch-manifest.sh staging
# or: ./scripts/switch-manifest.sh dev

# Switch ALL models and sub-agents back to PRODUCTION (port 2099):
./scripts/switch-manifest.sh prod

# Or simply toggle between them:
./scripts/switch-manifest.sh toggle

# Check current active mode and health across all stacks:
./scripts/switch-manifest.sh status
```

### What gets synchronized automatically:
1. **OhMyOpenCodeSlim Preset**: `~/.config/opencode/oh-my-opencode-slim.jsonc` (`preset: "manifest"` ↔ `"manifest-dev"`). Sub-agents (oracle, council, orchestrator, designer, fixer, librarian, explorer, observer) route to the matching tier models.
2. **OpenCode Core Models**: `~/.config/opencode/opencode.jsonc` (`model: "manifest/auto"` ↔ `"manifest-dev/auto"`, `small_model: "manifest/auto-simple"` ↔ `"manifest-dev/auto-simple"`).
3. **OpenCode Custom Agents**: `~/.config/opencode/agents/*.md` (`build.md`, `plan.md`, `paseo-coordinator.md`).
4. **Paseo Coordinator Agent Profile**: `~/.paseo/config.json` (`agent_profile_msth4nm4_lritziw6ft` model: `manifest/auto-standard` ↔ `manifest-dev/auto-standard`).
5. **Paseo Metadata Generation**: `~/.paseo/config.json` (`metadataGeneration.providers`: `manifest/auto-simple` ↔ `manifest-dev/auto-simple`).
6. **Paseo Orchestration Preferences**: `~/.paseo/orchestration-preferences.json` (all specialist providers: `opencode/manifest/auto-{tier}` ↔ `opencode/manifest-dev/auto-{tier}`).

> **Note:** After switching, restart OpenCode once to apply the changes to running sessions.

---

## 2. Local Worktree Stacks (`worktree-stack.sh`)

Every feature worktree gets an isolated disposable stack so parallel lanes never collide.

All commands support **zero-argument defaults** when executed inside a worktree directory:

```bash
# Start an isolated stack for the current worktree (copies prod DB snapshot + seeds admin login):
./scripts/worktree-stack.sh up

# Start for a specific worktree directory or with options:
./scripts/worktree-stack.sh up ../other-worktree --slug mylane
./scripts/worktree-stack.sh up . --no-snapshot    # fresh empty DB

# Check deployment status and URLs for the local worktree:
./scripts/worktree-stack.sh status

# Rebuild image from worktree source and restart (retains database volume):
./scripts/worktree-stack.sh rebuild

# Teardown the stack and release the port slot:
./scripts/worktree-stack.sh down
./scripts/worktree-stack.sh down --purge-volume  # also delete DB volume

# Follow manifest container logs:
./scripts/worktree-stack.sh logs
```

**Paseo UI Integration (`paseo.json`)**:
- `worktree-up`: Starts the isolated stack for the current worktree.
- `worktree-down`: Stops the current worktree stack and releases ports.
- `worktree-status`: Displays current worktree port, URLs, and container status.
- `worktree-rebuild`: Rebuilds the current worktree image and updates containers.
- `preset-prod`: Switches all OpenCode & Paseo agents to Production.
- `preset-staging`: Switches all OpenCode & Paseo agents to Staging.
- `snapshot`: Copies prod DB into the Staging instance (2099 → 2100).
- `status`: Shows status of all stacks and model routing.

---

## 3. Database Snapshots

To synchronize production data into Staging:

```bash
./scripts/switch-manifest.sh snapshot
```

The snapshot uses `pg_dump -Fc` for atomic binary transfer, drops/recreates the staging DB, restores the dump, restarts the staging manifest, and seeds `admin@manifest.local` / `admin1234`.
