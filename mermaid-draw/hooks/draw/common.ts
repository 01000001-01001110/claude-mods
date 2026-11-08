//! Small pieces every diagram reader shares: a numbered source line and the
//! `{name}` template filler used for every line of text from the data.

/** A line of a fence's source with its 1-based number, for warnings. */
export interface Line {
  n: number
  text: string
}

/** Fills `{name}` slots in a template from `values`; an unknown slot is left as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))
}
