import { CONFIG } from "../config";
import { registerAction } from "../ai/actions";
import { setThought } from "../ai/decision";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { addRole, adjustRel, getRel, removeRole } from "../social/relationships";
import type { Citizen, Loan, WorldState } from "../types";
import { avg, clamp, money, newId, round2 } from "../util";
import { citizenAcc, externalAcc, transfer } from "./ledger";

// Hustle Bank: savings accounts (with interest), loans, and the ledger of
// person-to-person loans. Defaults damage credit scores — and friendships.

export function activeLoans(world: WorldState, c: Citizen): Loan[] {
  return world.loans.filter((l) => l.borrower === c.id && l.status === "active");
}

export function outstanding(l: Loan): number {
  return round2(l.totalDue - l.paid);
}

/** Move cash into savings (or back). */
export function deposit(world: WorldState, c: Citizen, amount: number): number {
  amount = round2(Math.min(amount, c.money));
  if (amount <= 0) return 0;
  c.money = round2(c.money - amount);
  c.savings = round2(c.savings + amount);
  return amount;
}

export function withdraw(c: Citizen, amount: number): number {
  amount = round2(Math.min(amount, c.savings));
  if (amount <= 0) return 0;
  c.savings = round2(c.savings - amount);
  c.money = round2(c.money + amount);
  return amount;
}

/** Make sure `amount` is available as cash, drawing from savings if needed (debit card). */
export function ensureCash(c: Citizen, amount: number): boolean {
  if (c.money >= amount) return true;
  withdraw(c, amount - c.money);
  return c.money >= amount - 0.001;
}

export function maxBankLoan(world: WorldState, c: Citizen): number {
  if (c.creditScore < 30) return 0;
  if (world.loans.some((l) => l.borrower === c.id && l.lender === "bank" && l.status === "defaulted" && world.time - l.dueT < 10 * 1440)) return 0;
  const income = avg(c.finance.history.slice(-5).map((h) => h.income));
  const existing = activeLoans(world, c).filter((l) => l.lender === "bank").reduce((s, l) => s + outstanding(l), 0);
  return Math.max(0, Math.round(40 + c.creditScore * 3.5 + income * 4 - existing));
}

export function bankRateFor(world: WorldState, c: Citizen): number {
  return round2(world.economy.bankRate + clamp((60 - c.creditScore) / 400, -0.04, 0.15));
}

/** Ask the bank for a loan. Returns the loan if approved. */
export function takeBankLoan(world: WorldState, c: Citizen, amount: number, purpose: string): Loan | null {
  amount = Math.round(amount);
  if (amount <= 0 || amount > maxBankLoan(world, c)) return null;
  const rate = bankRateFor(world, c);
  const days = CONFIG.bankLoanDays;
  const totalDue = round2(amount * (1 + rate));
  const loan: Loan = {
    id: newId(world),
    lender: "bank",
    borrower: c.id,
    principal: amount,
    rate,
    totalDue,
    paid: 0,
    startT: world.time,
    dueT: world.time + days * 1440,
    installment: round2(totalDue / days),
    missed: 0,
    status: "active",
    purpose,
  };
  world.loans.push(loan);
  transfer(world, externalAcc("bank"), citizenAcc(c.id), amount, "loan", `Bank loan: ${purpose}`);
  logEvent(world, "finance", `🏦 ${c.name} took out a ${money(amount)} bank loan (${purpose}).`, 3, [c.id]);
  remember(world, c, { text: `I borrowed ${money(amount)} from the bank to ${purpose}. I owe ${money(totalDue)}.`, kind: "loan", importance: 6, valence: -0.1, people: [] });
  return loan;
}

