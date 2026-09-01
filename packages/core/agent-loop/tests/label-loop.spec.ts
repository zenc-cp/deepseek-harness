/**
 * Integration tests for the label-loop adapter.
 *
 * Covers: stream classification, synthetic INVALID_LABEL finish, and retry
 * through the `agent/request-error` waterfall.
 *
 * The label-loop registers its agent/request-error handler inside
 * `installLabelLoop`, so external waterfall observers must register
 * BEFORE installLabelLoop to fire before the label-loop handler swallows
 * the event with its { kind: 'retry' } return.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { installLabelLoop } from '@deepseek-ai/dsh-agent-loop'
import type { LabelVocabulary } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const chatVocab: LabelVocabulary = {
  allowedLabels: ['FINISH', 'TOOL', 'THINK'],
  terminalLabels: ['FINISH', 'TOOL'],
}

async function harness(adapter: MockAdapter, vocab?: LabelVocabulary): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  installLabelLoop(ctx, { defaultVocabulary: vocab, probeMaxChars: 64 })
  return ctx
}

describe('label-loop adapter', () => {
  it('passes through a correctly labeled stream unchanged', async () => {
    const adapter = new MockAdapter([
      textResponse('``FINISH`` Hello, I labeled correctly.'),
    ])
    const ctx = await harness(adapter, chatVocab)
    const agent = ctx.agentLoop.create(SessionId('ok'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const last = agent.session.deriveMessages().at(-1)
    expect(last?.content.some(b => b.type === 'text' && b.text.includes('labeled correctly'))).toBeTruthy()
  })

  it('retries once when the first response is unlabeled', async () => {
    const adapter = new MockAdapter([
      textResponse('Hello, I have no label.'),
      textResponse('``FINISH`` I learned my lesson.'),
    ])
    const ctx = await harness(adapter, chatVocab)
    const agent = ctx.agentLoop.create(SessionId('retry'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const last = agent.session.deriveMessages().at(-1)
    expect(last?.content.some(b => b.type === 'text' && b.text.includes('learned my lesson'))).toBeTruthy()
  })

  it('passes through when no vocabulary is configured', async () => {
    const adapter = new MockAdapter([
      textResponse('completely raw text with no labels at all'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('no-vocab'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
  })

  it('failFast mode does not retry on INVALID_LABEL', async () => {
    const adapter = new MockAdapter([
      textResponse('no label here'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    installLabelLoop(ctx, { defaultVocabulary: chatVocab, failFast: true, probeMaxChars: 64 })

    const agent = ctx.agentLoop.create(SessionId('failfast'), { provider: 'mock', model: 'mock' })
    let retried = false
    ctx.on('agent/request-error', () => {
      retried = true
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(retried).toBe(false)
    expect(adapter.requests).toHaveLength(1)
  })
})