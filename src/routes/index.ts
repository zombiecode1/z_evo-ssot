import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  handleChatCompletion,
  handleTextCompletion,
  handleTranscription,
  handleTranslation,
  handleEmbeddings,
  handleListModels,
  handleGetModel,
  handleDashboard,
  getService,
} from '../controllers/openaiController';
import {
  handleAgentChat,
  handleSetDirectory,
  handleGrantPermission,
  handleProjectStatus,
  handleRescan,
  handleReadSSOT,
  handleAgentRoutes,
  handleCreateEditorSession,
  handleCreateConversation,
  handleGetConversationHistory,
  handleListConversations,
  handleIndexWorkspace,
  handleSearchWorkspace,
  handleLangChainAgent,
  handleClearMemory,
  handleMemoryStats,
  handleRegisterEditor,
  handleClientStats,
  handleDisconnectEditor,
} from '../controllers/agentController';
import { handleMcpJsonRpc, handleMcpInfo, handleMcpSseStream, handleMcpDeleteSession } from '../controllers/mcpController';
import { clearRuntimeEvents, readRuntimeEvents } from '../services/runtimeEventLog';
import {
  handleDbList, handleDbGet, handleDbStats,
  handleGetIdentity, handleUpdateIdentity,
  handleListLlmSources, handleCreateLlmSource, handleDeleteLlmSource,
  handleListAgentNotes, handleCreateAgentNote, handleGetAgentNote, handleDeleteAgentNote,
  handleListWriteLog, handleCreateWriteLog,
  handleWriteLogWithHash, handleVerifyEntry, handleVerifyReport, handleVerifyWriteRead,
} from '../controllers/dbController';
import {
  handleAdminDashboard, handleAdminPage,
  handleAdminStats, handleAdminModels, handleAdminMapping,
  handleAdminModelsSync, handleAdminModelActive,
  handleAdminModelUpdate, handleAdminModelDelete,
  handleAdminMappingSave, handleAdminMappingDelete,
  handleAdminSessions, handleAdminConversations, handleAdminConversationDetail,
  handleAdminUsage, handleAdminIdentity,
  handleAdminDeleteSession, handleAdminDeleteConversation, handleAdminClearUsage,
  handleAdminModelPriority, handleAdminModelUsage,
  handleAdminMonitorSSE, handleAdminAgentHealth,
  handleAdminProvidersList, handleAdminProviderGet, handleAdminProviderSave, handleAdminProviderDelete,
  handleAdminProviderToggle, handleAdminProviderTest, handleAdminProviderSync,
  handleAdminProviderSyncAll, handleAdminModelTest, handleAdminAutoRouteTest,
  handleAdminSetDefaultModel, handleAdminProviderCosts,
  handleAdminProviderTools, handleAdminProviderToolTest, handleAdminProviderCapabilities,
  handleAdminPricing,
} from '../admin/controller';
import { requireAdmin } from '../middleware/authMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Health
router.get('/health', (req: Request, res: Response) => {
  const service = getService();
  res.json({
    status: 'ok',
    service: 'groq-openai-bridge',
    version: '2.0.0',
    uptime_ms: service ? Date.now() - service.startedAtMs : 0,
    models_loaded: service ? service.getModels().length : 0,
  });
});

// OpenAI-compatible endpoints
router.post('/v1/chat/completions', handleChatCompletion);
router.post('/v1/completions', handleTextCompletion);
router.post('/v1/audio/transcriptions', upload.single('file'), handleTranscription);
router.post('/v1/audio/translations', upload.single('file'), handleTranslation);
router.post('/v1/embeddings', handleEmbeddings);
router.get('/v1/models', handleListModels);
router.get('/v1/models/:model', handleGetModel);

// Dashboard
router.get('/dashboard', handleDashboard);

// ─── Admin Dashboard ──────────────────────────────────────
router.get('/admin/dashboard', handleAdminDashboard);
router.get('/admin/dashboard/:page', handleAdminPage);

// ─── Admin API (protected by requireAdmin) ────────────────
const adminApi = Router();
adminApi.use(requireAdmin);

