// OpenAI-compatible provider · works for OpenAI, Deepseek, Zhipu/GLM,
// Moonshot, Qwen, and any other vendor that exposes
// /v*/chat/completions in OpenAI format. Configure with baseURL.
//
// Translation: prepend `system` as a {role:'system'} message.

import OpenAI from 'openai';

export class OpenAICompatProvider {
  constructor({ apiKey, model, baseURL, label = 'openai-compat' }) {
    if (!apiKey) throw new Error(`${label}Provider: API key is required`);
    this.label = label;
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
  }

  get name() {
    return this.label;
  }

  async *streamText({ system, messages, model, maxTokens = 1024, signal }) {
    const fullMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;

    const stream = await this.client.chat.completions.create(
      {
        model: model || this.model,
        max_tokens: maxTokens,
        messages: fullMessages,
        stream: true,
      },
      signal ? { signal } : undefined,
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length) yield delta;
    }
  }
}
