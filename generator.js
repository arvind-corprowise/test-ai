// Workbook generation pipeline:
// uploaded files → extraction (cached by hash: pdftotext / OCR only where needed) → document type detection
// → deterministic transaction parsing → deterministic validation → AI categorization → Excel.
// Financial values never come from the AI for bank statements; the AI only categorizes descriptions
// (and, as a last resort, structures rows whose every amount is verified to exist in the source text).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {extractDocument, loadCachedExtraction} from './extract.js';
import {chat, pickModel, parseJSON} from './models.js';
import {detectBankStatement, parseBankStatement, amountKeysIn, OPENING_RE, CLOSING_RE} from './bank.js';
import {validateStatement, statusLabel} from './validate.js';
import {parseAmount, centsToNumber, formatCents} from './money.js';

export const DATA = process.env.KAD_DATA_DIR || path.join(os.homedir(), '.kad-local-ai-workbooks');
const MAX_CHUNK = 6000, MAX_SOURCE_JSON = 27000, CATEGORY_BATCH = 40;

let deps = {};
/** Test hook: override extractDocument, chat, pickModel, makeWorkbook. */
export function _setDeps(d) { deps = d || {}; }
const D = () => ({extractDocument, loadCachedExtraction, chat, pickModel, makeWorkbook: async spec => (await import('./workbook.js')).makeWorkbook(spec), normalizeSpec: async raw => (await import('./workbook.js')).normalizeSpec(raw), ...deps});

async function askJSON(model, system, prompt, opts) {
  const text = await D().chat(model, [{role: 'system', content: system}, {role: 'user', content: prompt}], {format: 'json', temperature: 0.1, ...opts});
  return parseJSON(text);
}

// ---------- AI fallback: structure rows from source text, then verify every value is in the source ----------
const STRUCTURE_SYSTEM = 'You convert bank statement text into JSON. Return ONLY {"rows":[{"date":"","description":"","withdrawal":"","deposit":"","balance":""}]}. One object per transaction in source order. Copy dates, descriptions and amounts EXACTLY as printed; leave a field empty if blank in the source. Do NOT include opening/closing balance lines or totals as rows. Never calculate, correct or invent values.';
async function aiStructurePage(model, page, name) {
  const out = await askJSON(model, STRUCTURE_SYSTEM, `Source: ${name}, page ${page.page}\n\n${page.text.slice(0, MAX_CHUNK)}`, {tokens: 4096, ctx: 8192});
  const keys = amountKeysIn(page.text); const lower = page.text.toLowerCase().replace(/\s+/g, ' ');
  const rows = [];
  for (const r of Array.isArray(out.rows) ? out.rows : []) {
    const desc = String(r.description || '').trim();
    if (OPENING_RE.test(desc) || CLOSING_RE.test(desc)) continue;
    const t = {date: String(r.date || '').trim() || null, dateCarried: false, description: desc,
      withdrawal: parseAmount(r.withdrawal), deposit: parseAmount(r.deposit), balance: parseAmount(r.balance),
      withdrawalRaw: r.withdrawal || null, depositRaw: r.deposit || null, balanceRaw: r.balance || null,
      page: page.page, method: page.method, sourceLines: [], raw: [], flags: [], origin: 'ai'};
    for (const [field, v] of [['withdrawal', t.withdrawal], ['deposit', t.deposit], ['balance', t.balance]])
      if (v !== null && !keys.has(String(Math.abs(v)))) t.flags.push(`AI ${field} ${formatCents(v)} does not appear in the source text (possible invention)`);
    const firstWord = desc.toLowerCase().split(/\s+/).find(w => w.length > 2);
    if (firstWord && !lower.includes(firstWord)) t.flags.push(`AI description "${desc}" not found in the source text`);
    rows.push(t);
  }
  return rows;
}

