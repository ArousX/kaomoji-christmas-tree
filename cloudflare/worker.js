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

// 繁体字转简体映射（仅覆盖单字规范化，防止繁体变体绕过检测）
const TRAD_CHAR_MAP = {
  '習':'习','澤':'泽','東':'东','鄧':'邓','溫':'温','寶':'宝','強':'强','趙':'赵',
  '樂':'乐','際':'际','韓':'韩','華':'华','國':'国','黨':'党','產':'产','獨':'独',
  '臺':'台','灣':'湾','輪':'轮','聖':'圣','門':'门','廣':'广','場':'场','運':'运',
  '動':'动','滅':'灭','權':'权','專':'专','壓':'压','亂':'乱','學':'学','維':'维',
  '慶':'庆','豐':'丰','賴':'赖','陳':'陈','達':'达','時':'时','復':'复','訴':'诉',
  '團':'团','隊':'队','紀':'纪','網':'网','牆':'墙','萬':'万','歲':'岁','書':'书',
  '記':'记','軍':'军','辦':'办','號':'号','媽':'妈','馬':'马','賤':'贱','貨':'货',
  '殘':'残','廢':'废','滾':'滚','穢':'秽','姦':'奸','倫':'伦','愛':'爱','陰':'阴',
  '莖':'茎','雞':'鸡','龜':'龟','擼':'撸','賣':'卖','賭':'赌','證':'证','槍':'枪',
  '彈':'弹','藥':'药','襲':'袭','殺':'杀','惡':'恶','筆':'笔','寫':'写','進':'进',
  '這':'这','會':'会','體':'体','總':'总','領':'领','導':'导','歷':'历','風':'风',
  '義':'义','烏':'乌','魯':'鲁','齊':'齐','橋':'桥','載':'载','饑':'饥','躍':'跃',
  '豬':'猪','島':'岛','軟':'软','絡':'络','輝':'辉','鎔':'镕','濤':'涛','來':'来',
  '週':'周','喬':'乔','環':'环','嵐':'岚','吳':'吴','紅':'红','黃':'黄','長':'长',
  '羅':'罗','張':'张','聲':'声','劉':'刘','雲':'云','麗':'丽','戰':'战','楊':'杨',
  '葉':'叶','劍':'剑','陽':'阳','計':'计','劃':'划','勛':'勋','滬':'沪','寧':'宁',
  '鵬':'鹏','衛':'卫','漢':'汉'
};

function toSimplifiedChars(str) {
  let out = '';
  for (const ch of str) {
    out += TRAD_CHAR_MAP[ch] || ch;
  }
  return out;
}

