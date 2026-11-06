const { sql, ensureTable } = require('./_db');

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function decode(v) {
  if (!v) return null;
  try { return decodeURIComponent(v); } catch { return v; }
}

// Vercel tự gắn vị trí theo IP vào header, không cần gọi API ngoài.
function getLocation(req) {
  const h = req.headers;
  return [decode(h['x-vercel-ip-city']), decode(h['x-vercel-ip-country-region']), h['x-vercel-ip-country']]
    .filter(Boolean)
    .join(', ') || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    await ensureTable();
    const ip = getClientIp(req);
    const userAgent = (req.headers['user-agent'] || 'unknown').slice(0, 500);
    const referrer = (req.headers['referer'] || '').slice(0, 500) || null;
    const location = getLocation(req);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    await sql`
      INSERT INTO game_visits (id, ip, location, user_agent, referrer)
      VALUES (${id}, ${ip}, ${location}, ${userAgent}, ${referrer})
    `;
  } catch (err) {
    console.error('visit log failed', err);
  }
  return res.status(204).end();
};
