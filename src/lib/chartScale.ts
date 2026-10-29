/** Axis with 4 equal steps of a clean size (1, 2, 2.5, 5 × 10ⁿ; whole numbers only), covering `max`. */
export function niceAxis(max: number): { max: number; ticks: number[] } {
  const raw = Math.max(max, 1) / 4;
  if (raw <= 10) {
    const step = Math.ceil(raw); // small counts: any whole step reads fine and fills the chart
    return { max: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => i * step) };
  }
  const pow = 10 ** Math.floor(Math.log10(raw));
  const steps = [1, 2, ...(pow >= 10 ? [2.5] : []), 5, 10].map((m) => m * pow);
  const step = Math.max(1, steps.find((s) => s >= raw) ?? 10 * pow);
  return { max: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => i * step) };
}
