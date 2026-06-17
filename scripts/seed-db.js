const path = require('path');
const { initStateDb, upsertAgentNote } = require('./dist/services/stateDb');

(async () => {
  try {
    const dbPath = path.resolve(__dirname, '.zombiecoder', 'state.db');
    const db = initStateDb(dbPath);
    upsertAgentNote(db, { workspace_id: null, key: 'seed:init-note', content: 'Seeded by proxi/seed-db.js', category: 'system' });
    console.log('Seeded agent_notes: seed:init-note');
  } catch (e) {
    console.error('Seed failed:', e);
    process.exit(1);
  }
})();
