// Balance knobs. Tweak these to change how the economy behaves.
// Money is fictional (£ sim-pounds). Nothing here touches real money.

export const CONFIG = {
  startingMoney: 100,
  citizenCount: 20,

  /** Walking speed in tiles per game minute. */
  walkSpeed: 1.1,

  // ---- living costs
  /** City Diner meal price (external business). */
  dinerMealPrice: 7,
  pubDrinkPrice: 5,
  /** Every 7 days rent is charged. Per-house rent is set in the map. */
  rentPeriodDays: 7,
  evictAfterArrears: 2.0, // multiples of weekly rent

  // ---- incomes
  corpBaseWage: 42,
  corpOpenings: 6,
  grant: 30,
  labPlaces: 3,
  welfare: 8,
  /** £ of freelance/agency work demanded per day in a normal economy. */
  serviceDemand: 360,
  /** Max £/hour a freelancer can bill, scaled by skill. */
  serviceRateCap: 9,

  // ---- banking
  depositRatePerDay: 0.002,
  bankLoanRate: 0.12,
  bankLoanDays: 10,

  // ---- businesses
  rent: { shop: 9, stall: 3, cafe: 9, agency: 10 } as Record<string, number>,
  startupCost: { shop: 140, stall: 50, cafe: 130, agency: 120 } as Record<string, number>,
  /** Customers per hour a business can serve: base + per staff member. */
  capacityBase: 3,
  capacityPerStaff: 4,
  bankruptAfterDaysInRed: 3,

  // ---- marketplace
  externalLotsPerDay: 5,

  // ---- AI
  strategyCooldownMin: 18 * 60,
  careerChangeCooldownDays: 3,
} as const;

/** Colours per occupation (used by renderer and UI). */
export const OCCUPATION_COLORS: Record<string, string> = {
  unemployed: "#9aa3ad",
  employee: "#4f8ef7",
  freelancer: "#a46cf5",
  shopkeeper: "#f59e2c",
  reseller: "#2fbf71",
  trader: "#e5484d",
  entrepreneur: "#f2c94c",
  researcher: "#22c3d6",
};

export const OCCUPATION_LABELS: Record<string, string> = {
  unemployed: "Unemployed",
  employee: "Employee",
  freelancer: "Freelancer",
  shopkeeper: "Shopkeeper",
  reseller: "Reseller",
  trader: "Trader",
  entrepreneur: "Entrepreneur",
  researcher: "Researcher",
};
