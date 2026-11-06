const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS game_visits (
      id TEXT PRIMARY KEY,
      ip TEXT NOT NULL,
      location TEXT,
      user_agent TEXT,
      referrer TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

module.exports = { sql, ensureTable };