// ---------- AI categorization (descriptions only; amounts are never sent back into the data) ----------
const CATEGORY_SYSTEM = 'You categorize bank transactions for bookkeeping. Return ONLY {"categories":[{"id":1,"category":"..."}]} with exactly one entry per input id. Use short category names. Follow any categories the user requests. If unclear use "Uncategorized". Do not change, add or remove transactions.';
async function categorize(model, txns, instructions, progress) {
  const out = new Array(txns.length).fill('Uncategorized'); const warnings = [];
  for (let s = 0; s < txns.length; s += CATEGORY_BATCH) {
    const batch = txns.slice(s, s + CATEGORY_BATCH);
    progress(`Categorizing transactions ${s + 1}–${s + batch.length} of ${txns.length} with ${model}`);
    const list = batch.map((t, i) => `${s + i + 1} | ${t.description} | ${t.withdrawal !== null ? 'withdrawal' : 'deposit'}`).join('\n');
    try {
      const res = await askJSON(model, CATEGORY_SYSTEM, `User instructions:\n${instructions}\n\nTransactions (id | description | type):\n${list}`, {tokens: 2048, ctx: 8192});
      for (const c of Array.isArray(res.categories) ? res.categories : []) {
        const id = Number(c.id) - 1;
        if (Number.isInteger(id) && id >= s && id < s + batch.length && typeof c.category === 'string' && c.category.trim()) out[id] = c.category.trim().slice(0, 60);
      }
    } catch (e) { warnings.push(`AI categorization failed for rows ${s + 1}–${s + batch.length} (${e.message}); left as Uncategorized.`); }
  }
  return {categories: out, warnings};
}

// ---------- Bank workbook (deterministic) ----------
function buildBankSpec(results, categories, {model, instructions}) {
  const n = centsToNumber; const tx = [], txHi = [], disc = [], val = [], summ = [], src = [];
  let k = 0;
  for (const r of results) {
    const v = r.validation;
    r.parsed.transactions.forEach(t => {
      const sev = t.issues?.some(i => i.severity === 'error') ? 'red' : t.issues?.some(i => i.severity === 'warning') ? 'yellow' : null;
      tx.push([r.name, t.page, t.sourceLines.join(', '), t.date, t.description, n(t.withdrawal), n(t.deposit), n(t.balance), n(t.calculatedBalance),
        {pass: 'OK', fail: 'MISMATCH', none: '', anchor: 'Start', unchecked: 'Not verifiable'}[t.balanceCheck] ?? '', categories[k++] ?? 'Uncategorized',
        (t.issues || []).filter(i => i.severity !== 'info').map(i => i.code).join(', ') + (t.dateCarried ? (t.issues?.length > 1 ? '; ' : '') + 'date carried' : '')]);
      if (sev) txHi.push({row: tx.length, color: sev});
    });
    for (const i of v.issues) disc.push([r.name, i.severity.toUpperCase(), i.code, i.page ?? '', i.line ?? '', i.message]);
    for (const c of v.checks) val.push([r.name, c.check, c.result.toUpperCase(), c.details]);
    const methods = [...new Set(r.pages.map(p => p.method))].join(', ');
    summ.push([r.name, 'Validation status', statusLabel(v)], [r.name, 'Transactions extracted', v.totals.transactions],
      [r.name, 'Opening balance', n(v.totals.opening)], [r.name, 'Total withdrawals (extracted)', n(v.totals.withdrawals)],
      [r.name, 'Total deposits (extracted)', n(v.totals.deposits)], [r.name, 'Running balance after last extracted row', n(v.totals.finalBalance)],
      [r.name, 'Closing balance stated', n(v.totals.closing)], [r.name, 'Pages provided', r.pageCount],
      [r.name, 'Missing pages', v.missingPages.join(', ') || (v.incomplete ? 'unknown' : 'none detected')],
      [r.name, 'Extraction method', methods], [r.name, 'File SHA-256', r.hash]);
    for (const p of r.pages) String(p.text).split('\n').forEach((line, i) => { if (line.trim()) src.push([r.name, p.page, p.method, i + 1, line.replace(/\s+$/, '')]); });
  }
  summ.push(['', 'AI model (categories / OCR)', model], ['', 'Generated', new Date().toISOString()], ['', 'Instructions', instructions.slice(0, 2000)]);
  const cats = new Map(); let j = 0;
  for (const r of results) for (const t of r.parsed.transactions) { const c = categories[j++] ?? 'Uncategorized'; const e = cats.get(c) || {w: 0, d: 0, n: 0}; e.w += t.withdrawal ?? 0; e.d += t.deposit ?? 0; e.n++; cats.set(c, e); }
  const catRows = [...cats].sort((a, b) => a[0].localeCompare(b[0])).map(([c, e]) => [c, e.n, n(e.w), n(e.d)]);
  const overall = results.every(r => r.validation.verified) ? 'verified' : results.some(r => r.validation.status === 'failed') ? 'FAILED' : 'UNVERIFIED';
  // Final guard: amount columns (Withdrawals, Deposits, Statement Balance, Calculated Balance) hold only numbers or blanks.
  tx.forEach((row, i) => { for (const col of [5, 6, 7, 8]) if (row[col] !== null && typeof row[col] !== 'number') throw Error(`Internal error: non-numeric value in amount column on Transactions row ${i + 1}; workbook not written`); });
  const MAX = 15000; const srcRows = src.slice(0, MAX);
  return {
    filename: `statement-${overall}`,
    notes: src.length > MAX ? `Source Text sheet shows the first ${MAX} of ${src.length} lines; full text is kept in the extraction cache.` : '',
    sheets: [
      {name: 'Summary', columns: ['Source', 'Item', 'Value'], rows: summ, highlights: []},
      {name: 'Transactions', columns: ['Source', 'Page', 'Source Line', 'Date', 'Description', 'Withdrawals', 'Deposits', 'Statement Balance', 'Calculated Balance', 'Balance Check', 'Category (AI)', 'Flags'], rows: tx, highlights: txHi},
      {name: 'Validation', columns: ['Source', 'Check', 'Result', 'Details'], rows: val, highlights: val.map((r, i) => r[2] === 'FAIL' ? {row: i + 1, color: 'red'} : null).filter(Boolean)},
      {name: 'Discrepancies', columns: ['Source', 'Severity', 'Code', 'Page', 'Line', 'Message'], rows: disc.length ? disc : [['', 'NONE', '', '', '', 'No discrepancies detected']], highlights: disc.map((r, i) => r[1] === 'ERROR' ? {row: i + 1, color: 'red'} : r[1] === 'WARNING' ? {row: i + 1, color: 'yellow'} : null).filter(Boolean)},
      {name: 'Category Summary', columns: ['Category (AI)', 'Count', 'Withdrawals', 'Deposits'], rows: catRows, highlights: []},
      {name: 'Source Text', columns: ['Source', 'Page', 'Method', 'Line', 'Text'], rows: srcRows, highlights: []}
    ]
  };
}

