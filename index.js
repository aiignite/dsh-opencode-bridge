/**
 * OpenCode Zen 免费模型 → DeepSeek Harness 原生 LlmAdapter。
 *
 * 免费层只认「真实的 opencode 运行时」：本插件在一个隔离的数据目录里拉起
 * `opencode serve`（独立 XDG 根、随机本地密码、permission=ask 的隔离 agent），
 * 再把这个运行时当前免费（各计费维度均为 0）的模型注册成一个 DSH provider。
 *
 * 运行时里的所有本地审批都会被拒绝并由桥接层转交为外部工具调用，因此在
 * 本机不会执行任何动作；真正执行的是 Harness。
 */

import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { findRuntime, startBackend } from './lib/runtime.js'
import { freeModels } from './lib/backend.js'
import { prepare } from './lib/protocol.js'
import { reasoningEfforts } from './lib/reasoning.js'

/** Provider 路由名（模型选择器里的分组）。 */
const PROVIDER = 'opencode-bridge'
const PROVIDER_LABEL = 'OpenCode 免费模型'
const REFRESH_MS = 10 * 60 * 1000

export const inject = ['llm']

/* ------------------------------------------------------------------ */
/* 模型 id                                                             */
/* ------------------------------------------------------------------ */

/** 运行时目录里的 id 是 `opencode/<name>`；对外只暴露 <name>。 */
function exposedID(runtimeID) {
  return runtimeID.startsWith('opencode/') ? runtimeID.slice('opencode/'.length) : runtimeID
}

/* ------------------------------------------------------------------ */
/* 消息转换：DSH 消息 → OpenAI chat messages                            */
/* ------------------------------------------------------------------ */

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

async function toOpenAIMessages(options, supportsImages, attachments) {
  const messages = []

  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }

  for (const message of options.messages ?? []) {
    if (!message || typeof message !== 'object') continue

    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content)
      if (text) messages.push({ role: 'system', content: text })
      continue
    }

    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? message.source?.callId ?? 'unknown',
        content: textOf(message.content) || '(no output)',
      })
      continue
    }

    if (message.role === 'assistant') {
      const text = textOf(message.content)
      const calls = (message.content ?? [])
        .filter(block => block && block.type === 'tool-call')
        .map(block => ({
          id: block.id ?? `call_${Math.random().toString(36).slice(2)}`,
          type: 'function',
          function: { name: block.name, arguments: block.arguments ?? '{}' },
        }))
      if (!text && calls.length === 0) continue
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      })
      continue
    }

    messages.push({
      role: 'user',
      content: await toOpenAIUserContent(message, supportsImages, attachments),
    })
  }

  return messages
}

/**
 * 把 DSH 的 user 消息转换成 OpenAI 内容数组，图片转成 base64 data URL。
 * 图片字节通过 host 的 attachments 服务按请求尺寸投影后读取。
 */