/** Record a loan between two citizens (money moves immediately). */
export function createPeerLoan(world: WorldState, lender: Citizen, borrower: Citizen, amount: number, rate: number, days: number, purpose: string): Loan | null {
  amount = round2(amount);
  if (!transfer(world, citizenAcc(lender.id), citizenAcc(borrower.id), amount, "loan", `Loan to ${borrower.name}: ${purpose}`)) return null;
  const loan: Loan = {
    id: newId(world),
    lender: lender.id,
    borrower: borrower.id,
    principal: amount,
    rate: round2(rate),
    totalDue: round2(amount * (1 + rate)),
    paid: 0,
    startT: world.time,
    dueT: world.time + Math.max(1, days) * 1440,
    installment: 0,
    missed: 0,
    status: "active",
    purpose,
  };
  world.loans.push(loan);
  addRole(lender, borrower.id, "debtor");
  addRole(borrower, lender.id, "creditor");
  adjustRel(world, borrower, lender.id, { affinity: 10, trust: 6 });
  remember(world, borrower, {
    text: `${lender.name} lent me ${money(amount)} for ${purpose}. I owe ${money(loan.totalDue)} by Day ${Math.floor(loan.dueT / 1440) + 1}.`,
    kind: "loan",
    importance: 7,
    valence: 0.5,
    people: [lender.id],
    key: `loan:${loan.id}`,
  });
  remember(world, lender, {
    text: `I lent ${borrower.name} ${money(amount)} for ${purpose} at ${Math.round(rate * 100)}%.`,
    kind: "loan",
    importance: 6,
    valence: 0.1,
    people: [borrower.id],
    key: `loan:${loan.id}`,
  });
  return loan;
}

/** Pay part/all of a loan. Returns the amount paid. */
export function repay(world: WorldState, l: Loan, amount: number): number {
  const borrower = world.citizens[l.borrower];
  if (!borrower || l.status !== "active") return 0;
  amount = round2(Math.min(amount, outstanding(l)));
  if (amount <= 0 || !ensureCash(borrower, amount)) return 0;
  const to = l.lender === "bank" ? externalAcc("bank") : citizenAcc(l.lender);
  if (!transfer(world, citizenAcc(borrower.id), to, amount, "repayment", l.lender === "bank" ? "Bank loan repayment" : `Repaid ${world.citizens[l.lender]?.name}`)) return 0;
  l.paid = round2(l.paid + amount);
  if (outstanding(l) <= 0.01) settle(world, l);
  return amount;
}

function settle(world: WorldState, l: Loan): void {
  l.status = "repaid";
  const b = world.citizens[l.borrower];
  if (!b) return;
  b.creditScore = clamp(b.creditScore + (l.lender === "bank" ? 8 : 4), 0, 100);
  if (l.lender !== "bank") {
    const lender = world.citizens[l.lender];
    if (!lender) return;
    removeRole(lender, b.id, "debtor");
    removeRole(b, lender.id, "creditor");
    adjustRel(world, lender, b.id, { affinity: 8, trust: 15 });
    adjustRel(world, b, lender.id, { affinity: 5 });
    remember(world, lender, { text: `${b.name} paid back the ${money(l.principal)} I lent them, with interest.`, kind: "favor", importance: 6, valence: 0.7, people: [b.id], key: `repaid:${b.id}` });
    remember(world, b, { text: `I paid ${lender.name} back in full.`, kind: "deal", importance: 5, valence: 0.5, people: [lender.id], key: `loan:${l.id}` });
    logEvent(world, "finance", `🤝 ${b.name} paid back ${lender.name} (${money(l.totalDue)}).`, 2, [b.id, lender.id]);
  } else {
    logEvent(world, "finance", `${b.name} paid off their bank loan.`, 2, [b.id]);
  }
}

function defaultLoan(world: WorldState, l: Loan): void {
  l.status = "defaulted";
  const b = world.citizens[l.borrower];
  if (!b) return;
  b.creditScore = clamp(b.creditScore - 25, 0, 100);
  const owed = outstanding(l);
  if (l.lender === "bank") {
    logEvent(world, "finance", `❌ ${b.name} defaulted on a bank loan (${money(owed)} unpaid).`, 4, [b.id]);
    remember(world, b, { text: `I defaulted on my bank loan. My credit is ruined.`, kind: "financial", importance: 8, valence: -0.9, people: [] });
    return;
  }
  const lender = world.citizens[l.lender];
  if (!lender) return;
  removeRole(lender, b.id, "debtor");
  removeRole(b, lender.id, "creditor");
  adjustRel(world, lender, b.id, { affinity: -40, trust: -60 });
  adjustRel(world, b, lender.id, { affinity: -10 });
  logEvent(world, "social", `💔 ${b.name} never paid back ${lender.name}. ${money(owed)} lost — and a friendship.`, 4, [b.id, lender.id]);
  remember(world, lender, { text: `${b.name} betrayed me: never paid back the ${money(l.principal)} I lent them.`, kind: "betrayal", importance: 9, valence: -1, people: [b.id], key: `betrayal:${b.id}` });
  remember(world, b, { text: `I couldn't (or didn't) pay ${lender.name} back.`, kind: "loan", importance: 6, valence: -0.5, people: [lender.id], key: `loan:${l.id}` });
}

