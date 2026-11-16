/** Wraps a value in single quotes for a device-side shell command. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
