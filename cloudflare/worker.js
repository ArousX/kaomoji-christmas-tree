/**
 * Cloudflare Workers + D1 共享圣诞树贺卡后端
 * - 零外部依赖，直接复制粘贴到 Cloudflare Dashboard 或通过 Wrangler 部署即可
 * - 首次请求自动建表，无需手动执行 SQL 迁移
 */

const VALID_STYLES = new Set(['gift', 'heart', 'star', 'snow']);
let schemaPromise = null;

function corsHeaders(env) {
  const origin = (env && env.ALLOWED_ORIGIN) ? env.ALLOWED_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Owner-Token, X-Admin-Key',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(data, status = 200, env = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(env)
    }
  });
}

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(String(text || ''));
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          kaomoji TEXT NOT NULL,
          style TEXT NOT NULL,
          message TEXT NOT NULL,
          sign TEXT NOT NULL,
          owner_hash TEXT NOT NULL,
          ip_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`
      ).run();
      await db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards (created_at DESC)'
      ).run();
      await db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_cards_ip_time ON cards (ip_hash, created_at DESC)'
      ).run();
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

function clampStr(val, maxLen, fallback = '') {
  const s = String(val == null ? '' : val).trim();
  if (!s) return fallback;
  return Array.from(s).slice(0, maxLen).join('');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (!env || !env.DB) {
      return jsonResponse({ error: '未绑定 D1 数据库 (binding name 必须为 DB)' }, 500, env);
    }

    try {
      await ensureSchema(env.DB);
    } catch (err) {
      return jsonResponse({ error: '数据库初始化失败: ' + err.message }, 500, env);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // 1. 健康检查
    if (request.method === 'GET' && (path === '/' || path === '/api/health')) {
      const row = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM cards').first();
      return jsonResponse({ ok: true, service: 'kaomoji-xmas-cards', count: row ? row.cnt : 0 }, 200, env);
    }

    // 2. 获取全网共享贺卡列表
    if (request.method === 'GET' && path === '/api/cards') {
      const limitParam = parseInt(url.searchParams.get('limit') || '80', 10);
      const limit = Math.max(1, Math.min(120, isNaN(limitParam) ? 80 : limitParam));

      const { results } = await env.DB.prepare(
        'SELECT id, title, kaomoji, style, message, sign, created_at FROM cards ORDER BY created_at DESC LIMIT ?'
      ).bind(limit).all();

      const cards = (results || []).map((r) => ({
        id: r.id,
        title: r.title,
        kaomoji: r.kaomoji,
        style: r.style,
        message: r.message,
        sign: r.sign,
        createdAt: r.created_at,
        custom: true
      }));

      return jsonResponse({ ok: true, cards }, 200, env);
    }

    // 3. 写入一张新贺卡挂上树
    if (request.method === 'POST' && path === '/api/cards') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: '请求体必须是有效的 JSON' }, 400, env);
      }

      const message = clampStr(body.message, 200, '');
      if (!message) {
        return jsonResponse({ error: '祝福语内容不能为空' }, 400, env);
      }

      const title = clampStr(body.title, 24, '我的圣诞心愿');
      const kaomoji = clampStr(body.kaomoji, 24, '(=^•ω•^=) ♡');
      const style = VALID_STYLES.has(body.style) ? body.style : 'gift';
      const sign = clampStr(body.sign, 20, '路过的圣诞老人');
      const ownerToken = clampStr(body.ownerToken, 80, '');

      const now = Date.now();
      const clientIp = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
      const ipHash = await sha256Hex(clientIp + '::xmas-salt');
      const ownerHash = ownerToken ? await sha256Hex(ownerToken + '::owner') : 'anon';

      // 防刷屏冷却：同一 IP 10 秒内最多挂 1 张贺卡
      const recent = await env.DB.prepare(
        'SELECT created_at FROM cards WHERE ip_hash = ? ORDER BY created_at DESC LIMIT 1'
      ).bind(ipHash).first();
      if (recent && now - recent.created_at < 10000) {
        const waitSec = Math.ceil((10000 - (now - recent.created_at)) / 1000);
        return jsonResponse({ error: `写得太快啦，请 ${waitSec} 秒后再挂下一张吧~` }, 429, env);
      }

      const id = 'cf-' + now.toString(36) + '-' + crypto.randomUUID().slice(0, 8);
      await env.DB.prepare(
        `INSERT INTO cards (id, title, kaomoji, style, message, sign, owner_hash, ip_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, title, kaomoji, style, message, sign, ownerHash, ipHash, now).run();

      return jsonResponse({
        ok: true,
        card: {
          id,
          title,
          kaomoji,
          style,
          message,
          sign,
          createdAt: now,
          custom: true,
          mine: true
        }
      }, 201, env);
    }

    // 4. 摘下贺卡（仅限原作者本机凭证或管理员密钥）
    if (request.method === 'DELETE' && path.startsWith('/api/cards/')) {
      const cardId = decodeURIComponent(path.slice('/api/cards/'.length)).trim();
      if (!cardId) {
        return jsonResponse({ error: '缺少贺卡 ID' }, 400, env);
      }

      const ownerToken = request.headers.get('X-Owner-Token') || url.searchParams.get('ownerToken') || '';
      const adminKey = request.headers.get('X-Admin-Key') || '';
      const isAdmin = Boolean(env.ADMIN_KEY && adminKey && adminKey === env.ADMIN_KEY);

      if (isAdmin) {
        await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(cardId).run();
        return jsonResponse({ ok: true }, 200, env);
      }

      if (!ownerToken) {
        return jsonResponse({ error: '只有写下这张贺卡的作者才能摘下它哦' }, 403, env);
      }

      const ownerHash = await sha256Hex(ownerToken + '::owner');
      const res = await env.DB.prepare(
        'DELETE FROM cards WHERE id = ? AND owner_hash = ?'
      ).bind(cardId, ownerHash).run();

      if (!res.meta || res.meta.changes === 0) {
        return jsonResponse({ error: '无权摘下他人挂上的贺卡，或贺卡已不存在' }, 403, env);
      }

      return jsonResponse({ ok: true }, 200, env);
    }

    return jsonResponse({ error: 'Not Found' }, 404, env);
  }
};
