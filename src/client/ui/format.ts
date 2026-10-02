export function gbp(v: number | null | undefined, digits?: number): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  const d = digits ?? (a >= 100 ? 0 : a % 1 === 0 ? 0 : 2);
  return `${sign}£${a.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function clock(t: number): string {
  const m = Math.floor(((t % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function day(t: number): number {
  return Math.floor(t / 1440) + 1;
}

export function when(t: number): string {
  return `D${day(t)} ${clock(t)}`;
}

export function initials(name: string): string {
  return name.slice(0, 2);
}

export const OCC_COLORS: Record<string, string> = {
  unemployed: "#9aa3ad",
  employee: "#4f8ef7",
  freelancer: "#a46cf5",
  shopkeeper: "#f59e2c",
  reseller: "#2fbf71",
  trader: "#e5484d",
  entrepreneur: "#f2c94c",
  researcher: "#22c3d6",
};

export const OCC_LABEL: Record<string, string> = {
  unemployed: "Unemployed",
  employee: "Employee",
  freelancer: "Freelancer",
  shopkeeper: "Shopkeeper",
  reseller: "Reseller",
  trader: "Trader",
  entrepreneur: "Entrepreneur",
  researcher: "Researcher",
};

export const KIND_LABEL: Record<string, string> = {
  shop: "Shop",
  stall: "Market stall",
  cafe: "Café",
  agency: "Agency",
};
