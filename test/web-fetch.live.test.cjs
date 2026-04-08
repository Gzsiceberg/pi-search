const test = require('node:test');
const assert = require('node:assert/strict');
const jiti = require('jiti')(__filename, { interopDefault: true });
const { AuthStorage, ModelRegistry } = jiti('@mariozechner/pi-coding-agent');

const mod = jiti('../index.ts');
const t = mod.__testables;

const query = process.env.PI_SEARCH_LIVE_FETCH_QUERY || 'OpenAI Wikipedia';

function makePiStub() {
  const tools = [];
  return {
    pi: {
      on() {},
      registerTool(tool) {
        tools.push(tool);
      },
    },
    tools,
  };
}

async function getLiveAuth() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  return t.resolveAuth({ modelRegistry });
}

function pickFetchableResult(results) {
  return (
    results.find((r) => /wikipedia\.org\/wiki\//i.test(r.url)) ||
    results.find((r) => /^https?:\/\//i.test(r.url) && !/\.(pdf|xml|json|txt)(?:[?#].*)?$/i.test(r.url)) ||
    results[0]
  );
}

test('web_fetch can fetch and parse a URL returned by web_search', async (ctx) => {
  const auth = await getLiveAuth();

  if (!auth) {
    ctx.skip('No OpenAI/OpenAI Codex auth available from pi model registry or environment');
    return;
  }

  const searchResults = await t.openaiWebSearch(query, auth.model, auth.apiKey);
  assert.ok(searchResults.length > 0, `expected at least one search result for query: ${query}`);

  const picked = pickFetchableResult(searchResults);
  assert.ok(picked, 'expected a search result to fetch');
  assert.match(picked.url, /^https?:\/\//, `expected http url, got: ${picked.url}`);

  const { pi, tools } = makePiStub();
  mod.default(pi);

  const webFetch = tools.find((tool) => tool.name === 'web_fetch');
  assert.ok(webFetch, 'expected web_fetch tool to be registered');

  const updates = [];
  const result = await webFetch.execute(
    'test-web-fetch',
    { url: picked.url },
    undefined,
    (update) => updates.push(update),
    {},
  );

  assert.ok(updates.length > 0, 'expected at least one progress update from web_fetch');
  assert.ok(result, 'expected tool result');
  assert.ok(Array.isArray(result.content), 'expected content array');
  assert.equal(result.content[0]?.type, 'text');

  const text = result.content[0]?.text || '';
  assert.ok(text.includes(`Source: ${picked.url}`), 'expected output to include fetched source URL');
  assert.match(text, /Extraction:\s+(static\+readability|playwright\+readability|static-raw|playwright-raw)/);
  assert.ok(text.length > 200, 'expected substantial fetched output');

  assert.ok(result.details, 'expected fetch details');
  assert.equal(result.details.url, picked.url);
  assert.equal(typeof result.details.title, 'string');
  assert.ok(result.details.title.length > 0, 'expected parsed title');
  assert.equal(typeof result.details.linkCount, 'number');
  assert.ok(result.details.method.length > 0, 'expected extraction method');

  const normalizedTitle = result.details.title.toLowerCase();
  assert.ok(
    normalizedTitle.includes('openai') || normalizedTitle.includes('wikipedia') || text.toLowerCase().includes(normalizedTitle),
    `expected parsed content/title to look related to the fetched page: ${result.details.title}`,
  );
});
