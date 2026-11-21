// Auto-detects models installed in the local Ollama instance (the Linux VM).
// No hardcoded model is required; env vars are optional preferences only.
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const PREF_VISION = process.env.OLLAMA_MODEL || '';
const PREF_TEXT = process.env.OLLAMA_TEXT_MODEL || '';
const VISION_HINTS = /(vl|vision|llava|bakllava|moondream|minicpm-v|gemma3|llama4|pixtral|granite3\.2-vision|mistral-small3)/i;
const SKIP = /(embed|bge|nomic|minilm|rerank)/i; // embedding-only models can't chat

const capsCache = new Map();
async function capabilities(name) {
  if (capsCache.has(name)) return capsCache.get(name);
  let caps = null;
  try {
    const r = await fetch(`${OLLAMA}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(5000) });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d.capabilities)) caps = d.capabilities; }
  } catch {}
  capsCache.set(name, caps);
  return caps;
}

export async function isVision(name) {
  const caps = await capabilities(name);
  return caps ? caps.includes('vision') : VISION_HINTS.test(name);
}

export async function listModels() {
  const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw Error(`Ollama unavailable at ${OLLAMA}`);
  const models = ((await r.json()).models || [])
    .filter(m => !SKIP.test(m.name))
    .sort((a, b) => (b.size || 0) - (a.size || 0)); // prefer larger (usually more capable)
  const out = [];
  for (const m of models) out.push({ name: m.name, vision: await isVision(m.name) });
  return out;
}

// requested: 'auto' or a model name. needVision: images/PDF pages involved.
export async function pickModel(requested = 'auto', { needVision = false } = {}) {
  const models = await listModels();
  if (!models.length) throw Error('No chat model installed in Ollama on the VM');
  const names = models.map(m => m.name);
  if (requested && requested !== 'auto') {
    if (!names.includes(requested)) throw Error(`Model ${requested} is not installed`);
    if (needVision && !models.find(m => m.name === requested).vision) throw Error(`Model ${requested} cannot read images; choose a vision model or Auto`);
    return requested;
  }
  const vision = models.filter(m => m.vision).map(m => m.name);
  if (needVision) {
    if (PREF_VISION && vision.includes(PREF_VISION)) return PREF_VISION;
    if (vision.length) return vision[0];
    throw Error('No vision-capable model installed in Ollama (needed for images/PDFs)');
  }
  if (PREF_TEXT && names.includes(PREF_TEXT)) return PREF_TEXT;
  if (PREF_VISION && names.includes(PREF_VISION)) return PREF_VISION;
  return (models.find(m => !m.vision) || models[0]).name;
}