// ---------- General documents (AI-designed workbook, with numeric traceability check) ----------
const EXTRACT_SYSTEM = 'Extract structured records from supplied document text. Return JSON ONLY: {"rows":[{"field":"value"}],"notes":[]}. Copy values exactly as written; never invent records or amounts. Keep each record distinct. Mark uncertain values in notes. No Markdown.';
const PLAN_SYSTEM = 'You design Excel workbooks from user instructions and source records. Return ONLY JSON with {"filename":"name.xlsx","sheets":[{"name":"Sheet","columns":["Column A"],"rows":[["value"]],"highlights":[{"row":1,"color":"red"}]}],"notes":"limitations and uncertainty"}. Sheet columns and count must follow user instructions. Use all source records relevant to the instructions; never invent facts or numbers. Rows must be arrays; numbers must be JSON numbers copied from the source. For revisions, modify the existing workbook. Limit 15 sheets, 60 columns. No Markdown.';
function traceNumbers(spec, sourceText) {
  const keys = amountKeysIn(sourceText); const digits = sourceText.replace(/,/g, '');
  let untraced = 0;
  for (const s of spec.sheets) s.rows.forEach((row, i) => {
    const bad = row.some(v => typeof v === 'number' && !(Number.isInteger(v) ? digits.includes(String(v)) || keys.has(String(Math.abs(v * 100))) : keys.has(String(Math.abs(Math.round(v * 100))))));
    if (bad) { untraced++; if (!s.highlights.some(h => h.row === i + 1)) s.highlights.push({row: i + 1, color: 'yellow'}); }
  });
  return untraced;
}
async function generalSpec({model, docs, instructions, previous, progress}) {
  let sources = []; const text = docs.flatMap(d => d.pages.map(p => p.text)).join('\n');
  for (const d of docs) for (const p of d.pages) {
    const chunks = p.text.match(new RegExp(`[\\s\\S]{1,${MAX_CHUNK}}`, 'g')) || [];
    for (let i = 0; i < chunks.length; i++) {
      progress(`Structuring ${d.name} page ${p.page}${chunks.length > 1 ? ` part ${i + 1}/${chunks.length}` : ''} with ${model}`);
      const ex = await askJSON(model, EXTRACT_SYSTEM, `Source file: ${d.name}; page ${p.page}; chunk ${i + 1}/${chunks.length}\n${chunks[i]}`, {tokens: 3000, ctx: 8192});
      if (!Array.isArray(ex.rows)) throw Error(`No structured rows returned for ${d.name} page ${p.page}`);
      sources.push(...ex.rows.map(row => ({source: d.name, page: p.page, ...row})));
    }
  }
  const sourceJSON = JSON.stringify(sources); const priorJSON = previous ? JSON.stringify(previous.spec) : '';
  if (sourceJSON.length > MAX_SOURCE_JSON || priorJSON.length > MAX_SOURCE_JSON) throw Error('Too much source data for a reliable single-pass workbook. Split documents into smaller batches. No data was silently dropped.');
  progress(`Designing workbook with ${model}`);
  const raw = await askJSON(model, PLAN_SYSTEM, `User instructions:\n${instructions}\n\n${previous ? 'Existing workbook JSON:\n' + priorJSON : 'Create a new workbook.'}\n\nSource records (${sources.length}):\n${sourceJSON}\n\nPreserve every relevant record; do not invent data.`, {tokens: 7500, ctx: 16384});
  const spec = await D().normalizeSpec(raw);
  if (sources.length && !spec.sheets.some(s => s.rows.length)) throw Error('AI returned no rows; workbook was not saved');
  const untraced = text ? traceNumbers(spec, text + (previous ? '\n' + priorJSON : '')) : 0;
  return {spec, sourceCount: sources.length, warnings: untraced ? [`${untraced} row(s) contain numbers that do not appear in the source documents (highlighted yellow). They may be AI calculations or errors — verify them.`] : []};
}

