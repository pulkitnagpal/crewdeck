// A small JSON Schema (draft-07) checker for the keywords the Claude Code settings schema subset uses: type, properties,
// additionalProperties, items, required, enum, pattern, minLength, minimum, maximum, uniqueItems, $ref to #/$defs.
export function checkSchema(schema: any, value: unknown, root = schema, at = '$'): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: not allowed`];
  if (schema.$ref) return checkSchema(schema.$ref.replace(/^#\/\$defs\//, '').split('/').reduce((o: any, k: string) => o?.[k], root.$defs), value, root, at);
  const out: string[] = [];
  const t = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((x: string) => x === t || (x === 'number' && t === 'integer'))) return [`${at}: ${t}, expected ${types.join('|')}`];
  }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} not in ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${at}: duplicate items`);
    value.forEach((v, i) => out.push(...checkSchema(schema.items, v, root, `${at}[${i}]`)));
  }
  if (t === 'object') {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) out.push(`${at}.${r}: required`);
    for (const [k, v] of Object.entries(o)) {
      if (schema.properties && Object.hasOwn(schema.properties, k)) out.push(...checkSchema(schema.properties[k], v, root, `${at}.${k}`));
      else if (schema.additionalProperties !== undefined) out.push(...checkSchema(schema.additionalProperties, v, root, `${at}.${k}`));
    }
  }
  return out;
}
