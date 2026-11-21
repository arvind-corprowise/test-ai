// Regression test against the real RBC sample statement (test/fixtures/rbc-estatement.pdf).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseBankStatement, detectBankStatement} from '../bank.js';
import {validateStatement} from '../validate.js';
import {parseAmount} from '../money.js';
import {rbcEStatementPage, rbcEStatementText, RBC_EXPECTED} from './rbc-estatement.js';

const c = v => (v === null ? null : parseAmount(v));
function assertRbc(parsed, v) {
  const t = parsed.transactions;
  assert.equal(t.length, 11, t.map(x => `${x.date} | ${x.description} | ${x.withdrawal} | ${x.deposit} | ${x.balance}`).join('\n'));
  RBC_EXPECTED.forEach(([date, desc, wd, dp, bal], i) => {
    const row = t[i]; const label = `row ${i + 1} ${desc}`;
    assert.equal(row.date, date, label + ' date');
    assert.equal(row.description, desc, label + ' description');
    assert.equal(row.withdrawal, c(wd), label + ' withdrawal');
    assert.equal(row.deposit, c(dp), label + ' deposit');
    assert.equal(row.balance, c(bal), label + ' balance');
    assert.equal(typeof row.description, 'string'); assert.ok(!/\d+\.\d{2}$/.test(row.description), label + ': amount leaked into description');
  });
  assert.equal(parsed.opening.cents, 424714);
  assert.equal(v.totals.finalBalance, 378336);
  assert.equal(v.totals.deposits, 8515);
  assert.equal(v.totals.withdrawals, 54893);
  assert.equal(v.errors, 0, JSON.stringify(v.issues.filter(i => i.severity === 'error'), null, 1));
  assert.equal(v.status, 'incomplete');
  assert.deepEqual(v.missingPages, [2]);
  assert.equal(parsed.summary.totalDeposits.cents, 14515);
  assert.equal(parsed.summary.totalWithdrawals.cents, 72750);
  assert.equal(parsed.summary.closing.cents, 366479);
  // Page 2 is missing: extracted 85.15 vs stated 145.15 must NOT be reported as reconciled or as an error.
  assert.ok(v.checks.filter(x => /Total|Closing/.test(x.check)).every(x => x.result === 'skipped'));
  const checkpoints = t.filter(x => x.balance !== null);
  assert.ok(checkpoints.every(x => x.balanceCheck === 'pass'), 'every printed running balance must match');
}

test('RBC eStatement (real page geometry): every amount, direction, date and balance', () => {
  const pages = [{page: 1, method: 'text', text: rbcEStatementText(), words: rbcEStatementPage()}];
  assert.ok(detectBankStatement(pages));
  const parsed = parseBankStatement(pages);
  assertRbc(parsed, validateStatement(parsed, {pageCount: 1}));
});

test('RBC eStatement: column mapping comes from header positions, not text order', () => {
  // Shift the whole page right by 40pt: mapping must follow the headers.
  const words = rbcEStatementPage().map(w => ({...w, x0: w.x0 + 40, x1: w.x1 + 40}));
  const parsed = parseBankStatement([{page: 1, method: 'text', text: rbcEStatementText(), words}]);
  assertRbc(parsed, validateStatement(parsed, {pageCount: 1}));
});

const hasPoppler = (() => { try { execFileSync('pdftotext', ['-v'], {stdio: 'ignore'}); return true; } catch { return false; } })();
test('RBC eStatement through real Poppler extraction', {skip: !hasPoppler && 'pdftotext not installed on this machine'}, async () => {
  const {extractDocument, _setDeps} = await import('../extract.js'); _setDeps(null);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kad-rbc-'));
  const pdf = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rbc-estatement.pdf');
  const ex = await extractDocument({path: pdf, originalname: 'eStatement.pdf'}, {dataDir: dir});
  assert.equal(ex.pages[0].method, 'text', 'digital PDF must not be OCR’d');
  assert.ok(ex.pages[0].words?.length, 'word coordinates must be captured');
  const parsed = parseBankStatement(ex.pages);
  assertRbc(parsed, validateStatement(parsed, {pageCount: ex.pageCount}));
});
