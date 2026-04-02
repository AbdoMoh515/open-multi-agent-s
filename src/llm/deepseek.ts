/**
 * @fileoverview DeepSeek adapter implementing {@link LLMAdapter}.
 *
 * DeepSeek provides an OpenAI-compatible API, so this adapter extends the
 * OpenAI adapter with a custom base URL and API key env var.
 *
 * Models:
 *   - `deepseek-chat`     — DeepSeek V4 ($0.30/$0.50 per MTok) — budget code gen
 *   - `deepseek-reasoner` — DeepSeek R1 ($0.55/$2.19 per MTok) — chain-of-thought reasoning
 *
 * API key resolution:
 *   1. Constructor argument
 *   2. DEEPSEEK_API_KEY environment variable
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

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

// ---------------------------------------------------------------------------
// Internal helpers — framework → OpenAI-compatible format
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
      // Split user message: text/image blocks → user message, tool_result → tool messages
      const userParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
      const toolResults: ChatCompletionToolMessageParam[] = []

      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            userParts.push({ type: 'text', text: block.text })
            break
          case 'image':
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

      // Emit tool results first (OpenAI requires them right after the assistant message)
      for (const tr of toolResults) out.push(tr)

      // Then user content if any
      if (userParts.length > 0) {
        out.push({ role: 'user', content: userParts } as ChatCompletionUserMessageParam)
      }
    } else {
      // Assistant message
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
// DeepSeekAdapter
// ---------------------------------------------------------------------------

export class DeepSeekAdapter implements LLMAdapter {
  readonly name = 'deepseek'
  private client: OpenAI

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.DEEPSEEK_API_KEY
    if (!key) {
      throw new Error(
        'DeepSeek API key not found. Set DEEPSEEK_API_KEY in your .env file or pass it to the constructor.',
      )
    }
    this.client = new OpenAI({ apiKey: key, baseURL: DEEPSEEK_BASE_URL })
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

      // Text delta
      if (delta.content) {
        fullText += delta.content
        yield { type: 'text', data: delta.content }
      }

      // Tool call deltas
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

      // Check if stream ended
      if (chunk.choices[0]?.finish_reason) {
        // Finalise text
        if (fullText) {
          content.push({ type: 'text', text: fullText })
        }

        // Finalise tool calls
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

        // Emit done
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
