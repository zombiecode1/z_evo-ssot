const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

function listTables(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  db.close();
  return rows.map(r => r.name);
}

function tableCounts(dbPath, table) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get();
  db.close();
  return row?.cnt ?? 0;
}

(async () => {
  try {
    const dbPath = path.resolve(__dirname, '.zombiecoder', 'state.db');
    if (!fs.existsSync(dbPath)) {
      console.error('STATE DB not found at', dbPath);
      process.exit(2);
    }
    console.log('STATE DB path:', dbPath);

    const tables = listTables(dbPath);
    console.log('Tables:', tables.join(', '));

    // Check a few important tables if present
    for (const t of ['identity','llm_sources','agent_personas','agent_notes']) {
      if (tables.includes(t)) {
        console.log(`- ${t}:`, tableCounts(dbPath, t));
      }
    }

    // Check SSOT.md in workspace (DiskRAG uses SSOT.md convention)
    const ssotPaths = [path.resolve(process.cwd(), 'SSOT.md'), path.resolve(process.cwd(), 'SSOT.MD'), path.resolve(process.cwd(), 'ssot.md'), path.resolve(process.cwd(), 'SSOT')];
    const found = ssotPaths.filter(p => fs.existsSync(p));
    if (found.length) {
      console.log('SSOT file(s) found:', found.join(', '));
    } else {
      console.log('No SSOT file found in current working directory.');
    }

    process.exit(0);
  } catch (e) {
    console.error('Error during DB/SSOT check:', e?.message || e);
    process.exit(1);
  }
})();