adminApi.get('/stats', handleAdminStats);
adminApi.get('/models', handleAdminModels);
adminApi.post('/models/sync', handleAdminModelsSync);
adminApi.patch('/models/:id/active', handleAdminModelActive);
adminApi.patch('/models/:id', handleAdminModelUpdate);
adminApi.delete('/models/:id', handleAdminModelDelete);
adminApi.get('/mapping', handleAdminMapping);
adminApi.post('/mapping', handleAdminMappingSave);
adminApi.delete('/mapping/:id', handleAdminMappingDelete);
adminApi.get('/sessions', handleAdminSessions);
adminApi.delete('/sessions/:id', handleAdminDeleteSession);
adminApi.get('/conversations', handleAdminConversations);
adminApi.get('/conversations/:id', handleAdminConversationDetail);
adminApi.delete('/conversations/:id', handleAdminDeleteConversation);
adminApi.get('/usage', handleAdminUsage);
adminApi.delete('/usage', handleAdminClearUsage);
adminApi.get('/identity', handleAdminIdentity);
adminApi.patch('/models/:id/priority', handleAdminModelPriority);
adminApi.get('/models/:id/usage', handleAdminModelUsage);
adminApi.get('/monitor', handleAdminMonitorSSE);
adminApi.get('/agent-health', handleAdminAgentHealth);

// ─── Provider Orchestration API ───────────────────────────
adminApi.get('/providers', handleAdminProvidersList);
adminApi.get('/providers/:id', handleAdminProviderGet);
adminApi.post('/providers', handleAdminProviderSave);
adminApi.delete('/providers/:id', handleAdminProviderDelete);
adminApi.patch('/providers/:id/toggle', handleAdminProviderToggle);
adminApi.post('/providers/:id/test', handleAdminProviderTest);
adminApi.post('/providers/:id/sync', handleAdminProviderSync);
adminApi.post('/providers/sync-all', handleAdminProviderSyncAll);
adminApi.post('/models/:id/test', handleAdminModelTest);
adminApi.post('/auto-route', handleAdminAutoRouteTest);
adminApi.post('/default-model', handleAdminSetDefaultModel);
adminApi.get('/provider-costs', handleAdminProviderCosts);
adminApi.get('/provider-tools', handleAdminProviderTools);
adminApi.post('/providers/:id/tools/:type/test', handleAdminProviderToolTest);
adminApi.get('/provider-capabilities', handleAdminProviderCapabilities);
adminApi.get('/pricing', handleAdminPricing);

router.use('/api/admin', adminApi);

// Internal API
router.get('/api/logs', (req: Request, res: Response) => {
  const service = getService();
  res.json({ logs: service?.getLogs().slice(-200) || [] });
});

router.get('/api/events', async (req: Request, res: Response) => {
  res.json({ events: await readRuntimeEvents(200) });
});

router.delete('/api/events', (req: Request, res: Response) => {
  clearRuntimeEvents();
  res.json({ success: true });
});

router.delete('/api/logs', (req: Request, res: Response) => {
  const service = getService();
  if (service) service.clearLogs();
  res.json({ success: true });
});

router.get('/api/rate-limits', (req: Request, res: Response) => {
  const service = getService();
  res.json(service?.getRateLimits() || []);
});

router.post('/api/auto-select', (req: Request, res: Response) => {
  const service = getService();
  if (service) {
    service.autoSelect = req.body.enabled === true;
    res.json({ auto_select: service.autoSelect });
  } else {
    res.status(500).json({ error: 'Service not initialized' });
  }
});

router.get('/api/status', (req: Request, res: Response) => {
  const service = getService();
  res.json(service?.getStatus() || { status: 'degraded' as const });
});

// ─── Agent & RAG Endpoints ────────────────────────────────
router.post('/v1/agent/chat', handleAgentChat);
router.post('/v1/agent/directory', handleSetDirectory);
router.post('/v1/agent/permission', handleGrantPermission);
router.post('/v1/agent/create-session', handleCreateEditorSession);
router.get('/v1/agent/status', handleProjectStatus);
router.get('/v1/agent/events', (req: Request, res: Response) => {
  // SSE real-time event stream for agent activities
  const { subscribeToAgentEvents } = require('../services/eventBroadcaster');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  subscribeToAgentEvents(res);
});
router.post('/v1/agent/rescan', handleRescan);
router.get('/v1/agent/ssot', handleReadSSOT);
router.get('/v1/agent/routes', handleAgentRoutes);
router.post('/v1/agent/conversations', handleCreateConversation);
router.get('/v1/agent/conversations', handleListConversations);
router.get('/v1/agent/conversations/:conversation_id', handleGetConversationHistory);
router.post('/v1/agent/index', handleIndexWorkspace);
router.post('/v1/agent/search', handleSearchWorkspace);

// ─── LangChain Agent (tools + memory + reasoning) ────────
router.post('/v1/agent/langchain', handleLangChainAgent);
router.post('/v1/agent/memory/clear', handleClearMemory);
router.get('/v1/agent/memory/stats', handleMemoryStats);

