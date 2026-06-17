import crypto from 'crypto';

export function sha256(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

export function hashRow(row: Record<string, any>): string {
  const stable = JSON.stringify(row, Object.keys(row).sort());
  return sha256(stable);
}

export function hashFromBody(body: Record<string, any>, excludeFields: string[] = []): string {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!excludeFields.includes(k)) clean[k] = v;
  }
  return hashRow(clean);
}
