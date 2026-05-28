import { describe, expect, it } from 'bun:test'
import { AgentSessionRenderer } from './agent-session'
import { CodexSessionRenderer } from './codex-session'

// Regression coverage for the duplicate-tail bug reported against #249
// (a285db16 "fix(slackbot): deliver the final answer when it never streamed live").
//
// Symptom: "the last 2-3 characters of the main reply get posted again in the thread."
//
// Root cause: on a fast turn the answer is queued and never flushed live, so done() folds the
// FULL answer into the durable chat.stopStream blocks but credits coverage as the count of
// live-streamed delta source chars. When the control plane's result_text carries a few trailing
// characters beyond that count, _slackbot_live_delivery_covers_result() returns False and the
// fallback reposts result_text.slice(streamed_chars) — the answer's tail — even though it is
// already present in the durable block.
//
// Fix: the renderer reports finalAnswerDurablyDelivered when the complete answer was composed
// into the durable blocks. The control plane treats that as full coverage and skips the fallback
// continuation. These tests pin the slackbot side of that contract.

function makeClient() {
  const calls: Array<{ method: string; params: any }> = []
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      startStream: async () => ({ ok: true, ts: '1778866940.295499' }),
      appendStream: async (params: any) => {
        calls.push({ method: 'chat.appendStream', params })
        return { ok: true }
      },
      stopStream: async (params: any) => {
        calls.push({ method: 'chat.stopStream', params })
        return { ok: true }
      },
      update: async () => ({ ok: true })
    }
  }
  return { client, calls }
}

function durableBlockText(calls: Array<{ method: string; params: any }>): string {
  const stop = calls.find(c => c.method === 'chat.stopStream')
  return (stop?.params.blocks ?? [])
    .filter((b: any) => b.type === 'markdown')
    .map((b: any) => String(b.text ?? ''))
    .join('\n')
}

describe('#249 duplicate-tail regression: durable-delivery signal', () => {
  it('reports finalAnswerDurablyDelivered when a fast-turn answer is folded into durable blocks', async () => {
    const { client, calls } = makeClient()
    const renderer = new AgentSessionRenderer(client as any)
    const { sessionId } = await renderer.open({
      channel: 'C123',
      parentTs: '1778883099.579529',
      recipientTeamId: 'T123',
      recipientUserId: 'U123',
      title: 'Centaur execution'
    })
    // A tool ran -> the segment carries a live plan (fold requires tasks.size > 0).
    await renderer.step(sessionId, {
      id: 'cmd-1',
      title: '1. run migration check',
      status: 'complete',
      details: '```\nmake db:check\n```',
      output: '```\nok\n```'
    })
    // Whole answer arrives in one burst and is only queued (never flushed live).
    const answer = 'Done. The migration is safe to run now'
    await renderer.textDelta(sessionId, answer, { flush: false })
    const result = await renderer.done(sessionId, { answerMarkdown: answer })

    // The complete answer is durably delivered, so the control plane must skip the fallback.
    expect(result.finalAnswerDurablyDelivered).toBe(true)
    expect(durableBlockText(calls)).toContain(answer)
  })

  it('does NOT report durable delivery when the answer streamed live', async () => {
    const { client, calls } = makeClient()
    const renderer = new AgentSessionRenderer(client as any)
    const { sessionId } = await renderer.open({
      channel: 'C123',
      parentTs: '1778883099.579529',
      recipientTeamId: 'T123',
      recipientUserId: 'U123',
      title: 'Centaur execution'
    })
    await renderer.step(sessionId, {
      id: 'cmd-1',
      title: '1. Command execution',
      status: 'in_progress'
    })
    await renderer.text(sessionId, 'Live answer body.')
    // Completing the step force-flushes the pending text, so the answer streams live.
    await renderer.step(sessionId, {
      id: 'cmd-1',
      title: '1. Command execution',
      status: 'complete'
    })
    const result = await renderer.done(sessionId, { answerMarkdown: 'Live answer body.' })

    // Streamed-live answers keep the existing coverage fallback as a safety net.
    expect(result.finalAnswerDurablyDelivered).toBe(false)
    expect(durableBlockText(calls)).not.toContain('Live answer body.')
  })

  it('propagates the durable-delivery signal through the codex harness-event response', async () => {
    const { client } = makeClient()
    const { sessionId } = await new AgentSessionRenderer(client as any).open({
      channel: 'C123',
      parentTs: '1778883099.579529',
      recipientTeamId: 'T123',
      recipientUserId: 'U123',
      title: 'Centaur execution'
    })
    const renderer = new CodexSessionRenderer(client as any)
    // No tools, no live plan -> a text-only turn streams live, not folded.
    const terminal = await renderer.event(sessionId, { type: 'result', text: 'PONG' })
    expect(terminal.done).toBe(true)
    expect(typeof terminal.finalAnswerDurablyDelivered).toBe('boolean')
    expect(terminal.finalAnswerDurablyDelivered).toBe(false)
  })
})