// ─── Editor Registration & Client Tracking ─────────────────
// Editors call this to register their root directory
router.post('/v1/agent/register', handleRegisterEditor);
// Get all connected clients and their status
router.get('/v1/agent/clients', handleClientStats);
// Disconnect a specific client
router.post('/v1/agent/clients/disconnect', handleDisconnectEditor);

// ─── Directory Index (auto-scan + flag tracking) ──────────
router.get('/v1/agent/index', (req: Request, res: Response) => {
  // Returns the in-memory directory index
  // Import would be circular, so we use dynamic import via require
  try {
    const indexPath = require('path').join(process.cwd(), '.zombiecoder', 'directory-index.json');
    const fs = require('fs');
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      res.json({ ok: true, directories: index, count: Object.keys(index).length });
    } else {
      res.json({ ok: true, directories: {}, count: 0, message: 'No index yet' });
    }
  } catch (err: any) {
    res.json({ ok: true, directories: {}, count: 0, error: err?.message });
  }
});

router.post('/v1/agent/index/scan', async (req: Request, res: Response) => {
  // Force re-scan a directory
  const { directory } = req.body;
  if (!directory) {
    return res.status(400).json({ error: 'directory required' });
  }
  try {
    const { DiskRAGService } = require('../services/ragService');
    const rag = new DiskRAGService();
    await rag.setWorkingDirectory(directory, { autoInit: true });
    res.json({ ok: true, directory, message: 'Directory scanned and SSOT updated' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

// ─── DB REST API (Phase 2 — Multi-Source SQLite) ────────
//   GET  /db/stats             — table row counts
//   GET  /db/:table            — list rows
//   GET  /db/:table/:id        — get row by id
//   GET  /db/identity          — get system identity
//   POST /db/identity          — update system identity
//   GET  /db/llm/sources       — list LLM sources
//   POST /db/llm/sources       — add LLM source
//   DELETE /db/llm/sources/:id — remove LLM source
//   GET  /db/notes             — list agent notes
//   POST /db/notes             — create agent note
//   GET  /db/notes/:key        — get agent note by key
//   DELETE /db/notes/:key      — delete agent note
//   GET  /db/write-log         — list write log entries
//   POST /db/write-log         — create write log entry
router.get('/db/stats', handleDbStats);
router.get('/db/identity', handleGetIdentity);
router.post('/db/identity', handleUpdateIdentity);
router.get('/db/llm/sources', handleListLlmSources);
router.post('/db/llm/sources', handleCreateLlmSource);
router.delete('/db/llm/sources/:id', handleDeleteLlmSource);
router.get('/db/notes', handleListAgentNotes);
router.post('/db/notes', handleCreateAgentNote);
router.get('/db/notes/:key', handleGetAgentNote);
router.delete('/db/notes/:key', handleDeleteAgentNote);
router.get('/db/write-log', handleListWriteLog);
router.post('/db/write-log', handleCreateWriteLog);
router.post('/db/write-log/hash', handleWriteLogWithHash);
router.get('/db/verify/report', handleVerifyReport);
router.post('/db/verify/:id', handleVerifyEntry);
router.post('/db/verify-read', handleVerifyWriteRead);
router.get('/db/:table', handleDbList);
router.get('/db/:table/:id', handleDbGet);

// MCP-style JSON-RPC endpoints for editor/tool clients
// Streamable HTTP Transport (MCP spec 2025-03-26)
// GET  /mcp          → SSE stream for server→client events (optional, for stateful sessions)
// POST /mcp          → JSON-RPC request/response (supports Accept: text/event-stream for SSE)
// DELETE /mcp/:id    → Session termination
router.get('/mcp', handleMcpSseStream);
router.post('/mcp', handleMcpJsonRpc);
router.get('/mcp/info', handleMcpInfo);
router.delete('/mcp/:sessionId', handleMcpDeleteSession);

// Zombie Agent endpoints — জম্বিদের ডাকার জন্য
import { 
  handleZombieAgentChat, 
  handleZombieAgentList,
  handleZombieAgentStats,
  handleZombieAgentActivity,
} from '../controllers/zombieAgentController';
router.get('/zombie/agents', handleZombieAgentList);
router.post('/zombie/chat', handleZombieAgentChat);

// ─── Zombie Agent Admin API (for admin panel) ───────────────
adminApi.get('/zombie/stats', handleZombieAgentStats);
adminApi.get('/zombie/activity', handleZombieAgentActivity);

export default router;
