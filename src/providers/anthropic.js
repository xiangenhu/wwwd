// Anthropic provider · uses native Messages API
// (system is a separate field, not a message)
//
// Prompt caching: when system is supplied as an array with a leading
// {type:'text', text:..., cache_control:{type:'ephemeral'}} block, that
// block is cached for ~5 minutes. The four deliberation stages share
// the same HAA preamble, so the second through fourth calls hit the
// cache and avoid re-billing those input tokens.

import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  constructor({ apiKey, model, baseURL }) {
    if (!apiKey) throw new Error('AnthropicProvider: ANTHROPIC_API_KEY is required');
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
  }

  get name() {
    return 'anthropic';
  }

  async *streamText({ system, messages, model, maxTokens = 1024, signal }) {
    // Normalize system into the array form Anthropic uses for cache_control.
    // If the caller already passed an array, trust it. Otherwise wrap the
    // string and mark it as ephemeral-cacheable.
    let systemBlocks;
    if (Array.isArray(system)) {
      systemBlocks = system;
    } else if (typeof system === 'string' && system.length) {
      systemBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    } else {
      systemBlocks = undefined;
    }

    const stream = this.client.messages.stream({
      model: model || this.model,
      max_tokens: maxTokens,
      ...(systemBlocks ? { system: systemBlocks } : {}),
      messages,
    });

    if (signal) {
      signal.addEventListener('abort', () => stream.controller?.abort?.(), { once: true });
    }

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        typeof event.delta.text === 'string'
      ) {
        yield event.delta.text;
      }
    }
  }
}
