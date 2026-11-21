import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generate, download, _setDeps} from '../generator.js';
import {_setDeps as setExtractDeps} from '../extract.js';
import {rbcPage, RBC_ROWS} from './helpers.js';

let hasExcel = true; try { await import('exceljs'); } catch { hasExcel = false; }

function setup({texts}) {
  const calls = {pdftotext: 0, chat: []};
  setExtractDeps({pdfPageCount: async () => texts.length, pdfPageTexts: async () => { calls.pdftotext++; return texts; },
    pdfImagePages: async () => new Map(), renderPage: async () => 'x', visionExtract: async () => 'x', pickModel: async () => 'vis'});
  const stubs = hasExcel ? {} : {
    normalizeSpec: async s => s,
    makeWorkbook: async spec => Buffer.from(JSON.stringify(spec)),
  };
  _setDeps({...stubs,
    pickModel: async (req) => req === 'auto' ? 'model-a' : req,
    chat: async (model, messages) => {
      calls.chat.push({model, prompt: messages.at(-1).content});
      const ids = [...messages.at(-1).content.matchAll(/^(\d+) \| /gm)].map(m => Number(m[1]));
      const cat = /Groceries/.test(messages.at(-1).content) ? 'Groceries' : 'General';
      return JSON.stringify({categories: ids.map(id => ({id, category: cat, amount: 999999}))});
    }});
  return calls;
}
async function file(dir) { const p = path.join(dir, 'rbc.pdf'); await fs.writeFile(p, '%PDF-1.4 rbc'); return {path: p, originalname: 'rbc.pdf'}; }

test('bank statement workbook: deterministic values, validation report, AI only categorizes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kad-gen-')); const calls = setup({texts: [rbcPage()]});
  const r = await generate({instructions: 'Create a categorized transaction list', files: [await file(dir)], dataDir: dir});
  assert.equal(r.kind, 'bank'); assert.equal(r.sourceCount, 11);
  assert.equal(r.verified, false, 'page 1 of 2 must not be marked verified');
  assert.equal(r.validation[0].status, 'incomplete');
  assert.equal(r.validation[0].totals.finalBalance, '3,783.36');
  const rec = JSON.parse(await fs.readFile(path.join(dir, r.id + '.json'), 'utf8'));
  const tx = rec.spec.sheets.find(s => s.name === 'Transactions');
  assert.equal(tx.rows.length, 11);
  const amounts = tx.rows.map(row => row[5] ?? row[6]);
  assert.ok(amounts.includes(0.15) && amounts.includes(148.11) && amounts.includes(125.13));
  assert.ok(!JSON.stringify(rec.spec).includes('999999'), 'AI output must never inject amounts');
  assert.ok(rec.spec.sheets.some(s => s.name === 'Source Text'), 'original extracted text kept separately');
  assert.ok(calls.chat.every(c => !/4,247\.14/.test(c.prompt)), 'AI is not asked to do arithmetic');
  assert.equal(rec.sources[0].methods[0], 'text');
  const dl = await download(r.id, dir); assert.ok(dl.buffer.length > 0);
});

test('regeneration with new instructions reuses cached extraction and links revisions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kad-gen-')); const calls = setup({texts: [rbcPage()]});
  const first = await generate({instructions: 'Categorize', files: [await file(dir)], dataDir: dir});
  const second = await generate({instructions: 'Use category Groceries', files: [], previousId: first.id, dataDir: dir});
  assert.equal(calls.pdftotext, 1, 'no re-extraction on regeneration');
  assert.equal(second.parentId, first.id);
  const rec = JSON.parse(await fs.readFile(path.join(dir, second.id + '.json'), 'utf8'));
  assert.ok(rec.categories.every(c => c === 'Groceries'));
  assert.ok(rec.sources[0].fromCache);
  // first workbook is not overwritten
  assert.ok(await fs.stat(path.join(dir, first.id + '.xlsx')));
  // re-uploading the same file also hits the cache
  await generate({instructions: 'Again', files: [await file(dir)], dataDir: dir});
  assert.equal(calls.pdftotext, 1);
});

test('failed validation is reported, not marked verified', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kad-gen-'));
  setup({texts: [rbcPage(RBC_ROWS.filter(r => r[1] !== 'Cheque - 30'), {pageOf: '1 of 1'})]});
  const r = await generate({instructions: 'Categorize', files: [await file(dir)], dataDir: dir});
  assert.equal(r.verified, false); assert.equal(r.validation[0].status, 'failed');
  assert.ok(r.validation[0].topIssues.some(m => /BALANCE|balance/.test(m)));
  assert.match(r.filename, /FAILED/);
});

test('stores model, timestamps and validation metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kad-gen-')); setup({texts: [rbcPage()]});
  const r = await generate({instructions: 'x categorize', files: [await file(dir)], model: 'model-b', dataDir: dir});
  const rec = JSON.parse(await fs.readFile(path.join(dir, r.id + '.json'), 'utf8'));
  assert.equal(rec.model, 'model-b'); assert.ok(rec.createdAt); assert.ok(rec.validation[0].checks.length); assert.equal(rec.version, 2);
});
