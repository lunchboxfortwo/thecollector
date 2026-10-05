import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyFromImage } from '../src/vision.js';

function withEnv(values, fn) {
  const saved = {};
  const managed = ['OPENROUTER_API_KEY', 'VISION_API_KEY', 'VISION_API_URL', 'VISION_MODEL'];
  for (const key of managed) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of managed) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('identifyFromImage maps country and provenance from the model reply', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              artist: 'Yayoi Kusama',
              title: 'Pumpkin',
              medium: 'acrylic on canvas',
              dimensions: '60 x 60 cm',
              year: '2015',
              country: 'Japan',
              provenance: 'Private collection, Tokyo.',
              edition: null,
              confidence: 0.86,
            }),
          },
        },
      ],
    }),
  });
  try {
    const result = await withEnv(
      { OPENROUTER_API_KEY: 'test-key', VISION_API_URL: 'http://vision.test/chat' },
      () => identifyFromImage({ imageBase64: 'AAAA', mimeType: 'image/jpeg' }),
    );
    assert.equal(result.identified, true);
    assert.equal(result.artist, 'Yayoi Kusama');
    assert.equal(result.country, 'Japan');
    assert.equal(result.provenance, 'Private collection, Tokyo.');
    assert.equal(result.match_confidence, 0.86);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('identifyFromImage reports failure when the model returns no usable field', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"artist":null,"confidence":0.1}' } }] }),
    };
  };
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: 'test-key' }, () =>
      identifyFromImage({ imageBase64: 'AAAA' }),
    );
    assert.equal(called, 1);
    assert.equal(result.identified, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('identifyFromImage without a key never calls the model', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    throw new Error('should not be called');
  };
  try {
    const result = await withEnv({}, () => identifyFromImage({ imageBase64: 'AAAA' }));
    assert.equal(called, 0);
    assert.equal(result.identified, false);
    assert.match(result.reason, /no vision key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
