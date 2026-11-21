import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {extractDocument, loadCachedExtraction, _setDeps} from '../extract.js';
import {rbcPage} from './helpers.js';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'kad-test-')); }
async function fakePdf(dir, name, content = 'x') { const p = path.join(dir, name); await fs.writeFile(p, '%PDF-1.4\n' + content); return {path: p, originalname: name}; }
function mocks({texts, images = new Map(), visionModel = 'vis:1'}) {
  const calls = {count: 0, text: 0, render: [], vision: [], pick: 0};
  _setDeps({
    pdfPageCount: async () => { calls.count++; return texts.length; },
    pdfPageTexts: async () => { calls.text++; return texts; },
    pdfImagePages: async () => images,
    renderPage: async (_p, page) => { calls.render.push(page); return 'BASE64PNG'; },
    visionExtract: async (model, _img, prompt) => { calls.vision.push({model, prompt}); return 'Date | Description | Withdrawals | Deposits | Balance\n01 Jan | Scanned row | 1.00 |  | 9.00'; },
    pickModel: async (_req, opts) => { calls.pick++; if (!opts?.needVision) throw Error('expected vision request'); return visionModel; },
  });
  return calls;
}

test('digital PDF uses pdftotext only (no rendering, no OCR)', async () => {
  const dir = await tmp(); const calls = mocks({texts: [rbcPage()]});
  const r = await extractDocument(await fakePdf(dir, 'digital.pdf'), {dataDir: dir});
  assert.deepEqual(r.pages.map(p => p.method), ['text']);
  assert.equal(calls.render.length, 0); assert.equal(calls.vision.length, 0); assert.equal(calls.pick, 0);
});

test('scanned PDF page is rendered and OCR’d with an auto-selected vision model', async () => {
  const dir = await tmp(); const calls = mocks({texts: ['   \n  ']});
  const r = await extractDocument(await fakePdf(dir, 'scan.pdf'), {dataDir: dir});
  assert.equal(r.pages[0].method, 'ocr'); assert.equal(r.pages[0].model, 'vis:1');
  assert.deepEqual(calls.render, [1]); assert.equal(calls.vision.length, 1);
});

test('mixed PDF: OCR only the scanned page(s); digital pages keep their text', async () => {
  const dir = await tmp();
  const calls = mocks({texts: [rbcPage(), '', 'Account statement header for customer 2024 continued', rbcPage()], images: new Map([[3, 2000 * 2000]])});
  const r = await extractDocument(await fakePdf(dir, 'mixed.pdf'), {dataDir: dir});
  assert.deepEqual(r.pages.map(p => p.method), ['text', 'ocr', 'text+ocr', 'text']);
  assert.deepEqual(calls.render, [2, 3]);
  assert.equal(r.pageCount, 4, 'no page may be skipped');
});

test('extraction is cached by file hash and reused; changed file is re-extracted', async () => {
  const dir = await tmp(); const calls = mocks({texts: [rbcPage()]});
  const f = await fakePdf(dir, 'a.pdf', 'same');
  const first = await extractDocument(f, {dataDir: dir});
  const second = await extractDocument({...f, originalname: 'renamed.pdf'}, {dataDir: dir});
  assert.equal(first.fromCache, false); assert.equal(second.fromCache, true);
  assert.equal(calls.text, 1, 'pdftotext must run once for identical content');
  assert.equal(second.name, 'renamed.pdf');
  assert.ok(await loadCachedExtraction(dir, first.hash));
  await fs.writeFile(f.path, '%PDF-1.4\nchanged');
  const third = await extractDocument(f, {dataDir: dir});
  assert.equal(third.fromCache, false); assert.notEqual(third.hash, first.hash); assert.equal(calls.text, 2);
  const forced = await extractDocument(f, {dataDir: dir, force: true});
  assert.equal(forced.fromCache, false); assert.equal(calls.text, 3);
});

test('cache survives a "restart" (fresh module state reads from disk)', async () => {
  const dir = await tmp(); mocks({texts: [rbcPage()]});
  const f = await fakePdf(dir, 'persist.pdf', 'p');
  const first = await extractDocument(f, {dataDir: dir});
  const files = await fs.readdir(path.join(dir, 'extractions'));
  assert.ok(files.includes(first.hash + '.json'));
  const calls = mocks({texts: ['should not be used']});
  const again = await extractDocument(f, {dataDir: dir});
  assert.equal(again.fromCache, true); assert.equal(calls.text, 0);
});

test('CSV is converted to a pipe table without AI', async () => {
  const dir = await tmp(); _setDeps(null);
  const p = path.join(dir, 's.csv'); await fs.writeFile(p, 'Date,Description,Debit,Credit,Balance\n01 Jan,"Shop, Inc",4.50,,95.50\n');
  const r = await extractDocument({path: p, originalname: 's.csv'}, {dataDir: dir});
  assert.equal(r.pages[0].text.split('\n')[1], '01 Jan | Shop, Inc | 4.50 |  | 95.50');
});
