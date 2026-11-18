/**
 * dsh-guide — 运行中引导 / mid-task guidance.
 *
 * 问题：Agent 干活时用户在对话框里补一句话，这句话会以一条普通用户消息进入
 * 当前回合（steer）或下一回合（queue）。模型看到「user: 新的一句话」，通常
 * 会把它当成一条新任务，于是丢掉当前进度重做。
 *
 * 做法：在消息真正进入模型上下文的那一步（`agent/pre-step`），于用户消息之前
 * 注入一条 `notice` 形态的引导说明。用户消息本身保持原样，聊天记录与队列语义不变。
 *
 * 开关与徽标：`GET /dsh-guide/state` / `POST /dsh-guide/toggle` 暴露开关状态，
 * 状态落在 `$DSH_HOME/dsh-guide.state.json`；客户端在会话头右侧渲染一个状态徽标，
 * 点一下即可开关。关闭时不再注入说明，也不再把规则放进 system prompt。
 *
 * 只使用公开扩展点：`agent/inbox/*`、`agent/pre-step`、`systemPrompt.section`、`webServer`。
 * 不 import 任何 @deepseek-ai 包，也不改动 Session 日志里用户的原文。
 *
 * @module @local/dsh-guide
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-guide'
export const inject = ['systemPrompt', 'webServer', 'agents']

/** Source kind of the injected notice; also the collapsed Chat row's label. */
const SOURCE_KIND = 'dsh-guide'

const ROUTE = '/dsh-guide'
const MAX_BODY = 64 * 1024
const MAX_TRACKED = 256

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/

const NOTE_ZH = [
  '<system-reminder>',
  '[运行中指导 · dsh-guide] 用户在你执行当前任务期间补充了下面的消息。',
  '请把它当作对当前任务的引导，而不是一个新任务：保留已经完成的工作，不要重来、不要重复已完成的步骤；',
  '只调整这条指引真正涉及的部分，然后继续当前任务。',
  '</system-reminder>',
].join('')

const NOTE_EN = [
  '<system-reminder>',
  '[Mid-task guidance · dsh-guide] The user sent the message below while this turn was still running. ',
  'Treat it as guidance for the task in progress, not as a new task: keep the work already completed, ',
  'do not restart or repeat finished steps, change only what this guidance actually affects, then continue the current task.',
  '</system-reminder>',
].join('')

const SUMMARY_ZH = '运行中指导 · 继续当前任务，不重做'
const SUMMARY_EN = 'Mid-task guidance · continue the current task'

/** One constant prompt section so the rule survives even if the notice is compacted away. */
const PROMPT_SECTION = [
  'Messages marked with a "[运行中指导 · dsh-guide]" or "[Mid-task guidance · dsh-guide]" system-reminder',
  'arrived while you were already working. Treat them as guidance for the task in progress, not as a new task:',
  'keep the work you already completed, do not restart or repeat finished steps, apply only what the guidance',
  'changes, and continue. Messages without that marker are ordinary requests.',
].join(' ')

/**
 * Render the guidance notice for the language of the interjection.
 * @param {readonly unknown[]} messages - the user messages entering this step.
 * @returns {{ text: string, summary: string }} model-facing notice and its one-line row summary.
 */
export function guidanceNotice(messages) {
  const text = messages
    .map((message) => {
      if (message === null || typeof message !== 'object') return ''
      const content = /** @type {{ content?: readonly { type?: string, text?: string }[] }} */ (message).content
      if (!Array.isArray(content)) return ''
      return content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('\n')
    })
    .join('\n')
  return CJK.test(text)
    ? { text: NOTE_ZH, summary: SUMMARY_ZH }
    : { text: NOTE_EN, summary: SUMMARY_EN }
}

/**
 * Build the notice message. Shaped like every other injected context message:
 * a user-role message whose `source` is not `user`, so Chat renders it as a
 * collapsed context row and message source checks ignore it.
 * @param {{ text: string, summary: string }} notice - rendered notice.
 * @returns {object} a complete `UserMessage` value.
 */
export function createNoticeMessage({ text, summary }) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary },
  }
}

/** Where the on/off state lives for this profile. */
function statePath(config) {
  if (typeof config?.stateFile === 'string') return config.stateFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-guide.state.json')
}

/** Read the persisted switch; a missing or unreadable file means "on". */
export function readEnabled(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw?.enabled !== false
  } catch {
    return true
  }
}

