// Anthropic provider · uses native Messages API
// (system is a separate field, not a message)

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
    const stream = this.client.messages.stream({
      model: model || this.model,
      max_tokens: maxTokens,
      system,
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
