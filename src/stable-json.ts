function compareKeys(left: string, right: string): number {
  // Code-unit ordering is locale-independent, which keeps output byte-identical across machines.
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, item]) => [key, normalize(item)])
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}
