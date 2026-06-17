import { BackendConfig } from './config'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatParams {
  model: string
  messages: ChatMessage[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

export interface ChatResponse {
  id: string
  model: string
  choices: {
    index: number
    message: { role: string; content: string }
    finish_reason: string
  }[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

async function openaiChat(
  baseURL: string,
  apiKey: string | undefined,
  params: ChatParams
): Promise<Response> {
  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens ?? undefined,
      temperature: params.temperature ?? 0.7,
      stream: params.stream ?? false,
    }),
  })
}

export async function chat(
  backend: BackendConfig,
  params: ChatParams
): Promise<ChatResponse> {
  const resp = await openaiChat(backend.baseURL, backend.apiKey, {
    ...params,
    model: params.model,
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`[${backend.name}] ${resp.status}: ${body}`)
  }

  return resp.json()
}

export async function* chatStream(
  backend: BackendConfig,
  params: ChatParams
): AsyncGenerator<string> {
  const resp = await openaiChat(backend.baseURL, backend.apiKey, {
    ...params,
    model: params.model,
    stream: true,
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`[${backend.name}] ${resp.status}: ${body}`)
  }

  const reader = resp.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return

      try {
        const parsed = JSON.parse(data)
        const content = parsed.choices?.[0]?.delta?.content || ''
        if (content) yield content
      } catch {
        // skip parse errors
      }
    }
  }
}
