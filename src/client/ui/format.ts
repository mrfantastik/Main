import type { Emotion, HappeningKind } from "../../sim/types";

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

/** Emotions in the order the UI lists them, with an icon and a colour each. */
export const EMOTION_UI: { key: Emotion; label: string; emoji: string; color: string }[] = [
  { key: "joy", label: "Joy", emoji: "😄", color: "#f2c94c" },
  { key: "love", label: "Love", emoji: "🥰", color: "#d65db1" },
  { key: "gratitude", label: "Gratitude", emoji: "🙏", color: "#22c3d6" },
  { key: "pride", label: "Pride", emoji: "😎", color: "#f59e2c" },
  { key: "sadness", label: "Sadness", emoji: "😢", color: "#4f8ef7" },
  { key: "anger", label: "Anger", emoji: "😠", color: "#e5484d" },
  { key: "fear", label: "Fear", emoji: "😰", color: "#a46cf5" },
  { key: "shame", label: "Shame", emoji: "😳", color: "#ff6f91" },
  { key: "envy", label: "Envy", emoji: "😒", color: "#2fbf71" },
  { key: "loneliness", label: "Loneliness", emoji: "😔", color: "#8d9ab0" },
];

export const VALUE_LABEL: Record<string, string> = {
  family: "👪 Family",
  status: "🏅 Status",
  freedom: "🕊️ Freedom",
  security: "🛡️ Security",
  fairness: "⚖️ Fairness",
  wealth: "💷 Wealth",
  community: "🤝 Community",
  knowledge: "📚 Knowledge",
};

/** Town happenings God Mode can trigger (who or what they need). */
export const HAPPENING_UI: { kind: HappeningKind; icon: string; label: string; target: "citizen" | "business" | null }[] = [
  { kind: "festival", icon: "🎪", label: "Festival in the park", target: null },
  { kind: "party", icon: "🎉", label: "Birthday party at the pub", target: "citizen" },
  { kind: "lottery", icon: "🎟️", label: "Lottery win", target: "citizen" },
  { kind: "celebrity", icon: "🌟", label: "Celebrity visit", target: "business" },
  { kind: "storm", icon: "⛈️", label: "Storm", target: null },
  { kind: "power_cut", icon: "🔌", label: "Power cut", target: null },
  { kind: "fire", icon: "🔥", label: "Fire at a business", target: "business" },
  { kind: "burglary", icon: "🚨", label: "Break-in", target: "citizen" },
  { kind: "food_poisoning", icon: "🤢", label: "Food poisoning at a café", target: "business" },
  { kind: "rent_rise", icon: "🏠", label: "Rent rise", target: null },
  { kind: "sculpture", icon: "🏛️", label: "Mysterious column in the park", target: null },
];

/** The AI that writes conversations, as labels show it ("Free AI" or "Claude"). */
export function aiName(free: boolean | undefined): string {
  return free ? "Free AI" : "Claude";
}
