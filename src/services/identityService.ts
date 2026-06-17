import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ZOMBIECODER_PERSONA, buildSystemPrompt } from '../config/persona';
import { getStateDb, setRuntimeConfig, getRuntimeConfig, getAllRuntimeConfig } from './stateDb';

const ID_PATH = path.resolve(__dirname, '../../identity.json');

let _identity: any = null;
let _hash: string | null = null;
let _lastModified: number = 0;

/**
 * Load identity.json with file change detection.
 * Also merges persona data from DB (runtime_config table).
 */
export function loadIdentity(forceReload = false): any {
    try {
        const stat = fs.statSync(ID_PATH);
        const currentMtime = stat.mtimeMs;

        if (_identity && !forceReload && currentMtime === _lastModified) {
            return _identity;
        }

        const raw = fs.readFileSync(ID_PATH, 'utf8');
        _identity = JSON.parse(raw);
        _hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
        _lastModified = currentMtime;

        // Merge persona from DB if available
        mergePersonaFromDb();

        return _identity;
    } catch (err: any) {
        console.error('identityService: failed to load identity.json:', err?.message || err);
        // Fallback: create identity from persona config
        _identity = createIdentityFromPersona();
        _hash = null;
        _lastModified = 0;
        return _identity;
    }
}

/**
 * Get identity with automatic cache refresh.
 */
export function getIdentity(): any {
    try {
        const stat = fs.statSync(ID_PATH);
        const currentMtime = stat.mtimeMs;

        if (!_identity || currentMtime !== _lastModified) {
            return loadIdentity(true);
        }
        return _identity;
    } catch {
        return _identity;
    }
}

export function getIdentityHash(): string | null {
    if (!_hash) loadIdentity();
    return _hash;
}

export function reloadIdentity(): any {
    return loadIdentity(true);
}

/**
 * Save persona configuration to DB.
 * Called on startup to ensure DB has latest persona data.
 */
export function savePersonaToDb(): void {
    const db = getStateDb();
    if (!db) return;

    try {
        const p = ZOMBIECODER_PERSONA;

        // Save identity basics
        setRuntimeConfig(db, 'persona:id', p.id, 'identity');
        setRuntimeConfig(db, 'persona:name', p.name, 'identity');
        setRuntimeConfig(db, 'persona:tagline', p.tagline, 'identity');
        setRuntimeConfig(db, 'persona:owner:name', p.owner.name, 'identity');
        setRuntimeConfig(db, 'persona:owner:location', p.owner.location, 'identity');
        setRuntimeConfig(db, 'persona:owner:contact', p.owner.contact, 'identity');
        setRuntimeConfig(db, 'persona:owner:website', p.owner.website, 'identity');
        setRuntimeConfig(db, 'persona:language:primary', p.language.primary, 'identity');
        setRuntimeConfig(db, 'persona:language:technical', p.language.technical, 'identity');
        setRuntimeConfig(db, 'persona:language:greeting', p.language.greeting, 'identity');

        // Save principles as JSON
        setRuntimeConfig(db, 'persona:principles', JSON.stringify(p.principles), 'persona');
        setRuntimeConfig(db, 'persona:workflow', JSON.stringify(p.workflow), 'persona');
        setRuntimeConfig(db, 'persona:rules', JSON.stringify(p.rules), 'persona');
        setRuntimeConfig(db, 'persona:competencies', JSON.stringify(p.competencies), 'persona');
        setRuntimeConfig(db, 'persona:responseStyle', JSON.stringify(p.responseStyle), 'persona');

        // Save system prompt
        setRuntimeConfig(db, 'persona:system_prompt', buildSystemPrompt(p), 'persona');

        console.log('✅ Persona saved to DB');
    } catch (err: any) {
        console.warn('⚠️ Failed to save persona to DB:', err?.message || err);
    }
}

/**
 * Load persona from DB and merge into identity object.
 */
function mergePersonaFromDb(): void {
    const db = getStateDb();
    if (!db || !_identity) return;

    try {
        const rows = getAllRuntimeConfig(db);
        if (rows.length === 0) return;

        // Convert array to Record<string, string>
        const config: Record<string, string> = {};
        for (const row of rows) config[row.key] = row.value;

        // Ensure system_identity exists
        if (!_identity.system_identity) {
            _identity.system_identity = {};
        }

        // Merge persona fields from DB
        const sys = _identity.system_identity;
        sys.name = config['persona:name'] || sys.name || ZOMBIECODER_PERSONA.name;
        sys.tagline = config['persona:tagline'] || sys.tagline || ZOMBIECODER_PERSONA.tagline;
        sys.system_prompt = config['persona:system_prompt'] || sys.system_prompt || buildSystemPrompt(ZOMBIECODER_PERSONA);

        // Merge owner info
        if (!_identity.owner) _identity.owner = {};
        _identity.owner.name = config['persona:owner:name'] || _identity.owner.name || ZOMBIECODER_PERSONA.owner.name;
        _identity.owner.location = config['persona:owner:location'] || _identity.owner.location || ZOMBIECODER_PERSONA.owner.location;
        _identity.owner.contact = config['persona:owner:contact'] || _identity.owner.contact || ZOMBIECODER_PERSONA.owner.contact;
        _identity.owner.website = config['persona:owner:website'] || _identity.owner.website || ZOMBIECODER_PERSONA.owner.website;

        // Attach full persona data
        const cfg = config;
        _identity.persona = {
            principles: cfg['persona:principles'] ? JSON.parse(cfg['persona:principles']) : ZOMBIECODER_PERSONA.principles,
            workflow: cfg['persona:workflow'] ? JSON.parse(cfg['persona:workflow']) : ZOMBIECODER_PERSONA.workflow,
            rules: cfg['persona:rules'] ? JSON.parse(cfg['persona:rules']) : ZOMBIECODER_PERSONA.rules,
            competencies: cfg['persona:competencies'] ? JSON.parse(cfg['persona:competencies']) : ZOMBIECODER_PERSONA.competencies,
            responseStyle: cfg['persona:responseStyle'] ? JSON.parse(cfg['persona:responseStyle']) : ZOMBIECODER_PERSONA.responseStyle,
        };
    } catch (err: any) {
        console.warn('mergePersonaFromDb failed:', err?.message || err);
    }
}

/**
 * Create identity from persona config (fallback when identity.json missing).
 */
function createIdentityFromPersona(): any {
    const p = ZOMBIECODER_PERSONA;
    return {
        system_identity: {
            name: p.name,
            tagline: p.tagline,
            system_prompt: buildSystemPrompt(p),
            version: '2.0.0',
        },
        owner: { ...p.owner },
        persona: {
            principles: p.principles,
            workflow: p.workflow,
            rules: p.rules,
            competencies: p.competencies,
            responseStyle: p.responseStyle,
        },
    };
}

export default {
    loadIdentity,
    getIdentity,
    getIdentityHash,
    reloadIdentity,
    savePersonaToDb,
};
