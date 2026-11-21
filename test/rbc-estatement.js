// Geometry of the real RBC sample "eStatement.pdf" (page 1 of 2), as pdftotext -bbox reports it:
// x positions measured from the PDF's own text operators; amounts right-aligned to each header's right edge
// (Withdrawals ≈ 371pt, Deposits ≈ 461pt, Balance ≈ 582pt). y grows downward (top-origin points).
const CW = 4.67, DW = 4.2; // digit and text glyph widths at ~8.5pt
const word = (t, x0, y, cw = DW) => ({t, x0, x1: +(x0 + t.length * cw).toFixed(2), y0: y - 7, y1: y + 1.5});
const words = (text, x0, y, cw = DW) => { const out = []; let x = x0; for (const t of text.split(' ')) { out.push(word(t, x, y, cw)); x = out.at(-1).x1 + 2.3; } return out; };
const right = (t, xr, y) => word(t, +(xr - t.length * CW).toFixed(2), y, CW);
const W = 371, D = 461, B = 582;

export const RBC_EXPECTED = [
  ['15 Mar', 'Transfer', null, '85.00', null],
  ['15 Mar', 'Interest paid', null, '.15', null],
  ['15 Mar', 'ATM withdrawal', '100.00', null, null],
  ['15 Mar', 'Interac purchase -1361 - Nasr Foods Inc.', '47.82', null, '4,184.47'],
  ['17 Mar', 'Overdraft interest', '0.93', null, '4,183.54'],
  ['18 Mar', 'Cheque #30', '40.00', null, null],
  ['18 Mar', 'Cheque #31', '148.11', null, '3,995.43'],
  ['19 Mar', 'ATM withdrawal', '60.00', null, '3,935.43'],
  ['22 Mar', 'ATM withdrawal', '20.00', null, null],
  ['22 Mar', 'Interac purchase - 1361 - The Bay', '125.13', null, null],
  ['22 Mar', 'Interac purchase - 1361 - Highland Farms', '6.94', null, '3,783.36'],
];

export function rbcEStatementPage() {
  const w = [];
  const top = y => 792 - y; // convert from the PDF's bottom-origin coordinates
  w.push(...words('Your personal chequing', 319, top(715), 12), ...words('account statement', 376, top(688), 12));
  w.push(...words('From March 12, 2004 to April 12, 2004', 429, top(670)));
  // Summary (left) and the "RBC is now paperless!" panel (right) share lines.
  w.push(...words('Summary of your account for this period', 33, top(508), 7));
  w.push(...words('RBC is now paperless!', 382, top(512)));
  w.push(...words('Your opening balance on March 12, 2004', 33, top(443)), word('$4,247.14', 318, top(443), CW));
  w.push(...words('not already an RBC Royal Bank Online Banking', 382, top(437)));
  w.push(...words('Total deposits into your account', 33, top(429)), word('+', 340, top(429)), word('145.15', 348, top(429), CW));
  w.push(...words('Total withdrawals from your account', 33, top(415)), word('-', 326, top(415)), word('727.50', 333, top(415), CW));
  w.push(...words('simply call 1-800-ROYAL® 5-5 (1-800-769-2555).', 382, top(415)));
  w.push(...words('Your closing balance on April 12, 2004', 33, top(400)), word('=', 310, top(400)), word('$3,664.79', 316, top(400), CW));
  w.push(...words('Details of your account activity', 33, top(345), 7));
  // Table header
  const hy = top(325);
  w.push(word('Date', 33, hy), word('Description', 77, hy), ...words('Withdrawals ($)', 316, hy, 3.9), ...words('Deposits ($)', 419, hy, 3.6), ...words('Balance ($)', 543, hy, 3.6));
  // Opening balance row
  w.push(...words('Opening balance', 77, top(311)), right('4,247.14', B, top(311)));
  const ys = [297, 283, 269, 255, 241, 227, 213, 199, 185, 171, 157];
  const firstOfDate = new Set([0, 4, 5, 7, 8]);
  RBC_EXPECTED.forEach(([date, desc, wd, dp, bal], i) => {
    const y = top(ys[i]);
    if (firstOfDate.has(i)) w.push(...words(date, 33, y));
    w.push(...words(desc, 77, y));
    if (wd) w.push(right(wd, W, y));
    if (dp) w.push(right(dp, D, y));
    if (bal) w.push(right(bal, B, y));
  });
  w.push(...words('1 of 2', 561, top(82)));
  return w;
}

/** Plain layout-style text for the same page (used for summary and page markers). */
export function rbcEStatementText() {
  return ['Your opening balance on March 12, 2004                         $4,247.14',
    'Total deposits into your account                                 + 145.15',
    'Total withdrawals from your account                              - 727.50',
    'Your closing balance on April 12, 2004                         = $3,664.79', '',
    'Details of your account activity',
    'Date   Description         Withdrawals ($)   Deposits ($)   Balance ($)',
    '', '                                                                        1 of 2'].join('\n');
}
