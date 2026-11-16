/**
 * Image relay: when the session's current model accepts text only, describe
 * each image with an image-capable model from the same provider and inject the
 * description next to the image so the text-only model can use it.
 *
 * Covered paths:
 * - `agent/pre-step`: images attached to newly claimed user messages get a
 *   description text block inserted after the image block.
 * - `tools/post-execute`: `read_image` results get the same treatment.
 *
 * For models listed in `relayFor` (or when `always` is set) the catalog's
 * declared modality is not trusted: the relay always runs and the image block
 * is REPLACED by the description text in the outgoing request, so an endpoint
 * that is text-only in practice never receives an image block even though the
 * catalog claims otherwise (the UI-side `input: [text, image]` override case).
 *
 * The image blocks themselves stay in the durable log untouched; only the
 * per-step request messages are rewritten.
 *
 * @module @local/image-relay
 */

/**
 * This plugin deliberately imports no Cordis internals: a locally installed
 * bundle is a linked checkout whose module resolution cannot reach the
 * Harness's internal packages, so stream assembly is done over the raw chunk
 * protocol instead of `BlockAssembler`, and configuration is validated by
 * hand. Node built-ins are safe to import.
 * @module @local/image-relay
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'image-relay'
export const inject = ['llm']

/** Prefix of every injected description block; also the idempotency marker. */
const RELAY_PREFIX = '[image relay:'

const DEFAULT_PROMPT = 'Describe this image precisely for a text-only assistant: overall subject, visible text (transcribed verbatim), objects and people, layout, colors, and any data or numbers. Be factual and concise; do not speculate beyond what is visible.'

/** Descriptions persisted to disk survive restarts; capped to bound growth. */
const CACHE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'description-cache.json')
const CACHE_MAX_ENTRIES = 500

/**
 * Load the persistent description cache, best effort.
 * @returns {Map<string, string>} attachmentId -> description.
 */
function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    const entries = Object.entries(raw ?? {}).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
    return new Map(entries.slice(-CACHE_MAX_ENTRIES))
  } catch {
    return new Map()
  }
}

/**
 * Persist the description cache, best effort; failures are logged and ignored.
 * @param {Map<string, string>} cache
 * @param {object} log
 * @returns {void}
 */
function saveCache(cache, log) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 })
  } catch (error) {
    log.warn(`image-relay: cannot persist description cache: ${error?.message ?? error}`)
  }
}

