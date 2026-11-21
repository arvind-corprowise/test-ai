// Document extraction with persistent, hash-keyed caching.
// PDFs: digital text via `pdftotext -layout` per page; only pages without usable text (or that are
// mostly a scanned image) are rendered and OCR'd with a vision model. Mixed PDFs are handled per page.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pdfPageCount, pdfPageTexts, pdfPageWords, pdfImagePages, renderPage, visionExtract, OCR_PROMPT} from './pdf-vision.js';
import {pickModel} from './models.js';

export const EXTRACTOR_VERSION = 3; // v3: word coordinates for column mapping
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIN_TEXT_CHARS = 30;      // fewer alphanumerics than this → page is treated as scanned
const MIXED_TEXT_CHARS = 200;   // a page with a large image and little text gets OCR in addition to its text
const LARGE_IMAGE_PX = 600 * 600;

let deps = {pdfPageCount, pdfPageTexts, pdfPageWords, pdfImagePages, renderPage, visionExtract, pickModel};
/** Test hook. */
export function _setDeps(d) { deps = d ? {...deps, ...d} : {pdfPageCount, pdfPageTexts, pdfPageWords, pdfImagePages, renderPage, visionExtract, pickModel}; }

export async function hashFile(p) {
  const h = crypto.createHash('sha256');
  const fh = await fs.open(p, 'r');
  try { for await (const chunk of fh.createReadStream()) h.update(chunk); } finally { await fh.close().catch(() => {}); }
  return h.digest('hex');
}

const alnum = s => (String(s).match(/[A-Za-z0-9]/g) || []).length;
const cacheDir = dataDir => path.join(dataDir, 'extractions');

export async function loadCachedExtraction(dataDir, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  try {
    const c = JSON.parse(await fs.readFile(path.join(cacheDir(dataDir), hash + '.json'), 'utf8'));
    return c.version === EXTRACTOR_VERSION ? c : null;
  } catch { return null; }
}

async function saveExtraction(dataDir, rec) {
  await fs.mkdir(cacheDir(dataDir), {recursive: true, mode: 0o700});
  const final = path.join(cacheDir(dataDir), rec.hash + '.json');
  const tmp = final + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(rec), {mode: 0o600});
  await fs.rename(tmp, final);
}

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const rowsToPipe = rows => rows.map(r => r.map(c => String(c ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()).join(' | ')).join('\n');

/**
 * file: {path, originalname}
 * Returns {version, hash, name, ext, kind, pageCount, pages:[{page, method, text, model?}], models, createdAt, fromCache}
 */
export async function extractDocument(file, {dataDir, model = 'auto', onProgress = () => {}, force = false} = {}) {
  const name = path.basename(file.originalname || file.path);
  const ext = path.extname(name).toLowerCase();
  const hash = await hashFile(file.path);
  if (!force) {
    const cached = await loadCachedExtraction(dataDir, hash);
    if (cached) { onProgress(`Reusing cached extraction for ${name} (${cached.pageCount} page${cached.pageCount === 1 ? '' : 's'})`); return {...cached, name, fromCache: true}; }
  }
  let visionModel = null;
  const getVision = async () => (visionModel ||= await deps.pickModel(model, {needVision: true}).catch(e => model !== 'auto' ? deps.pickModel('auto', {needVision: true}) : Promise.reject(e)));
  const pages = []; let kind;

  if (ext === '.pdf') {
    kind = 'pdf';
    const count = await deps.pdfPageCount(file.path);
    onProgress(`${name}: ${count} page(s); reading digital text`);
    const texts = await deps.pdfPageTexts(file.path, count);
    if (texts.length !== count) throw Error(`${name}: text extraction returned ${texts.length} of ${count} pages; refusing to continue with missing pages`);
    const words = await deps.pdfPageWords(file.path, count);
    const images = await deps.pdfImagePages(file.path);
    for (let p = 1; p <= count; p++) {
      const text = texts[p - 1] || ''; const chars = alnum(text);
      const scanned = chars < MIN_TEXT_CHARS;
      const mixed = !scanned && chars < MIXED_TEXT_CHARS && (images.get(p) || 0) >= LARGE_IMAGE_PX;
      if (!scanned && !mixed) { pages.push({page: p, method: 'text', text, ...(words?.[p - 1]?.length ? {words: words[p - 1]} : {})}); continue; }
      const vm = await getVision();
      onProgress(`${name}: page ${p}/${count} is ${scanned ? 'scanned' : 'partly scanned'}; running OCR with ${vm}`);
      const img = await deps.renderPage(file.path, p, 150);
      const ocr = await deps.visionExtract(vm, img, `${OCR_PROMPT} (Page ${p} of ${count} of ${name}.)`, {tokens: 4096, ctx: 8192});
      pages.push(scanned ? {page: p, method: 'ocr', text: ocr, model: vm} : {page: p, method: 'text+ocr', text: text + '\n' + ocr, model: vm});
    }
  } else if (IMAGE.has(ext)) {
    kind = 'image';
    const vm = await getVision();
    onProgress(`${name}: running OCR with ${vm}`);
    const img = (await fs.readFile(file.path)).toString('base64');
    pages.push({page: 1, method: 'ocr', text: await deps.visionExtract(vm, img, OCR_PROMPT, {tokens: 4096, ctx: 8192}), model: vm});
  } else if (ext === '.xlsx') {
    kind = 'spreadsheet';
    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.readFile(file.path);
    wb.SheetNames.forEach((sn, i) => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], {header: 1, defval: '', raw: false});
      pages.push({page: i + 1, method: 'sheet', sheet: sn, text: rowsToPipe(rows)});
    });
  } else if (ext === '.csv') {
    kind = 'csv';
    pages.push({page: 1, method: 'csv', text: rowsToPipe(parseCSV((await fs.readFile(file.path, 'utf8')).replace(/^﻿/, '')))});
  } else if (['.txt', '.md', '.json'].includes(ext)) {
    kind = 'text';
    pages.push({page: 1, method: 'text', text: (await fs.readFile(file.path, 'utf8')).replace(/^﻿/, '')});
  } else throw Error(`Unsupported file type: ${name}`);

  const rec = {version: EXTRACTOR_VERSION, hash, name, ext, kind, pageCount: pages.length, pages,
    models: [...new Set(pages.map(p => p.model).filter(Boolean))], createdAt: new Date().toISOString()};
  await saveExtraction(dataDir, rec);
  return {...rec, fromCache: false};
}
