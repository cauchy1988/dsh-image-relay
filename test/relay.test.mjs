import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { randomUUID } from 'node:crypto'

/**
 * Mock Cordis context: captures event handlers and records vision calls.
 * `acceptsImages` drives resolveModelInfo; `failStream` makes descriptions fail.
 */
function makeCtx({ acceptsImages = false, failStream = false } = {}) {
  const calls = { prepareCall: 0, requests: [] }
  const handlers = {}
  const ctx = {
    on: (name, fn) => { handlers[name] = fn },
    logger: { info() {}, warn() {} },
    llm: {
      async resolveModelInfo() {
        return { inputModalities: acceptsImages ? ['text', 'image'] : ['text'] }
      },
      async listModels() {
        return [
          { id: 'text-model', inputModalities: ['text'] },
          { id: 'glm-4.6v', inputModalities: ['text', 'image'] },
        ]
      },
      async prepareCall() {
        calls.prepareCall += 1
        return {
          config: {},
          stream: (req) => {
            calls.requests.push(req)
            if (failStream) {
              return (async function* () {
                throw new Error('boom')
              })()
            }
            return (async function* () {
              yield { type: 'text-delta', text: `DESC:${req.messages[0].content[0].attachment.attachmentId}` }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      },
    },
  }
  return { ctx, handlers, calls }
}

function imageBlock() {
  return { type: 'image', attachment: { attachmentId: `sha256:${randomUUID()}` } }
}

const text = (t) => ({ type: 'text', text: t })

async function runPreStep(handler, content, { provider = 'zai', model = 'glm-5.3' } = {}) {
  return handler(
    { modelSelection: { provider, model }, signal: undefined },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content }] }),
  )
}

test('text-only declared route: description inserted after the image', async () => {
  const { ctx, handlers, calls } = makeCtx({ acceptsImages: false })
  apply(ctx, { relayFor: [] })
  const img = imageBlock()
  const decision = await runPreStep(handlers['agent/pre-step'], [img, text('看到了啥')])
  assert.equal(calls.prepareCall, 1)
  assert.equal(calls.requests[0].messages[0].content[1].text.includes('Describe this image'), true)
  const out = decision.messages[0].content
  assert.deepEqual(out.map((b) => b.type), ['image', 'text', 'text'])
  assert.match(out[1].text, /^\[image relay: zai\/glm-4\.6v\]\nDESC:sha256:/)
  assert.equal(out[2].text, '看到了啥')
})

test('forced route (relayFor) with lying catalog: image replaced by description', async () => {
  const { ctx, handlers, calls } = makeCtx({ acceptsImages: true })
  apply(ctx, { relayFor: ['glm-5.3'] })
  const img = imageBlock()
  const decision = await runPreStep(handlers['agent/pre-step'], [text('hi'), img])
  assert.equal(calls.prepareCall, 1)
  const out = decision.messages[0].content
  assert.equal(out.some((b) => b.type === 'image'), false, 'image block must be replaced')
  assert.deepEqual(out.map((b) => b.type), ['text', 'text'])
  assert.match(out[1].text, /^\[image relay: zai\/glm-4\.6v\]\nDESC:sha256:/)
})

test('duplicate images in one batch are described exactly once', async () => {
  const { ctx, handlers, calls } = makeCtx({ acceptsImages: false })
  apply(ctx, { relayFor: [] })
  const img = { type: 'image', attachment: { attachmentId: `sha256:${randomUUID()}` } }
  const decision = await runPreStep(handlers['agent/pre-step'], [img, { ...img }, text('q')])
  assert.equal(calls.prepareCall, 1, 'in-flight dedupe must collapse concurrent identical images')
  const out = decision.messages[0].content
  assert.equal(out.filter((b) => b.type === 'text' && b.text.startsWith('[image relay:')).length, 2)
})

test('forced route with failing description: placeholder replaces the image', async () => {
  const { ctx, handlers, calls } = makeCtx({ acceptsImages: true, failStream: true })
  apply(ctx, { relayFor: ['glm-5.3'], retries: 0 })
  const img = imageBlock()
  const decision = await runPreStep(handlers['agent/pre-step'], [img])
  assert.equal(calls.prepareCall, 1)
  const out = decision.messages[0].content
  assert.equal(out.some((b) => b.type === 'image'), false)
  assert.match(out[0].text, /image omitted: description unavailable/)
})

test('image-capable route not in relayFor: untouched, zero vision calls', async () => {
  const { ctx, handlers, calls } = makeCtx({ acceptsImages: true })
  apply(ctx, { relayFor: [] })
  const content = [imageBlock(), text('q')]
  const decision = await runPreStep(handlers['agent/pre-step'], content)
  assert.equal(calls.prepareCall, 0)
  assert.equal(decision.messages[0].content, content)
})

test('second pass over relayed content is idempotent and cache-hit', async () => {
  const { ctx, handlers, calls } = makeCtx({ acceptsImages: false })
  apply(ctx, { relayFor: [] })
  const handler = handlers['agent/pre-step']
  const first = await runPreStep(handler, [imageBlock(), text('q')])
  assert.equal(calls.prepareCall, 1)
  const second = await runPreStep(handler, first.messages[0].content)
  assert.equal(calls.prepareCall, 1, 'cached attachment must not be re-described')
  const out = second.messages[0].content
  assert.equal(out.filter((b) => b.type === 'text' && b.text.startsWith('[image relay:')).length, 1)
})

test('read_image results are relayed on forced routes', async () => {
  const { ctx, handlers, calls } = makeCtx({ acceptsImages: true })
  apply(ctx, { relayFor: ['glm-5.3'] })
  const img = imageBlock()
  const decision = await handlers['tools/post-execute'](
    { name: 'read_image', agent: { model: { current: () => ({ provider: 'zai', model: 'glm-5.3' }) } }, signal: undefined },
    { content: [img] },
    async () => ({ kind: 'accept', content: undefined }),
  )
  assert.equal(calls.prepareCall, 1)
  assert.equal(decision.content.some((b) => b.type === 'image'), false)
  assert.match(decision.content[0].text, /^\[image relay: zai\/glm-4\.6v\]/)
})
