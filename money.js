// Decimal-safe money handling. All amounts are integer cents (Number, exact up to ~9e13 dollars).
// Never use floating point for financial arithmetic.

const AMOUNT_SHAPE = /^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d{1,2})?$/;

// Parses "4,247.14", ".15", "$85.00", "(12.00)", "12.00-", "12.00 DR", "+ 85.15", "1 234,56"? (no: comma decimals unsupported → null)
export function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  let s = String(raw).trim().replace(/−/g, '-');
  if (!s || /^[-–—]+$/.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (/\s*CR$/i.test(s)) s = s.replace(/\s*CR$/i, '');
  else if (/\s*DR$/i.test(s)) { neg = !neg; s = s.replace(/\s*DR$/i, ''); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1).trim(); }
  if (/^[+]/.test(s)) s = s.slice(1).trim();
  if (/^-/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
  s = s.replace(/^(?:CAD|USD|C\$|US\$)\s*/i, '').replace(/^\$\s*/, '').trim();
  if (!s || !/\d/.test(s) || !AMOUNT_SHAPE.test(s)) return null;
  const [int, frac = ''] = s.replace(/,/g, '').split('.');
  const cents = Number(int || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

export function formatCents(cents, { sign = false } = {}) {
  if (cents === null || cents === undefined) return '';
  const neg = cents < 0; const abs = Math.abs(cents);
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = `${int}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : (sign ? `+${s}` : s);
}

// For Excel cells only (display). Exact for 2-decimal values.
export const centsToNumber = c => (c === null || c === undefined ? null : c / 100);

// Canonical digits used for traceability comparisons ("$4,247.14" -> "424714").
export const amountKey = raw => { const c = parseAmount(raw); return c === null ? null : String(Math.abs(c)); };
