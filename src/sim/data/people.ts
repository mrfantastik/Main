import type { Traits } from "../types";

export const FIRST_NAMES = [
  "Jake", "Sarah", "Mike", "Priya", "Tom", "Aisha", "Alex", "Chloe", "Omar", "Grace",
  "Ben", "Zara", "Ethan", "Mei", "Dan", "Sofia", "Kwame", "Hannah", "Leo", "Ruby",
  "Nadia", "Sam", "Ivy", "Raj", "Lucy", "Femi", "Nina", "Oscar", "Jade", "Theo",
  "Amara", "Finn", "Rosa", "Kai", "Elena", "Marcus", "Tara", "Yusuf", "Holly", "Ravi",
];

export const SURNAMES = [
  "Walker", "Patel", "Okafor", "Chen", "Murphy", "Khan", "Hughes", "Nowak", "Silva", "Reid",
  "Mensah", "Clarke", "Haddad", "Evans", "Kowalski", "Ito", "Byrne", "Ahmed", "Moreau", "Price",
];

/**
 * Personality archetypes. A citizen gets a primary and a secondary archetype;
 * traits are blended from them plus noise. These traits weight every utility
 * score in the AI, so archetypes genuinely change behaviour.
 */
export const ARCHETYPES: Record<string, Partial<Traits>> = {
  Ambitious: { ambition: 0.95, diligence: 0.75, risk: 0.6 },
  "Risk-taking": { risk: 0.95, frugality: 0.2, entrepreneurship: 0.6 },
  Conservative: { risk: 0.1, frugality: 0.85, diligence: 0.65 },
  Lazy: { diligence: 0.12, ambition: 0.2, sociability: 0.6 },
  Friendly: { sociability: 0.95, generosity: 0.7, competitiveness: 0.2 },
  Competitive: { competitiveness: 0.95, ambition: 0.75, generosity: 0.25 },
  Entrepreneurial: { entrepreneurship: 0.95, ambition: 0.75, risk: 0.65 },
  Greedy: { greed: 0.95, generosity: 0.1, competitiveness: 0.6 },
  Generous: { generosity: 0.95, greed: 0.1, sociability: 0.7 },
  Frugal: { frugality: 0.95, risk: 0.3, greed: 0.5 },
  Curious: { ambition: 0.6, risk: 0.5, diligence: 0.7 },
};

export const BASE_TRAITS: Traits = {
  ambition: 0.5,
  risk: 0.45,
  sociability: 0.5,
  generosity: 0.45,
  greed: 0.45,
  diligence: 0.55,
  competitiveness: 0.45,
  entrepreneurship: 0.35,
  frugality: 0.5,
};

export const CITIZEN_COLORS = [
  "#ff7a59", "#ffc75f", "#f9f871", "#845ec2", "#d65db1", "#ff6f91", "#00c9a7", "#4d8076",
  "#c34a36", "#4b4453", "#b0a8b9", "#ff8066", "#0089ba", "#2c73d2", "#008e9b", "#c4fcef",
  "#fbeaff", "#9b89b3", "#f3c5ff", "#00d2fc",
];
