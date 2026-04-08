const test = require('node:test');
const assert = require('node:assert/strict');
const jiti = require('jiti')(__filename, { interopDefault: true });
const { AuthStorage, ModelRegistry } = jiti('@mariozechner/pi-coding-agent');

const mod = jiti('../index.ts');
const t = mod.__testables;

const query = process.env.PI_SEARCH_LIVE_QUERY || 'Tencent stock';

async function getLiveAuth() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  return t.resolveAuth({ modelRegistry });
}

test('openaiWebSearch returns live results for a real query', async (ctx) => {
  const auth = await getLiveAuth();

  if (!auth) {
    ctx.skip('No OpenAI/OpenAI Codex auth available from pi model registry or environment');
    return;
  }

  const results = await t.openaiWebSearch(query, auth.model, auth.apiKey);

  assert.ok(Array.isArray(results), 'expected results array');
  assert.ok(results.length > 0, `expected at least one result for query: ${query}`);

  for (const result of results) {
    assert.equal(typeof result.title, 'string');
    assert.equal(typeof result.url, 'string');
    assert.equal(typeof result.snippet, 'string');
    assert.ok(result.url.startsWith('http'), `expected http url, got: ${result.url}`);
  }
});
