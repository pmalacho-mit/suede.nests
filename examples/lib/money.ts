// A first-party module the examples import, with state of its own so that the
// isolation contract is visible: each test gets a fresh copy of this module.

let conversions = 0;

/** How many times this module has formatted an amount. */
export const conversionCount = () => conversions;

/** Cents as a display string: `1234` → `"$12.34"`. */
export function formatCents(cents: number): string {
  conversions += 1;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
