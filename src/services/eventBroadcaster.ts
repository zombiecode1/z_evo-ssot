import { Response } from 'express';
import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════════
// Event Broadcaster — real-time SSE event stream for agent activities
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentEvent {
  type: 'ssot_updated' | 'workspace_indexed' | 'agent_chat' | 'session_created' | 'session_terminated' | 'rescan' | 'permission_granted' | 'heartbeat';
  timestamp: string;
  payload?: Record<string, any>;
}

type Subscriber = {
  id: string;
  res: Response;
  lastEventId: string;
};

const subscribers = new Map<string, Subscriber>();
let eventCounter = 0;

function generateEventId(): string {
  eventCounter++;
  return `evt-${Date.now()}-${eventCounter}`;
}

/**
 * Add a subscriber for real-time agent events.
 * Returns the subscriber id.
 */
export function subscribeToAgentEvents(res: Response): string {
  const id = `sub-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  subscribers.set(id, { id, res, lastEventId: '0' });

  // Send initial connection event
  sendSse(subscribers.get(id)!, 'connection', {
    status: 'connected',
    subscriberId: id,
    timestamp: new Date().toISOString(),
  });

  // Remove subscriber on close
  res.on('close', () => {
    subscribers.delete(id);
  });

  // Keep alive with heartbeats
  const heartbeat = setInterval(() => {
    const sub = subscribers.get(id);
    if (!sub) { clearInterval(heartbeat); return; }
    try {
      sendSse(sub, 'heartbeat', { timestamp: new Date().toISOString() });
    } catch {
      clearInterval(heartbeat);
      subscribers.delete(id);
    }
  }, 30000);

  // Clean up heartbeat on close
  res.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(id);
  });

  console.log(`📡 Event subscriber added: ${id} (total: ${subscribers.size})`);
  return id;
}

/**
 * Broadcast an agent event to all connected SSE subscribers.
 */
export function broadcastAgentEvent(event: AgentEvent): void {
  const eventId = generateEventId();
  const payload = `id: ${eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

  let sent = 0;
  for (const [id, sub] of subscribers) {
    try {
      sub.res.write(payload);
      sub.lastEventId = eventId;
      sent++;
    } catch (err: any) {
      console.warn(`📡 Event subscriber write error (${id}): ${err?.message?.substring(0, 50)}`);
      subscribers.delete(id);
    }
  }

  if (sent > 0) {
    console.log(`📡 Broadcast: ${event.type} → ${sent} subscriber(s)`);
  }
}

function sendSse(sub: Subscriber, eventName: string, data: any): void {
  const eventId = generateEventId();
  sub.res.write(`id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify({ ...data, _eventId: eventId })}\n\n`);
  sub.lastEventId = eventId;
}

/**
 * Get subscriber count.
 */
export function getSubscriberCount(): number {
  return subscribers.size;
}

/**
 * Get all active subscribers for admin/debug.
 */
export function listSubscribers(): Array<{ id: string; lastEventId: string }> {
  return Array.from(subscribers.values()).map(s => ({ id: s.id, lastEventId: s.lastEventId }));
}
