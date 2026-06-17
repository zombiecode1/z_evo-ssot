import { ChatOpenAI } from '@langchain/openai'
import { resolveModel } from './config'

export function createBridgeModel(
  modelName?: string
): ChatOpenAI {
  const target = modelName || process.env.AGENT_MODEL || 'deepseek-v4-flash-free'
  const resolved = resolveModel(target)

  const baseURL = `${resolved.backend.baseURL.replace(/\/+$/, '')}`
  const apiKey = resolved.backend.apiKey || process.env[resolved.backend.envVar] || ''

  console.log(`[bridge] "${target}" → ${resolved.backend.name}/${resolved.modelName}`)
  if (!apiKey && resolved.backend.name !== 'local-bridge') {
    console.warn(`[bridge] ⚠️ No API key for "${resolved.backend.name}". Set ${resolved.backend.envVar}`)
  }

  return new ChatOpenAI({
    model: resolved.modelName,
    temperature: 0,
    configuration: { baseURL },
    apiKey: apiKey || undefined,
  })
}