/** Persist the switch. A write failure must not break the agent loop. */
export function writeEnabled(file, enabled) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ enabled }, null, 2))
  } catch {
    /* best effort: the in-memory switch still works for this process */
  }
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('payload too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/**
 * Register the guidance behavior.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {{ enabled?: boolean, stateFile?: string }} [config] - optional row config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const file = statePath(config)
  let enabled = typeof config?.enabled === 'boolean' ? config.enabled : readEnabled(file)
  let revision = 0
  if (config?.enabled === false || config?.enabled === true) writeEnabled(file, enabled)

  /** Messages that arrived while their agent was running: `messageId -> sessionId`. */
  const midTask = new Map()
  /** When a Session last received a mid-task message, for the felt confirmation. */
  const interjections = new Map()
  /** How many notices were injected per Session, and when the last one was read. */
  const injections = new Map()
  /** The live prompt-section disposer, so the switch can remove the rule. */
  let disposeSection = null

  const syncSection = () => {
    if (disposeSection !== null) {
      disposeSection()
      disposeSection = null
    }
    if (!enabled) return
    disposeSection = ctx.systemPrompt.section({
      name: 'dsh-guide/mid-task-guidance',
      order: 9000,
      text: PROMPT_SECTION,
    })
  }
  syncSection()
  ctx.effect(() => () => {
    if (disposeSection !== null) {
      disposeSection()
      disposeSection = null
    }
  })

  const snapshot = (sessionId) => {
    const key = typeof sessionId === 'string' ? sessionId : ''
    const entry = injections.get(key)
    return {
      enabled,
      revision,
      injected: entry?.count ?? 0,
      interjectedAt: interjections.get(key) ?? 0,
      injectedAt: entry?.at ?? 0,
    }
  }

  const setEnabled = (next) => {
    if (next === enabled) return
    enabled = next
    revision += 1
    writeEnabled(file, enabled)
    syncSection()
  }

  /* A message inserted while the agent is running arrived mid-task, whichever
     delivery mode the composer used: steer (same turn) or queue (next turn). */
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      if (!enabled) return
      if (message?.source?.kind !== 'user') return
      if (agent.status !== 'running') return
      if (midTask.size >= MAX_TRACKED) {
        const oldest = midTask.keys().next().value
        if (oldest !== undefined) midTask.delete(oldest)
      }
      midTask.set(message.id, agent.id)
      interjections.set(agent.id, Date.now())
      revision += 1
    } catch {
      /* Never break an in-flight admission because bookkeeping failed. */
    }
  })

  ctx.on('agent/inbox/discarded', ({ message }) => {
    midTask.delete(message.id)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    for (const [messageId, sessionId] of midTask) {
      if (sessionId === agent.id) midTask.delete(messageId)
    }
  })

  ctx.on('agent/pre-step', async ({ agent, signal, step }, next) => {
    const decision = await next()
    try {
      if (!enabled) return decision
      if (decision.kind === 'reject' || signal.aborted) return decision
      /* Two independent signals, so guidance survives even if inbox tracking
         misses an insertion:
         - tracked: the message entered the inbox while its agent was running,
           which also covers queue-mode delivery into a later turn;
         - step > 1: the turn already ran at least one step, so a user message
           admitted now can only have arrived mid-task. */
      const guided = decision.messages.filter(
        (message) =>
          midTask.has(message.id) ||
          (step > 1 && message.source?.kind === 'user'),
      )
      if (guided.length === 0) return decision
      for (const message of guided) midTask.delete(message.id)
      const notice = createNoticeMessage(guidanceNotice(guided))
      const previous = injections.get(agent.id)
      injections.set(agent.id, { count: (previous?.count ?? 0) + 1, at: Date.now() })
      revision += 1
      return { ...decision, messages: [notice, ...decision.messages] }
    } catch {
      /* A guidance notice is best-effort: the step still enters with its own messages. */
      return decision
    }
  })

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === `${ROUTE}/state` && req.method === 'GET') {
        sendJson(res, 200, snapshot(url.searchParams.get('session') ?? ''))
        return
      }

      if (url.pathname === `${ROUTE}/toggle` && req.method === 'POST') {
        const body = await readJson(req)
        const next = typeof body.enabled === 'boolean' ? body.enabled : !enabled
        setEnabled(next)
        sendJson(res, 200, snapshot(body.sessionId ?? ''))
        return
      }

      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      sendJson(res, 500, { error: String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
}
