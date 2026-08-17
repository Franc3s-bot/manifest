---
name: manifest-dev
description: Manage the Manifest Prod/Staging/Worktree multi-stack setup (router 2098 / prod 2099 / staging 2100 / worktrees 2100+N). Use when the user asks to switch between prod and staging/dev models, snapshot the database, check stack status, rebuild containers, manage worktree stacks, or anything related to the dev environment protocol.
---

# Manifest Dev & Staging Protocol

Two permanent Manifest instances run side-by-side on the host, plus on-demand isolated worktree stacks, routed via the **Manifest Dynamic Router (Port 2098)**:

| Service / Stack | Port | Healer | DB Volume | Docker Project | Managed by |
|---|---|---|---|---|---|
| **Dynamic Router** | **2098** | - | - | Systemd daemon (`manifest-router.service`) | `switch-manifest.sh` |
| **Prod** | 2099 | 3100 | `manifest_pgdata` | `mnfst` | `switch-manifest.sh` |
| **Staging (Dev)** | 2100 | 3101 | `manifest_dev_pgdata` | `mnfst-dev` | `switch-manifest.sh` |
| **Feature worktree** | 2100+N | 3100+N | `manifest_wt_<slug>_pgdata` | `mnfst-wt-<slug>` | `worktree-stack.sh` |

---

## 1. Quick Model & Provider Routing (Prod ↔ Staging)

Switching is **immediate** via the dynamic router without modifying config files or restarting OpenCode:

```bash
# Route ALL models and sub-agents to STAGING (port 2100):
./scripts/switch-manifest.sh staging

# Route ALL models and sub-agents to PRODUCTION (port 2099):
./scripts/switch-manifest.sh prod

# Check current active route and stack health:
./scripts/switch-manifest.sh status
```

---

## 2. Restarts

```bash
# Restart the dynamic router (:2098):
./scripts/switch-manifest.sh restart-router

# Rebuild image from main and restart Production (:2099):
./scripts/switch-manifest.sh restart-prod

# Rebuild image from staging and restart Staging (:2100):
./scripts/switch-manifest.sh restart-staging
```

---

## 3. Database Snapshots (Bidirectional)

```bash
# Copy Production DB (2099) -> Staging DB (2100):
./scripts/switch-manifest.sh snapshot prod-to-staging

# Copy Staging DB (2100) -> Production DB (2099):
./scripts/switch-manifest.sh snapshot staging-to-prod
```

---

## 4. Local Feature Worktrees (`worktree-stack.sh`)

```bash
# Start an isolated stack for the current worktree:
./scripts/worktree-stack.sh up

# Check status and port for the current worktree stack:
./scripts/worktree-stack.sh status

# Rebuild worktree image:
./scripts/worktree-stack.sh build
# (or ./scripts/worktree-stack.sh rebuild)

# Stop worktree stack and release port slot:
./scripts/worktree-stack.sh down
```

---

## 5. Paseo UI Shortcuts (`paseo.json`)

The following clean set of 12 shortcuts is configured in `paseo.json`:
- `status`: Show router and stack status
- `route-prod`: Switch router to Production (:2099)
- `route-staging`: Switch router to Staging (:2100)
- `restart-prod`: Rebuild and restart Production (:2099)
- `restart-staging`: Rebuild and restart Staging (:2100)
- `restart-router`: Restart the Dynamic Router (:2098)
- `snapshot-prod-to-staging`: Copy Prod DB -> Staging DB
- `snapshot-staging-to-prod`: Copy Staging DB -> Prod DB
- `worktree-status`: Check worktree stack status
- `worktree-build`: Rebuild worktree image
- `worktree-up`: Start worktree stack
- `worktree-down`: Stop worktree stack
