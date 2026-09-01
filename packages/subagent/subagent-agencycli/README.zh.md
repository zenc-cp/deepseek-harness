# @deepseek-ai/dsh-subagent-agencycli

[English](README.md) | 中文

本包注册固定的 `agencycli` subagent 提供方。每次接受运行请求后，它都会在发起委托的会话工作区（或配置的 cwd）中启动 `agencycli exec --no-session`，提交一个自包含的文本任务，并通过共享的 [`dsh-subagent`](../subagent/README.md) 结果约定返回收集到的标准输出。

## 启动与所有权

`start(request)` 只接受非空的文本块序列，并根据配置或父会话确定子级 cwd。随后，它通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) spawn 固定命令：

```
agencycli --dir <cwd> exec --project <project> --agent <agent> --prompt <task> --no-session
```

必须传入 `--no-session`。否则 AgencyCLI 会恢复已保存的会话，这是 DSH 一次性运行所不允许的。本插件不会执行 `agencycli start`、雇佣 agent、修改 inbox 状态，也不会安装该二进制文件。

已发布的 `run.result` 会等待进程退出。退出码 0 会以收集到的标准输出结算为 `completed`。非零退出、spawn 失败或其他子进程错误会扁平化为 `error`，并保留已收集的文本。本地取消映射为 `aborted`。`dispose()` 具有幂等性：它会终止受管进程树并等待整棵进程树退出。

## 能力与上下文

本提供方不声明任何可选的启动时能力，并报告 `inheritsParentContext: false`。AgencyCLI 会接收独立文本任务和工作区目录，但不会接收父会话的对话、角色设定、工具筛选器、深度策略或结构化输出约定。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `command` | `agencycli` | 用作 argv[0] 的可执行文件。 |
| `cwd` | 父会话 cwd | 子进程工作目录，同时作为 `--dir`。 |
| `project` | （必填） | AgencyCLI `--project`。 |
| `agent` | （必填） | AgencyCLI `--agent`。 |
| `env` | `{}` | 显式指定的子进程环境，叠加在由子进程 seam 清除凭证后的父环境之上。 |
| `credentialEnv` | `{}` | 子进程环境变量名到 DSH 凭据引用的映射。每次启动时解析。未映射的存储键绝不会被转发。 |
| `disposeGraceMs` | `3000` | 正有限宽限期（毫秒），不得大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)。 |
| `maxOutputBytes` | `64000` | 内存中 stdout 收集上限。 |

子进程 seam 会移除具有凭证特征的环境变量。供子进程使用的密钥必须通过 `env` 显式提供，或通过 `credentialEnv` 映射。映射是部署配置：Foundry 或 Caddy 等 DSH 引用不会被猜测为 `AGENCYCLI_HTTP_API_KEY`。

生产 `dsh` 不会安装或挂载这个可选提供方。选择启用它的 Profile 必须安装 `@deepseek-ai/dsh-subagent-agencycli`，并在 host plane（宿主平面）挂载一次；加载提供方本身不会在工具调用前启动 AgencyCLI 进程。

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
