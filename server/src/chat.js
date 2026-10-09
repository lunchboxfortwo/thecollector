// Conversational orchestrator for a text-only message in the chat log.
// The app sends free text here instead of re-running the image/appraisal path,
// so the user gets an answer about pricing, paintings or art, not a new read.

export function chatConfig() {
  const key = process.env.OPENROUTER_API_KEY || process.env.VISION_API_KEY;
  return {
    key,
    url: process.env.CHAT_API_URL || process.env.VISION_API_URL || 'https://openrouter.ai/api/v1/chat/completions',
    model: process.env.CHAT_MODEL || process.env.VISION_MODEL || 'google/gemini-3.5-flash',
  };
}

export function chatConfigured() {
  return Boolean(chatConfig().key);
}

const SYSTEM_PROMPT = `You are the appraiser behind The Collector, an art and collectible appraisal app.
Answer the user's question about this work and about pricing, paintings and art. Use the appraisal
context below when it is relevant. Rules:
- Answer the actual question in two to five short sentences.
- Never invent a price or a sale. If you state a value, use the range in the context.
- If there is no estimate yet, say what is still needed instead of guessing.
- If the user asks for a new or different estimate, tell them to send a photo, paste a link, or fill
  in the missing fields; do not restate the whole appraisal.
- Stay on pricing, paintings, art and this work. Politely decline anything else.`;

function contextBlock({ identity, value, confidence }) {
  const lines = [];
  if (identity && (identity.artist || identity.title)) {
    const bits = [identity.artist, identity.title, identity.year, identity.medium, identity.dimensions, identity.country]
      .filter(Boolean)
      .join(' · ');
    lines.push(`Identified work: ${bits}`);
  }
  if (value && Number.isFinite(value.low) && Number.isFinite(value.high)) {
    lines.push(`Current projected value: $${Math.round(value.low)} to $${Math.round(value.high)} ${value.currency || 'USD'}`);
  } else {
    lines.push('Current projected value: none yet (the work is not priced).');
  }
  if (confidence?.basis?.length) lines.push(`Basis: ${confidence.basis.join(' ')}`);
  return lines.join('\n');
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.text.slice(0, 2000) }));
}

// Deterministic answer used when no model key is configured. It stays truthful
// about what is known and always returns something the user can act on.
export function groundedAnswer({ message, identity, value }) {
  const hasValue = value && Number.isFinite(value.low) && Number.isFinite(value.high);
  const where = [identity?.artist, identity?.title].filter(Boolean).join(' — ');
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const ask = String(message || '').toLowerCase();
  const wantsOffer = /\boffer|bid|pay\b|how much|what.*worth/.test(ask);
  if (hasValue) {
    const line = `Right now ${where || 'this piece'} sits at ${money(value.low)}–${money(value.high)}.`;
    if (wantsOffer) {
      return `${line} ${money(value.low)} is the market floor I can defend from the recorded sales; offering at or just under the midpoint leaves room to negotiate. I can only tighten this further with more identifying detail or a clearer photo of the work.`;
    }
    return `${line} Ask me how the range was built, what medium or series sold near this, or what a fair offer looks like.`;
  }
  return `I don't have a price for this yet. Add the artist, year, size or medium (or send a clearer photo), and I'll price it from recorded auction sales.`;
}

export async function answerQuestion({ message, identity, value, confidence, history } = {}) {
  const cfg = chatConfig();
  if (!cfg.key) return { answer: groundedAnswer({ message, identity, value }), source: 'grounded' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.CHAT_TIMEOUT_MS || 30000));
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
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT}\n\nAppraisal context:\n${contextBlock({ identity, value, confidence })}` },
          ...cleanHistory(history),
          { role: 'user', content: String(message || '').slice(0, 4000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
    const json = await res.json();
    const answer = String(json?.choices?.[0]?.message?.content || '').trim();
    if (!answer) throw new Error('chat returned no answer');
    return { answer, source: 'model' };
  } catch (err) {
    return { answer: groundedAnswer({ message, identity, value }), source: 'grounded', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
