export interface BackendConfig {
  name: string
  baseURL: string
  apiKey?: string
  envVar: string
  models: string[]
  priority: number
}

export interface WrapperConfig {
  backends: BackendConfig[]
  defaultBackend: string
  defaultModel: string
}

const config: WrapperConfig = {
  backends: [
    {
      name: 'local-bridge',
      baseURL: process.env.BRIDGE_URL || 'http://localhost:9999/v1',
      apiKey: process.env.BRIDGE_API_KEY || '',
      envVar: 'BRIDGE_URL / BRIDGE_API_KEY',
      models: [
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'openai/gpt-oss-safeguard-20b',
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'meta-llama/llama-4-scout-17b-16e-instruct',
        'qwen/qwen3-32b',
        'groq/compound',
        'groq/compound-mini',
        'allam-2-7b',
        'meta-llama/llama-prompt-guard-2-86m',
        'meta-llama/llama-prompt-guard-2-22m',
        'whisper-large-v3',
        'whisper-large-v3-turbo',
      ],
      priority: 1,
    },
    {
      name: 'opencode-zen',
      baseURL: 'https://opencode.ai/zen/v1',
      envVar: 'OPENCODE_API_KEY',
      models: [
        'big-pickle',
        'deepseek-v4-flash-free',
        'mimo-v2.5-free',
        'nemotron-3-ultra-free',
        'deepseek-v4-flash',
        'kimi-k2.5',
        'kimi-k2.6',
        'qwen3.7-plus',
        'qwen3.7-max',
        'minimax-m2.7',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
        'gpt-5.1-codex',
        'gpt-5.3-codex',
        'gemini-3.5-flash',
      ],
      priority: 2,
    },
  ],

  defaultBackend: 'opencode-zen',
  defaultModel: 'deepseek-v4-flash-free',
}

function findBackend(name: string): BackendConfig | undefined {
  return config.backends.find(b => b.name === name)
}

export function resolveModel(model: string): { backend: BackendConfig; modelName: string } {
  const zen = findBackend('opencode-zen')
  const bridge = findBackend('local-bridge')

  // OpenCode Zen models first (free, fast, capable)
  if (zen && zen.models.includes(model)) {
    return { backend: zen, modelName: model }
  }
  // Fallback to local bridge (Groq)
  if (bridge && bridge.models.includes(model)) {
    return { backend: bridge, modelName: model }
  }

  if (zen && zen.models.includes(model)) {
    if (!process.env.OPENCODE_API_KEY) {
      throw new Error(
        `Model "${model}" needs OPENCODE_API_KEY. Get one at https://opencode.ai/auth`
      )
    }
    return { backend: zen, modelName: model }
  }

  if (bridge) {
    return { backend: bridge, modelName: model }
  }

  throw new Error(`No backend found for model "${model}"`)
}

export { config as wrapperConfig }
