// Deterministic validation of parsed bank statements. Integer-cent arithmetic only.
import {formatCents as f} from './money.js';
const DATE_SHAPE = /^(?:\d{1,2}[ \-/]?[a-z]{3,9}\.?(?:[ ,\-/]+\d{2,4})?|[a-z]{3,9}\.? ?\d{1,2}(?:,? ?\d{4})?|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?)$/i;

/**
 * parsed: output of parseBankStatement (optionally with AI-structured rows marked origin:'ai').
 * pageCount: pages actually present in the uploaded file.
 * Returns {status, verified, issues, checks, totals, finalBalance, incomplete, missingPages}
 * status: 'verified' | 'incomplete' | 'unverified' | 'failed'
 */
export function validateStatement(parsed, {pageCount, sourceName = 'statement'} = {}) {
  const issues = []; const checks = [];
  const add = (severity, code, message, extra = {}) => issues.push({severity, code, message, ...extra});
  const txns = parsed.transactions;

  for (const a of parsed.anomalies || []) if (a.severity !== 'info' || a.code === 'BALANCE_FORWARD') add(a.severity, a.code, a.message, {page: a.page, line: a.line});
  if (!txns.length) add('error', 'NO_TRANSACTIONS', 'No transactions were found in the transaction table.');

  // 1. Per-transaction field validation.
  txns.forEach((t, i) => {
    const at = {txn: i, page: t.page, line: t.sourceLines?.[0]};
    t.issues = [];
    const tag = (sev, code, msg) => { add(sev, code, `Row ${i + 1} (${t.date || 'no date'} ${t.description || ''}): ${msg}`, at); t.issues.push({severity: sev, code}); };
    // Strict schema: date/description are text, amounts are integer cents or null.
    for (const f of ['withdrawal', 'deposit', 'balance']) if (t[f] !== null && !Number.isSafeInteger(t[f])) tag('error', 'SCHEMA_AMOUNT', `${f} is not a valid amount (${JSON.stringify(t[f])})`);
    if (t.date !== null && (typeof t.date !== 'string' || !DATE_SHAPE.test(t.date))) tag('error', 'SCHEMA_DATE', `date "${t.date}" is not a recognizable date`);
    if (typeof t.description !== 'string') tag('error', 'SCHEMA_DESCRIPTION', 'description is not text');
    else if (/^\s*[-+]?\$?[\d,]*\.\d{2}\s*$/.test(t.description)) tag('error', 'SCHEMA_DESCRIPTION', `description "${t.description}" is a number (column misalignment)`);
    if (!t.description) tag('error', 'MISSING_DESCRIPTION', 'description is missing');
    if (!t.date) tag('error', 'MISSING_DATE', 'date is missing and cannot be carried from a previous row');
    else if (t.dateCarried) tag('info', 'DATE_CARRIED', `date cell is blank in the source; using previous date ${t.date}`);
    const w = t.withdrawal, d = t.deposit;
    if (w === null && d === null) tag('error', 'NO_AMOUNT', 'no withdrawal or deposit amount');
    if (w !== null && d !== null && w !== 0 && d !== 0) tag('error', 'BOTH_DEBIT_CREDIT', 'has both a withdrawal and a deposit');
    if ((w ?? 0) < 0 || (d ?? 0) < 0) tag('warning', 'NEGATIVE_AMOUNT', 'negative value inside a withdrawal/deposit column');
    if (t.signAssumed) tag('warning', 'SIGN_ASSUMED', 'single amount column: negative treated as withdrawal, positive as deposit');
    if (t.origin === 'ai') tag('warning', 'AI_STRUCTURED', 'row structured by AI from source text (values verified to exist in the source)');
    if (t.method === 'ocr' || t.method === 'text+ocr') tag('info', 'FROM_OCR', 'values read by OCR from a scanned page');
    for (const fl of t.flags || []) tag('error', 'ROW_FLAG', fl);
  });

  // 2. Running balance verification.
  const opening = parsed.opening?.cents ?? parsed.summary?.opening?.cents ?? null;
  if (parsed.opening && parsed.summary?.opening && parsed.opening.cents !== parsed.summary.opening.cents)
    add('warning', 'OPENING_MISMATCH', `Opening balance in table (${f(parsed.opening.cents)}) differs from summary (${f(parsed.summary.opening.cents)}).`);
  let running = opening, checkpoints = 0, mismatches = 0, anchoredLate = false;
  txns.forEach((t, i) => {
    const amt = (t.deposit ?? 0) - (t.withdrawal ?? 0);
    t.calculatedBalance = null; t.balanceCheck = t.balance === null ? 'none' : 'unchecked';
    if (running === null) {
      if (t.balance !== null) { running = t.balance; anchoredLate = true; t.calculatedBalance = running; t.balanceCheck = 'anchor'; }
      return;
    }
    const expected = running + amt; t.calculatedBalance = expected;
    if (t.balance === null) { running = expected; return; }
    checkpoints++;
    if (expected === t.balance) { t.balanceCheck = 'pass'; running = expected; return; }
    mismatches++; t.balanceCheck = 'fail';
    const at = {txn: i, page: t.page, line: t.sourceLines?.[0]};
    if (running - amt === t.balance) {
      add('error', 'DEBIT_CREDIT_SWAPPED', `Row ${i + 1} (${t.date} ${t.description}): amount ${f(Math.abs(amt))} appears to be in the wrong column (withdrawal vs deposit). Statement balance ${f(t.balance)}; balance with the column swapped matches.`, at);
    } else {
      const diff = t.balance - expected;
      add('error', 'BALANCE_MISMATCH', `Row ${i + 1} (${t.date} ${t.description}): statement balance ${f(t.balance)} but calculated ${f(expected)} (difference ${f(diff, {sign: true})}). Possible missing transaction(s), wrong amount, duplicate, or OCR error between the previous balance and this row.`, {...at, difference: diff});
    }
    running = t.balance; // resynchronise so later errors are localised
    t.calculatedBalance = expected;
  });
  if (opening === null) add('warning', 'NO_OPENING_BALANCE', anchoredLate ? 'No opening balance found; rows before the first printed balance cannot be verified.' : 'No opening balance and no printed balances; running balances cannot be verified.');
  checks.push({check: 'Running balance checkpoints', result: checkpoints === 0 ? 'skipped' : mismatches ? 'fail' : 'pass', details: checkpoints === 0 ? 'No printed balances to check against' : `${checkpoints - mismatches}/${checkpoints} printed balances match the calculated running balance`});

  // 3. Duplicates.
  const seen = new Map();
  txns.forEach((t, i) => {
    const key = [t.date, t.description.toLowerCase(), t.withdrawal, t.deposit].join('|');
    if (!seen.has(key)) { seen.set(key, i); return; }
    const first = seen.get(key);
    const confirmed = t.balanceCheck === 'pass' || (t.balanceCheck === 'none' && txns.slice(i).some(x => x.balanceCheck === 'pass') && !txns.slice(i).some(x => x.balanceCheck === 'fail'));
    if (confirmed) add('warning', 'REPEATED_TRANSACTION', `Rows ${first + 1} and ${i + 1} are identical (${t.date} ${t.description}). Running balances confirm both are on the statement; review only.`, {txn: i, page: t.page});
    else add('error', 'POSSIBLE_DUPLICATE', `Rows ${first + 1} and ${i + 1} are identical (${t.date} ${t.description}) and the running balance does not confirm both. Possible duplicated extraction.`, {txn: i, page: t.page});
    t.issues.push({severity: confirmed ? 'warning' : 'error', code: 'DUPLICATE'});
  });

  // 4. Completeness (page X of Y).
  const declared = Math.max(0, ...(parsed.pageMarkers || []).map(m => m.of));
  const seenNums = new Set((parsed.pageMarkers || []).map(m => m.page));
  let incomplete = false; let missingPages = [];
  if (declared) {
    for (let p = 1; p <= declared; p++) if (!seenNums.has(p)) missingPages.push(p);
    if (missingPages.length || (pageCount && pageCount < declared)) {
      incomplete = true;
      add('warning', 'INCOMPLETE_STATEMENT', `${sourceName} says it has ${declared} page(s) but only ${pageCount ?? seenNums.size} page(s) were provided${missingPages.length ? ` (missing page ${missingPages.join(', ')})` : ''}. Totals and closing balance cannot be fully reconciled.`);
    }
  }
  checks.push({check: 'Statement completeness', result: declared ? (incomplete ? 'fail' : 'pass') : 'skipped', details: declared ? `Page markers declare ${declared} page(s); ${seenNums.size} found` : 'No "Page X of Y" markers found; completeness cannot be confirmed'});

  // 5. Totals vs summary.
  const sumW = txns.reduce((s, t) => s + (t.withdrawal ?? 0), 0);
  const sumD = txns.reduce((s, t) => s + (t.deposit ?? 0), 0);
  const closing = parsed.closing?.cents ?? parsed.summary?.closing?.cents ?? null;
  const cmp = (label, got, want, code) => {
    if (want === null || want === undefined) { checks.push({check: label, result: 'skipped', details: 'Not stated in the document'}); return; }
    if (incomplete) { checks.push({check: label, result: 'skipped', details: `Statement incomplete; extracted ${f(got)} vs stated ${f(want)} not compared`}); return; }
    if (got === want) checks.push({check: label, result: 'pass', details: `${f(got)} matches statement`});
    else { checks.push({check: label, result: 'fail', details: `Extracted ${f(got)} vs statement ${f(want)} (difference ${f(got - want, {sign: true})})`}); add('error', code, `${label}: extracted ${f(got)} but statement shows ${f(want)} (difference ${f(got - want, {sign: true})}). Transactions may be missing or misread.`); }
  };
  cmp('Total deposits', sumD, parsed.summary?.totalDeposits?.cents, 'DEPOSIT_TOTAL_MISMATCH');
  cmp('Total withdrawals', sumW, parsed.summary?.totalWithdrawals?.cents, 'WITHDRAWAL_TOTAL_MISMATCH');
  const finalBalance = running;
  if (opening !== null) cmp('Closing balance (opening + deposits − withdrawals)', opening + sumD - sumW, closing, 'CLOSING_MISMATCH');
  else checks.push({check: 'Closing balance', result: 'skipped', details: 'No opening balance'});

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  let status;
  if (errors) status = 'failed';
  else if (incomplete) status = 'incomplete';
  else if (!checkpoints && closing === null) status = 'unverified';
  else if (opening === null) status = 'unverified';
  else status = 'verified';
  return {status, verified: status === 'verified', errors, warnings, issues, checks, incomplete, missingPages,
    totals: {transactions: txns.length, withdrawals: sumW, deposits: sumD, opening, closing, finalBalance}};
}

export function statusLabel(v) {
  return {verified: 'VERIFIED — all balance checks passed',
    incomplete: 'INCOMPLETE — visible rows are consistent, but the statement is missing pages; full reconciliation not possible',
    unverified: 'UNVERIFIED — not enough balance information in the document to verify',
    failed: 'FAILED — discrepancies found; review the Discrepancies sheet'}[v.status];
}
