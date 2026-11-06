const crypto = require('crypto');
const { sql, ensureTable } = require('./_db');

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatTime(date) {
  return new Date(date).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function device(ua) {
  ua = ua || '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '?';
  const br = /Zalo/i.test(ua) ? 'Zalo' : /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook'
    : /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '?';
  return `${os} · ${br}`;
}

function keyOk(given) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return true; // chưa đặt ADMIN_KEY thì không khoá
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (!keyOk(req.query.key)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(401).send('Unauthorized — dùng /admin?key=...');
  }

  await ensureTable();

  const [summary] = await sql`
    SELECT
      count(*)::int AS total,
      count(DISTINCT ip)::int AS unique_ips,
      count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS today,
      count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS week
    FROM visits
  `;

  const byIp = await sql`
    SELECT ip,
           count(*)::int AS hits,
           max(location) AS location,
           (array_agg(user_agent ORDER BY created_at DESC))[1] AS "userAgent",
           min(created_at) AS "firstSeen",
           max(created_at) AS "lastSeen"
    FROM visits
    GROUP BY ip
    ORDER BY "lastSeen" DESC
    LIMIT 300
  `;

  const recent = await sql`
    SELECT ip, location, user_agent AS "userAgent", referrer, created_at AS "createdAt"
    FROM visits
    ORDER BY created_at DESC
    LIMIT 300
  `;

  const ipRows = byIp.map((v) => `
    <tr>
      <td><code>${escapeHtml(v.ip)}</code></td>
      <td class="n">${v.hits}</td>
      <td>${escapeHtml(v.location || '')}</td>
      <td>${escapeHtml(device(v.userAgent))}</td>
      <td>${escapeHtml(formatTime(v.firstSeen))}</td>
      <td>${escapeHtml(formatTime(v.lastSeen))}</td>
    </tr>`).join('');

  const recentRows = recent.map((v) => `
    <tr>
      <td>${escapeHtml(formatTime(v.createdAt))}</td>
      <td><code>${escapeHtml(v.ip)}</code></td>
      <td>${escapeHtml(v.location || '')}</td>
      <td>${escapeHtml(device(v.userAgent))}</td>
      <td class="ua">${escapeHtml(v.userAgent)}</td>
      <td class="ua">${escapeHtml(v.referrer || '')}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Admin - Góc Cờ</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 16px; background: #fafafa; color: #222; margin: 0; }
  h1 { font-size: 20px; } h2 { font-size: 17px; margin-top: 28px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 12px 14px; }
  .card b { display: block; font-size: 26px; }
  .card span { color: #666; font-size: 13px; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 13px; vertical-align: top; text-align: left; white-space: nowrap; }
  th { background: #f0f0f0; }
  tr:nth-child(even) { background: #f9f9f9; }
  td.n { text-align: right; font-weight: 600; }
  td.ua { white-space: normal; max-width: 360px; color: #555; font-size: 12px; }
</style>
</head>
<body>
<h1>Thống kê Góc Cờ</h1>
<div class="cards">
  <div class="card"><b>${summary.total}</b><span>Tổng lượt vào</span></div>
  <div class="card"><b>${summary.unique_ips}</b><span>IP khác nhau</span></div>
  <div class="card"><b>${summary.today}</b><span>Hôm nay</span></div>
  <div class="card"><b>${summary.week}</b><span>7 ngày qua</span></div>
</div>

<h2>Theo IP (${byIp.length})</h2>
<div class="wrap"><table>
  <thead><tr><th>IP</th><th>Lượt</th><th>Vị trí</th><th>Thiết bị</th><th>Lần đầu</th><th>Lần cuối</th></tr></thead>
  <tbody>${ipRows}</tbody>
</table></div>

<h2>300 lượt gần nhất</h2>
<div class="wrap"><table>
  <thead><tr><th>Thời gian</th><th>IP</th><th>Vị trí</th><th>Thiết bị</th><th>User Agent</th><th>Nguồn</th></tr></thead>
  <tbody>${recentRows}</tbody>
</table></div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
};
