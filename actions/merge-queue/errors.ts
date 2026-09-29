// One place for the stderr / message / thrown-value fallbacks so each arm
// is a tested branch instead of a copy at every catch.
export function errorText(err: unknown): string {
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const record = err as { stderr?: unknown; message?: unknown }
    if (record.stderr) return String(record.stderr)
    if (record.message) return String(record.message)
  }
  return String(err)
}