// ---------- Main entry ----------
export async function generate({instructions, files = [], model = 'auto', previousId = '', onProgress = () => {}, force = false, dataDir = DATA}) {
  const progress = msg => { try { onProgress(msg); } catch {} };
  if (!instructions || instructions.length > 6000) throw Error('Provide instructions (max 6000 characters)');
  await fs.mkdir(dataDir, {recursive: true, mode: 0o700});
  let previous = null;
  if (previousId) {
    if (!/^[a-f0-9-]{36}$/.test(previousId)) throw Error('Invalid workbook ID');
    try { previous = JSON.parse(await fs.readFile(path.join(dataDir, previousId + '.json'), 'utf8')); } catch { throw Error('Previous workbook not found'); }
  }
  if (!files.length && !previous) throw Error('Attach documents or revise a previously generated workbook');

  // 1. Extraction (cached by SHA-256; unchanged files are never re-extracted).
  let docs = [];
  if (files.length) {
    for (const f of files) { progress(`Extracting ${f.originalname}`); docs.push(await D().extractDocument(f, {dataDir, model, onProgress: progress, force})); }
  } else if (previous.sources?.length) {
    progress('Reusing extracted content from the previous workbook (no re-extraction)');
    for (const s of previous.sources) {
      const c = await D().loadCachedExtraction(dataDir, s.hash);
      if (!c) throw Error(`Cached extraction for ${s.name} is missing; re-attach the file to regenerate.`);
      docs.push({...c, name: s.name, fromCache: true});
    }
  }
  const ocrModel = docs.flatMap(d => d.models || [])[0] || '';
  const warnings = [];

  // 2. Document type detection.
  const bankDocs = docs.filter(d => detectBankStatement(d.pages));
  const isBank = docs.length > 0 && bankDocs.length === docs.length;
  if (bankDocs.length && !isBank) warnings.push('Some files are bank statements and some are not; processed all with the general AI workbook path. Upload statements separately for deterministic validation.');
  let selected = null; const getModel = async () => (selected ||= await D().pickModel(model, {prefer: ocrModel}));

  let spec, sourceCount, kind, validations = [], categories = [], transactionsRecord = [];
  if (isBank) {
    kind = 'bank';
    // 3. Deterministic parsing + 4. validation.
    const results = [];
    for (const d of docs) {
      progress(`Parsing transactions in ${d.name}`);
      const parsed = parseBankStatement(d.pages);
      for (const p of d.pages) {
        // Only pages with no parsed rows but several amounts (unrecognized/OCR layouts) go to the AI fallback.
        if (parsed.transactions.some(t => t.page === p.page) || amountKeysIn(p.text).size < 3) continue;
        if (!parsed.tablePages.includes(p.page) && p.method === 'text') {
          warnings.push(`${d.name} page ${p.page}: contains amounts but no recognizable transaction table; not included. Check this page manually.`);
          continue;
        }
        progress(`${d.name} page ${p.page}: table layout not recognized; AI structuring with source verification`);
        const rows = await aiStructurePage(await getModel(), p, d.name);
        parsed.transactions.push(...rows); parsed.transactions.sort((a, b) => a.page - b.page);
        if (rows.length) warnings.push(`${d.name} page ${p.page}: rows structured by AI; every amount was checked against the source text.`);
      }
      progress(`Validating ${d.name}`);
      const validation = validateStatement(parsed, {pageCount: d.pageCount, sourceName: d.name});
      results.push({name: d.name, hash: d.hash, pageCount: d.pageCount, pages: d.pages, parsed, validation});
    }
    // 5. AI categorization (only descriptions → category labels).
    const all = results.flatMap(r => r.parsed.transactions);
    if (all.length) {
      const m = await getModel().catch(e => { warnings.push(`No model for categorization: ${e.message}`); return null; });
      if (m) { const c = await categorize(m, all, instructions, progress); categories = c.categories; warnings.push(...c.warnings); }
    }
    const raw = buildBankSpec(results, categories, {model: selected || ocrModel || 'none', instructions});
    spec = await D().normalizeSpec(raw);
    sourceCount = all.length;
    validations = results.map(r => ({source: r.name, status: r.validation.status, verified: r.validation.verified, errors: r.validation.errors, warnings: r.validation.warnings, checks: r.validation.checks, issues: r.validation.issues.slice(0, 500), totals: r.validation.totals, missingPages: r.validation.missingPages}));
    transactionsRecord = results.map(r => ({source: r.name, transactions: r.parsed.transactions.map(t => ({...t, issues: undefined}))}));
    for (const v of validations) warnings.push(`${v.source}: ${statusLabel(v)}${v.errors ? ` (${v.errors} error(s))` : ''}${v.warnings ? ` (${v.warnings} warning(s))` : ''}.`);
    if (instructions && !/categor|classif|transaction|statement|excel|sheet|workbook/i.test(instructions)) warnings.push('Bank statements use a fixed, validated workbook layout; your instructions were applied to categorization.');
  } else {
    kind = 'general';
    const m = await getModel();
    const r = await generalSpec({model: m, docs, instructions, previous: previous?.kind !== 'bank' ? previous : null, progress});
    spec = r.spec; sourceCount = r.sourceCount; warnings.push(...r.warnings);
  }

  // 6. Excel + persistent record.
  progress('Writing Excel workbook');
  const id = crypto.randomUUID(); const buffer = await D().makeWorkbook(spec);
  const record = {version: 2, id, parentId: previous?.id || previousId || null, kind, instructions, createdAt: new Date().toISOString(),
    model: selected || ocrModel || null, ocrModels: [...new Set(docs.flatMap(d => d.models || []))],
    sources: docs.map(d => ({name: d.name, hash: d.hash, pageCount: d.pageCount, methods: [...new Set(d.pages.map(p => p.method))], fromCache: !!d.fromCache})),
    validation: validations, categories, transactions: transactionsRecord, sourceCount, spec, warnings};
  await fs.writeFile(path.join(dataDir, id + '.xlsx'), buffer, {mode: 0o600});
  await fs.writeFile(path.join(dataDir, id + '.json'), JSON.stringify(record), {mode: 0o600});
  const verified = kind === 'bank' && validations.length > 0 && validations.every(v => v.verified);
  return {id, parentId: record.parentId, kind, filename: spec.filename.endsWith('.xlsx') ? spec.filename : spec.filename + '.xlsx', model: record.model,
    sheets: spec.sheets.map(s => ({name: s.name, rows: s.rows.length, columns: s.columns})), sourceCount, verified,
    validation: validations.map(v => ({source: v.source, status: v.status, errors: v.errors, warnings: v.warnings, missingPages: v.missingPages,
      totals: Object.fromEntries(Object.entries(v.totals).map(([k2, x]) => [k2, typeof x === 'number' && k2 !== 'transactions' ? formatCents(x) : x])),
      topIssues: v.issues.filter(i => i.severity !== 'info').slice(0, 8).map(i => i.message)})),
    sources: record.sources,
    warnings: [...warnings, ...(spec.notes ? [spec.notes] : []), verified ? 'All deterministic balance checks passed. Still review categories.' : 'Not verified: review every figure against the source before use.']};
}

export async function download(id, dataDir = DATA) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid ID');
  const info = JSON.parse(await fs.readFile(path.join(dataDir, id + '.json'), 'utf8'));
  return {buffer: await fs.readFile(path.join(dataDir, id + '.xlsx')), filename: info.spec.filename.endsWith('.xlsx') ? info.spec.filename : info.spec.filename + '.xlsx'};
}
