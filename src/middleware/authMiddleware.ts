import { Request, Response, NextFunction } from 'express';

// Extend Express Request type for TypeScript
declare global {
  namespace Express {
    interface Request {
      apiKey?: string;
    }
  }
}

/**
 * Authentication middleware for proxi bridge server.
 * 
 * Priority order:
 * 1. Authorization header (Bearer token)
 * 2. GROQ_API_KEY env var (fallback)
 * 3. OPENCODE_API_KEY env var (OpenCode Zen)
 * 
 * Returns 500 if no API key is configured at all.
 */
export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const groqKey = process.env.GROQ_API_KEY;
  const openCodeKey = process.env.OPENCODE_API_KEY;
  const defaultKey = groqKey || openCodeKey;

  const authHeader = req.headers.authorization;

  // No auth header — use default key
  if (!authHeader) {
    if (!defaultKey) {
      return res.status(500).json({
        error: 'Server configuration error: no API key available',
        hint: 'Set GROQ_API_KEY or OPENCODE_API_KEY environment variable',
      });
    }
    req.apiKey = defaultKey;
    return next();
  }

  // Extract token from Bearer header
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({
      error: 'Empty bearer token',
      hint: 'Provide a valid API key in the Authorization header',
    });
  }

  req.apiKey = token;
  next();
};

/**
 * Admin authentication middleware.
 * Requires a valid API key AND checks for admin-specific header.
 * If ADMIN_SECRET is not configured, admin routes are open (local dev mode).
 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const adminSecret = process.env.ADMIN_SECRET;

  // No secret configured — open access for local development
  if (!adminSecret) {
    return next();
  }

  const adminHeader = req.headers['x-admin-secret'] as string;

  if (!adminHeader || adminHeader !== adminSecret) {
    return res.status(403).json({
      error: 'Forbidden: admin access required',
      hint: 'Set X-Admin-Secret header or ADMIN_SECRET env var',
    });
  }

  next();
};
