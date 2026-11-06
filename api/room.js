const crypto = require('crypto');
const { sql } = require('./_db');

const GAMES = ['caro', 'chess', 'xq'];
const ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = sql`
      CREATE TABLE IF NOT EXISTS game_rooms (
        id TEXT PRIMARY KEY,
        game TEXT NOT NULL,
        moves JSONB NOT NULL DEFAULT '[]'::jsonb,
        ver INT NOT NULL DEFAULT 0,
        p0 TEXT,
        p1 TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.then(() => sql`ALTER TABLE game_rooms ADD COLUMN IF NOT EXISTS s0 TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS s1 TIMESTAMPTZ`)
     .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const newId = () => Array.from(crypto.randomBytes(5), (b) => ID_CHARS[b % ID_CHARS.length]).join('');
const newToken = () => crypto.randomBytes(16).toString('hex');
const cleanId = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function view(row, side) {
  return { id: row.id, game: row.game, moves: row.moves, ver: row.ver, p0: !!row.p0, p1: !!row.p1, side };
}

function sideOf(row, token) {
  if (!token) return -1;
  if (row.p0 === token) return 0;
  if (row.p1 === token) return 1;
  return -1;
}

// Nước đi chỉ cần các trường nhỏ: {f,t,promo} cho cờ vua/cờ tướng, {r,c} cho caro.
function cleanMove(game, m) {
  if (!m || typeof m !== 'object') return null;
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (game === 'caro') {
    return int(m.r, -10000, 10000) && int(m.c, -10000, 10000) ? { r: m.r, c: m.c } : null;
  }
  const max = game === 'chess' ? 63 : 89;
  if (!int(m.f, 0, max) || !int(m.t, 0, max)) return null;
  const out = { f: m.f, t: m.t };
  if (game === 'chess' && m.promo != null) {
    if (!'qrbn'.includes(m.promo) || m.promo.length !== 1) return null;
    out.promo = m.promo;
  }
  return out;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureTable();

    if (req.method === 'GET') {
      // danh sách phòng có người đang ở trong (báo "còn đây" trong 60 giây gần nhất)
      if (req.query.list) {
        const game = String(req.query.list);
        if (!GAMES.includes(game)) return res.status(400).json({ error: 'game' });
        const rooms = await sql`
          SELECT id, (p1 IS NULL) AS waiting, jsonb_array_length(moves)::int AS n,
                 extract(epoch FROM now() - created_at)::int AS age
          FROM game_rooms
          WHERE game = ${game}
            AND (s0 > now() - interval '60 seconds' OR s1 > now() - interval '60 seconds')
          ORDER BY (p1 IS NULL) DESC, created_at DESC
          LIMIT 30`;
        return res.status(200).json({ rooms });
      }
      const id = cleanId(req.query.id);
      const tok = req.headers['x-room-token'];
      if (typeof tok === 'string' && tok) {
        await sql`
          UPDATE game_rooms
          SET s0 = CASE WHEN p0 = ${tok} THEN now() ELSE s0 END,
              s1 = CASE WHEN p1 = ${tok} THEN now() ELSE s1 END
          WHERE id = ${id} AND (p0 = ${tok} OR p1 = ${tok})`;
      }
      const [row] = await sql`SELECT * FROM game_rooms WHERE id = ${id}`;
      if (!row) return res.status(404).json({ error: 'notfound' });
      return res.status(200).json(view(row, -1));
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'method' });
    }

    const body = await readBody(req);
    const action = body.action;

    if (action === 'create') {
      if (!GAMES.includes(body.game)) return res.status(400).json({ error: 'game' });
      // dọn phòng bỏ hoang
      if (Math.random() < 0.1) await sql`DELETE FROM game_rooms WHERE updated_at < now() - interval '7 days'`;
      const token = newToken();
      const custom = body.id != null && body.id !== '';
      if (custom) {
        const id = cleanId(body.id);
        if (!/^[A-Z0-9]{4,8}$/.test(id)) return res.status(400).json({ error: 'badid' });
        // mã đã có: chỉ cho lấy lại nếu phòng cũ bỏ hoang hơn 1 ngày
        const rows = await sql`
          INSERT INTO game_rooms (id, game, p0, s0) VALUES (${id}, ${body.game}, ${token}, now())
          ON CONFLICT (id) DO UPDATE
            SET game = EXCLUDED.game, p0 = EXCLUDED.p0, p1 = NULL, moves = '[]'::jsonb, ver = game_rooms.ver + 1,
                s0 = now(), s1 = NULL, created_at = now(), updated_at = now()
            WHERE game_rooms.updated_at < now() - interval '1 day'
              AND coalesce(greatest(game_rooms.s0, game_rooms.s1), 'epoch'::timestamptz) < now() - interval '1 day'
          RETURNING *`;
        if (!rows.length) return res.status(409).json({ error: 'taken' });
        return res.status(200).json({ ...view(rows[0], 0), token });
      }
      for (let i = 0; i < 5; i++) {
        const id = newId();
        const rows = await sql`
          INSERT INTO game_rooms (id, game, p0, s0) VALUES (${id}, ${body.game}, ${token}, now())
          ON CONFLICT (id) DO NOTHING RETURNING *`;
        if (rows.length) return res.status(200).json({ ...view(rows[0], 0), token });
      }
      return res.status(500).json({ error: 'id' });
    }

    const id = cleanId(body.id);
    const [row] = await sql`SELECT * FROM game_rooms WHERE id = ${id}`;
    if (!row) return res.status(404).json({ error: 'notfound' });
    const token = typeof body.token === 'string' ? body.token : '';

    if (action === 'join') {
      const side = sideOf(row, token);
      if (side === 0) await sql`UPDATE game_rooms SET s0 = now() WHERE id = ${id}`;
      if (side === 1) await sql`UPDATE game_rooms SET s1 = now() WHERE id = ${id}`;
      if (side >= 0) return res.status(200).json({ ...view(row, side), token });
      if (!row.p1) {
        const t = newToken();
        const rows = await sql`
          UPDATE game_rooms SET p1 = ${t}, s1 = now(), ver = ver + 1, updated_at = now()
          WHERE id = ${id} AND p1 IS NULL RETURNING *`;
        if (rows.length) return res.status(200).json({ ...view(rows[0], 1), token: t });
      }
      const [cur] = await sql`SELECT * FROM game_rooms WHERE id = ${id}`;
      return res.status(200).json(view(cur, -1)); // phòng đủ người: chỉ xem
    }

    const side = sideOf(row, token);
    if (side < 0) return res.status(403).json({ error: 'token', state: view(row, -1) });

    if (action === 'move') {
      const move = cleanMove(row.game, body.move);
      const n = body.n;
      if (!move || !Number.isInteger(n)) return res.status(400).json({ error: 'move' });
      if (n % 2 !== side) return res.status(409).json({ error: 'turn', state: view(row, side) });
      // chỉ nhận khi đúng lượt và hai bên đang thấy cùng một bàn
      const rows = await sql`
        UPDATE game_rooms
        SET moves = moves || jsonb_build_array(${JSON.stringify(move)}::jsonb), ver = ver + 1, updated_at = now()
        WHERE id = ${id} AND jsonb_array_length(moves) = ${n}::int AND jsonb_array_length(moves) < 2000
        RETURNING *`;
      if (rows.length) return res.status(200).json(view(rows[0], side));
      const [cur] = await sql`SELECT * FROM game_rooms WHERE id = ${id}`;
      return res.status(409).json({ error: 'conflict', state: view(cur, side) });
    }

    if (action === 'reset') {
      const rows = await sql`
        UPDATE game_rooms SET moves = '[]'::jsonb, ver = ver + 1, updated_at = now()
        WHERE id = ${id} RETURNING *`;
      return res.status(200).json(view(rows[0], side));
    }

    return res.status(400).json({ error: 'action' });
  } catch (err) {
    console.error('room error', err);
    return res.status(500).json({ error: 'server' });
  }
};