/**
 * Mount the pre-step and post-execute listeners.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {any} config - validated plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const log = ctx.logger ?? console
  const maxTokens = Number.isInteger(config.maxTokens) && config.maxTokens > 0 ? config.maxTokens : 1024
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs >= 1000 ? config.timeoutMs : 120000
  const retries = Number.isInteger(config.retries) && config.retries >= 0 ? config.retries : 1
  const prompt = typeof config.prompt === 'string' && config.prompt.trim().length > 0 ? config.prompt : DEFAULT_PROMPT
  const explicitModel = typeof config.visionModel === 'string' && config.visionModel.length > 0 ? config.visionModel : undefined
  const explicitProvider = typeof config.visionProvider === 'string' && config.visionProvider.length > 0 ? config.visionProvider : undefined
  const preferred = Array.isArray(config.preferVisionModels)
    ? config.preferVisionModels.filter((id) => typeof id === 'string' && id.length > 0)
    : []
  const relayFor = new Set(
    (Array.isArray(config.relayFor) ? config.relayFor : [])
      .filter((id) => typeof id === 'string' && id.length > 0)
      .flatMap((id) => (id.includes('/') ? id.split('/', 2) : [id])),
  )

  /** attachmentId -> description text; persisted across sessions. */
  const descriptions = loadCache()
  /** `${provider}/${model}` -> boolean image capability. */
  const imageCapability = new Map()
  /** `${provider}` -> vision model id or null. */
  const visionChoice = new Map()

  /**
   * Whether one exact route accepts image input. Absent modality metadata
   * counts as text-only: pi-ai falls back to `defaultInput` `[text]` and the
   * direct DeepSeek adapter treats omission as text-only.
   */
  async function routeAcceptsImages(provider, model) {
    const key = `${provider}/${model}`
    const cached = imageCapability.get(key)
    if (cached !== undefined) return cached
    let accepts = false
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      accepts = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
    } catch (error) {
      log.warn(`image-relay: resolveModelInfo(${key}) failed: ${error?.message ?? error}`)
      return false // transient: do not cache the failure
    }
    imageCapability.set(key, accepts)
    return accepts
  }

  /**
   * Pick an image-capable model id within one provider: explicit config first,
   * then preference order, then the adapter's first advertised vision model.
   */
  async function pickVisionModel(provider) {
    if (visionChoice.has(provider)) return visionChoice.get(provider)
    let picked
    try {
      const models = await ctx.llm.listModels(provider)
      const vision = (models ?? []).filter((m) => Array.isArray(m?.inputModalities) && m.inputModalities.includes('image'))
      if (explicitModel !== undefined && vision.some((m) => m.id === explicitModel)) {
        picked = explicitModel
      } else {
        picked = preferred.map((id) => vision.find((m) => m.id === id)).find(Boolean)?.id ?? vision[0]?.id
      }
    } catch (error) {
      log.warn(`image-relay: listModels(${provider}) failed: ${error?.message ?? error}`)
      picked = undefined // transient: do not cache the failure
    }
    if (picked !== undefined) visionChoice.set(provider, picked)
    return picked
  }

  /**
   * Provider whose vision models describe images: the current route's own
   * provider by default, or an explicit `visionProvider` for cross-provider
   * relay (for example glm-5.3 on zai-coding-cn described by a DeepSeek
   * vision route).
   */
  function relayProviderFor(provider) {
    return explicitProvider ?? provider
  }

  /**
   * Whether this exact route must be relayed with image replacement regardless
   * of the declared modality: blanket `always`, or the route appears in
   * `relayFor` (matched by model id or `provider/model`).
   */
  function forcedRoute(provider, model) {
    return config.always === true || relayFor.has(model) || relayFor.has(`${provider}/${model}`)
  }

  /**
   * Decide whether to relay for one route, and whether image blocks must be
   * replaced by text in the outgoing request. Replacement is required whenever
   * request assembly would pass the image through (declared image-capable
   * routes); text-only declared routes already project images to placeholders,
   * so the description is simply inserted beside the placeholder.
   * @returns {boolean} true when the relay should run for this route.
   */
  async function shouldRelay(provider, model) {
    if (forcedRoute(provider, model)) return true
    return !(await routeAcceptsImages(provider, model))
  }

  /** Combine the caller signal with a deadline signal when the API is available. */
  function withDeadline(signal, ms) {
    const timeout = AbortSignal.timeout(ms)
    if (typeof AbortSignal.any === 'function' && signal) return AbortSignal.any([signal, timeout])
    return timeout
  }

  /**
   * Describe one durable image block through the vision model, with retry.
   * @returns description text, or undefined when the call fails; failures fall
   *   back to the harness placeholder rather than failing the turn.
   */
  async function describeImage(provider, visionModel, block, signal) {
    const attachmentId = String(block.attachment?.attachmentId ?? '')
    if (attachmentId && descriptions.has(attachmentId)) return descriptions.get(attachmentId)
    for (let attempt = 0; ; attempt += 1) {
      try {
        const deadlineSignal = withDeadline(signal, timeoutMs)
        const call = await ctx.llm.prepareCall({ provider, model: visionModel, maxTokens }, deadlineSignal)
        let streamed = ''
        let finishKind
        for await (const chunk of call.stream({
          ...call.config,
          messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }],
          system: 'You describe images for an assistant that cannot see them. Reply with the description only.',
          purpose: 'image-relay',
          signal: deadlineSignal,
        })) {
          if (chunk.type === 'text-delta') streamed += chunk.text
          else if (chunk.type === 'finish') finishKind = chunk.reason?.kind ?? chunk.kind
        }
        if (finishKind === 'stop' || finishKind === 'max-tokens') {
          const text = streamed.trim() || undefined
          if (text !== undefined) {
            if (attachmentId) {
              descriptions.set(attachmentId, text)
              if (descriptions.size > CACHE_MAX_ENTRIES) {
                descriptions.delete(descriptions.keys().next().value)
              }
              saveCache(descriptions, log)
            }
            return text
          }
        }
        log.warn(`image-relay: description finished with kind=${String(finishKind)}`)
      } catch (error) {
        log.warn(`image-relay: description attempt ${attempt + 1} failed: ${error?.message ?? error}`)
      }
      if (attempt >= retries) return undefined
    }
  }

  /** Relay marker block for one described image. */
  function relayBlock(provider, visionModel, description) {
    return { type: 'text', text: `${RELAY_PREFIX} ${provider}/${visionModel}]\n${description}` }
  }

  /** Placeholder used when replacement is required but no description exists. */
  function unavailableBlock(provider, visionModel) {
    return { type: 'text', text: `${RELAY_PREFIX} ${provider}/${visionModel}] image omitted: description unavailable` }
  }

  /**
   * Rewrite one content array. All images without an existing relay marker are
   * described concurrently. In replace mode the image block is dropped and the
   * description (or placeholder) stands in for it; otherwise the description
   * is inserted right after the untouched image block.
   * @returns the rewritten array, or the original reference when unchanged.
   */
  async function relayContent(content, provider, visionModel, signal, replace) {
    if (!Array.isArray(content) || !content.some((block) => block?.type === 'image')) return content
    // Pass 1: locate image blocks and which of them need a fresh description.
    const pending = []
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index]
      if (block?.type !== 'image') continue
      const following = content[index + 1]
      const already = following !== undefined && following.type === 'text' && following.text.startsWith(RELAY_PREFIX)
      if (!already) pending.push(index)
    }
    // Describe concurrently; undefined marks failure.
    const described = await Promise.all(pending.map((index) => describeImage(provider, visionModel, content[index], signal)))
    const fresh = new Map(pending.map((index, slot) => [index, described[slot]]))
    if (!replace && fresh.size === 0) return content
    // Pass 2: rebuild.
    const next = []
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index]
      if (block?.type !== 'image') {
        next.push(block)
        continue
      }
      const following = content[index + 1]
      const already = following !== undefined && following.type === 'text' && following.text.startsWith(RELAY_PREFIX)
      if (replace) {
        if (already) {
          next.push(following) // reuse the existing marker text verbatim
          index += 1 // skip the stale marker
        } else {
          const description = fresh.get(index)
          next.push(description !== undefined ? relayBlock(provider, visionModel, description) : unavailableBlock(provider, visionModel))
        }
      } else if (already) {
        next.push(block, following)
        index += 1
      } else {
        const description = fresh.get(index)
        if (description !== undefined) next.push(block, relayBlock(provider, visionModel, description))
        else next.push(block)
      }
    }
    return next
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (config.enabled === false || decision.kind !== 'enter') return decision
    if (!decision.messages.some((message) => Array.isArray(message?.content) && message.content.some((block) => block?.type === 'image'))) return decision
    const { provider, model } = payload.modelSelection
    if (provider === undefined || model === undefined) return decision
    if (!(await shouldRelay(provider, model))) return decision
    const relayProvider = relayProviderFor(provider)
    const visionModel = await pickVisionModel(relayProvider)
    if (visionModel === undefined) return decision
    const replace = forcedRoute(provider, model)
    log.info(`image-relay: relaying via ${relayProvider}/${visionModel} for ${provider}/${model}${replace ? ' (replace)' : ''}`)
    const relayed = []
    for (const message of decision.messages) {
      const content = await relayContent(message.content, relayProvider, visionModel, payload.signal, replace)
      relayed.push(content === message.content ? message : { ...message, content })
    }
    return { ...decision, messages: relayed }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (config.enabled === false || exec.name !== 'read_image') return decision
    if (decision.kind !== 'accept' || decision.content !== undefined) return decision
    const content = result?.content
    if (!Array.isArray(content) || !content.some((block) => block?.type === 'image')) return decision
    const selection = exec.agent?.model?.current?.()
    if (selection?.provider === undefined || selection?.model === undefined) return decision
    if (!(await shouldRelay(selection.provider, selection.model))) return decision
    const relayProvider = relayProviderFor(selection.provider)
    const visionModel = await pickVisionModel(relayProvider)
    if (visionModel === undefined) return decision
    const replace = forcedRoute(selection.provider, selection.model)
    const relayed = await relayContent(content, relayProvider, visionModel, exec.signal, replace)
    if (relayed === content) return decision
    return { kind: 'accept', content: relayed }
  })
}
