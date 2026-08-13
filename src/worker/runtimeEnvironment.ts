export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function nonNegativeIntegerEnvironment(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer.`);
  return Number(value);
}

export function requiredArgument(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
