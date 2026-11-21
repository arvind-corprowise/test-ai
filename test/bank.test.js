import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBankStatement, detectBankStatement} from '../bank.js';
import {validateStatement} from '../validate.js';
import {parseAmount, formatCents} from '../money.js';
import {rbcPage, RBC_ROWS, pages, header, row} from './helpers.js';

const run = (texts, pageCount) => { const parsed = parseBankStatement(pages(...texts)); return {parsed, v: validateStatement(parsed, {pageCount: pageCount ?? texts.length})}; };
const codes = v => v.issues.map(i => i.code);

test('money parsing is decimal-safe and handles .15, commas, signs', () => {
  assert.equal(parseAmount('.15'), 15);
  assert.equal(parseAmount('4,247.14'), 424714);
  assert.equal(parseAmount('$85.00'), 8500);
  assert.equal(parseAmount('(12.50)'), -1250);
  assert.equal(parseAmount('12.50-'), -1250);
  assert.equal(parseAmount('+ 85.15'), 8515);
  assert.equal(parseAmount('abc'), null);
  assert.equal(formatCents(424714), '4,247.14');
  // 0.1 + 0.2 style float errors cannot occur.
  assert.equal(parseAmount('0.10') + parseAmount('0.20'), parseAmount('0.30'));
});

test('RBC regression (synthetic page 1 of 2): 11 transactions, running balance 3,783.36, incomplete not verified', () => {
  const {parsed, v} = run([rbcPage()]);
  assert.ok(detectBankStatement(pages(rbcPage())));
  const t = parsed.transactions;
  assert.equal(t.length, 11, t.map(x => x.description).join('\n'));
  assert.equal(parsed.opening.cents, 424714);
  assert.ok(!t.some(x => /opening balance/i.test(x.description)), 'opening balance must not be a transaction');
  const find = s => t.find(x => x.description.includes(s));
  assert.equal(find('Transfer').deposit, 8500);
  assert.equal(find('Interest').deposit, 15);
  assert.equal(find('Interest').date, '15 Mar'); assert.equal(find('Interest').dateCarried, true);
  assert.equal(find('Cheque - 30').withdrawal, 14811);
  assert.equal(find('ATM withdrawal - 5PK3').withdrawal, 6000);
  assert.equal(find('THE BAY').withdrawal, 12513);
  assert.equal(find('THE BAY').description, 'Interac purchase - 1361 THE BAY #5012');
  assert.equal(find('HIGHLAND').withdrawal, 694);
  assert.equal(v.totals.finalBalance, 378336);
  assert.equal(v.errors, 0, JSON.stringify(v.issues.filter(i => i.severity === 'error'), null, 1));
  assert.equal(v.status, 'incomplete');
  assert.equal(v.verified, false);
  assert.ok(codes(v).includes('INCOMPLETE_STATEMENT'));
  assert.deepEqual(v.missingPages, [2]);
  assert.ok(v.checks.filter(c => /Total|Closing/.test(c.check)).every(c => c.result === 'skipped'), 'must not claim totals reconcile without page 2');
});

test('missing transaction is detected by balance mismatch', () => {
  const rows = RBC_ROWS.filter(r => !r[1].startsWith('Cheque - 30'));
  const {v} = run([rbcPage(rows)]);
  assert.equal(v.status, 'failed');
  const m = v.issues.find(i => i.code === 'BALANCE_MISMATCH');
  assert.ok(m); assert.equal(m.difference, -14811);
});

test('duplicated extraction row is flagged', () => {
  const rows = [...RBC_ROWS]; rows.splice(7, 0, ['18 Mar', 'Cheque - 30', '148.11', '', '']);
  const {v} = run([rbcPage(rows)]);
  assert.equal(v.status, 'failed');
  assert.ok(codes(v).includes('POSSIBLE_DUPLICATE'));
});

test('legitimate repeated purchase confirmed by balances is a warning, not an error', () => {
  const rows = RBC_ROWS.map(r => r[1] === 'Monthly fee' ? [r[0], r[1], '5.00', '', ''] : r);
  rows.push(['', 'Monthly fee', '5.00', '', '3,778.36']);
  const {v} = run([rbcPage(rows)]);
  assert.equal(v.errors, 0, JSON.stringify(v.issues));
  assert.ok(codes(v).includes('REPEATED_TRANSACTION'));
});

