const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual route handler without making paid AI calls.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf("app.post('/api/orders/analyze'");
const end = source.indexOf("app.post('/api/login'", start);

for (const scenario of ['synonyms', 'empty', 'error']) {
  test(`order analysis searches original input when AI returns ${scenario}`, async () => {
    let handler;
    let searched;
    let response;
    vm.runInNewContext(source.slice(start, end), {
      app: { post: (...args) => { handler = args.at(-1); } },
      loadSession() {}, requireAuth() {},
      console: { log() {}, dir() {} },
      getProductSynonyms: async () => {
        if (scenario === 'error') throw { status: 429, code: 'rate_limit', message: 'test' };
        return scenario === 'synonyms' ? ['vỏ xe'] : [];
      },
      searchProducts: async (terms) => {
        searched = Array.from(terms);
        return [{ id: '1', name: 'Lốp xe', matched_keywords: [terms[0]] }];
      },
    });
    await handler({ body: { items: [{ product_name: ' lốp xe ', quantity: 2, note: '' }] } }, {
      json: (body) => { response = body; },
      status: () => { throw new Error('Unexpected validation error'); },
    });
    assert.deepEqual(searched, scenario === 'synonyms' ? ['lốp xe', 'vỏ xe'] : ['lốp xe']);
    assert.deepEqual(Array.from(response.results[0].search_terms), searched);
    assert.equal(response.results[0].matches[0].name, 'Lốp xe');
    assert.equal(Boolean(response.results[0].synonyms_error), scenario === 'error');
  });
}
