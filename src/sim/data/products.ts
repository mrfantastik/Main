import type { Product } from "../types";

type ProductSeed = Omit<Product, "inventorId" | "royalty" | "inventedT">;

/** Products traded from day 1. Data-driven: add rows to add products. */
export const STARTING_PRODUCTS: ProductSeed[] = [
  { id: "food", name: "Groceries", emoji: "🥦", category: "essential", baseCost: 2.5, baseRetail: 5, externalDemand: 27.2, volatility: 0.03 },
  { id: "coffee", name: "Coffee", emoji: "☕", category: "consumable", baseCost: 1, baseRetail: 3, externalDemand: 35.2, volatility: 0.04 },
  { id: "clothes", name: "Clothes", emoji: "👕", category: "durable", baseCost: 11, baseRetail: 22, externalDemand: 7.2, volatility: 0.05 },
  { id: "trainers", name: "Trainers", emoji: "👟", category: "luxury", baseCost: 28, baseRetail: 55, externalDemand: 4.0, volatility: 0.07 },
  { id: "phones", name: "Phones", emoji: "📱", category: "luxury", baseCost: 105, baseRetail: 180, externalDemand: 1.3, volatility: 0.06 },
  { id: "books", name: "Books", emoji: "📚", category: "durable", baseCost: 5, baseRetail: 11, externalDemand: 6.4, volatility: 0.03 },
  { id: "gadgets", name: "Gadgets", emoji: "🎧", category: "luxury", baseCost: 20, baseRetail: 40, externalDemand: 3.2, volatility: 0.08 },
];

/** Things researchers can invent. A breakthrough adds one as a brand new product. */
export const INVENTIONS: ProductSeed[] = [
  { id: "smartwatch", name: "Smart Watches", emoji: "⌚", category: "luxury", baseCost: 45, baseRetail: 95, externalDemand: 3, volatility: 0.09 },
  { id: "ebike", name: "E-Bikes", emoji: "🚲", category: "luxury", baseCost: 160, baseRetail: 300, externalDemand: 0.9, volatility: 0.07 },
  { id: "plantburger", name: "Plant Burgers", emoji: "🍔", category: "consumable", baseCost: 2, baseRetail: 6, externalDemand: 25, volatility: 0.05 },
  { id: "vrheadset", name: "VR Headsets", emoji: "🥽", category: "luxury", baseCost: 90, baseRetail: 170, externalDemand: 1.4, volatility: 0.1 },
  { id: "drone", name: "Mini Drones", emoji: "🛸", category: "luxury", baseCost: 38, baseRetail: 80, externalDemand: 2.5, volatility: 0.1 },
  { id: "energydrink", name: "Energy Drinks", emoji: "🥤", category: "consumable", baseCost: 0.8, baseRetail: 2.5, externalDemand: 30, volatility: 0.05 },
];

export function inventionSeed(id: string): ProductSeed | undefined {
  return INVENTIONS.find((p) => p.id === id);
}
