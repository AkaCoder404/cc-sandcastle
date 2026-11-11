---
name: init
description: Guided setup of a sandcastle Docker image for the current project (Python/uv). Detects the project, proposes a plan, generates .sandcastle/Dockerfile, builds it tagged sandcastle:<dirname>, and smoke tests the result so /sandcastle on just works. Use when the user runs /sandcastle init or asks to set up, create, or fix the sandcastle container image for this project.
---

# Sandcastle init — build this project's sandbox image

Goal: leave the project with a **built** Docker image named `sandcastle:<dirname>` that the `/sandcastle on` command can start. This version of the skill supports **Python + uv projects only** (Node/bun/npm is a planned follow-up).

Work through the phases in order. Show the plan and get the user's confirmation before writing any file.

## Phase 0 — Preflight

1. Docker must be up: run `docker info --format '{{.ServerVersion}}'`. If it fails, stop and tell the user to start Docker Desktop and rerun.
2. Repo root: `git rev-parse --show-toplevel`. If this is not a git repository, stop and say so (the image name derives from the repo directory name).

**Image name rule — follow it exactly, the plugin derives the same name at `/sandcastle on`:**

```
root     = git rev-parse --show-toplevel
dirname  = basename(root) lowercased, every char outside [a-z0-9_.-] replaced with "-"
image    = sandcastle:<dirname>        (fall back to sandcastle:local if empty)
```

## Phase 1 — Detect the project

From the repo root, check and read:

- `pyproject.toml` — required. If absent, stop: this skill handles Python/uv only; tell the user and suggest initializing the project first.
- `uv.lock` — if absent, the plan must include running `uv lock` on the host before building (the warm cache layer needs it). Confirm with the user.
- `.python-version` — note the pinned version; if absent the plan uses the version from `.python-version`-less default (latest CPython 3.12 via uv).
- Gate commands: read `pyproject.toml` for dev dependencies and pick what exists — typically `uv run ruff check .` and/or `uv run pytest -q`. List what you found; if none, say the smoke test will be `uv sync --frozen` only.

Also check the git remote (`git remote get-url origin`): if the host contains `gitlab`, note that the plan can include the GitLab CLI (`glab`) — ask the user, default is **no**.

## Phase 2 — Confirm the plan

Present a compact summary and wait for the user's OK:

- Base image: `node:22-bookworm` (Node is required: the image ships the Claude Code CLI)
- Python: the pinned version found above
- Files that exist and will be copied into the warm cache layer
- Gate commands the smoke test will run
- Whether `glab` is included
- **Warning: the smoke test mounts this repo into a container and creates `.venv` in the project** — say so explicitly.

## Phase 3 — Write `.sandcastle/Dockerfile`

Generate the file from this template. Adapt per the rules below; keep everything else byte-for-byte.