// 不可逆 SHA-256 同步摘要（仅取前 16 位 hex，避免代码库中出现任何明文/可逆涉政关键词或姓名）
function syncDigest16(str) {
  const bytes = new TextEncoder().encode('kmj-safe::' + str);
  const words = [];
  for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  const bitLen = bytes.length * 8;
  words[bitLen >> 5] |= 0x80 << (24 - (bitLen % 32));
  words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const W = new Array(64);
  for (let i = 0; i < words.length; i += 16) {
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      if (t < 16) W[t] = words[i + t] | 0;
      else {
        const s0 = ((W[t-15]>>>7)|(W[t-15]<<25))^((W[t-15]>>>18)|(W[t-15]<<14))^(W[t-15]>>>3);
        const s1 = ((W[t-2]>>>17)|(W[t-2]<<15))^((W[t-2]>>>19)|(W[t-2]<<13))^(W[t-2]>>>10);
        W[t] = (W[t-16] + s0 + W[t-7] + s1) | 0;
      }
      const S1 = ((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = ((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  return ((H[0] >>> 0).toString(16).padStart(8, '0')) + ((H[1] >>> 0).toString(16).padStart(8, '0'));
}

const SAFE_HASH_LENS = [2, 3, 4, 5, 6, 7];
const SAFE_PHRASE_HASHES = new Set([
  '2b512111c3688537','d000496a55fb28b5','06a62a876e34d59b','93308a1d6135763e','0e960d49f6a54395','fe873197931c8121','adcd37d45398ede1','06a34e08bc624ff4','71268206eee08728','836cac794fdb0a10',
  'c5adf430718cc494','3c14096dbc488c3b','ffbd5adb8a85964e','aca50ec2a39327ef','2ebc5bdedb180247','31651674e0c9843a','933a90d86f9d82c5','57f3ee2b6766ffcf','7a88088252f37b00','cd8e7dcacb04dd61',
  '66b9d76bf363f9af','a147c76471ca1728','69005fc6c796a1ce','ea461e5313e09f2d','e8636410ccd37d0b','7e0be69575bf6e11','49b4e2d29fffee1b','fbeb23fa43615b14','5bdb0f39bd7e23d0','d4f9af89a2e7d20e',
  '52b7efbe0185fc1c','d079e7df67821390','f6fb506a616c8db0','fae7ea91a6b493bf','1d23df9214325356','0c70a693838c3ec0','568407a8806ee291','7330e47406173820','71de99a9a5053138','a12f8beea2e23284',
  '1462b88a675347f9','e7e558aa2e43f8f3','545f4f3a9dac4ba5','6b93d01ed0a2f256','0435bd67aeedc987','a098af0e40604ea3','eb5b5b401f264284','07ee77d9d9dc6c5f','7c460dea86ef28cb','b642339df7946302',
  '04d85be2f4b881d8','48de8f7447a2a74d','3ce1881fef1f75d1','e54ceb9a7908f0ed','6973038d59ddf088','485857e2e799eb95','a2a3ac9a39821679','8f27949a201cff54','ac17a4ac36bf5dd8','35cf09c984c11a9b',
  'e5ab580412d8598c','e5bfd9effce45ab9','78d0963b796fce3c','b4599be314fdec74','3e3db7c65cff4c87','6d06ba6fd7ff9333','b06a4004227a931d','02f5a56358b4fbcd','e476c11a1aba24ee','2b3814b148504fa5',
  '283c6b8e6111887d','e8e709749b31dcea','fe5822d9fed7b049','8fc895dfcad98159','dd3df5fedd67f4c1','a16b5e4bd4d393e7','e9263fe0da5941ed','b7dfe9c346993d5a','9cf747a2a41af158','a8b10d537bcf765f',
  'b7e4a73e92c44711','426a82ad010cd582','5121773e9e99fd2c','7855592b2b3de25a','3f690f5a78b2b212','51b9aca7987be28d','56b70009f6d47c94','29278eedbf873979','aad29703868eac1a','53588062394239b2',
  '3495d4c9fee62c0e','7ddc09cf6e064754','42a6583a88af1039','9320ffa8cb706a62','e0f6af8ac3abbb23','295f1b5bc9f4b42f','ab1287705eede65b','48f7bb2ef4956b23','6f287bde7ad46f87','898cc64b3dac814f',
  '8e18bdfcb4b4a043','9697875a6a6b126a','5890f2f9bef1b6ac','46c5f8f442d1184e','75ae2fa50a1553df','7f7830ba45d13141','a3912492661a1cdb','87580075640ee7f2','1463648a04feb667','ddfe8a9f1abdeeb7',
  '0875baaca95ce228','aeff3067fa234134','8b208ef042e6e59d','ec64c9be0631bad4','26b083c63132644d','aa0dc7311c687d95','c0534e1cab9863bd','9287220b40031c8c','946ad2f42e34cdff','7bd585f6e32223df',
  '3656c6826c10e2c7','3d347031805ad014','e2262925490f2679','a8d9cef9d10d16af','38c63860d3fe3635','d3d914b7e86308c7','34e7b4aa54ec0eb6','cd59c5cb1e4e3714','37133060c625c999','d10b15398667684e',
  'fea6c917bd6bde28','e57c84955a65c216','97c2f657dfcd1096','ce924ed95c17c4c1','51c811a3b731c454','1fa3e7f5ec459833','19fac53f5a7e2cc3','93b69e027e1ce730'
]);
const SAFE_ASCII_HASHES = new Set([
  '8a632e9ba068b03b','56b3156f3344921c','f6d6dbe5e289378c','e079e9dafba38a5f',
  'b9535faeff56da1c','ea3ba84d63819897','9ae8883bc51ce23e','a58486a5ac9217c7'
]);

function matchesSafeHash(nfkc, compact) {
  const chars = Array.from(compact);
  for (const len of SAFE_HASH_LENS) {
    if (chars.length < len) continue;
    for (let i = 0; i <= chars.length - len; i++) {
      if (SAFE_PHRASE_HASHES.has(syncDigest16(chars.slice(i, i + len).join('')))) return true;
    }
  }
  const tokens = nfkc.match(/[a-z]{2,8}/g);
  if (tokens) {
    for (const tok of tokens) {
      if (SAFE_ASCII_HASHES.has(syncDigest16(tok))) return true;
    }
  }
  return false;
}

// 粗口辱骂、低俗违禁与外链广告拦截
const BLOCKED_ZH_PHRASES = [
  '傻逼', '煞笔', '沙比', '傻比', '傻屄', '妈逼', '草泥马', '操你妈', '肏你妈',
  '操你', '肏你', '日你妈', '去死吧', '去死', '死全家', '死妈', '他妈的', '她妈的',
  '王八蛋', '狗娘养', '婊子', '贱人', '贱货', '畜生', '脑残', '智障', '滚蛋',
  '我操', '卧槽', '狗屎', '废物东西',
  '色情', '淫秽', '裸聊', '约炮', '强奸', '轮奸', '乱伦', '做爱', '性交',
  '口交', '肛交', '阴茎', '阴道', '鸡巴', '鸡吧', '龟头', '射精', '精液',
  '自慰', '撸管', '嫖娼', '卖淫', '援交', 'av女优',
  '赌博', '博彩', '六合彩', '时时彩', '网赌', '冰毒', '海洛因', '大麻',
  '摇头丸', '代孕', '办假证', '枪支弹药', '制造炸药', '恐怖袭击', '自杀教学',
  '加微信', '微信号', '加qq'
];

const BLOCKED_EN_PATTERNS = [
  /(?:^|[^a-z])f[\W_]*u[\W_]*c[\W_]*k(?:$|[^a-z])/i,
  /(?:^|[^a-z])f[\W_]*c[\W_]*k(?:$|[^a-z])/i,
  /(?:^|[^a-z])s[\W_]*h[\W_]*i[\W_]*t(?:$|[^a-z])/i,
  /(?:^|[^a-z])b[\W_]*i[\W_]*t[\W_]*c[\W_]*h(?:$|[^a-z])/i,
  /(?:^|[^a-z])a[\W_]*s[\W_]*s[\W_]*h[\W_]*o[\W_]*l[\W_]*e(?:$|[^a-z])/i,
  /(?:^|[^a-z])w[\W_]*h[\W_]*o[\W_]*r[\W_]*e(?:$|[^a-z])/i,
  /(?:^|[^a-z])c[\W_]*u[\W_]*n[\W_]*t(?:$|[^a-z])/i,
  /(?:^|[^a-z])s[\W_]*l[\W_]*u[\W_]*t(?:$|[^a-z])/i,
  /(?:^|[^a-z])d[\W_]*i[\W_]*c[\W_]*k(?:$|[^a-z])/i,
  /(?:^|[^a-z])p[\W_]*u[\W_]*s[\W_]*s[\W_]*y(?:$|[^a-z])/i,
  /(?:^|[^a-z])p[\W_]*o[\W_]*r[\W_]*n(?:$|[^a-z])/i,
  /(?:^|[^a-z])n[\W_]*a[\W_]*z[\W_]*i(?:$|[^a-z])/i,
  /(?:^|[^a-z])c[\W_]*n[\W_]*m(?:$|[^a-z])/i,
  /(?:^|[^a-z])n[\W_]*m[\W_]*s[\W_]*l(?:$|[^a-z])/i,
  /(?:^|[^a-z])w[\W_]*c[\W_]*n[\W_]*m(?:$|[^a-z])/i,
  /(?:^|[^a-z])q[\W_]*n[\W_]*m[\W_]*d(?:$|[^a-z])/i,
  /(?:^|[^a-z])t[\W_]*m[\W_]*d(?:$|[^a-z])/i,
  /(?:^|[^a-z])m[\W_]*l[\W_]*g[\W_]*b(?:$|[^a-z])/i,
  /(?:^|[^a-z])m[\W_]*m[\W_]*p(?:$|[^a-z])/i,
  /(?:^|[^a-z])s(?:[^a-z0-9\s]{1,2})?b(?:$|[^a-z])/i,
  /(?:^|[^a-z])j8(?:$|[^a-z0-9])/i,
  /(?:^|[^0-9])(?:89[\W_]*64|64[\W_]*89)(?:$|[^0-9])/,
  /https?:\/\/|www\.[a-z0-9-]+/i
];

function normalizeForFilter(raw) {
  const nfkc = toSimplifiedChars(
    String(raw || '').normalize('NFKC').toLowerCase()
      .replace(/[\u200B-\u200F\uFEFF\u00AD]/g, '')
  );
  // 去掉汉字间常见插空与符号干扰
  const compact = nfkc.replace(/[\s~`!@#$%^&*()\-_=+[\]{}|\\;:'",.<>/?·•￥…—]+/g, '');
  return { nfkc, compact };
}

function findSensitiveMatch(text, extraWordsRaw = '') {
  if (!text) return null;
  const { nfkc, compact } = normalizeForFilter(text);
  for (const word of BLOCKED_ZH_PHRASES) {
    if (compact.includes(word)) return word;
  }
  if (matchesSafeHash(nfkc, compact)) return 'restricted';
  if (extraWordsRaw) {
    const extras = String(extraWordsRaw).split(/[\r\n,，]+/).map((w) => w.trim()).filter(Boolean);
    for (const rawWord of extras) {
      const { compact: cw, nfkc: nw } = normalizeForFilter(rawWord);
      if ((cw && compact.includes(cw)) || (nw && nfkc.includes(nw))) return rawWord;
    }
  }
  for (const re of BLOCKED_EN_PATTERNS) {
    if (re.test(nfkc)) return 'inappropriate';
  }
  return null;
}

function validateCardFieldsClean(fields, extraWordsRaw = '') {
  for (const [label, value] of fields) {
    if (findSensitiveMatch(value, extraWordsRaw)) {
      return `${label}包含敏感或不当词汇，请修改后再挂上树哦~`;
    }
  }
  return null;
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

      const violation = validateCardFieldsClean([
        ['标题', title],
        ['祝福语', message],
        ['署名', sign],
        ['颜文字印章', kaomoji]
      ], env.BLOCKED_WORDS || '');
      if (violation) {
        return jsonResponse({ error: violation }, 400, env);
      }

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
