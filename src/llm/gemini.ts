/**
 * @fileoverview Google Gemini adapter implementing {@link LLMAdapter}.
 *
 * Stub implementation for Phase 5. Uses the OpenAI-compatible API provided
 * by Google's AI Studio.
 *
 * Models:
 *   - `gemini-2.5-flash` — Fast bulk tasks ($0.30/$2.50 per MTok)
 *   - `gemini-3.1-pro`   — Planning alternative ($3.00/$15.00 per MTok)
 *
 * API key resolution:
 *   1. Constructor argument
 *   2. GOOGLE_AI_API_KEY environment variable
 *
 * TODO (Phase 5): Full implementation with Gemini-specific features
 *   - Cached context pricing model
 *   - System instructions parameter
 *   - Function calling format differences
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

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'

// ---------------------------------------------------------------------------
// Helpers (same OpenAI-compatible pattern)
// ---------------------------------------------------------------------------

function toOpenAIMessages(messages: readonly LLMMessage[], systemPrompt?: string): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })

  for (const msg of messages) {
    if (msg.role === 'user') {
      const userParts: Array<{ type: 'text'; text: string }> = []
      const toolResults: ChatCompletionToolMessageParam[] = []

      for (const block of msg.content) {
        if (block.type === 'text') userParts.push({ type: 'text', text: block.text })
        else if (block.type === 'tool_result') {
          toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
        }
      }

      for (const tr of toolResults) out.push(tr)
      if (userParts.length > 0) out.push({ role: 'user', content: userParts } as ChatCompletionUserMessageParam)
    } else {
      const text = msg.content.filter((b): b is TextBlock => b.type === 'text').map(b => b.text).join('')
      const toolCalls: ChatCompletionMessageToolCall[] = msg.content
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map(b => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }))

      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      } as ChatCompletionAssistantMessageParam)
    }
  }
  return out
}

function toOpenAITools(tools: readonly LLMToolDef[]): ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> },
  }))
}

function fromResponse(response: ChatCompletion): LLMResponse {
  const choice = response.choices[0]!
  const content: ContentBlock[] = []
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content })
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })
    }
  }
  return {
    id: response.id,
    content,
    model: response.model,
    stop_reason: choice.finish_reason ?? 'stop',
    usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0 },
  }
}

// ---------------------------------------------------------------------------
// GeminiAdapter
// ---------------------------------------------------------------------------

export class GeminiAdapter implements LLMAdapter {
  readonly name = 'gemini'
  private client: OpenAI

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.GOOGLE_AI_API_KEY
    if (!key) {
      throw new Error('Google AI API key not found. Set GOOGLE_AI_API_KEY in your .env file or pass it to the constructor.')
    }
    this.client = new OpenAI({ apiKey: key, baseURL: GEMINI_BASE_URL })
  }

  async chat(messages: readonly LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: toOpenAIMessages(messages, options.systemPrompt),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      ...(options.tools ? { tools: toOpenAITools(options.tools) } : {}),
    })
    return fromResponse(response as ChatCompletion)
  }

  async *stream(messages: readonly LLMMessage[], options: LLMStreamOptions): AsyncGenerator<StreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: toOpenAIMessages(messages, options.systemPrompt),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      stream: true,
      ...(options.tools ? { tools: toOpenAITools(options.tools) } : {}),
    })

    const content: ContentBlock[] = []
    let fullText = ''

    for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      if (delta.content) {
        fullText += delta.content
        yield { type: 'text', data: delta.content }
      }

      if (chunk.choices[0]?.finish_reason) {
        if (fullText) content.push({ type: 'text', text: fullText })
        yield {
          type: 'done',
          data: {
            id: chunk.id, content, model: chunk.model,
            stop_reason: chunk.choices[0].finish_reason,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }
      }
    }
  }
}
