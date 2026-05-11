// Azure OpenAI provider · uses the AzureOpenAI client from the openai SDK
//
// Differences vs. plain OpenAI:
//   - URL is per-resource: https://{resource}.openai.azure.com/
//   - Models are addressed by deployment name, not model id
//   - api-version query param is required
//   - Auth header is `api-key:` (handled by the SDK)

import { AzureOpenAI } from 'openai';
import { flattenSystem } from '../prompts.js';

export class AzureOpenAIProvider {
  constructor({ apiKey, endpoint, apiVersion, deployment, model }) {
    if (!apiKey) throw new Error('AzureOpenAIProvider: apiKey is required');
    if (!endpoint) throw new Error('AzureOpenAIProvider: endpoint is required');
    if (!apiVersion) throw new Error('AzureOpenAIProvider: apiVersion is required');
    if (!deployment) throw new Error('AzureOpenAIProvider: deployment is required');

    this.client = new AzureOpenAI({ apiKey, endpoint, apiVersion, deployment });
    this.deployment = deployment;
    // The SDK uses `model` as the deployment name on Azure; default to the
    // configured deployment but allow per-request override.
    this.model = model || deployment;
  }

  get name() {
    return 'azure';
  }

  async *streamText({ system, messages, model, maxTokens = 1024, signal }) {
    const systemStr = flattenSystem(system);
    const fullMessages = systemStr
      ? [{ role: 'system', content: systemStr }, ...messages]
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
