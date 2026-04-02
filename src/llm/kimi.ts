/**
 * @fileoverview Moonshot Kimi K2.5 adapter implementing {@link LLMAdapter}.
 *
 * Kimi uses an OpenAI-compatible API with additional features:
 *   - Dual mode: thinking (deep deliberative) vs non-thinking (rapid)
 *   - Native image/visual input support (pretrained on 15T visual+text tokens)
 *
 * Models:
 *   - `kimi-k2.5` — Frontend visual synthesis ($0.15-$0.60 / $2.20-$3.00)
 *
 * API key resolution:
 *   1. Constructor argument
 *   2. KIMI_API_KEY environment variable
 *
 * TODO (Phase 3): Add image input support for visual-to-code workflows.
 */

import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions/index.js'

import type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
} from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIMI_BASE_URL = 'https://api.moonshot.cn/v1'

// ---------------------------------------------------------------------------
// Internal helpers — OpenAI-compatible format conversion
// ---------------------------------------------------------------------------

function toOpenAIMessages(
  messages: readonly LLMMessage[],
  systemPrompt?: string,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []

  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const userParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
      const toolResults: ChatCompletionToolMessageParam[] = []

      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            userParts.push({ type: 'text', text: block.text })
            break
          case 'image':
            // Kimi supports image inputs for visual-to-code
            userParts.push({
              type: 'image_url',
              image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
            })
            break
          case 'tool_result':
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            })
            break
        }
      }

      for (const tr of toolResults) out.push(tr)
      if (userParts.length > 0) {
        out.push({ role: 'user', content: userParts } as ChatCompletionUserMessageParam)
      }
    } else {
      const text = msg.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')

      const toolCalls: ChatCompletionMessageToolCall[] = msg.content
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map(b => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }))

      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      }
      out.push(assistantMsg)
    }
  }

  return out
}

function toOpenAITools(tools: readonly LLMToolDef[]): ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }))
}

function fromOpenAIResponse(response: ChatCompletion): LLMResponse {
  const choice = response.choices[0]!
  const message = choice.message
  const content: ContentBlock[] = []

  if (message.content) {
    content.push({ type: 'text', text: message.content })
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      })
    }
  }

  return {
    id: response.id,
    content,
    model: response.model,
    stop_reason: choice.finish_reason ?? 'stop',
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// KimiAdapter
// ---------------------------------------------------------------------------

export class KimiAdapter implements LLMAdapter {
  readonly name = 'kimi'
  private client: OpenAI

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.KIMI_API_KEY
    if (!key) {
      throw new Error(
        'Kimi API key not found. Set KIMI_API_KEY in your .env file or pass it to the constructor.',
      )
    }
    this.client = new OpenAI({ apiKey: key, baseURL: KIMI_BASE_URL })
  }

  async chat(
    messages: readonly LLMMessage[],
    options: LLMChatOptions,
  ): Promise<LLMResponse> {
    const openaiMessages = toOpenAIMessages(messages, options.systemPrompt)
    const tools = options.tools ? toOpenAITools(options.tools) : undefined

    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      ...(tools && tools.length > 0 ? { tools } : {}),
    })

    return fromOpenAIResponse(response as ChatCompletion)
  }

  async *stream(
    messages: readonly LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncGenerator<StreamEvent> {
    const openaiMessages = toOpenAIMessages(messages, options.systemPrompt)
    const tools = options.tools ? toOpenAITools(options.tools) : undefined

    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      stream: true,
      ...(tools && tools.length > 0 ? { tools } : {}),
    })

    const content: ContentBlock[] = []
    let fullText = ''
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      if (delta.content) {
        fullText += delta.content
        yield { type: 'text', data: delta.content }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!pendingToolCalls.has(idx)) {
            pendingToolCalls.set(idx, { id: tc.id ?? '', name: '', args: '' })
          }
          const pending = pendingToolCalls.get(idx)!
          if (tc.id) pending.id = tc.id
          if (tc.function?.name) pending.name = tc.function.name
          if (tc.function?.arguments) pending.args += tc.function.arguments
        }
      }

      if (chunk.choices[0]?.finish_reason) {
        if (fullText) content.push({ type: 'text', text: fullText })

        for (const [, tc] of pendingToolCalls) {
          const toolUse: ToolUseBlock = {
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.args || '{}'),
          }
          content.push(toolUse)
          yield { type: 'tool_use', data: { name: tc.name, input: toolUse.input } }
        }

        yield {
          type: 'done',
          data: {
            id: chunk.id,
            content,
            model: chunk.model,
            stop_reason: chunk.choices[0].finish_reason,
            usage: {
              input_tokens: (chunk as unknown as { usage?: { prompt_tokens?: number } }).usage?.prompt_tokens ?? 0,
              output_tokens: (chunk as unknown as { usage?: { completion_tokens?: number } }).usage?.completion_tokens ?? 0,
            },
          },
        }
      }
    }
  }
}
