// LLM provider factory
//
// Selection: LLM_PROVIDER (default: anthropic)
//   anthropic    — Claude via @anthropic-ai/sdk
//   openai       — OpenAI ChatGPT
//   deepseek     — Deepseek Chat (OpenAI-compat)
//   zhipu        — Zhipu GLM (OpenAI-compat at /api/paas/v4)
//   openai-compat— Generic; supply OPENAI_COMPAT_BASE_URL/_API_KEY/_MODEL.
//                  Use this for Moonshot, Qwen/Doubao, Mistral, vLLM,
//                  Ollama, or any other OpenAI-shaped endpoint.
//
// Each block in env is independent; only the selected one is consulted.

import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';

const PRESETS = {
  anthropic: {
    klass: AnthropicProvider,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-opus-4-5',
  },
  openai: {
    klass: OpenAICompatProvider,
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    modelEnv: 'OPENAI_MODEL',
    defaultBaseUrl: undefined, // SDK default
    defaultModel: 'gpt-4o',
    label: 'openai',
  },
  deepseek: {
    klass: OpenAICompatProvider,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    label: 'deepseek',
  },
  zhipu: {
    klass: OpenAICompatProvider,
    apiKeyEnv: 'ZHIPU_API_KEY',
    baseUrlEnv: 'ZHIPU_BASE_URL',
    modelEnv: 'ZHIPU_MODEL',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    label: 'zhipu',
  },
  'openai-compat': {
    klass: OpenAICompatProvider,
    apiKeyEnv: 'OPENAI_COMPAT_API_KEY',
    baseUrlEnv: 'OPENAI_COMPAT_BASE_URL',
    modelEnv: 'OPENAI_COMPAT_MODEL',
    label: 'openai-compat',
    requireBaseUrl: true,
  },
};

export function createProvider(env = process.env) {
  const key = (env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
  const preset = PRESETS[key];
  if (!preset) {
    throw new Error(
      `Unknown LLM_PROVIDER='${key}'. Expected one of: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  const apiKey = env[preset.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `LLM_PROVIDER='${key}' requires ${preset.apiKeyEnv} (and ` +
        `${preset.baseUrlEnv} if you need a custom endpoint).`,
    );
  }
  const baseURL = env[preset.baseUrlEnv] || preset.defaultBaseUrl;
  if (preset.requireBaseUrl && !baseURL) {
    throw new Error(
      `LLM_PROVIDER='${key}' requires ${preset.baseUrlEnv} (no default).`,
    );
  }
  const model = env.LLM_MODEL || env[preset.modelEnv] || preset.defaultModel;
  if (!model) {
    throw new Error(`LLM_PROVIDER='${key}' has no model — set LLM_MODEL or ${preset.modelEnv}.`);
  }

  return new preset.klass({ apiKey, model, baseURL, label: preset.label });
}

// Exposed for /api/health introspection.
export function describeProvider(env = process.env) {
  const key = (env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
  const preset = PRESETS[key];
  if (!preset) return { provider: key, configured: false };
  const baseURL = env[preset.baseUrlEnv] || preset.defaultBaseUrl || '(sdk default)';
  const model = env.LLM_MODEL || env[preset.modelEnv] || preset.defaultModel || '(unset)';
  return {
    provider: key,
    configured: Boolean(env[preset.apiKeyEnv]),
    baseURL,
    model,
  };
}
