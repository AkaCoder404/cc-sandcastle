import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const containerAtom = atom(
  { plugin: 'sandcastle', key: 'container' } as const,
  null as string | null,
)

export const register: Register = on => {
  // Register the slash command and restore status bar if a container is already
  // stored from a previous reload in this session.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sandcastle',
      description: 'Toggle Docker sandbox for Bash commands — /sandcastle on|off|status',
    })
    const id = await read($, containerAtom)
    if (id) $.ui.status('🐳 sandcastle')
    return next(e)
  })

  // /sandcastle [on|off|status]  — no arg toggles
  on('command.run', { command: 'sandcastle' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, containerAtom)

    // ── status ──────────────────────────────────────────────────────────────
    if (arg === 'status') {
      return current
        ? { text: `Sandcastle active — container ${current.slice(0, 12)}.` }
        : { text: 'Sandcastle is off. Run `/sandcastle on` to start.' }
    }

    // ── off (or empty toggle while running) ─────────────────────────────────
    if (arg === 'off' || (arg === '' && current)) {
      if (!current) return { text: 'Sandcastle is not running.' }
      await $.process.run(['docker', 'rm', '-f', current], { timeoutMs: 10_000 })
      await update($, containerAtom, () => null)
      $.ui.status(undefined)
      return { text: 'Sandcastle stopped. Bash commands run on the host again.' }
    }

    // ── on (or empty toggle while stopped) ──────────────────────────────────
    if (current) {
      return {
        text: `Sandcastle already running (${current.slice(0, 12)}). Use \`/sandcastle off\` to stop.`,
      }
    }

    // Parse optional overrides: /sandcastle on --memory 2g --cpus 1 --image name
    const memMatch = arg.match(/--memory\s+(\S+)/)
    const cpusMatch = arg.match(/--cpus\s+(\S+)/)
    const imgMatch = arg.match(/--image\s+(\S+)/)
    const memory = memMatch?.[1] ?? '4g'
    const cpus = cpusMatch?.[1] ?? '2'

    // Derive repo root and image name from the current working directory.
    // git rev-parse runs from the session's cwd (follows cd), so after
    // `cd dtms-ai` this correctly resolves the dtms-ai repo root.
    const gitResult = await $.process.run(
      ['git', 'rev-parse', '--show-toplevel'],
      { timeoutMs: 5_000 },
    )
    const repoRoot = gitResult.exitCode === 0
      ? gitResult.stdout.trim()
      : await $.session.root()
    const dirName = repoRoot.split('/').pop() ?? 'local'
    const imageName = imgMatch?.[1] ?? `sandcastle:${dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`

    // Fail fast if the image hasn't been built yet
    const imgCheck = await $.process.run(
      ['docker', 'image', 'inspect', imageName],
      { timeoutMs: 5_000 },
    )
    if (imgCheck.exitCode !== 0) {
      return {
        text: `Image \`${imageName}\` not found. Run \`npm run sandbox:build\` in \`${repoRoot}\` first.\n\nOr specify the image directly: \`/sandcastle on --image sandcastle:dtms-ai\``,
      }
    }

    $.ui.status('🐳 starting…')

    const startResult = await $.process.run(
      [
        'docker', 'run', '-d',
        '--memory', memory,
        '--cpus', cpus,
        '-v', `${repoRoot}:/home/agent/workspace`,
        imageName,
      ],
      { timeoutMs: 30_000 },
    )

    if (startResult.exitCode !== 0) {
      $.ui.status(undefined)
      return { text: `Failed to start container: ${startResult.stderr.trim()}` }
    }

    const containerId = startResult.stdout.trim()

    // Run uv sync once so the .venv is ready for the session
    $.ui.status('🐳 syncing…')
    const syncResult = await $.process.run(
      ['docker', 'exec', '-w', '/home/agent/workspace', containerId, 'uv', 'sync', '--frozen'],
      { timeoutMs: 300_000 },
    )

    await update($, containerAtom, () => containerId)
    $.ui.status('🐳 sandcastle')

    const syncNote =
      syncResult.exitCode !== 0
        ? '\n\n⚠️ `uv sync` failed — check output with `/sandcastle off` then `uv sync --frozen`.'
        : ''

    return {
      text: `Sandcastle on (${memory} RAM, ${cpus} vCPU). All Bash commands now run in the container.${syncNote}`,
    }
  })

  // ── Route Bash calls through docker exec when sandcastle is active ─────────
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const containerId = await read($, containerAtom)
    if (!containerId) return next(e)

    const result = await $.process.run(
      ['docker', 'exec', '-w', '/home/agent/workspace', containerId, 'sh', '-c', e.command],
      { timeoutMs: e.timeout ?? 120_000 },
    )

    // Exit code 125 means docker itself errored — the container is likely gone
    // (OOM-killed, manually removed). Clear state and fall through to the host.
    if (result.exitCode === 125) {
      await update($, containerAtom, () => null)
      $.ui.status(undefined)
      $.ui.toast('⚠️ Sandcastle container stopped — running on host')
      return next(e)
    }

    return {
      result: {
        stdout: result.stdout,
        stderr: result.stderr,
        interrupted: false,
      },
    }
  }).catch(($, e, next) =>
    // If the hook itself throws (e.g. docker not running), fall through gracefully.
    next.called ? next(e) : next(e),
  )

  // ── Cleanup on session end ────────────────────────────────────────────────
  // session.end has a ~1.5 s wall-clock bound; docker rm -f is usually fast.
  on('session.end', async ($, e, next) => {
    const containerId = await read($, containerAtom)
    if (containerId) {
      await $.process.run(['docker', 'rm', '-f', containerId], { timeoutMs: 1_200 })
      await update($, containerAtom, () => null)
    }
    return next(e)
  })
}
