// Ollama model discovery and calls. No model names are hardcoded: models are discovered with
// /api/tags, capabilities come from /api/show, and the already-loaded model (/api/ps) is preferred
// so a second large model is not loaded unnecessarily. Env vars are optional preferences only.
const OLLAMA = () => process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const PREF_VISION = () => process.env.OLLAMA_MODEL && process.env.OLLAMA_MODEL !== 'auto' ? process.env.OLLAMA_MODEL : '';
const PREF_TEXT = () => process.env.OLLAMA_TEXT_MODEL || '';

let fetchImpl = (...a) => globalThis.fetch(...a);
const capsCache = new Map();
/** Test hook: replace fetch (and clear capability cache). */
export function _setFetch(f) { fetchImpl = f || ((...a) => globalThis.fetch(...a)); capsCache.clear(); }

function capsFromShow(d) {
  if (Array.isArray(d.capabilities) && d.capabilities.length) return d.capabilities;
  // Older Ollama versions: infer from metadata, never from the model name.
  const info = d.model_info || {};
  if (/bert/i.test(String(info['general.architecture'] || ''))) return ['embedding'];
  const caps = ['completion'];
  if (d.projector_info || Object.keys(info).some(k => /\.vision\./.test(k)) || (d.details?.families || []).includes('clip')) caps.push('vision');
  return caps;
}

async function capabilities(name, digest = '') {
  const key = `${name}@${digest}`;
  if (capsCache.has(key)) return capsCache.get(key);
  let caps = ['completion'];
  try {
    const r = await fetchImpl(`${OLLAMA()}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(10000) });
    if (r.ok) caps = capsFromShow(await r.json());
  } catch {}
  capsCache.set(key, caps);
  return caps;
}

export async function isVision(name) { return (await capabilities(name)).includes('vision'); }

export async function listModels() {
  let r;
  try { r = await fetchImpl(`${OLLAMA()}/api/tags`, { signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw Error(`Ollama is not reachable at ${OLLAMA()} (${e.message})`); }
  if (!r.ok) throw Error(`Ollama unavailable at ${OLLAMA()} (HTTP ${r.status})`);
  const tags = ((await r.json()).models || []).sort((a, b) => (b.size || 0) - (a.size || 0));
  const out = [];
  for (const m of tags) {
    const caps = await capabilities(m.name, m.digest);
    if (!caps.includes('completion') && !caps.includes('vision')) continue; // embedding-only etc.
    out.push({ name: m.name, size: m.size || 0, vision: caps.includes('vision'), capabilities: caps });
  }
  return out;
}

async function loadedModels() {
  try {
    const r = await fetchImpl(`${OLLAMA()}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    return ((await r.json()).models || []).map(m => m.name || m.model);
  } catch { return []; }
}

/**
 * requested: 'auto' or an installed model name.
 * needVision: images / scanned pages.
 * prefer: a model already used in this job (reused to avoid loading a second model).
 */
export async function pickModel(requested = 'auto', { needVision = false, prefer = '' } = {}) {
  const models = await listModels();
  if (!models.length) throw Error('No chat-capable model is installed in Ollama. Install one with `ollama pull <model>`.');
  const byName = new Map(models.map(m => [m.name, m]));
  const ok = name => byName.has(name) && (!needVision || byName.get(name).vision);
  if (requested && requested !== 'auto') {
    if (!byName.has(requested)) throw Error(`Model "${requested}" is not installed in Ollama. Choose Auto or another installed model.`);
    if (needVision && !byName.get(requested).vision) throw Error(`Model "${requested}" cannot read images or scanned pages. Choose Auto or a vision-capable model.`);
    return requested;
  }
  if (prefer && ok(prefer)) return prefer;
  const envPref = needVision ? PREF_VISION() : (PREF_TEXT() || PREF_VISION());
  if (envPref && ok(envPref)) return envPref;
  const loaded = (await loadedModels()).find(ok);
  if (loaded) return loaded;
  if (needVision) {
    const v = models.find(m => m.vision);
    if (!v) throw Error('No vision-capable model is installed in Ollama, but this file needs OCR (image or scanned PDF page). Install a vision model, or upload a text-based PDF.');
    return v.name;
  }
  // Text: a vision model also handles text; prefer the largest installed model overall so only one model is needed.
  return models[0].name;
}

/**
 * Streaming chat call. Streaming avoids fetch's ~5 minute header timeout on slow CPU inference,
 * so long-running requests are not cut off. Returns the full text.
 */
export async function chat(model, messages, { format, tokens = 2048, ctx = 8192, temperature = 0, signal, onToken } = {}) {
  const body = { model, messages, stream: true, think: false, options: { num_ctx: ctx, num_predict: tokens, temperature } };
  if (format) body.format = format;
  const r = await fetchImpl(`${OLLAMA()}/api/chat`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw Error(`Ollama returned ${r.status}: ${(await r.text()).slice(0, 300)}`);
  if (!r.body?.getReader) { // non-streaming mocks
    const d = await r.json(); return d.message?.content || '';
  }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', text = '', truncated = false;
  const handle = line => {
    if (!line.trim()) return; const part = JSON.parse(line);
    if (part.error) throw Error(`Ollama: ${part.error}`);
    if (part.message?.content) { text += part.message.content; onToken?.(part.message.content); }
    if (part.done && part.done_reason === 'length') truncated = true;
  };
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop();
    lines.forEach(handle);
  }
  handle(buf + dec.decode());
  if (truncated) throw Error(`Model output hit the ${tokens}-token limit; the result would be incomplete. Process smaller files or fewer pages.`);
  return text;
}

export function parseJSON(text) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/); const s = m ? m[1] : String(text);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw Error('AI did not return JSON');
  return JSON.parse(s.slice(a, b + 1));
}
