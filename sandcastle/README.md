# sandcastle

A Claude Code plugin that routes Bash tool commands into a resource-limited Docker container, on demand.

```
/plugin install sandcastle --marketplace AkaCoder404/cc-sandcastle
```

Run `/sandcastle on` to start a container (default 4 GB RAM, 2 vCPUs, image derived from the current repo, e.g. `sandcastle:dtms-ai` from an `@ai-hero/sandcastle` build); every subsequent Bash call runs via `docker exec` inside it, with `uv sync` done once at startup. Run `/sandcastle off` to return to the host, `/sandcastle status` to check state. If the container dies (OOM kill, manual removal), the plugin detects exit code 125, clears state, and falls back to host execution automatically; the container is removed when the session ends. Optional flags on `on`: `--memory 2g`, `--cpus 1`, `--image <name>`.