/**
 * Daily loan processing.
 *  - Bank loans: automatic instalments; 3 missed = default.
 *  - Peer loans: on the due date the borrower decides whether to pay. Honest
 *    people pay if they can; greedy people with weak ties might not...
 */
export function loansDaily(world: WorldState): void {
  // Forget loans that were settled a while ago (everything that matters about
  // them lives on in memories, credit scores and relationships).
  world.loans = world.loans.filter((l) => l.status === "active" || world.time - Math.max(l.dueT, l.startT) < 14 * 1440);
  for (const l of world.loans) {
    if (l.status !== "active") continue;
    const b = world.citizens[l.borrower];
    if (!b) continue;
    if (l.lender === "bank") {
      const due = Math.min(l.installment, outstanding(l));
      const paid = repay(world, l, due);
      if (paid + 0.01 < due) {
        l.missed++;
        b.creditScore = clamp(b.creditScore - 4, 0, 100);
        if (l.missed >= 3) defaultLoan(world, l);
        else b.reviewRequested = b.reviewRequested ?? "missed loan payment";
      }
      continue;
    }
    if (world.time < l.dueT) continue;
    const owed = outstanding(l);
    const lender = world.citizens[l.lender];
    const liquid = b.money + b.savings;
    const rel = getRel(b, l.lender);
    // Willingness to honour the debt (a deterministic, logged-by-event choice).
    const honesty = 0.55 + b.traits.generosity * 0.25 - b.traits.greed * 0.35 + (rel.affinity + rel.trust) / 400 + (b.family.includes(l.lender) ? 0.3 : 0);
    const canPay = liquid >= owed + 5;
    // Paying in full when it would leave them with almost nothing for rent and
    // food is a real temptation: only the very honest do it without blinking.
    const cushion = 3 * avg(b.finance.history.slice(-5).map((h) => h.expenses));
    const strained = liquid - owed < cushion;
    if (canPay && honesty > 0.3 && (!strained || honesty > 0.75)) {
      repay(world, l, owed);
      continue;
    }
    if (honesty > 0.3) {
      // Pay what they can spare and ask for more time.
      const part = round2((liquid - Math.max(15, canPay ? cushion : 0)) * 0.6);
      if (part > 0) repay(world, l, part);
      if (l.status !== "active") continue;
    }
    l.missed++;
    if (lender && l.missed === 1) {
      remember(world, lender, { text: `${b.name} is late paying me back.`, kind: "loan", importance: 5, valence: -0.4, people: [b.id], key: `late:${l.id}` });
      adjustRel(world, lender, b.id, { trust: -10 });
      lender.cooldowns[`chase:${b.id}`] = world.time;
    }
    // Someone who has paid back most of it gets more patience.
    const patience = l.paid >= l.totalDue * 0.5 ? 7 : 4;
    if (l.missed >= patience || (canPay && honesty <= 0.3)) defaultLoan(world, l);
  }
}

/** Interest on savings, paid daily. */
export function interestDaily(world: WorldState): void {
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (c.savings <= 1) continue;
    const interest = round2(c.savings * world.economy.depositRate);
    if (interest > 0 && transfer(world, externalAcc("bank"), citizenAcc(c.id), interest, "interest", "Savings interest")) {
      deposit(world, c, interest);
    }
  }
}

export function registerBankActions(): void {
  registerAction("BANK", {
    kind: "bank",
    complete(world, c, a, minutes) {
      if (minutes < 5) return;
      const op = String(a.params.op ?? "deposit");
      const amount = Number(a.params.amount ?? 0);
      if (op === "deposit") {
        const d = deposit(world, c, amount);
        if (d > 0) setThought(world, c, `Put ${money(d)} in the bank. Rainy day fund.`, 2);
      } else if (op === "withdraw") {
        withdraw(c, amount);
      } else if (op === "repay") {
        const l = world.loans.find((x) => x.id === Number(a.params.loanId));
        if (l) repay(world, l, amount);
      } else if (op === "loan") {
        takeBankLoan(world, c, amount, String(a.params.purpose ?? "get by"));
      }
    },
  });
}