async function toOpenAIUserContent(message, supportsImages, attachments) {
  const parts = []
  for (const block of message.content ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      if (!supportsImages || block.offloaded || !attachments) {
        parts.push({ type: 'text', text: '[图片已省略：当前模型不支持图片或图片已被卸载]' })
        continue
      }
      try {
        const ref = block.attachment
        const target = {
          width: ref?.width ?? 1024,
          height: ref?.height ?? 1024,
          maxBytes: ref?.bytes ?? 4 * 1024 * 1024,
        }
        const request = await attachments.readImageRequest(ref, target)
        const base64 = Buffer.from(request.data).toString('base64')
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${request.mediaType};base64,${base64}` },
        })
      } catch (error) {
        parts.push({ type: 'text', text: `[图片读取失败：${error?.message ?? error}]` })
      }
      continue
    }
    if (block.type === 'file') {
      parts.push({ type: 'text', text: '[附件已省略：当前版本仅转发图片与文本]' })
    }
  }
  return parts
}

function toOpenAITools(tools) {
  return (tools ?? []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

class OpenCodeBridgeAdapter {
  #catalog
  #backend
  #logger
  #attachments
  #images

  constructor({ catalog, backend, logger, attachments, images = false }) {
    this.#catalog = catalog
    this.#backend = backend
    this.#logger = logger
    this.#attachments = attachments
    this.#images = images
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_LABEL }
  }

  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async listModels(provider) {
    return this.#catalog().map(model => ({
      provider,
      id: exposedID(model.id),
      name: model.name || exposedID(model.id),
      ...(model.context ? { description: `context ${model.context}` } : {}),
      inputModalities: model.images ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const entry = this.#find(model)
    if (!entry) return { provider, id: model, name: model }
    const efforts = reasoningEfforts(entry)
    const effortIDs = Object.keys(efforts)
    return {
      provider,
      id: model,
      name: entry.name || model,
      ...(entry.context ? { context: { contextWindow: entry.context } } : {}),
      ...(entry.output ? { defaultMaxTokens: entry.output } : {}),
      ...(effortIDs.length
        ? {
            reasoning: {
              efforts: effortIDs.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
              ...(effortIDs.includes('medium') ? { defaultEffort: 'medium' } : {}),
            },
          }
        : {}),
    }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  #find(id) {
    const wanted = String(id)
    return this.#catalog().find(
      entry => exposedID(entry.id) === wanted || entry.id === wanted || entry.name === wanted,
    )
  }

  async *#streamError(message, code) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message, code } },
    }
  }

  async *stream(options) {
    const backend = this.#backend()
    if (!backend) {
      yield* this.#streamError('OpenCode 运行时尚未就绪，请稍后重试', 'BRIDGE_NOT_READY')
      return
    }

    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } },
      }
      return
    }

    const catalog = this.#catalog()
    const entry = this.#find(options.model)
    if (!entry) {
      yield* this.#streamError(`模型不在当前免费清单中：${options.model}`, 'MODEL_NOT_FOUND')
      return
    }

    const body = {
      model: entry.id,
      messages: await toOpenAIMessages(
        options,
        this.#images && entry.images === true,
        this.#attachments?.(),
      ),
      tools: toOpenAITools(options.tools),
      tool_choice: (options.tools?.length ?? 0) > 0 ? 'auto' : 'none',
      parallel_tool_calls: true,
      stream: false,
      ...(options.reasoningEffort && Object.keys(reasoningEfforts(entry)).length
        ? { reasoning_effort: String(options.reasoningEffort) }
        : {}),
    }

    if (body.messages.length === 0) {
      yield* this.#streamError('没有可发送的对话内容', 'EMPTY_CONVERSATION')
      return
    }

    let request
    try {
      request = prepare(body, catalog)
    } catch (error) {
      yield* this.#streamError(error?.message ?? String(error), error?.code ?? 'INVALID_REQUEST')
      return
    }

    let result
    try {
      result = await backend.complete(request, options.signal, {})
    } catch (error) {
      if (options.signal?.aborted) {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } },
        }
        return
      }
      this.#logger?.warn?.(`opencode-bridge: 推理失败：${error?.message ?? error}`)
      yield* this.#streamError(error?.message ?? String(error), error?.code ?? 'BRIDGE_ERROR')
      return
    }

    const message = result?.choices?.[0]?.message ?? {}
    const content = typeof message.content === 'string' ? message.content : ''
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []

    let index = 0
    if (content.length > 0) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: content }
      yield { type: 'block-end', index, block: { type: 'text', text: content } }
      index += 1
    }

    for (const call of calls) {
      const id = call?.id ?? `call_${Math.random().toString(36).slice(2)}`
      const name = call?.function?.name ?? 'unknown'
      const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}'
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
      index += 1
    }

    const usage = result?.usage
    if (usage && Number.isFinite(usage.prompt_tokens + usage.completion_tokens)) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        },
      }
    }

    yield {
      type: 'finish',
      reason: calls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
    }
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const dataDir = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'opencode-bridge')

  let catalog = []
  let backend
  let stopRuntime
  let disposed = false
  let timer

  const status = {
    phase: 'starting',
    version: '',
    lastError: '',
    startedAt: Date.now(),
    writtenAt: new Date().toISOString(),
  }

  const adapter = new OpenCodeBridgeAdapter({
    catalog: () => catalog,
    backend: () => backend,
    logger,
    attachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
    images: config.images === true,
  })

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  logger?.info?.(`opencode-bridge: provider "${PROVIDER}" 已注册，运行时启动中`)

  // Settings → OpenCode 桥 卡片读取的状态端点（仅本机页面使用）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], webCtx => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: '/api/opencode-bridge/status',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end('{"error":"method not allowed"}')
            return
          }
          const body = JSON.stringify({
            provider: PROVIDER,
            phase: status.phase,
            version: status.version,
            models: catalog.length,
            ids: catalog.map(model => exposedID(model.id)),
            uptimeMs: Date.now() - status.startedAt,
            lastError: status.lastError,
            dataDir,
            writtenAt: status.writtenAt,
          })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          res.end(body)
        },
      }))
    })
  }

  const refresh = async () => {
    if (!backend || disposed) return
    const models = await backend.models()
    if (disposed) return
    const next = models.filter(model => model.id)
    const changed = JSON.stringify(next.map(model => [model.id, model.name, model.context])) !==
      JSON.stringify(catalog.map(model => [model.id, model.name, model.context]))
    catalog = next
    status.models = catalog.length
    status.ids = catalog.map(model => exposedID(model.id))
    status.writtenAt = new Date().toISOString()
    status.lastError = ''
    await writeFile(
      join(dataDir, 'status.json'),
      JSON.stringify({
        provider: PROVIDER,
        models: catalog.length,
        ids: catalog.map(model => exposedID(model.id)),
        updatedAt: new Date().toISOString(),
      }, null, 2),
    ).catch(() => {})
    if (changed) {
      try {
        registration.replace([PROVIDER])
        logger?.info?.(`opencode-bridge: 免费模型已更新，共 ${catalog.length} 个`)
      } catch (error) {
        logger?.warn?.(`opencode-bridge: 目录更新广播失败：${error?.message ?? error}`)
      }
    }
  }

  ctx.effect(() => () => {
    disposed = true
    if (timer) clearInterval(timer)
    Promise.resolve(stopRuntime?.()).catch(() => {})
  })

  void (async () => {
    await mkdir(dataDir, { recursive: true })
    const logStream = createWriteStream(join(dataDir, 'bridge.log'), { flags: 'a' })
    try {
      const binaryPath = config.binaryPath
        || await findRuntime(dataDir, message => logger?.info?.(`opencode-bridge: ${message}`))
      const runtime = await startBackend(binaryPath, dataDir, logStream)
      if (disposed) {
        await runtime.stop()
        return
      }
      backend = runtime.backend
      stopRuntime = runtime.stop
      status.phase = 'ready'
      status.version = runtime.version
      logger?.info?.(`opencode-bridge: OpenCode ${runtime.version} 运行时已就绪`)

      timer = setInterval(() => {
        void refresh().catch(error =>
          logger?.warn?.(`opencode-bridge: 模型目录刷新失败：${error?.message ?? error}`))
      }, REFRESH_MS)
      timer.unref?.()

      // 运行时的 provider 目录是在第一次查询时才去上游抓的：刚启动的那几秒
      // /provider 里还没有 opencode 条目，因此这里要重试到清单真正就绪。
      for (let attempt = 0; attempt < 30 && !disposed && catalog.length === 0; attempt += 1) {
        try {
          await refresh()
        } catch { /* 目录尚未就绪，继续等 */ }
        if (catalog.length === 0) await new Promise(resolve => setTimeout(resolve, 2000))
      }
      logger?.info?.(`opencode-bridge: 已暴露 ${catalog.length} 个免费模型`)
    } catch (error) {
      status.phase = 'error'
      status.lastError = String(error?.message ?? error)
      logger?.error?.(`opencode-bridge: 运行时启动失败：${error?.message ?? error}`)
    }
  })()
}

export { PROVIDER, OpenCodeBridgeAdapter }
