/**
 * Money helpers. Every amount in Trip Guardian is a whole number of rupees.
 *
 * We print "Rs" rather than the rupee glyph on purpose: it renders identically
 * in every terminal and in a screen recording, which matters for the demo.
 */

/** True only for a finite, non negative, whole number of rupees. */
export function isValidAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Format rupees the Indian way (lakh grouping), for example 15000 -> "Rs 15,000".
 * Negative amounts print with the sign in front, for example "-Rs 450".
 */
export function formatINR(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const grouped = Math.abs(amount).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return `${sign}Rs ${grouped}`;
}
