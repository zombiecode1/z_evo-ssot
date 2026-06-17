interface UpstreamConfig {
  name: string
  baseURL: string
  apiKey: string
  models: string[]
  priority: number
}

interface UpstreamModel {
  id: string
  upstream: string
  object: string
  created: number
  owned_by: string
}

const UPSTREAMS: UpstreamConfig[] = [
  {
    name: 'groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY || '',
    models: [], // will be fetched from Groq
    priority: 1,
  },
  {
    name: 'opencode-zen',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKey: process.env.OPENCODE_API_KEY || '',
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
    ],
    priority: 2,
  },
]

class UpstreamManager {
  private models: UpstreamModel[] = []
  private initialized = false

  async initialize(): Promise<void> {
    this.models = []

    for (const upstream of UPSTREAMS) {
      if (!upstream.apiKey) {
        console.warn(`⚠️ No API key for upstream "${upstream.name}" — skipping model fetch`)
        // still add static models if available
        if (upstream.models.length > 0) {
          for (const id of upstream.models) {
            this.models.push({
              id,
              upstream: upstream.name,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: upstream.name,
            })
          }
        }
        continue
      }

      try {
        const resp = await fetch(`${upstream.baseURL.replace(/\/+$/, '')}/models`, {
          headers: { Authorization: `Bearer ${upstream.apiKey}` },
        })
        if (resp.ok) {
          const data = await resp.json()
          const list = data?.data || []
          for (const m of list) {
            this.models.push({
              id: m.id,
              upstream: upstream.name,
              object: 'model',
              created: m.created || Math.floor(Date.now() / 1000),
              owned_by: m.owned_by || upstream.name,
            })
          }
          console.log(`✅ Loaded ${list.length} models from ${upstream.name}`)
        } else {
          console.warn(`⚠️ Failed to fetch models from ${upstream.name}: ${resp.status}`)
        }
      } catch (err: any) {
        console.warn(`⚠️ Error fetching from ${upstream.name}: ${err.message}`)
      }
    }

    this.initialized = true
    console.log(`📋 Total models across all upstreams: ${this.models.length}`)
  }

  getModels(): UpstreamModel[] {
    return this.models
  }

  findUpstream(modelId: string): UpstreamConfig | null {
    // find exact match
    const model = this.models.find(m => m.id === modelId)
    if (model) {
      return UPSTREAMS.find(u => u.name === model.upstream) || null
    }

    // check model name prefix patterns
    for (const upstream of UPSTREAMS) {
      if (upstream.models.some(m => modelId.startsWith(m.split('-')[0]) || modelId.includes(m))) {
        return upstream
      }
    }

    // fallback to first available
    return UPSTREAMS.find(u => u.apiKey) || UPSTREAMS[0]
  }

  async forwardChatCompletion(params: any): Promise<any> {
    const modelId = params.model
    const upstream = this.findUpstream(modelId)

    if (!upstream || !upstream.apiKey) {
      // Fallback: try Groq anyway via env GROQ_API_KEY
      const groqUpstream = UPSTREAMS.find(u => u.name === 'groq')
      if (groqUpstream?.apiKey) {
        return this.doChatCompletion(groqUpstream, params)
      }
      throw new Error(`No API key configured for upstream. Set GROQ_API_KEY or OPENCODE_API_KEY`)
    }

    return this.doChatCompletion(upstream, params)
  }

  private async doChatCompletion(upstream: UpstreamConfig, params: any): Promise<any> {
    const url = `${upstream.baseURL.replace(/\/+$/, '')}/chat/completions`
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify(params),
    })

    if (!resp.ok) {
      const body = await resp.text()
      const err = new Error(`[${upstream.name}] ${resp.status}: ${body}`) as any
      err.status = resp.status
      throw err
    }

    // Check if it's a stream
    if (params.stream) {
      return resp.body
    }

    return resp.json()
  }

  async forwardChatCompletionStream(params: any): Promise<ReadableStream | null> {
    const modelId = params.model
    const upstream = this.findUpstream(modelId)

    if (!upstream || !upstream.apiKey) {
      const groqUpstream = UPSTREAMS.find(u => u.name === 'groq')
      if (groqUpstream?.apiKey) {
        return this.doChatCompletionStream(groqUpstream, params)
      }
      throw new Error(`No API key configured for upstream. Set GROQ_API_KEY or OPENCODE_API_KEY`)
    }

    return this.doChatCompletionStream(upstream, params)
  }

  private async doChatCompletionStream(upstream: UpstreamConfig, params: any): Promise<ReadableStream | null> {
    const url = `${upstream.baseURL.replace(/\/+$/, '')}/chat/completions`
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify({ ...params, stream: true }),
    })

    if (!resp.ok) {
      const body = await resp.text()
      const err = new Error(`[${upstream.name}] ${resp.status}: ${body}`) as any
      err.status = resp.status
      throw err
    }

    return resp.body
  }
}

export const upstreamManager = new UpstreamManager()
export default UpstreamManager
