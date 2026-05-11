// Azure OpenAI provider · uses the AzureOpenAI client from the openai SDK
//
// Differences vs. plain OpenAI:
//   - URL is per-resource: https://{resource}.openai.azure.com/
//   - Models are addressed by deployment name, not model id
//   - api-version query param is required
//   - Auth header is `api-key:` (handled by the SDK)
//
// The streaming loop is identical to OpenAICompatProvider; subclass to
// avoid duplicating it.

import { AzureOpenAI } from 'openai';
import { OpenAICompatProvider } from './openai-compat.js';

export class AzureOpenAIProvider extends OpenAICompatProvider {
  constructor({ apiKey, endpoint, apiVersion, deployment, model }) {
    if (!apiKey) throw new Error('AzureOpenAIProvider: apiKey is required');
    if (!endpoint) throw new Error('AzureOpenAIProvider: endpoint is required');
    if (!apiVersion) throw new Error('AzureOpenAIProvider: apiVersion is required');
    if (!deployment) throw new Error('AzureOpenAIProvider: deployment is required');

    // Skip the parent constructor — it expects an `apiKey` and would build
    // a plain OpenAI client. Build the AzureOpenAI client directly and
    // populate the same instance fields the parent's streamText expects.
    super({ apiKey, model: model || deployment, label: 'azure' });
    this.client = new AzureOpenAI({ apiKey, endpoint, apiVersion, deployment });
    this.deployment = deployment;
  }

  get name() {
    return 'azure';
  }
}
