// Israeli VAT / company id (עוסק מורשה / ח.פ.): 9 digits with a Luhn-style check digit.
// 8-digit ids are the same number printed without its leading zero.

/** Digits only, 8-digit ids padded to 9. Returns null when the result isn't 9 digits. */
export function normalizeVatId(value: string | null | undefined): string | null {
  if (!value) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 8) digits = '0' + digits;
  return digits.length === 9 ? digits : null;
}

/** True when the value normalizes to 9 digits and passes the Israeli checksum. */
export function isValidVatIdChecksum(value: string | null | undefined): boolean {
  const digits = normalizeVatId(value);
  if (!digits) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = parseInt(digits[i], 10);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
