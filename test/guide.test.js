import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, guidanceNotice, readEnabled, writeEnabled } from '../index.js'

function tempStateFile(name) {
  return join(tmpdir(), `dsh-guide-test-${process.pid}-${name}-${Date.now()}.json`)
}

/** Minimal Cordis-shaped context: effect, on, system prompt, and the web carrier. */
function makeCtx(config) {
  const listeners = new Map()
  const sections = []
  const routes = new Map()
  return {
    sections,
    routes,
    config,
    effect(fn) {
      return fn()
    },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    emit(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args)
    },
    preStep(payload, messages, next) {
      const handler = (listeners.get('agent/pre-step') ?? [])[0]
      return handler(payload, next ?? (async () => ({ kind: 'enter', messages })))
    },
  }
}

function userMessage(id, text) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${id}` },
  }
}

const signal = () => new AbortController().signal

function fakeReq(method, url, body) {
  const req = { method, url, socket: { remoteAddress: '127.0.0.1' } }
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(JSON.stringify(body))
    }
  }
  return req
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(value) {
      this.body = value
    },
  }
}

async function call(ctx, method, url, body) {
  const res = fakeRes()
  await ctx.routes.get('/dsh-guide').handler(fakeReq(method, url, body), res)
  return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) }
}

test('prompt section and the switch route are registered', () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('register') })
  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].name, 'dsh-guide/mid-task-guidance')
  assert.ok(ctx.routes.has('/dsh-guide'))
})

test('a message inserted while running gets a guidance notice before it', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('inject') })
  const agent = { id: 's1', status: 'running' }
  const message = userMessage('m1', '改成用 Tab 缩进')

  ctx.emit('agent/inbox/inserted', { agent, message })
  const decision = await ctx.preStep({ agent, messages: [message], turn: 2, step: 3, signal: signal() }, [message])

  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.kind, 'dsh-guide')
  assert.equal(decision.messages[0].source.form, 'notice')
  assert.match(decision.messages[0].content[0].text, /运行中指导/)
  assert.equal(decision.messages[1], message)
})

test('the notice is injected once and not repeated for the same message', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('once') })
  const agent = { id: 's1', status: 'running' }
  const message = userMessage('m1', 'use tabs')

  ctx.emit('agent/inbox/inserted', { agent, message })
  await ctx.preStep({ agent, messages: [message], turn: 2, step: 3, signal: signal() }, [message])
  const again = await ctx.preStep({ agent, messages: [], turn: 2, step: 4, signal: signal() }, [])

  assert.deepEqual(again, { kind: 'enter', messages: [] })
})

test('a message sent while running but queued into the next turn still gets the notice', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('queue') })
  const agent = { id: 's1', status: 'running' }
  const message = userMessage('m2', 'keep the tests passing')

  ctx.emit('agent/inbox/inserted', { agent, message })
  const decision = await ctx.preStep({ agent, messages: [message], turn: 5, step: 1, signal: signal() }, [message])

  assert.equal(decision.messages[0].source.kind, 'dsh-guide')
})

test('an idle send is an ordinary request and stays untouched', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('idle') })
  const agent = { id: 's1', status: 'idle' }
  const message = userMessage('m3', 'start a new task')

  ctx.emit('agent/inbox/inserted', { agent, message })
  const decision = await ctx.preStep({ agent, messages: [message], turn: 1, step: 1, signal: signal() }, [message])

  assert.equal(decision.messages.length, 1)
})

test('non-user sources are ignored', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('relay') })
  const agent = { id: 's1', status: 'running' }
  const message = { ...userMessage('m4', 'relay'), source: { kind: 'agent-message', form: 'relay', senderSessionId: 'p' } }

  ctx.emit('agent/inbox/inserted', { agent, message })
  const decision = await ctx.preStep({ agent, messages: [message], turn: 1, step: 1, signal: signal() }, [message])

  assert.equal(decision.messages.length, 1)
})

test('a discarded message never gets a notice', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('discard') })
  const agent = { id: 's1', status: 'running' }
  const message = userMessage('m5', 'never admitted')

  ctx.emit('agent/inbox/inserted', { agent, message })
  ctx.emit('agent/inbox/discarded', { agent, message })
  const decision = await ctx.preStep({ agent, messages: [message], turn: 1, step: 1, signal: signal() }, [message])

  assert.equal(decision.messages.length, 1)
})

test('a rejected step stays rejected', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('reject') })
  const agent = { id: 's1', status: 'running' }
  const message = userMessage('m6', 'hi')

  ctx.emit('agent/inbox/inserted', { agent, message })
  const decision = await ctx.preStep(
    { agent, messages: [message], turn: 1, step: 2, signal: signal() },
    [message],
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
})

test('a message admitted at step > 1 is guidance even without tracking', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('step') })
  const agent = { id: 's1', status: 'running' }
  const message = userMessage('m7', '走 B 方案')

  const decision = await ctx.preStep({ agent, messages: [message], turn: 3, step: 4, signal: signal() }, [message])

  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.kind, 'dsh-guide')
})

test('language follows the interjection', () => {
  assert.match(guidanceNotice([userMessage('a', '改成用 Tab')]).text, /运行中指导/)
  assert.match(guidanceNotice([userMessage('b', 'use tabs')]).text, /Mid-task guidance/)
})

test('switching off removes the rule and stops injecting', async () => {
  const file = tempStateFile('toggle-off')
  const ctx = makeCtx()
  apply(ctx, { stateFile: file })
  const agent = { id: 's1', status: 'running' }
  const message = userMessage('m8', 'stop guiding')

  const off = await call(ctx, 'POST', '/dsh-guide/toggle', { enabled: false })
  assert.equal(off.json.enabled, false)
  assert.equal(ctx.sections.length, 0)

  ctx.emit('agent/inbox/inserted', { agent, message })
  const decision = await ctx.preStep({ agent, messages: [message], turn: 2, step: 3, signal: signal() }, [message])
  assert.equal(decision.messages.length, 1)

  const on = await call(ctx, 'POST', '/dsh-guide/toggle', { enabled: true })
  assert.equal(on.json.enabled, true)
  assert.equal(ctx.sections.length, 1)

  const guided = await ctx.preStep({ agent, messages: [message], turn: 2, step: 4, signal: signal() }, [message])
  assert.equal(guided.messages[0].source.kind, 'dsh-guide')
})

test('the switch survives a restart through the state file', async () => {
  const file = tempStateFile('persist')
  rmSync(file, { force: true })
  writeEnabled(file, false)
  assert.equal(readEnabled(file), false)

  const ctx = makeCtx()
  apply(ctx, { stateFile: file })
  assert.equal(ctx.sections.length, 0)

  const state = await call(ctx, 'GET', '/dsh-guide/state?session=s1')
  assert.equal(state.json.enabled, false)
})

test('the state route reports the per-session injection count and timestamps', async () => {
  const ctx = makeCtx()
  apply(ctx, { stateFile: tempStateFile('count') })
  const agent = { id: 's1', status: 'running' }
  const message = userMessage('m9', 'one note')

  const before = await call(ctx, 'GET', '/dsh-guide/state?session=s1')
  assert.equal(before.json.injected, 0)
  assert.equal(before.json.interjectedAt, 0)

  ctx.emit('agent/inbox/inserted', { agent, message })
  const afterInsert = await call(ctx, 'GET', '/dsh-guide/state?session=s1')
  assert.ok(afterInsert.json.interjectedAt > 0)
  assert.ok(afterInsert.json.revision > before.json.revision)

  await ctx.preStep({ agent, messages: [message], turn: 2, step: 3, signal: signal() }, [message])

  const state = await call(ctx, 'GET', '/dsh-guide/state?session=s1')
  assert.equal(state.json.injected, 1)
  assert.equal(state.json.enabled, true)
  assert.ok(state.json.injectedAt >= state.json.interjectedAt)
  assert.ok(state.json.revision > afterInsert.json.revision)
})
