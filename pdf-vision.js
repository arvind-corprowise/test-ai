// Poppler helpers (pdfinfo, pdftotext -layout, pdfimages, pdftoppm) and Ollama vision OCR.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chat} from './models.js';

let run = promisify(execFile);
/** Test hook: replace the process runner. Signature: (cmd, args, opts) => {stdout}. */
export function _setRunner(fn) { run = fn || promisify(execFile); }

async function assertPdf(pdfPath) {
  const handle = await fs.open(pdfPath, 'r');
  try {
    const header = Buffer.alloc(5);
    const {bytesRead} = await handle.read(header, 0, 5, 0);
    if (bytesRead !== 5 || header.toString('ascii') !== '%PDF-') throw Error('Invalid or empty PDF upload');
  } finally { await handle.close(); }
}

function popplerError(e) {
  if (e?.code === 'ENOENT') return Error('Poppler is not installed on the server. Run: sudo apt install -y poppler-utils');
  return e;
}

export async function pdfPageCount(pdfPath) {
  await assertPdf(pdfPath);
  let stdout;
  try { ({stdout} = await run('pdfinfo', [pdfPath], {timeout: 60000, maxBuffer: 1024 * 1024})); } catch (e) { throw popplerError(e); }
  const pages = Number(String(stdout).match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(pages) || pages < 1) throw Error('Could not determine PDF page count');
  return pages;
}

/** Text of every page using `pdftotext -layout` (keeps column positions). Returns string[] (one per page). */
export async function pdfPageTexts(pdfPath, pages) {
  let stdout;
  try { ({stdout} = await run('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {timeout: 300000, maxBuffer: 64 * 1024 * 1024})); }
  catch (e) { throw popplerError(e); }
  let parts = String(stdout).split('\f');
  if (parts.length > pages && parts.slice(pages).every(p => !p.trim())) parts = parts.slice(0, pages);
  if (parts.length === pages) return parts;
  // Fallback: page by page, so no page is ever silently dropped.
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const r = await run('pdftotext', ['-layout', '-enc', 'UTF-8', '-f', String(p), '-l', String(p), pdfPath, '-'], {timeout: 120000, maxBuffer: 16 * 1024 * 1024});
    out.push(String(r.stdout).replace(/\f$/, ''));
  }
  return out;
}

/** Map of page -> largest image area fraction hint (pixels). Empty map if pdfimages is unavailable. */
export async function pdfImagePages(pdfPath) {
  const pages = new Map();
  try {
    const {stdout} = await run('pdfimages', ['-list', pdfPath], {timeout: 60000, maxBuffer: 8 * 1024 * 1024});
    for (const line of String(stdout).split('\n').slice(2)) {
      const c = line.trim().split(/\s+/); const page = Number(c[0]), w = Number(c[3]), h = Number(c[4]);
      if (Number.isInteger(page) && w > 0 && h > 0) pages.set(page, Math.max(pages.get(page) || 0, w * h));
    }
  } catch {}
  return pages;
}

/** Render one page to PNG (base64). Rendering only the needed page avoids converting digital pages to images. */
export async function renderPage(pdfPath, page, dpi = 150) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kad-pdf-'));
  try {
    const out = path.join(dir, 'page');
    try { await run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi), '-png', '-singlefile', pdfPath, out], {timeout: 300000, maxBuffer: 1024 * 1024}); }
    catch (e) { throw popplerError(e); }
    return (await fs.readFile(out + '.png')).toString('base64');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}

// Kept for backward compatibility with existing callers.
export async function pdfPageImages(pdfPath, maxPages = 12) {
  const pages = await pdfPageCount(pdfPath);
  if (pages > maxPages) throw Error(`PDF has ${pages} pages; this operation allows at most ${maxPages}. Split the PDF into smaller files; no pages were skipped.`);
  const out = [];
  for (let p = 1; p <= pages; p++) out.push(await renderPage(pdfPath, p, 115));
  return out;
}

export const OCR_PROMPT = 'Transcribe ALL text on this page exactly as printed, top to bottom. For every table, output the header row and then one line per table row with cells separated by " | ", keeping empty cells empty (e.g. "15 Mar | Transfer |  | 85.00 | "). Copy every number exactly, including leading decimals like .15. Do not summarize, reorder, correct, calculate or add anything. Write [illegible] for text you cannot read.';

export async function visionExtract(model, image, prompt, {tokens = 4096, ctx = 8192} = {}) {
  const text = (await chat(model, [{role: 'user', content: prompt, images: [image]}], {tokens, ctx, temperature: 0})).trim();
  if (!text) throw Error('Vision model returned no content; retry or choose another model');
  return text;
}