test('debit placed in credit column is detected', () => {
  const rows = RBC_ROWS.map(r => r[1] === 'Cheque - 30' ? [r[0], r[1], '', '148.11', r[4]] : r);
  const {v} = run([rbcPage(rows)]);
  assert.ok(codes(v).includes('DEBIT_CREDIT_SWAPPED'), JSON.stringify(codes(v)));
  assert.equal(v.status, 'failed');
});

test('incorrect amount / balance is detected', () => {
  const rows = RBC_ROWS.map(r => r[1] === 'Monthly fee' ? [r[0], r[1], '5.00', '', '3,783.63'] : r);
  const {v} = run([rbcPage(rows)]);
  assert.ok(codes(v).includes('BALANCE_MISMATCH'));
});

test('complete 2-page statement verifies and compares summary totals', () => {
  const p1 = rbcPage(RBC_ROWS, {pageOf: '1 of 2', summary: false})
    .replace('Details of your account activity', 'Your opening balance on March 15   $4,247.14\nTotal deposits into your account   + 1,085.15\nTotal withdrawals from your account   - 1,048.93\nYour closing balance on April 14   $4,283.36\n\nDetails of your account activity');
  const p2 = ['Details of your account activity - continued', header(),
    row('02 Apr', 'Payroll deposit', '', '1,000.00', ''), row('', 'Rent', '500.00', '', '4,283.36'),
    row('', 'Closing Balance', '', '', '4,283.36'), '', '                    Page 2 of 2'].join('\n');
  const {parsed, v} = run([p1, p2]);
  assert.equal(parsed.transactions.length, 13);
  assert.equal(v.errors, 0, JSON.stringify(v.issues, null, 1));
  assert.equal(v.status, 'verified');
  assert.ok(v.checks.find(c => c.check === 'Total deposits').result === 'pass');
  assert.ok(!parsed.transactions.some(t => /closing balance/i.test(t.description)));
});

test('summary totals mismatch on a complete statement is an error', () => {
  const p = rbcPage(RBC_ROWS, {pageOf: '1 of 1', summary: false}).replace('Details of', 'Total deposits into your account   + 90.15\nDetails of');
  const {v} = run([p]);
  assert.ok(codes(v).includes('DEPOSIT_TOTAL_MISMATCH'));
});

test('OCR pipe-table output (scanned page) is parsed deterministically', () => {
  const ocr = ['Date | Description | Withdrawals | Deposits | Balance', '--- | --- | --- | --- | ---',
    ' | Opening balance |  |  | 100.00', '01 Jan | Coffee shop | 4.50 |  | 95.50', ' | Refund |  | .50 | 96.00', 'Page 1 of 1'].join('\n');
  const parsed = parseBankStatement([{page: 1, method: 'ocr', text: ocr}]);
  const v = validateStatement(parsed, {pageCount: 1});
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[1].deposit, 50);
  assert.equal(parsed.transactions[1].date, '01 Jan');
  assert.equal(v.errors, 0);
});

test('non-statement text is not detected as a bank statement', () => {
  assert.equal(detectBankStatement(pages('Meeting notes\nAttendees: A, B\nBudget 1,200.00 approved')), false);
});

test('strict schema: text in amount fields or numeric descriptions are errors', () => {
  const parsed = {transactions: [
    {date: '15 Mar', description: '85.00', withdrawal: null, deposit: 8500, balance: null, sourceLines: [1], flags: []},
    {date: 'Transfer', description: 'x', withdrawal: 'abc', deposit: null, balance: null, sourceLines: [2], flags: []}],
    anomalies: [], summary: {}, pageMarkers: []};
  const v = validateStatement(parsed, {pageCount: 1});
  const c = v.issues.map(i => i.code);
  assert.ok(c.includes('SCHEMA_DESCRIPTION') && c.includes('SCHEMA_AMOUNT') && c.includes('SCHEMA_DATE'));
  assert.equal(v.status, 'failed');
});
