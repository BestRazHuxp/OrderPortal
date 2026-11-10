const express = require('express');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream');
const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./database/database');
const OpenAI = require('openai');
const { loadSession, requireAuth, requirePageAuth, requireRole, getSessionHash, sessionCookieOptions } = require('./middleware/auth');

const app = express();
const port = process.env.PORT || 3000;
const deriveKey = promisify(scrypt);
const sessionDuration = 7 * 24 * 60 * 60 * 1000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

let openaiClient;

async function getProductSynonyms(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  const term = input.trim();
  if (!term) return [];
  if (term.length > 500) throw new RangeError('input must not exceed 500 characters');
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY in .env');

  openaiClient ||= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 20000,
    maxRetries: 1,
  });
  const response = await openaiClient.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    store: false,
    max_output_tokens: 600,
    instructions: `Bạn là chuyên viên phụ tùng xe đạp điện tại Việt Nam.

Nhiệm vụ: Tạo tối đa 5 truy vấn tìm kiếm để tìm sản phẩm
trong danh mục hàng hóa dựa trên tên khách hàng nhập.

Quy tắc:
- Giữ lại tên gốc và tạo thêm các biến thể tìm kiếm.
- Nhận diện tên viết tắt, tên gọi dân gian và thuật ngữ ngành.
- Ví dụ: "ắc quy" có thể được viết là "AQ".
- Ví dụ: "bộ xupai" có thể tìm bằng "ắc quy xupai",
  "AQ XUPAI" và "xupai".
- Tách các ghi chú nghiệp vụ như "trả bh", "đổi hàng"
  khỏi tên sản phẩm khi tạo từ khóa tìm kiếm.
- Có thể bỏ các từ chung chung để mở rộng tìm kiếm,
  nhưng phải giữ các tên riêng và thông số kỹ thuật.
- Không tự bịa thông số, kích thước, mã SKU hoặc thương hiệu.
- Không tạo các truy vấn chỉ đến loại sản phẩm khác.
- Nếu không chắc chắn, ưu tiên từ khóa ngắn hơn
  thay vì suy đoán thêm thuộc tính sản phẩm.
- Các truy vấn chỉ dùng để tìm ứng viên,
  không khẳng định sản phẩm tương đương hoàn toàn.`,
    input: [{ role: 'user', content: JSON.stringify({ product_name: term }) }],
    text: {
      format: {
        type: 'json_schema',
        name: 'product_synonyms',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            synonyms: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          },
          required: ['synonyms'],
          additionalProperties: false,
        },
      },
    },
  });
  if (response.status !== 'completed' || !response.output_text) {
    throw new Error('OpenAI did not return a complete synonym result');
  }
  const data = JSON.parse(response.output_text);
  if (!Array.isArray(data.synonyms) || data.synonyms.some((word) => typeof word !== 'string')) {
    throw new Error('Invalid synonym result from OpenAI');
  }
  const keyOf = (word) => word.normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ');
  const seen = new Set([keyOf(term)]);
  return data.synonyms.map((word) => word.trim()).filter((word) => {
    const key = keyOf(word);
    if (!word || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

// Match every search token, regardless of accents, case, order or separators.
// Numeric tokens remain exact numbers: 19 matches 19cm, but not 119 or 190.
async function queryProducts(search, limit = 30) {
  if (typeof search !== 'string') throw new TypeError('search must be a string');
  if (search.length > 500) throw new RangeError('search must not exceed 500 characters');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer from 1 to 100');
  }

  const normalized = search.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  // Separate letters and numbers so AQ24 and AQ 24 search the same way.
  const tokens = [...new Set(normalized.match(/[a-z]+|[0-9]+/g) || [])];
  if (!tokens.length) return [];

  const patterns = tokens.map((token) => /^\d+$/.test(token)
    ? `(^|[^0-9])${token}([^0-9]|$)`
    : token);
  const { rows } = await db.query(`
    WITH normalized_products AS (
      SELECT id, name,
        regexp_replace(
          replace(regexp_replace(normalize(lower(name), NFD), $2, '', 'g'), 'đ', 'd'),
          '[^a-z0-9]+', ' ', 'g'
        ) AS search_name
      FROM public.products
    )
    SELECT id, name
    FROM normalized_products p
    WHERE NOT EXISTS (
      SELECT 1 FROM unnest($1::text[]) AS term(pattern)
      WHERE p.search_name !~ term.pattern
    )
    ORDER BY
      (trim(search_name) = $3) DESC,
      (strpos(search_name, $3) > 0) DESC,
      length(search_name), id
    LIMIT $4
  `, [patterns, '[\u0300-\u036f]', tokens.join(' '), limit]);
  return rows;
}

const productAliases = [
  ['ac quy', 'aq'],
  ['lop xe', 'vo xe'],
  ['sam xe', 'ruot xe'],
];

function normalizeProductSearch(value) {
  return value.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
    .replace(/([a-z])([0-9])/g, '$1 $2').replace(/([0-9])([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

async function searchProducts(searchTerms) {
  if (!Array.isArray(searchTerms) || searchTerms.some((term) => typeof term !== 'string')) {
    throw new TypeError('searchTerms must be an array of strings');
  }
  if (searchTerms.length > 50 || searchTerms.some((term) => term.length > 500)) {
    throw new RangeError('Use at most 50 search terms, each up to 500 characters');
  }
  const seen = new Set();
  const terms = [];
  for (const raw of searchTerms) {
    const normalized = normalizeProductSearch(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const variants = new Set([normalized]);
    for (const aliases of productAliases) {
      for (const alias of aliases) {
        const pattern = new RegExp(`(^| )${alias}(?= |$)`, 'g');
        if (!pattern.test(normalized)) continue;
        for (const replacement of aliases) {
          variants.add(normalized.replace(pattern, (_, prefix) => prefix + replacement));
        }
      }
    }
    terms.push({ term: raw.trim(), variants: [...variants], numbers: normalized.match(/\d+/g) || [] });
  }
  if (!terms.length) return [];

  const { rows } = await db.query(`
    WITH search_input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS input(term text, variants text[], numbers text[])
    ), normalized_products AS MATERIALIZED (
      SELECT id, sku, name,
        trim(regexp_replace(
          regexp_replace(regexp_replace(
            replace(regexp_replace(normalize(lower(name), NFD), $2, '', 'g'), 'đ', 'd'),
            '([a-z])([0-9])', $3, 'g'), '([0-9])([a-z])', $3, 'g'),
          '[^a-z0-9]+', ' ', 'g')) AS search_name
      FROM public.products
    )
    SELECT input.term AS keyword, best.*
    FROM search_input input
    CROSS JOIN LATERAL (
      SELECT p.id, p.sku, p.name, max(scored.score) AS score
      FROM normalized_products p
      CROSS JOIN unnest(input.variants) AS variant(term)
      CROSS JOIN LATERAL (
        SELECT greatest(
          word_similarity(variant.term, p.search_name) * 0.85 +
            similarity(variant.term, p.search_name) * 0.15,
          CASE WHEN p.search_name = variant.term THEN 1.0
            WHEN p.search_name ILIKE '%' || variant.term || '%' THEN 0.92 ELSE 0 END
        ) AS score
      ) scored
      WHERE (word_similarity(variant.term, p.search_name) >= $4
        OR similarity(variant.term, p.search_name) >= $5
        OR p.search_name ILIKE '%' || variant.term || '%')
        AND NOT EXISTS (
          SELECT 1 FROM unnest(input.numbers) AS number(value)
          WHERE p.search_name !~ ('(^|[^0-9])' || number.value || '([^0-9]|$)')
        )
      GROUP BY p.id, p.sku, p.name
      ORDER BY score DESC, p.id
      LIMIT 10
    ) best
  `, [JSON.stringify(terms), '[\u0300-\u036f]', '\\1 \\2', 0.45, 0.25]);

  const merged = new Map();
  for (const row of rows) {
    const key = String(row.id);
    const existing = merged.get(key);
    if (existing) {
      existing.score = Math.max(existing.score, Number(row.score));
      if (!existing.matched_keywords.includes(row.keyword)) existing.matched_keywords.push(row.keyword);
    } else {
      merged.set(key, {
        id: row.id, sku: row.sku, name: row.name,
        score: Number(row.score), matched_keywords: [row.keyword],
      });
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score ||
    (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)).slice(0, 20);
}

app.get('/api/me', loadSession, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json(req.user || { user_id: null });
});

app.get('/api/products', loadSession, requireAuth, async (req, res) => {
  const { start_id, end_id } = req.query;
  const isId = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value));
  if (!isId(start_id) || !isId(end_id) || Number(start_id) > Number(end_id)) {
    return res.status(400).json({ message: 'start_id và end_id phải là số nguyên dương, start_id không lớn hơn end_id.' });
  }
  const [products, bounds] = await Promise.all([
    db.query('SELECT name FROM public.products WHERE id BETWEEN $1 AND $2 ORDER BY id', [start_id, end_id]),
    db.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM public.products'),
  ]);
  return res.json({
    products: products.rows,
    total_pages: Math.ceil(Number(bounds.rows[0].max_id) / 15),
  });
});

app.post('/api/orders/analyze', loadSession, requireAuth, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.some((item) =>
    !item || typeof item.product_name !== 'string' ||
    !item.product_name.trim() || item.product_name.length > 500)) {
    return res.status(400).json({ message: 'Vui lòng gửi danh sách items có tên sản phẩm hợp lệ.' });
  }
  console.dir({
    method: req.method,
    url: req.originalUrl,
    params: req.params,
    query: req.query,
    body: req.body,
  }, { depth: null });
  const results = [];
  for (const item of items) {
    let synonyms = [];
    let synonymsError;
    try {
      synonyms = await getProductSynonyms(item.product_name);
      console.log('Từ đồng nghĩa:', { product_name: item.product_name, synonyms });
    } catch (error) {
      synonymsError = 'Không thể lấy từ đồng nghĩa từ OpenAI.';
      console.log('Lỗi tìm từ đồng nghĩa:', {
        product_name: item.product_name,
        status: error.status || null,
        error_code: error.code || error.error?.code || null,
        message: error.error?.message || error.message || synonymsError,
      });
    }
    // Always search the original input, even if AI returns no synonyms or fails.
    const searchTerms = [...new Set([item.product_name.trim(), ...synonyms])];
    console.log('Từ khóa tìm kiếm (gồm tên ban đầu):', searchTerms);
    const matches = await searchProducts(searchTerms);
    results.push({
      product_name: item.product_name,
      quantity: item.quantity,
      note: item.note,
      synonyms,
      search_terms: searchTerms,
      ...(synonymsError ? { synonyms_error: synonymsError } : {}),
      matches,
    });
  }
  console.log('Kết quả tìm sản phẩm cho đơn hàng:');
  console.dir(results, { depth: null });
  return res.json({ message: 'Đã tìm sản phẩm và in kết quả ra console, chưa lưu đơn hàng.', results });
});

app.post('/api/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { user_name, password } = req.body || {};
  if (typeof user_name !== 'string' || !user_name.trim() || user_name.length > 255 ||
      typeof password !== 'string' || !password || password.length > 1024) {
    return res.status(400).json({ message: 'Vui lòng nhập tên đăng nhập và mật khẩu hợp lệ.' });
  }

  const { rows: [user] } = await db.query(
    'SELECT id, user_name, password_hash FROM "user" WHERE lower(user_name) = lower($1)',
    [user_name.trim()]
  );
  // Password hashes use scrypt$salt$hex (64-byte derived key).
  const parts = user ? user.password_hash.split('$') : [];
  const validHash = parts.length === 3 && parts[0] === 'scrypt' &&
    /^[a-f0-9]{32}$/i.test(parts[1]) && /^[a-f0-9]{128}$/i.test(parts[2]);
  const salt = validHash ? parts[1] : '00000000000000000000000000000000';
  const expected = validHash ? Buffer.from(parts[2], 'hex') : Buffer.alloc(64);
  const actual = await deriveKey(password, salt, 64);
  const matches = timingSafeEqual(actual, expected);
  if (!validHash || !matches) {
    return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
  }

  const sessionId = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(sessionId).digest('hex');
  const oldHash = getSessionHash(req);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO "session" (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, new Date(Date.now() + sessionDuration)]);
    if (oldHash) await client.query('DELETE FROM "session" WHERE token_hash = $1', [oldHash]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.cookie('session_id', sessionId, {
    ...sessionCookieOptions(req),
    maxAge: sessionDuration,
  });
  return res.json({ user_id: user.id, user_name: user.user_name });
});

app.post('/api/logout', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const tokenHash = getSessionHash(req);
  if (tokenHash) {
    await db.query('DELETE FROM "session" WHERE token_hash = $1', [tokenHash]);
  }
  res.clearCookie('session_id', sessionCookieOptions(req));
  return res.sendStatus(204);
});

app.get(['/', '/login', '/login.html'], (req, res, next) => {
  res.type('html');
  pipeline(
    createReadStream(path.join(__dirname, 'public', 'login.html')),
    res,
    (error) => {
      if (error) next(error);
    }
  );
});

app.get('/home.html', loadSession, requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/staff.html', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, loadSession, requirePageAuth, requireRole('staff'), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'staff.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((error, req, res, next) => {
  console.error('Request failed:', error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ message: 'Máy chủ gặp lỗi. Vui lòng thử lại.' });
});

async function start() {
  try {
    await db.initialize();
    app.listen(port, () => {
      console.log(`Server đang chạy tại http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Không thể khởi động PostgreSQL:', error.message);
    await db.end();
    process.exitCode = 1;
  }
}

if (require.main === module) start();
module.exports = app;
module.exports.queryProducts = queryProducts;
module.exports.searchProducts = searchProducts;
module.exports.getProductSynonyms = getProductSynonyms;
