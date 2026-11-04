// Which of the options a model's answer means. Models (small local ones
// especially) don't always give the id exactly as listed: "[work]", "Work",
// "work.", the option's label, or its number in the list all mean the same
// thing, and turning those down would leave people standing there waiting
// to be asked again.

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[^a-z0-9£]+/g, " ")
    .trim();

/** The option the answer names (undefined: none of them, or it could be more than one). */
export function matchOption<T extends { id: string; label: string }>(answer: unknown, options: readonly T[]): T | undefined {
  if (typeof answer === "number") return Number.isInteger(answer) ? options[answer - 1] : undefined;
  if (typeof answer !== "string") return undefined;
  const raw = answer.trim();
  const exact = options.find((o) => o.id === raw);
  if (exact) return exact;
  const byId = (s: string) => options.find((o) => o.id === s) ?? options.find((o) => o.id.toLowerCase() === s.toLowerCase());
  // "[work] Go to work": the id it starts with.
  const lead = raw.match(/^\[([^\]]+)\]/)?.[1]?.trim();
  if (lead && byId(lead)) return byId(lead);
  const s = raw.replace(/^[\s"'“‘[(]+|[\s"'”’\]).!,;:]+$/g, "");
  if (!s) return undefined;
  if (byId(s)) return byId(s);
  // "2": the second one on the list.
  if (/^\d{1,2}$/.test(s)) return options[Number(s) - 1];
  // The label, or (if it can only be one of them) the start of it.
  const n = norm(s);
  if (!n) return undefined;
  const same = options.filter((o) => norm(o.label) === n);
  if (same.length === 1) return same[0];
  if (n.length >= 6) {
    const starts = options.filter((o) => {
      const l = norm(o.label);
      return l.startsWith(n) || n.startsWith(l);
    });
    if (starts.length === 1) return starts[0];
  }
  return undefined;
}
