// Optional multimodal identification. Without a key the endpoint still works and
// returns `needs_details`; with a key it asks a vision model for structured attributes.

export function visionConfig() {
  const key = process.env.OPENROUTER_API_KEY || process.env.VISION_API_KEY;
  return {
    key,
    url: process.env.VISION_API_URL || 'https://openrouter.ai/api/v1/chat/completions',
    model: process.env.VISION_MODEL || 'openai/gpt-4o-mini',
  };
}

export function visionConfigured() {
  return Boolean(visionConfig().key);
}

function clean(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'unknown' || s.toLowerCase() === 'n/a') return null;
  return s;
}

const PROMPT = (note) => `You are an art and collectible cataloguer. Identify the single work shown in the image.
Reply with ONLY minified JSON, no markdown fences:
{"artist":string|null,"title":string|null,"medium":string|null,"dimensions":string|null,"year":string|null,"country":string|null,"edition":string|null,"confidence":number}
Use null for any field you cannot determine. "confidence" is 0..1.
Additional information from the user (may be empty): ${note || '(none)'}`;

export async function identifyFromImage({ imageBase64, mimeType, imageUrl, note } = {}) {
  const cfg = visionConfig();
  if (!cfg.key) return { identified: false, reason: 'no vision key configured' };

  let imagePart = null;
  if (imageUrl) {
    imagePart = { type: 'image_url', image_url: { url: imageUrl } };
  } else if (imageBase64) {
    imagePart = {
      type: 'image_url',
      image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` },
    };
  }
  if (!imagePart) return { identified: false, reason: 'no image supplied' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.VISION_TIMEOUT_MS || 30000));
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT(note) }, imagePart] }],
      }),
    });
    if (!res.ok) return { identified: false, reason: `vision HTTP ${res.status}` };
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(String(text).replace(/```(?:json)?/gi, '').trim());
    const artist = clean(parsed.artist);
    const title = clean(parsed.title);
    if (!artist && !title) {
      return { identified: false, reason: 'model returned no identity', raw: parsed };
    }
    return {
      identified: true,
      method: 'vision',
      artist,
      title,
      medium: clean(parsed.medium),
      dimensions: clean(parsed.dimensions),
      year: clean(parsed.year),
      country: clean(parsed.country),
      edition: clean(parsed.edition),
      match_confidence: Number(parsed.confidence) || 0.5,
    };
  } catch (err) {
    return { identified: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}
