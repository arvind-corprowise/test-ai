// Builds synthetic statement text in the same column layout `pdftotext -layout` produces.
// NOTE: this is a synthetic fixture modelled on the RBC sample described in the requirements
// (page 1 of 2, opening 4,247.14, 11 transactions, running balance 3,783.36). It is not the real PDF.
const W_END = 76, D_END = 100, B_END = 118;
const put = (line, text, end) => { line = line.padEnd(end - text.length); return line + text; };
export function row(date, desc, w = '', d = '', b = '') {
  let l = (date || '').padEnd(10) + desc;
  if (w) l = put(l, w, W_END);
  if (d) l = put(l, d, D_END);
  if (b) l = put(l, b, B_END);
  return l;
}
export const header = () => put(put(put('Date      Description', 'Cheques & Debits ($)', W_END), 'Deposits & Credits ($)', D_END), 'Balance ($)', B_END);

export const RBC_ROWS = [
  ['', 'Opening Balance', '', '', '4,247.14'],
  ['15 Mar', 'Transfer from savings', '', '85.00', ''],
  ['', 'Interest paid', '', '.15', '4,332.29'],
  ['17 Mar', 'ATM withdrawal - 5PK3', '60.00', '', ''],
  ['', 'Interac purchase - 1361', '', '', ''],          // multiline description, line 1
  ['', 'THE BAY #5012', '125.13', '', '4,147.16'],      // line 2 carries the amount
  ['18 Mar', 'Cheque - 30', '148.11', '', '3,999.05'],
  ['21 Mar', 'Interac purchase - 2251 HIGHLAND FARMS', '6.94', '', ''],
  ['', 'ATM withdrawal - 7QX1', '100.00', '', '3,892.11'],
  ['26 Mar', 'Interac purchase - 1361 NASR FOODS', '47.82', '', ''],
  ['', 'Interac purchase - 1361 NASR FOODS', '29.94', '', '3,814.35'],
  ['28 Mar', 'Cheque - 31', '25.99', '', ''],
  ['', 'Monthly fee', '5.00', '', '3,783.36'],
];

export function rbcPage(rows = RBC_ROWS, {pageOf = '1 of 2', summary = true} = {}) {
  const lines = ['ROYAL SAMPLE BANK                                          Your account statement', ''];
  if (summary) lines.push(
    'Summary of your account for this period',
    'Your opening balance on March 15                         $4,247.14',
    'Total deposits into your account                          + 1,285.15',
    'Total withdrawals from your account                       - 2,001.00',
    'Your closing balance on April 14                       = $3,531.29', '');
  lines.push('Details of your account activity', header());
  for (const r of rows) lines.push(row(...r));
  lines.push('', `                                                                               Page ${pageOf}`);
  return lines.join('\n');
}
export const pages = (...texts) => texts.map((text, i) => ({page: i + 1, method: 'text', text}));
