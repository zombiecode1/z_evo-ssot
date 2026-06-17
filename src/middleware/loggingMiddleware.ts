import { Request, Response, NextFunction } from 'express';

/**
 * Structured logging middleware for Express.
 * Uses res.on('finish') to capture response completion.
 * Avoids monkey-patching res.send/res.json.
 */
export const loggingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  // Log response when it finishes
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    const method = req.method;
    const path = req.path;
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.get('user-agent') || '';

    const logData = {
      timestamp: new Date().toISOString(),
      method,
      path,
      status: statusCode,
      duration: `${duration}ms`,
      ip: ip ? String(ip).replace(/^::ffff:/, '') : undefined,
      userAgent: userAgent.slice(0, 100),
    };

    // Color coding for terminal
    const color = statusCode >= 500 ? '\x1b[31m' : statusCode >= 400 ? '\x1b[33m' : '\x1b[32m';
    const reset = '\x1b[0m';
    const logLine = `${color}[${logData.timestamp}] ${method} ${path} - ${statusCode} - ${duration}ms${reset}`;

    if (statusCode >= 500) {
      console.error(logLine);
    } else if (statusCode >= 400) {
      console.warn(logLine);
    } else {
      console.log(logLine);
    }
  });

  next();
};
