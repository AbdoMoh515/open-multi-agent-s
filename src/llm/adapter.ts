/**
 * @fileoverview LLM adapter factory.
 *
 * Re-exports the {@link LLMAdapter} interface and provides a
 * {@link createAdapter} factory that returns the correct concrete
 * implementation based on the requested provider.
 *
 * Supports: Anthropic, OpenAI, DeepSeek, Qwen (DashScope), Kimi, Gemini.
 *
 * @example
 * ```ts
 * import { createAdapter } from './adapter.js'
 *
 * const anthropic = createAdapter('anthropic')
 * const deepseek  = createAdapter('deepseek')
 * ```
 */

export type {
  LLMAdapter,
  LLMChatOptions,
  LLMStreamOptions,
  LLMToolDef,
  LLMMessage,
  LLMResponse,
  StreamEvent,
  TokenUsage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
} from '../types.js'

import type { LLMAdapter } from '../types.js'

/**
 * The set of LLM providers supported out of the box.
 * Additional providers can be integrated by implementing {@link LLMAdapter}
 * directly and bypassing this factory.
 */
export type SupportedProvider =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'gemini'

/**
 * Instantiate the appropriate {@link LLMAdapter} for the given provider.
 *
 * API keys fall back to the standard environment variables when not
 * supplied explicitly:
 *   - ANTHROPIC_API_KEY
 *   - OPENAI_API_KEY
 *   - DEEPSEEK_API_KEY
 *   - DASHSCOPE_API_KEY  (Alibaba Qwen)
 *   - KIMI_API_KEY       (Moonshot Kimi)
 *   - GOOGLE_AI_API_KEY  (Google Gemini)
 *
 * Adapters are imported lazily so that projects using only one provider
 * are not forced to install the SDK for the other.
 *
 * @param provider - Which LLM provider to target.
 * @param apiKey   - Optional API key override; falls back to env var.
 * @throws {Error} When the provider string is not recognised.
 */
export async function createAdapter(
  provider: SupportedProvider,
  apiKey?: string,
): Promise<LLMAdapter> {
  switch (provider) {
    case 'anthropic': {
      const { AnthropicAdapter } = await import('./anthropic.js')
      return new AnthropicAdapter(apiKey)
    }
    case 'openai': {
      const { OpenAIAdapter } = await import('./openai.js')
      return new OpenAIAdapter(apiKey)
    }
    case 'deepseek': {
      const { DeepSeekAdapter } = await import('./deepseek.js')
      return new DeepSeekAdapter(apiKey)
    }
    case 'qwen': {
      const { QwenAdapter } = await import('./qwen.js')
      return new QwenAdapter(apiKey)
    }
    case 'kimi': {
      const { KimiAdapter } = await import('./kimi.js')
      return new KimiAdapter(apiKey)
    }
    case 'gemini': {
      const { GeminiAdapter } = await import('./gemini.js')
      return new GeminiAdapter(apiKey)
    }
    default: {
      const _exhaustive: never = provider
      throw new Error(`Unsupported LLM provider: ${String(_exhaustive)}`)
    }
  }
}
