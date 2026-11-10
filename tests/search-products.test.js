const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const db = require('../database/database');
const { searchProducts } = require('../server');

test('PostgreSQL fuzzy search: aliases, typos, deduplication and limits', async () => {
  let client;
  const originalQuery = db.query;
  try {
    await db.initialize();
    client = await db.connect();
    await client.query('BEGIN');
    db.query = (sql, values) => client.query(sql, values);
    const add = async (name) => {
      const sku = randomUUID();
      const { rows: [row] } = await client.query(
        'INSERT INTO products (sku, name) VALUES ($1, $2) RETURNING id, sku', [sku, name]);
      return row;
    };
    const battery = await add('AQ 987654');
    const wrongBattery = await add('AQ 9876540');
    const tire = await add('Lốp xe zqxspecial');
    const aliases = await searchProducts(['ắc quy 987654', 'AQ 987654']);
    const match = aliases.find((row) => row.id === battery.id);
    assert.ok(match);
    assert.equal(match.sku, battery.sku);
    assert.equal(match.name, 'AQ 987654');
    assert.ok(match.score > 0 && match.score <= 1);
    assert.deepEqual(match.matched_keywords, ['ắc quy 987654', 'AQ 987654']);
    assert.equal(aliases.filter((row) => row.id === battery.id).length, 1);
    assert.ok(!aliases.some((row) => row.id === wrongBattery.id));
    assert.ok((await searchProducts(['vỏ xe zqxspecial'])).some((row) => row.id === tire.id));
    assert.ok((await searchProducts(['lop xe zqxspecal'])).some((row) => row.id === tire.id));
    assert.equal((await searchProducts(['AQ987654']))[0].id, battery.id);

    for (const marker of ['987651', '987652', '987653']) {
      for (let i = 0; i < 12; i++) await add(`Testpart ${marker} type ${i}`);
      assert.equal((await searchProducts([`Testpart ${marker}`])).length, 10);
    }
    const combined = await searchProducts(['Testpart 987651', 'Testpart 987652', 'Testpart 987653']);
    assert.equal(combined.length, 20);
    assert.equal(new Set(combined.map((row) => row.id)).size, combined.length);
    assert.ok(combined.every((row, index) => index === 0 || combined[index - 1].score >= row.score));
    assert.deepEqual(await searchProducts([]), []);
    assert.deepEqual(await searchProducts(['  ', '%%%']), []);
    assert.deepEqual(await searchProducts(["'; DROP TABLE products; -- 987659999"]), []);
    await assert.rejects(searchProducts('AQ'), TypeError);
    await assert.rejects(searchProducts([null]), TypeError);
  } finally {
    db.query = originalQuery;
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await db.end();
  }
});
