const path = require('path');
const { initStateDb } = require('./dist/services/stateDb');

const dbPath = path.resolve(__dirname, '.zombiecoder', 'state.db');
const db = initStateDb(dbPath);
const rows = db.prepare('SELECT * FROM agent_notes WHERE key LIKE ?').all('seed:%');
console.log(rows);
