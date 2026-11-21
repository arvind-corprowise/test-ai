// Deterministic bank-statement parser. No AI involved: every value is copied from source text with
// its page and line number so it stays traceable.
// Supports `pdftotext -layout` text (column positions) and pipe tables (OCR output, CSV, XLSX).
import {parseAmount} from './money.js';

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_RE = new RegExp(`^(?:\\d{1,2}[ \\-/]?${MONTH}(?:[ ,\\-/]+\\d{2,4})?|${MONTH} ?\\d{1,2}(?:,? ?\\d{4})?|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.\\-]\\d{1,2}(?:[/.\\-]\\d{2,4})?)(?=\\s|$)`, 'i');
const AMOUNT_RE = /(?<=^|\s)(?:[+-]\s?)?\(?-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d{2}\)?(?:-|\s?CR\b|\s?DR\b)?(?=\s|$)/gi;
const OPENING_RE = /\b(opening|previous|beginning|starting) balance\b|\bbalance (brought )?forward\b/i;
const CLOSING_RE = /\b(closing|ending|new) balance\b|\bbalance carried forward\b/i;
const TOTAL_RE = /^\s*(sub)?totals?\b/i;
const MONEY_TYPES = ['withdrawal', 'deposit', 'amount'];
const AMOUNT_TYPES = ['withdrawal', 'deposit', 'balance', 'amount'];

export function headerType(t) {
  t = String(t).toLowerCase();
  if (/balance/.test(t)) return 'balance';
  if (/\bdate\b/.test(t)) return 'date';
  if (/withdraw|debit|cheque|\bcheck|paid out|money out|payments?\b|charges/.test(t)) return 'withdrawal';
  if (/deposit|credit|paid in|money in|receipts/.test(t)) return 'deposit';
  if (/\bamount\b/.test(t)) return 'amount';
  if (/description|details|particulars|transaction|narrative|memo|payee/.test(t)) return 'description';
  return null;
}
const isHeaderSet = types => types.has('balance') && MONEY_TYPES.some(t => types.has(t)) && (types.has('date') || types.has('description'));

const segments = line => [...line.matchAll(/\S+(?: \S+)*/g)].map(m => ({text: m[0], start: m.index, end: m.index + m[0].length}));
const amountTokens = line => [...line.matchAll(AMOUNT_RE)].map(m => ({text: m[0].trim(), start: m.index, end: m.index + m[0].length}));
const isPipeLine = l => (l.match(/\|/g) || []).length >= 2;
// lead: whether the table's header row starts with '|'. If not, a leading '|' in a row means an empty first cell.
const splitPipe = (l, lead = true) => { let s = l.trimEnd(); if (lead) { s = s.trim(); if (s.startsWith('|')) s = s.slice(1); } if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map(c => c.trim()); };

function layoutHeader(lines, i) {
  const build = segs => {
    const cols = []; const types = new Set();
    for (const s of segs) { const type = headerType(s.text); if (!type) continue; const ex = cols.find(c => c.type === type);
      if (ex) { if (Math.abs(ex.start - s.start) < 25 || Math.abs(ex.end - s.end) < 25) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end); } continue; }
      cols.push({type, start: s.start, end: s.end, text: s.text}); types.add(type); }
    return isHeaderSet(types) ? cols.sort((a, b) => a.start - b.start) : null;
  };
  if (isPipeLine(lines[i]) || amountTokens(lines[i]).length) return null;
  const one = build(segments(lines[i])); if (one) return {cols: one, used: 1};
  if (i + 1 < lines.length && !isPipeLine(lines[i + 1]) && !amountTokens(lines[i + 1]).length) {
    if (build(segments(lines[i + 1]))) return null; // next line is a complete header on its own; this line is a title
    const two = build([...segments(lines[i]), ...segments(lines[i + 1])]); if (two) return {cols: two, used: 2};
  }
  return null;
}
function pipeHeader(line) {
  if (!isPipeLine(line)) return null;
  const lead = line.trim().startsWith('|');
  const cells = splitPipe(line, lead); const types = new Set(); const map = [];
  cells.forEach((c, idx) => { const t = headerType(c); if (t && !types.has(t)) { types.add(t); map[idx] = t; } });
  return isHeaderSet(types) ? {pipe: true, map, width: cells.length, lead} : null;
}

