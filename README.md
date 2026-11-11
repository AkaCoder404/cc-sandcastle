# cc-sandcastle

Claude Code plugins for running Bash tool commands inside a resource-limited Docker container — protects your machine from runaway tests, builds, or scripts, since Claude Code's own sandbox is access-control only (no memory/CPU limits).

## Install

One step (Claude Code 2.1.275+):

```
/plugin install sandcastle --marketplace AkaCoder404/cc-sandcastle
```

## Usage

```
/sandcastle init                        # guided setup: generates + builds the image
/sandcastle on                          # start container (4 GB RAM, 2 vCPU default)
/sandcastle on --memory 2g --cpus 1     # custom limits
/sandcastle on --image my-image         # explicit image name
/sandcastle off                         # stop container, back to host
/sandcastle status                      # check state
/sandcastle                             # toggle
```

## How it works

- `/sandcastle init` ships as a plugin skill: it detects the project (Python/uv today, Node/bun/npm planned), proposes a plan, writes `.sandcastle/Dockerfile` (agent user with UID/GID alignment, Claude Code + uv baked in, prewarmed dependency cache), builds it tagged `sandcastle:<dirname>`, and smoke tests the image before declaring success.
- `/sandcastle on` resolves the repo root from your current directory (`git rev-parse --show-toplevel`), derives the image name `sandcastle:<dirname>` (the `@ai-hero/sandcastle` convention), runs `docker run -d --memory 4g --cpus 2 -v <repo>:/home/agent/workspace <image>`, then `uv sync --frozen` once.
- A `tool.call` hook intercepts every Bash call and reroutes it through `docker exec -w /home/agent/workspace <id> sh -c "<command>"` — the model never knows the difference.
- If the container dies (OOM kill, manual removal), exit code 125 is detected, state clears, and execution falls back to the host with a toast.
- `session.end` removes the container automatically.

## Requirements

- Docker Desktop (or compatible daemon) running
- A prebuilt image named `sandcastle:<your-repo-dirname>`. Get one via `/sandcastle init` (guided), or pass `--image <name>` to use an existing image — with [@ai-hero/sandcastle](https://www.npmjs.com/package/@ai-hero/sandcastle), `npm run sandbox:build` in your project produces exactly the image this plugin expects.
- Project works best with a container image that has `uv` on PATH (the sandcastle image does; `uv sync` failure is non-fatal and just warns).

## Caveats

- `cd` does not persist between Bash calls inside the container (each `docker exec` starts at the mount root).
- File paths inside Bash results show container paths (`/home/agent/workspace/...`) — normal.

## Plugins in this marketplace

| Plugin | Description |
|---|---|
| `sandcastle` | Toggle a Docker sandbox for Bash commands |