```dockerfile
FROM node:22-bookworm

# System dependencies
RUN apt-get update && apt-get install -y \
  git curl jq ca-certificates gnupg \
  && rm -rf /var/lib/apt/lists/*

# ── Optional GitLab CLI block: include ONLY when the user said yes ──
# ARG GLAB_VERSION=1.117.0
# ARG TARGETARCH
# RUN curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/glab.tgz \
#   && tar -xzf /tmp/glab.tgz -C /tmp bin/glab \
#   && mv /tmp/bin/glab /usr/local/bin/glab \
#   && rm -rf /tmp/glab.tgz /tmp/bin

# UID/GID alignment: image-built files and bind-mounted files share an
# owner with the host user, without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
# Git identity used for commits made inside the container.
ARG GIT_USER_NAME=agent
ARG GIT_USER_EMAIL=agent@localhost

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Claude Code CLI + uv (uv fetches the pinned CPython itself). Installed
# into the user prefix; this RUN executes as the non-root agent user.
RUN npm install -g --prefix=/home/agent/.local @anthropic-ai/claude-code \
  && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/agent/.local/bin:/home/agent/.cargo/bin:$PATH"

# uv cache lives at an image-layer path (NOT ~/.cache/uv): a host bind-mount
# at the default path would mask the build-time warmed cache.
ENV UV_CACHE_DIR=/home/agent/.uv-cache \
  UV_PYTHON_INSTALL_DIR=/home/agent/.uv-cache/python \
  UV_LINK_MODE=copy

# Agent git identity + bind-mount safety
RUN git config --global gc.auto 0 \
  && git config --global user.name "${GIT_USER_NAME}" \
  && git config --global user.email "${GIT_USER_EMAIL}" \
  && git config --global --add safe.directory /home/agent/workspace

# Pre-warm the uv cache with the project's locked deps: the runtime
# `uv sync --frozen` hook then hits the image-layer cache instead of
# re-downloading every wheel per container. The throwaway .venv is discarded.
COPY --chown=agent:agent pyproject.toml uv.lock .python-version /tmp/warm/
RUN cd /tmp/warm && uv sync --frozen && rm -rf /tmp/warm

WORKDIR /home/agent

ENTRYPOINT ["sleep", "infinity"]
```

Adaptation rules:

- **COPY line**: list only files that actually exist (a COPY fails if any named source is missing). Minimum is `pyproject.toml uv.lock`; drop `.python-version` if there is none. If `uv.lock` was missing and the plan included locking, run `uv lock` on the host before writing the file.
- **glab block**: uncomment only when the user opted in during Phase 2.
- Build context is the **repo root** (not `.sandcastle/`) so the COPY paths resolve — the build command below reflects that.
- **Build context size**: the context uploads the whole repo. If the repo has heavy generated dirs (`node_modules`, `.venv`, `dist`, large data), propose adding them to `.dockerignore`. If a `.dockerignore` already exists at the root, leave it alone and only mention gaps; if none exists, offer to create a minimal one with the user's OK.
- **Secrets**: the Dockerfile will be committed to the repo. Never add `.env`, tokens, credentials, or private keys to it or to build args. If the project's setup needs secrets at runtime, say they belong outside the image.

## Phase 4 — Build

Run from the repo root, passing the host user's UID/GID and git identity:

```sh
docker build -f .sandcastle/Dockerfile \
  --build-arg AGENT_UID="$(id -u)" \
  --build-arg AGENT_GID="$(id -g)" \
  --build-arg GIT_USER_NAME="$(git config user.name || echo agent)" \
  --build-arg GIT_USER_EMAIL="$(git config user.email || echo agent@localhost)" \
  -t sandcastle:<dirname> .
```

A failed build is a real failure: read the failing layer's output, fix the Dockerfile, and rebuild. Do not declare success on a red build.

## Phase 5 — Smoke test

Run the image the way `/sandcastle on` will:

```sh
docker run --rm -v <root>:/home/agent/workspace sandcastle:<dirname> \
  sh -c 'cd /home/agent/workspace && uv sync --frozen && <gate commands>'
```

Interpret results strictly:

- `uv sync --frozen` failure → **image problem**. Diagnose (missing lock file, Python version conflict, private index needing auth) and fix before reporting success.
- Gate command failures (ruff/pytest) → **pre-existing project issues, not setup problems**. Report them as such; the sandbox itself is fine. Do not attempt to fix project code as part of init.
- Confirm ownership sanity: `ls -ln /home/agent/workspace` inside a throwaway container should show the host UID/GID on mounted files.

## Phase 6 — Report

Summarize: image tag built, Dockerfile path, what the warm cache covers, smoke test outcome, and the exact next step:

> Run `/sandcastle on` to start using it. Rebuild with the same `docker build` command (or rerun `/sandcastle init`) whenever `uv.lock` or the Dockerfile changes — note the runtime `uv sync` tolerates lock changes without a rebuild, it just loses the prewarmed cache for new wheels.
