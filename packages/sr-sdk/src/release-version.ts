/** Stable creator releases use three non-negative safe integer segments. */
export type ReleaseVersion = readonly [number, number, number];

export function parseReleaseVersion(value: unknown): ReleaseVersion | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function isReleaseVersion(value: unknown): value is string {
  return parseReleaseVersion(value) !== null;
}

export function compareReleaseVersion(left: string, right: string): -1 | 0 | 1 {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right);
  if (!a || !b) throw new RangeError('Invalid stable release version');
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}
