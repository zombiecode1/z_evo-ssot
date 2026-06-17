import { Request, Response, NextFunction } from 'express';
import { getIdentity, getIdentityHash } from '../services/identityService';

/**
 * Identity middleware — attaches identity headers to responses.
 * 
 * In production, sensitive headers (X-Powered-By, X-Identity-Name, etc.)
 * are disabled to prevent information leakage.
 */
export function identityMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        // In production, don't expose identity information
        if (process.env.NODE_ENV === 'production') {
            // Still set the hash for protocol compatibility, but no other headers
            const idHash = getIdentityHash();
            if (idHash) {
                res.setHeader('X-Identity-Hash', idHash);
            }
            return next();
        }

        // Development: full identity headers
        const identity = getIdentity();
        const idHash = getIdentityHash();

        if (identity && identity.system_identity) {
            const id = identity.system_identity;
            if (id.version) res.setHeader('X-Identity-Version', String(id.version));
            if (id.name) res.setHeader('X-Identity-Name', String(id.name));
        }

        if (idHash) {
            res.setHeader('X-Identity-Hash', idHash);
        }
    } catch (e) {
        // Don't fail requests if header injection fails
        console.warn('identityMiddleware error:', (e as any)?.message || e);
    }

    next();
}

export default identityMiddleware;