function takeDate(text) {
  const lead = text.match(/^\s*/)[0].length; const m = text.slice(lead).match(DATE_RE);
  return m ? {date: m[0].trim(), rest: text.slice(lead + m[0].length), lead} : {date: null, rest: text, lead};
}

function parseLayoutLine(line, layout) {
  const amountCols = layout.cols.filter(c => AMOUNT_TYPES.includes(c.type));
  const descCol = layout.cols.find(c => c.type === 'description');
  const zoneStart = Math.min(...amountCols.map(c => c.start)) - 8;
  const tokens = amountTokens(line).filter(t => t.end > zoneStart);
  const amounts = {}; const conflicts = [];
  for (const t of tokens) {
    let best = null, bestScore = Infinity;
    for (const c of amountCols) {
      const overlap = Math.min(t.end, c.end) - Math.max(t.start, c.start);
      const score = overlap > 0 ? -overlap : Math.min(Math.abs(t.end - c.end), Math.abs(t.start - c.start));
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (amounts[best.type] !== undefined) conflicts.push(`two amounts in ${best.type} column`);
    amounts[best.type] = t.text;
  }
  const firstAmt = tokens.length ? Math.min(...tokens.map(t => t.start)) : line.length;
  const left = line.slice(0, firstAmt);
  const lead = left.match(/^\s*/)[0].length;
  const dateZone = descCol ? descCol.start + 2 : 14;
  let date = null, rest = left;
  if (lead < dateZone) { const d = takeDate(left); if (d.date) { date = d.date; rest = d.rest; } }
  return {date, desc: rest.replace(/\s+/g, ' ').trim(), amounts, conflicts, indent: lead, amountStart: zoneStart, lineLength: line.trimEnd().length};
}
function parsePipeLine(line, hdr) {
  const cells = splitPipe(line, hdr.lead); const out = {date: null, desc: '', amounts: {}, conflicts: [], indent: 0};
  const unparsedAmounts = [];
  cells.forEach((c, idx) => {
    const t = hdr.map[idx]; if (!c) return;
    if (t === 'date') { const d = c.match(DATE_RE); if (d) out.date = d[0].trim(); else out.desc = (c + ' ' + out.desc).trim(); }
    else if (t === 'description') out.desc = (out.desc + ' ' + c).trim();
    else if (AMOUNT_TYPES.includes(t)) { if (parseAmount(c) !== null) out.amounts[t] = c; else out.conflicts.push(`unreadable ${t} "${c}"`); }
    else if (amountTokens(c).length) unparsedAmounts.push(c);
  });
  if (unparsedAmounts.length) out.conflicts.push(`amount(s) outside known columns: ${unparsedAmounts.join(', ')}`);
  return out;
}

function pageNumbers(text) {
  const m = String(text).match(/\bpage\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i) || String(text).match(/^\s*(\d+)\s+of\s+(\d+)\s*$/im);
  return m ? {page: Number(m[1]), of: Number(m[2])} : null;
}

/** True when any page contains a recognizable transaction-table header. */
export function detectBankStatement(pages) {
  return pages.some(p => { const lines = String(p.text).split('\n'); return lines.some((l, i) => layoutHeader(lines, i) || pipeHeader(l)); });
}

/**
 * pages: [{page, text, method}]
 * Returns {transactions, opening, closing, summary, pageMarkers, anomalies, tablePages, sourceLines}
 * Amounts are integer cents; raw strings are kept for traceability.
 */
export function parseBankStatement(pages) {
  const transactions = []; const anomalies = []; const pageMarkers = []; const tablePages = new Set();
  let opening = null, closing = null, lastDate = null;
  const summary = {}; const consumed = new Set();
  const cents = v => (v === undefined ? null : parseAmount(v));

  for (const pg of pages) {
    const lines = String(pg.text).replace(/\r/g, '').split('\n');
    const marker = pageNumbers(pg.text); if (marker) pageMarkers.push({sourcePage: pg.page, ...marker});
    let layout = null, inTable = false, pending = null, last = null, blankRun = 0;
    const parsed = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const h = layoutHeader(lines, i) || pipeHeader(raw);
      if (h) { layout = h; inTable = true; pending = null; last = null; tablePages.add(pg.page);
        for (let k = 0; k < (h.used || 1); k++) consumed.add(`${pg.page}:${i + k}`); i += (h.used || 1) - 1; continue; }
      if (!inTable) continue;
      if (layout.pipe && /^[\s|:\-]+$/.test(raw) && raw.includes('-')) { consumed.add(`${pg.page}:${i}`); continue; } // markdown separator
      if (!raw.trim()) { parsed.push({blank: true, i}); continue; }
      if (layout.pipe && !isPipeLine(raw)) { parsed.push({end: true, i}); continue; }
      parsed.push({i, raw, ...(layout.pipe ? parsePipeLine(raw, layout) : parseLayoutLine(raw, layout))});
    }

    const hasMoney = p => MONEY_TYPES.some(t => p.amounts?.[t] !== undefined);
    const nextNonBlank = k => { for (let j = k + 1; j < parsed.length; j++) if (!parsed[j].blank) return parsed[j]; return null; };
    let ended = false;
    for (let k = 0; k < parsed.length && !ended; k++) {
      const p = parsed[k];
      if (p.blank) { blankRun++; continue; }
      if (p.end) { if (last || pending) ended = true; continue; }
      const key = `${pg.page}:${p.i}`; const ln = p.i + 1;
      const desc = p.desc || '';
      const balanceVal = cents(p.amounts.balance);
      if (OPENING_RE.test(desc) && !hasMoney(p)) {
        consumed.add(key);
        const v = balanceVal ?? cents(Object.values(p.amounts)[0]);
        if (v !== null) { if (opening === null) opening = {cents: v, raw: p.amounts.balance, page: pg.page, line: ln, label: desc};
          else if (transactions.length) anomalies.push({severity: 'info', code: 'BALANCE_FORWARD', page: pg.page, line: ln, message: `Balance forward ${p.amounts.balance} on page ${pg.page}`, cents: v}); }
        pending = null; blankRun = 0; continue;
      }
      if (CLOSING_RE.test(desc) && !hasMoney(p)) {
        consumed.add(key);
        const v = balanceVal ?? cents(Object.values(p.amounts)[0]);
        if (v !== null) closing = {cents: v, raw: p.amounts.balance, page: pg.page, line: ln, label: desc};
        ended = true; continue;
      }
      if (TOTAL_RE.test(desc)) { consumed.add(key); anomalies.push({severity: 'info', code: 'TABLE_TOTAL_LINE', page: pg.page, line: ln, message: `Total line: ${p.raw.trim()}`}); continue; }
      for (const c of p.conflicts || []) anomalies.push({severity: 'error', code: 'UNPARSEABLE_ROW', page: pg.page, line: ln, message: `${c}: "${p.raw.trim()}"`});

      if (!hasMoney(p) && balanceVal === null) {
        // Text-only row: start of a multiline description, or continuation of the previous one.
        const nxt = nextNonBlank(k);
        const prose = !layout.pipe && p.lineLength > p.amountStart + 10; // long text running into amount columns = not table content
        if (prose) { if (last || pending) ended = true; continue; }
        consumed.add(key);
        if (p.date) pending = {date: p.date, desc, lines: [ln]};
        else if (pending) { pending.desc = (pending.desc + ' ' + desc).trim(); pending.lines.push(ln); }
        else if (last && blankRun <= 1 && !layout.pipe && p.indent > (layout.cols.find(c => c.type === 'description')?.start ?? 0) + 1) { last.description = (last.description + ' ' + desc).trim(); last.sourceLines.push(ln); last.raw.push(p.raw.trim()); } // indented further → continuation of previous row
        else if (nxt && !nxt.blank && !nxt.end && hasMoney(nxt) && !nxt.date) pending = {date: null, desc, lines: [ln]}; // amount printed on the last line of a multi-line entry
        else if (last && blankRun <= 1) { last.description = (last.description + ' ' + desc).trim(); last.sourceLines.push(ln); last.raw.push(p.raw.trim()); }
        else if (desc) anomalies.push({severity: 'info', code: 'TEXT_OUTSIDE_ROW', page: pg.page, line: ln, message: `Ignored text: "${desc.slice(0, 80)}"`});
        blankRun = 0; continue;
      }
      if (!hasMoney(p)) {
        // Balance-only row: balance printed on its own line for the previous transaction.
        consumed.add(key);
        if (!desc && last && last.balance === null) { last.balance = balanceVal; last.balanceRaw = p.amounts.balance; last.sourceLines.push(ln); }
        else anomalies.push({severity: 'warning', code: 'BALANCE_ONLY_ROW', page: pg.page, line: ln, message: `Row has a balance but no withdrawal/deposit: "${p.raw.trim()}"`});
        blankRun = 0; continue;
      }
      consumed.add(key);
      let date = p.date || pending?.date || null; let dateCarried = false;
      if (!date && lastDate) { date = lastDate; dateCarried = true; }
      let w = cents(p.amounts.withdrawal), d = cents(p.amounts.deposit); let signAssumed = false;
      if (p.amounts.amount !== undefined && w === null && d === null) { const a = cents(p.amounts.amount); if (a < 0) w = -a; else d = a; signAssumed = true; }
      const txn = {
        date, dateCarried, description: [pending?.desc, desc].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
        withdrawal: w, deposit: d, balance: balanceVal,
        withdrawalRaw: p.amounts.withdrawal ?? (signAssumed && w !== null ? p.amounts.amount : null),
        depositRaw: p.amounts.deposit ?? (signAssumed && d !== null ? p.amounts.amount : null),
        balanceRaw: p.amounts.balance ?? null, signAssumed,
        page: pg.page, method: pg.method, sourceLines: [...(pending?.lines || []), ln], raw: [p.raw.trim()],
        flags: (p.conflicts || []).slice(), origin: 'parser'
      };
      transactions.push(txn); last = txn; pending = null; lastDate = date; blankRun = 0;
    }
    if (pending) anomalies.push({severity: 'warning', code: 'DANGLING_DESCRIPTION', page: pg.page, line: pending.lines[0], message: `Description without amounts at end of table: "${pending.desc}"`});

    // Summary lines anywhere outside the parsed table rows.
    lines.forEach((l, i) => {
      if (consumed.has(`${pg.page}:${i}`)) return;
      const toks = amountTokens(l); if (!toks.length) return;
      const v = parseAmount(toks[toks.length - 1].text); if (v === null) return;
      const s = l.toLowerCase(); const ref = {cents: Math.abs(v), raw: toks[toks.length - 1].text, page: pg.page, line: i + 1, text: l.trim()};
      if (OPENING_RE.test(s) && !summary.opening) summary.opening = ref;
      else if (CLOSING_RE.test(s) && !summary.closing) summary.closing = ref;
      else if (/total (deposits|credits)|deposits? (and|&) credits?|deposits into/.test(s) && !summary.totalDeposits) summary.totalDeposits = ref;
      else if (/total (withdrawals|debits|cheques)|withdrawals from|cheques (and|&) debits/.test(s) && !summary.totalWithdrawals) summary.totalWithdrawals = ref;
    });
  }
  return {transactions, opening, closing, summary, pageMarkers, anomalies, tablePages: [...tablePages]};
}

/** All amount strings present in a text, as canonical cent keys (for traceability of AI output). */
export function amountKeysIn(text) {
  return new Set(amountTokens(String(text).replace(/\|/g, ' ')).map(t => { const c = parseAmount(t.text); return c === null ? null : String(Math.abs(c)); }).filter(Boolean));
}
export {OPENING_RE, CLOSING_RE};
