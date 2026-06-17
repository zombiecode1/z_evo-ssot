import { Request, Response } from 'express';
import { GroqService } from '../services/groqService';
import { ChatCompletionCreateParams } from 'groq-sdk/resources/chat/completions';
import { getIdentity } from '../services/identityService';
import { logUsage, recordSession } from '../admin/db';
import { runPipeline, runStreamingPipeline, routeModel } from '../services/unifiedPipeline';

function tryParseJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// XSS protection — escape HTML special characters
function escapeHtml(str: string | undefined | null): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

let groqService: GroqService;

export const initializeService = (apiKey: string) => {
  groqService = new GroqService(apiKey);
  return groqService;
};

export const getService = () => groqService;

export const handleChatCompletion = async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const params: ChatCompletionCreateParams = req.body;

    if (!params.messages || !Array.isArray(params.messages) || params.messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'messages is required and must be a non-empty array',
          type: 'invalid_request_error',
          code: 'missing_messages',
        }
      });
    }

    const isStream = params.stream === true;

    // ─── Unified Pipeline (Architecture: single pipeline) ─────────
    // Replaces: ProviderGateway + ResponseNormalizer + GroqService fallback
    // Pipeline handles: Identity → RAG → Model Routing → AI SDK generateText/streamText

    if (isStream) {
      // ─── Streaming via Unified Pipeline ─────────────────────────
      try {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        res.socket?.setNoDelay(true);
        res.write(': connected\n\n');

        const streamResult = await runStreamingPipeline({
          messages: params.messages.map(m => ({
            role: m.role as string,
            content: String(m.content || ''),
            tool_calls: (m as any).tool_calls,
            tool_call_id: (m as any).tool_call_id,
            name: (m as any).name,
          })),
          model: params.model,
          maxOutputTokens: params.max_tokens ?? undefined,
          temperature: params.temperature ?? undefined,
          tools: params.tools as any,
          tool_choice: params.tool_choice as any,
          enableRag: false,
        });

        // Use textStream for legacy route (text-only, no reasoning/tool parts)
        for await (const text of streamResult.stream) {
          if (text) {
            const sseChunk = {
              id: streamResult.id,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: streamResult.model,
              choices: [{
                index: 0,
                delta: { content: text },
                finish_reason: null,
              }],
            };
            res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
          }
        }

        // Send finish chunk
        const finishChunk = {
          id: streamResult.id,
          object: 'chat.completion.chunk' as const,
          created: Math.floor(Date.now() / 1000),
          model: streamResult.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
          }],
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);

        res.write('data: [DONE]\n\n');
        res.end();

        // Log usage
        try {
          const durationMs = Date.now() - startTime;
          logUsage(streamResult.model || params.model || 'unknown', 0, 0, durationMs);
          const sessionId = (req as any).sessionId || `chat-${Date.now()}`;
          recordSession(sessionId, undefined, undefined, streamResult.model || params.model);
        } catch (_) { /* don't fail request for logging */ }

        return;
      } catch (streamErr: any) {
        console.error('❌ Streaming pipeline failed:', streamErr.message);
        // If streaming fails, end the response with error
        if (!res.headersSent) {
          res.status(500).json({ error: { message: streamErr.message, type: 'server_error' } });
        } else {
          res.write(`data: ${JSON.stringify({ error: streamErr.message })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }
    }

    // ─── Non-Streaming via Unified Pipeline ───────────────────────
    const pipelineResult = await runPipeline({
      messages: params.messages.map(m => ({
        role: m.role as string,
        content: String(m.content || ''),
        tool_calls: (m as any).tool_calls,
        tool_call_id: (m as any).tool_call_id,
        name: (m as any).name,
      })),
      model: params.model,
      maxOutputTokens: params.max_tokens ?? undefined,
      temperature: params.temperature ?? undefined,
      tools: params.tools as any,
      tool_choice: params.tool_choice as any,
      enableRag: false, // Legacy route: no RAG by default
    });

    // Add provider field for backward compatibility
    const response: any = {
      ...pipelineResult,
      provider: 'openai',
    };

    // Log usage
    try {
      const durationMs = Date.now() - startTime;
      logUsage(pipelineResult.model || params.model || 'unknown', pipelineResult.usage.prompt_tokens, pipelineResult.usage.completion_tokens, durationMs);
      const sessionId = (req as any).sessionId || `chat-${Date.now()}`;
      recordSession(sessionId, undefined, undefined, pipelineResult.model || params.model);
    } catch (_) { /* don't fail request for logging */ }

    res.json(response);
    return;

  } catch (err: any) {
    console.error('❌ Chat completion error:', err.stack || err.message);
    res.status(err.status || 500).json({
      error: { message: err.message || 'Chat completion failed', type: 'server_error' },
    });
  }
};

export const handleTextCompletion = async (req: Request, res: Response) => {
  try {
    const { model, prompt, max_tokens, temperature, stop, stream } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: {
          message: 'prompt is required',
          type: 'invalid_request_error',
          code: 'missing_prompt',
        }
      });
    }

    let messages = typeof prompt === 'string'
      ? [{ role: 'user' as const, content: prompt }]
      : prompt.map((p: string) => ({ role: 'user' as const, content: p }));

    // Identity anchoring: prepend system identity prompt if not present
    try {
      const identity = getIdentity();
      const sys = identity?.system_identity?.system_prompt;
      if (sys) {
        const first = messages[0];
        const needsInsert = !(first && first.role === 'system' && String(first.content || '').includes('ZombieCoder'));
        if (needsInsert) messages = [{ role: 'system' as const, content: sys }, ...messages];
      }
    } catch (e) {
      console.warn('identity anchor failed:', (e as any)?.message || e);
    }

    const chatParams: ChatCompletionCreateParams = {
      model: model || 'auto',
      messages,
      max_tokens: max_tokens || 1024,
      temperature: temperature ?? 0.7,
      stop: stop || undefined,
      stream: stream === true,
    };

    if (stream) {
      const groqStream = await groqService.createChatCompletion(chatParams);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.socket?.setNoDelay(true);

      // Track chunk metadata for normalization
      let chunkId: string | null = null;
      let chunkCreated: number | null = null;
      let chunkModel: string | null = null;

      for await (const chunk of groqStream as any) {
        // Update tracked metadata from current chunk if available
        if (chunk.id) chunkId = chunk.id;
        if (chunk.created) chunkCreated = chunk.created;
        if (chunk.model) chunkModel = chunk.model;

        const textChunk = {
          id: chunk.id || chunkId || `textcmpl-${Date.now()}`,
          object: 'text_completion.chunk',
          created: chunk.created || chunkCreated || Math.floor(Date.now() / 1000),
          model: chunk.model || chunkModel || chatParams.model || 'unknown',
          choices: [{
            index: 0,
            text: chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.text || '',
            finish_reason: chunk.choices?.[0]?.finish_reason || null,
            logprobs: null,
          }],
        };
        res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const completion = await groqService.createChatCompletion(chatParams);
      const data = completion as any;
      const textResponse = {
        id: data.id,
        object: 'text_completion',
        created: data.created,
        model: data.model,
        choices: [{
          index: 0,
          text: data.choices[0]?.message?.content || '',
          finish_reason: data.choices[0]?.finish_reason || 'stop',
          logprobs: null,
        }],
        usage: data.usage,
      };
      res.json(textResponse);
    }
  } catch (error: any) {
    console.error('❌ Text completion error:', error.message);
    res.status(error.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
      }
    });
  }
};

export const handleTranscription = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: {
          message: 'file is required',
          type: 'invalid_request_error',
          code: 'missing_file',
        }
      });
    }

    const result = await groqService.createTranscription(
      req.file.buffer,
      req.file.originalname,
      req.body
    );

    const format = req.body.response_format || 'json';
    if (format === 'text') {
      res.set('Content-Type', 'text/plain');
      return res.send(result.text);
    }
    if (format === 'verbose_json') {
      return res.json({ ...result, task: 'transcribe', language: req.body.language || 'en', duration: 0 });
    }
    res.json(result);
  } catch (error: any) {
    console.error('❌ Transcription error:', error.message);
    res.status(error.status || 500).json({
      error: {
        message: error.message || 'Transcription failed',
        type: 'server_error',
      }
    });
  }
};

export const handleTranslation = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: {
          message: 'file is required',
          type: 'invalid_request_error',
          code: 'missing_file',
        }
      });
    }

    const result = await groqService.createTranslation(
      req.file.buffer,
      req.file.originalname,
      req.body
    );

    const format = req.body.response_format || 'json';
    if (format === 'text') {
      res.set('Content-Type', 'text/plain');
      return res.send(result.text);
    }
    if (format === 'verbose_json') {
      return res.json({ ...result, task: 'translate', language: 'en', duration: 0 });
    }
    res.json(result);
  } catch (error: any) {
    console.error('❌ Translation error:', error.message);
    res.status(error.status || 500).json({
      error: {
        message: error.message || 'Translation failed',
        type: 'server_error',
      }
    });
  }
};

export const handleEmbeddings = async (req: Request, res: Response) => {
  try {
    if (!req.body.input) {
      return res.status(400).json({
        error: {
          message: 'input is required',
          type: 'invalid_request_error',
          code: 'missing_input',
        }
      });
    }

    const result = await groqService.createEmbeddings(req.body);
    res.json(result);
  } catch (error: any) {
    console.error('❌ Embeddings error:', error.message);

    const statusCode = error.status || error.statusCode || 500;
    const httpStatus = statusCode;

    let message = error.message || 'Embeddings failed';
    let type = error.type || (statusCode === 400 ? 'invalid_request_error' : 'server_error');
    let code = error.code || (statusCode === 404 ? 'model_not_found' : (statusCode === 400 ? 'bad_request' : 'internal_error'));

    // Some SDK errors encode the original response as: "404 { ...json... }"
    if (typeof message === 'string' && /^\d{3}\s+{/.test(message)) {
      const idx = message.indexOf('{');
      if (idx !== -1) {
        try {
          const parsed = JSON.parse(message.slice(idx));
          if (parsed?.error?.message) message = parsed.error.message;
          if (parsed?.error?.type) type = parsed.error.type;
          if (parsed?.error?.code) code = parsed.error.code;
        } catch { /* ignore */ }
      }
    }

    res.status(httpStatus).json({
      error: { message, type, code }
    });
  }
};

export const handleListModels = async (req: Request, res: Response) => {
  try {
    const models = groqService.getModels();
    res.json({
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: m.created,
        owned_by: m.owned_by,
        context_window: m.context_window || 0,
        max_tokens: m.max_tokens || 0,
        category: m.category || 'balanced',
      })),
    });
  } catch (error: any) {
    res.status(500).json({
      error: { message: error.message, type: 'server_error' }
    });
  }
};

export const handleGetModel = async (req: Request, res: Response) => {
  try {
    const model = groqService.getModel(req.params.model);
    if (!model) {
      return res.status(404).json({
        error: {
          message: `Model '${req.params.model}' not found`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        }
      });
    }
    res.json({
      id: model.id,
      object: 'model',
      created: model.created,
      owned_by: model.owned_by,
      context_window: model.context_window || 0,
      max_tokens: model.max_tokens || 0,
      category: model.category || 'balanced',
    });
  } catch (error: any) {
    res.status(500).json({
      error: { message: error.message, type: 'server_error' }
    });
  }
};

export const handleDashboard = async (req: Request, res: Response) => {
  const status = groqService.getStatus();
  const models = groqService.getModels();
  const logs = groqService.getLogs().slice(-200);
  const rateLimits = groqService.getRateLimits();
  const apiKey = process.env.GROQ_API_KEY ? '••••••••' + (process.env.GROQ_API_KEY.slice(-4)) : '';
  const identity = getIdentity();
  const identityName = identity?.system_identity?.name || 'ZombieCoder';
  const identityOwner = identity?.system_identity?.owner || '';
  const identityWebsite = identity?.system_identity?.contact?.website || '';

  const modelRows = models.map(m => `
    <tr class="${escapeHtml(m.category)}">
      <td><span class="badge badge-${escapeHtml(m.category)}">${escapeHtml(m.category)}</span></td>
      <td><code>${escapeHtml(m.id)}</code></td>
      <td>${escapeHtml(m.owned_by)}</td>
      <td>${m.context_window.toLocaleString()}</td>
      <td>${m.max_tokens.toLocaleString()}</td>
      <td><span class="status-dot ${m.category !== 'other' ? 'online' : 'offline'}"></span></td>
    </tr>
  `).join('');

  const logRows = logs.map(l => {
    const cls = l.success ? 'log-success' : 'log-error';
    return `<tr class="${cls}">
      <td>${new Date(l.timestamp).toLocaleTimeString()}</td>
      <td>${escapeHtml(l.method)}</td>
      <td><code>${escapeHtml(l.path)}</code></td>
      <td><code>${escapeHtml(l.model)}</code></td>
      <td>${l.status}</td>
      <td>${l.tokens}</td>
      <td>${l.duration_ms}ms</td>
    </tr>`;
  }).join('');

  const rateLimitRows = rateLimits.map(r => {
    const rpmPct = r.rpm > 0 ? Math.round(r.current_rpm / r.rpm * 100) : 0;
    const tpmPct = r.tpm > 0 ? Math.round(r.current_tpm / r.tpm * 100) : 0;
    const rpmBar = rpmPct > 80 ? 'bg-danger' : rpmPct > 50 ? 'bg-warning' : 'bg-success';
    const tpmBar = tpmPct > 80 ? 'bg-danger' : tpmPct > 50 ? 'bg-warning' : 'bg-success';
    return `<tr>
      <td><code>${escapeHtml(r.model)}</code></td>
      <td>${r.current_rpm} / ${r.rpm}
        <div class="progress"><div class="progress-bar ${rpmBar}" style="width:${rpmPct}%"></div></div>
      </td>
      <td>${r.current_tpm.toLocaleString()} / ${r.tpm.toLocaleString()}
        <div class="progress"><div class="progress-bar ${tpmBar}" style="width:${tpmPct}%"></div></div>
      </td>
      <td>${r.resets_in_seconds}s</td>
    </tr>`;
  }).join('');

  const uptime = Math.floor(status.uptime / 1000);
  const uptimeStr = uptime < 60 ? `${uptime}s` :
    uptime < 3600 ? `${Math.floor(uptime / 60)}m ${uptime % 60}s` :
      `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en" data-theme="dark">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Groq Bridge - Dashboard</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px}',
    '.container{max-width:1400px;margin:0 auto}',
    'h1{font-size:1.5rem;margin-bottom:8px;color:#58a6ff}',
    'h2{font-size:1.2rem;margin-bottom:12px;color:#8b949e}',
    '.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:12px}',
    '.status-bar{display:flex;gap:16px;align-items:center;flex-wrap:wrap}',
    '.status-badge{padding:4px 12px;border-radius:12px;font-size:.8rem;font-weight:600}',
    '.status-badge.ok{background:#1a7f37;color:#fff}',
    '.status-badge.degraded{background:#d29922;color:#fff}',
    '.stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 20px;text-align:center}',
    '.stat-value{font-size:1.4rem;font-weight:700;color:#58a6ff}',
    '.stat-label{font-size:.75rem;color:#8b949e;text-transform:uppercase}',
    '.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:24px}',
    '.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:20px}',
    '.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}',
    '.auto-toggle{display:flex;align-items:center;gap:8px}',
    '.toggle{width:44px;height:24px;background:#30363d;border-radius:12px;cursor:pointer;position:relative;transition:background .3s;border:1px solid #58a6ff}',
    '.toggle.active{background:#1f6feb}',
    '.toggle::after{content:"";position:absolute;width:18px;height:18px;background:#fff;border-radius:50%;top:2px;left:2px;transition:transform .3s}',
    '.toggle.active::after{transform:translateX(20px)}',
    'table{width:100%;border-collapse:collapse;font-size:.85rem}',
    'th{text-align:left;padding:8px 12px;border-bottom:2px solid #30363d;color:#8b949e;font-weight:600;font-size:.75rem;text-transform:uppercase}',
    'td{padding:8px 12px;border-bottom:1px solid #21262d}',
    'tr:hover td{background:#1c2128}',
    'code{background:#21262d;padding:2px 6px;border-radius:4px;font-size:.8rem}',
    '.badge{display:inline-block;padding:2px 8px;border-radius:8px;font-size:.7rem;font-weight:600;text-transform:uppercase}',
    '.badge-fast{background:#0e4429;color:#3fb950}',
    '.badge-balanced{background:#0d2b45;color:#58a6ff}',
    '.badge-powerful{background:#3d1f00;color:#d29922}',
    '.badge-vision{background:#271052;color:#bc8cff}',
    '.badge-audio{background:#1f3a3a;color:#56d4dd}',
    '.badge-embedding{background:#1a1f3a;color:#7788ff}',
    '.badge-guard{background:#3d0d0d;color:#ff7b72}',
    '.badge-other{background:#21262d;color:#8b949e}',
    '.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%}',
    '.online{background:#3fb950}',
    '.offline{background:#30363d}',
    '.log-success td{color:#c9d1d9}',
    '.log-error td{color:#ff7b72}',
    '.progress{height:4px;background:#21262d;border-radius:2px;margin-top:4px;overflow:hidden}',
    '.progress-bar{height:100%;border-radius:2px;transition:width .5s}',
    '.bg-success{background:#3fb950}',
    '.bg-warning{background:#d29922}',
    '.bg-danger{background:#f85149}',
    '.scroll{max-height:400px;overflow-y:auto}',
    '.scroll::-webkit-scrollbar{width:6px}',
    '.scroll::-webkit-scrollbar-track{background:#161b22}',
    '.scroll::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}',
    '.actions{display:flex;gap:8px}',
    '.btn{padding:6px 14px;border:1px solid #30363d;border-radius:6px;cursor:pointer;font-size:.8rem;background:#21262d;color:#c9d1d9;transition:all .2s}',
    '.btn:hover{background:#30363d;border-color:#8b949e}',
    '.btn-primary{background:#1f6feb;border-color:#1f6feb;color:#fff}',
    '.btn-primary:hover{background:#388bfd}',
    '.empty{text-align:center;padding:24px;color:#484f58}',
    '.model-count{font-size:.85rem;color:#8b949e}',
    '.tab-bar{display:flex;gap:4px;margin-bottom:16px}',
    '.tab{padding:6px 16px;border:1px solid #30363d;border-radius:6px 6px 0 0;cursor:pointer;font-size:.85rem;background:#161b22;color:#8b949e;border-bottom:none}',
    '.tab.active{background:#0d1117;color:#c9d1d9;border-color:#30363d;border-bottom:1px solid #0d1117;margin-bottom:-1px}',
    '.tab-content{display:none}',
    '.tab-content.active{display:block}',
    '@media(max-width:768px){.stats{grid-template-columns:repeat(3,1fr)}.header{flex-direction:column;align-items:flex-start}}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="container">',
    '<div class="header">',
    '<div>',
    '<h1>Groq Bridge Proxy</h1>',
    '<div style="font-size:.9rem;color:#8b949e;margin-top:6px">Powered by <strong>' + escapeHtml(identityName) + '</strong>' + (identityOwner ? ' — ' + escapeHtml(identityOwner) : '') + (identityWebsite ? ' <a href="' + escapeHtml(identityWebsite) + '" style="color:#58a6ff;text-decoration:none;margin-left:6px" target="_blank">' + escapeHtml(identityWebsite) + '</a>' : '') + '</div>',
    '<div class="status-bar">',
    '<span class="status-badge ' + status.status + '">' + status.status.toUpperCase() + '</span>',
    '<span>Uptime: ' + uptimeStr + '</span>',
    '<span>Memory: ' + status.memory_mb + ' MB</span>',
    '<a href="https://console.groq.com" target="_blank" style="color:#58a6ff;text-decoration:none;font-size:.85rem">Groq Console</a>',
    '</div>',
    '</div>',
    '<div class="auto-toggle">',
    '<span style="font-size:.85rem;color:#8b949e">Auto-Select Model:</span>',
    '<div id="autoToggle" class="toggle ' + (status.auto_select ? 'active' : '') + '" onclick="toggleAutoSelect()"></div>',
    '<span id="autoLabel" style="font-size:.85rem;font-weight:600">' + (status.auto_select ? 'ON' : 'OFF') + '</span>',
    '</div>',
    '</div>',
    '<div class="stats">',
    '<div class="stat"><div class="stat-value">' + status.total_requests + '</div><div class="stat-label">Total Requests</div></div>',
    '<div class="stat"><div class="stat-value">' + status.models_count + '</div><div class="stat-label">Available Models</div></div>',
    '<div class="stat"><div class="stat-value">' + rateLimits.length + '</div><div class="stat-label">Active Rate Limits</div></div>',
    '<div class="stat"><div class="stat-value" id="lastMinRPM">0</div><div class="stat-label">RPM (last min)</div></div>',
    '</div>',
    '<div class="card">',
    '<div class="tab-bar">',
    '<div class="tab active" onclick="switchTab(\'models\')">Models</div>',
    '<div class="tab" onclick="switchTab(\'logs\')">Recent Logs</div>',
    '<div class="tab" onclick="switchTab(\'limits\')">Rate Limits</div>',
    '</div>',
    '<div id="tab-models" class="tab-content active">',
    '<div class="card-header"><h2>Available Models <span class="model-count">(' + models.length + ' total)</span></h2><button class="btn" onclick="refreshModels()">Refresh</button></div>',
    '<div class="scroll">',
    '<table>',
    '<thead><tr><th>Category</th><th>Model ID</th><th>Owned By</th><th>Context</th><th>Max Tokens</th><th>Status</th></tr></thead>',
    '<tbody>' + modelRows + '</tbody>',
    '</table>',
    '</div>',
    '</div>',
    '<div id="tab-logs" class="tab-content">',
    '<div class="card-header"><h2>Recent Requests <span class="model-count">(last ' + Math.min(logs.length, 200) + ')</span></h2>',
    '<div class="actions"><button class="btn" onclick="refreshLogs()">Refresh</button><button class="btn" onclick="clearLogs()">Clear</button></div></div>',
    '<div class="scroll">' + (logs.length > 0 ? '<table><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Model</th><th>Status</th><th>Tokens</th><th>Duration</th></tr></thead><tbody>' + logRows + '</tbody></table>' : '<div class="empty">No requests yet. Send a request to see logs.</div>') + '</div>',
    '</div>',
    '<div id="tab-limits" class="tab-content">',
    '<div class="card-header"><h2>Rate Limits Per Model</h2><button class="btn" onclick="refreshLimits()">Refresh</button></div>',
    '<div class="scroll">' + (rateLimits.length > 0 ? '<table><thead><tr><th>Model</th><th>RPM</th><th>TPM</th><th>Resets In</th></tr></thead><tbody>' + rateLimitRows + '</tbody></table>' : '<div class="empty">No rate limit data yet. Send a request to see limits.</div>') + '</div>',
    '</div>',
    '</div>',
    '<div class="card">',
    '<h2>Quick Test</h2>',
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px">',
    '<div style="flex:1;min-width:300px">',
    '<textarea id="testInput" rows="4" style="width:100%;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:8px;color:#c9d1d9;font-family:monospace;font-size:.85rem" placeholder="Enter your message here...">Hello! What can you do?</textarea>',
    '</div>',
    '<div style="display:flex;flex-direction:column;gap:8px;min-width:200px">',
    '<select id="testModel" style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:8px;color:#c9d1d9">',
    '<option value="auto">Auto-Select</option>',
    models.map(m => '<option value="' + m.id + '">' + m.id + '</option>').join(''),
    '</select>',
    '<button class="btn btn-primary" onclick="testChat()">Send Test</button>',
    '</div>',
    '</div>',
    '<pre id="testResult" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;margin-top:12px;font-size:.8rem;min-height:60px;white-space:pre-wrap;word-break:break-word;color:#8b949e">Result will appear here...</pre>',
    '</div>',
    '</div>',
    '<script>',
    'var API_KEY = ""; // redacted from server side',
    'function toggleAutoSelect(){',
    '  fetch("/api/auto-select",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:!document.getElementById("autoToggle").classList.contains("active")})}).then(function(r){if(r.ok)location.reload()})',
    '}',
    'function switchTab(n){',
    '  var tabs=document.querySelectorAll(".tab");',
    '  for(var i=0;i<tabs.length;i++)tabs[i].classList.remove("active");',
    '  var contents=document.querySelectorAll(".tab-content");',
    '  for(var i=0;i<contents.length;i++)contents[i].classList.remove("active");',
    '  var idx=["models","logs","limits"].indexOf(n);',
    '  if(idx>=0)tabs[idx].classList.add("active");',
    '  document.getElementById("tab-"+n).classList.add("active")',
    '}',
    'function refreshModels(){location.reload()}',
    'function refreshLogs(){location.reload()}',
    'function refreshLimits(){location.reload()}',
    'function clearLogs(){fetch("/api/logs",{method:"DELETE"}).then(function(){location.reload()})}',
    'function testChat(){',
    '  var i=document.getElementById("testInput").value;',
    '  var m=document.getElementById("testModel").value;',
    '  var r=document.getElementById("testResult");',
    '  r.textContent="Sending...";',
    '  r.style.color="#8b949e";',
    '  var body={messages:[{role:"user",content:i}],max_tokens:200,temperature:0.7};',
    '  if(m!=="auto")body.model=m;',
    '  fetch("/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_KEY},body:JSON.stringify(body)}).then(function(res){return res.json()}).then(function(d){r.textContent=JSON.stringify(d,null,2);r.style.color="#3fb950"}).catch(function(e){r.textContent="Error: "+e.message;r.style.color="#f85149"})',
    '}',
    'function fetchRPM(){',
    '  fetch("/api/rate-limits").then(function(r){return r.json()}).then(function(d){var s=0;for(var i=0;i<d.length;i++)s+=d[i].current_rpm;document.getElementById("lastMinRPM").textContent=s}).catch(function(){})',
    '}',
    'fetchRPM();',
    'setInterval(fetchRPM,5000);',
    'setInterval(function(){',
    '  fetch("/api/logs").then(function(r){return r.json()}).then(function(d){',
    '    var el=document.getElementById("tab-logs");',
    '    if(!el||!el.classList.contains("active"))return;',
    '    var sc=el.querySelector(".scroll");',
    '    if(!sc||!d.logs||!d.logs.length)return;',
    '    var html="<table><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Model</th><th>Status</th><th>Tokens</th><th>Duration</th></tr></thead><tbody>";',
    '    var items=d.logs.slice(-50);',
    '    for(var i=0;i<items.length;i++){',
    '      var l=items[i];',
    '      var cls=l.success?"log-success":"log-error";',
    '      html+="<tr class=\\\""+cls+"\\\"><td>"+new Date(l.timestamp).toLocaleTimeString()+"</td><td>"+l.method+"</td><td>"+l.path+"</td><td>"+l.model+"</td><td>"+l.status+"</td><td>"+l.tokens+"</td><td>"+l.duration_ms+"ms</td></tr>"',
    '    }',
    '    html+="</tbody></table>";',
    '    sc.innerHTML=html',
    '  }).catch(function(){})',
    '},3000);',
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');

  res.set('Content-Type', 'text/html');
  res.send(html);
};
