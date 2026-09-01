# @deepseek-ai/dsh-subagent-agencycli

English | [中文](README.zh.md)

This package registers the fixed `agencycli` subagent provider. Each accepted run starts `agencycli exec --no-session` in the delegating Session's workspace (or a configured cwd), submits one self-contained text task, and returns collected stdout through the shared [`dsh-subagent`](../subagent/README.md) result contract.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from config or the parent Session. It then spawns the fixed command through [`dsh-subprocess`](../../subprocess/subprocess/README.md):

```
agencycli --dir <cwd> exec --project <project> --agent <agent> --prompt <task> --no-session
```

`--no-session` is required. AgencyCLI otherwise resumes a saved conversation, which a DSH one-shot must not do. The plugin does not run `agencycli start`, hire agents, mutate inbox state, or install the binary.

The published `run.result` waits for process exit. Exit code 0 settles as `completed` with collected stdout. A non-zero exit, spawn failure, or other child error flattens to `error` while preserving any collected text. Local cancellation maps to `aborted`. `dispose()` is idempotent: it terminates the managed process tree and waits for whole-tree exit.

## Capabilities and context

The provider advertises no optional start-time capabilities and reports `inheritsParentContext: false`. AgencyCLI receives the standalone text task and workspace directory, but not the parent conversation, persona, tool filter, depth policy, or structured-output contract.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | `agencycli` | Executable used as argv[0]. |
| `cwd` | parent Session cwd | Workspace directory for the child and `--dir`. |
| `project` | (required) | AgencyCLI `--project`. |
| `agent` | (required) | AgencyCLI `--agent`. |
| `env` | `{}` | Explicit child environment layered over the subprocess seam's credential-scrubbed parent environment. |
| `credentialEnv` | `{}` | Child env name to DSH credential-ref map. Resolved per start. Unmapped store keys are never forwarded. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |
| `maxOutputBytes` | `64000` | In-memory stdout collector cap. |

Credential-shaped ambient variables are removed by the subprocess seam. A secret intended for the child must be supplied in `env` or mapped through `credentialEnv`. Mapping is deployment config: DSH refs such as Foundry or Caddy names are not guessed as `AGENCYCLI_HTTP_API_KEY`.

Production `dsh` does not install or mount this optional provider. A Profile that opts in must install `@deepseek-ai/dsh-subagent-agencycli` and mount it once on the host plane; loading the provider starts no AgencyCLI process until a tool call.

```yaml
- id: subagent-agencycli
  name: '@deepseek-ai/dsh-subagent-agencycli'
  config:
    project: demo
    agent: dev
    credentialEnv:
      AGENCYCLI_HTTP_API_KEY: YOUR_DSH_CREDENTIAL_REF

- id: tool-subagent-agencycli
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: agencycli
    toolName: subagent_agencycli
    backgroundMode: one-shot
    maxDepth: provider-managed
```
