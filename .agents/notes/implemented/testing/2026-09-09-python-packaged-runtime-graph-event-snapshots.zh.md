# Agent Note: Python packaged-runtime snapshots pin graph events and zero trace clocks

Status: implemented

[English](2026-09-09-python-packaged-runtime-graph-event-snapshots.md) | 中文

## 问题

turn/step 图现在会把 `session/checkpoint-node` 与 `session/trace-node` 事件追加到 Python SDK 结果和持久化日志。必需的打包运行时 CI 会把这些转录与 `scripts/snapshots/python-sdk-single-exe/` 做逐字节比对。先前基线省略了这些事件，而每条 `session/trace-node` 载荷都带有会随运行变化的墙钟 `startedAt` 与 `durationMs`，即使节点身份、路由、访问计数、已声明消息与事件顺序保持不变。

## 决策

[打包运行时冒烟测试](../../../../scripts/smoke-python-runtime.py)把这两类图事件保留在经审阅的期望输出中。`normalize_snapshot_value` 只把 `session/trace-node` 事件上的数值型 `data.startedAt` 与 `data.durationMs` 归零，包括它作为 `session.event` 通知被包装时的同一载荷。同名嵌套状态字段、检查点载荷、其他事件类型、不完整追踪、访问计数、路由、已声明消息与事件顺序仍参与比对。

`python/sdk/tests/test_smoke_model.py` 在不启动运行时的情况下拥有该边界。`scripts/snapshots/python-sdk-single-exe/` 下的 `sdk-snapshot` 与 `sdk-restart` 期望文件记录这些图事件，且那两个时钟已经归零。

## 曾考虑的替代方案

**从 Python 快照中丢掉检查点与追踪事件。** 否决，因为这些事件现已成为组装后的 SDK 转录的一部分。省略它们会让缺失、重排或语义已变的图事件通过打包运行时 CI。

**把所有 `startedAt` 与 `durationMs` 字段，或整份检查点载荷都归零。** 否决，因为嵌套状态时钟与检查点内容可以区分路由、访问计数、已声明消息与结果。过宽的擦除会掩盖这些变化。

**在提交文件中保留原始追踪时钟。** 否决，因为每个 CI 主机会写入不同的时间戳与持续时间，相同的图行为也会让快照比对失败。

**不写单元测试、只刷新基线。** 否决，因为后续录制可能再次引入易变时钟或丢掉事件。任一时钟仍为实时值，或图事件区分丢失时，pytest 用例会先失败。

## 后果

Python 打包运行时快照现在会在图事件缺失、重排或语义变化时失败，并在图行为相同时跨主机保持稳定。审阅者仍需检查检查点与追踪载荷，包括这些事件中捕获的沙箱与审批文本。此处未重建 SEA Windows 可执行文件；本地验证使用的是已暂存的 node 载体。Issue policy 的 GitHub App 输入仍是单独的仓库配置失败。
