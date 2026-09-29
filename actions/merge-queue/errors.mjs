// One place for the stderr / message / thrown-value fallbacks so each arm
// is a tested branch instead of a copy at every catch.
export function errorText(err) {
  if (typeof err === 'string') return err
  if (err && err.stderr) return String(err.stderr)
  if (err && err.message) return String(err.message)
  return String(err)
}
