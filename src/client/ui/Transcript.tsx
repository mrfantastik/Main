import type { ConversationDTO } from "../../shared/protocol";
import { store, useStore } from "../net/store";
import { when } from "./format";

const TOPIC: Record<string, string> = {
  chat: "Chat",
  ask_loan: "Loan request",
  pitch_investment: "Investment pitch",
  ask_job: "Job request",
  offer_job: "Job offer",
  demand_repayment: "Debt collection",
  sell_stock: "Stock sale",
  argue: "Argument",
  ask_help: "Asking for help",
  share_tip: "Market tip",
};

export function Transcript({ c }: { c: ConversationDTO }) {
  const writer = useStore((s) => s.state?.ai.writer ?? null);
  return (
    <div className="item" style={{ borderColor: c.source === "llm" ? "var(--llm)" : undefined }}>
      <div className="meta" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span className="chip">{TOPIC[c.topic] ?? c.topic}</span>
        <span>
          {when(c.t)} · {c.place}
        </span>
        {c.source === "llm" ? <span className="chip llm">✨ Claude</span> : <span className="chip">{c.topic === "chat" ? "improvised" : "built-in AI"}</span>}
        {c.live && <span className="chip good">talking now</span>}
      </div>
      {c.topics.length > 0 && <div className="meta">Talked about: {c.topics.join(" · ")}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "6px 0" }}>
        {c.lines.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 6, flexDirection: l.speaker === c.a ? "row" : "row-reverse" }}>
            <span className="who" style={{ fontWeight: 700, cursor: "pointer", color: "var(--accent-2)", whiteSpace: "nowrap" }} onClick={() => store.select({ kind: "citizen", id: l.speaker })}>
              {l.name}
            </span>
            <span style={{ background: l.speaker === c.a ? "#26324a" : "#2e2a40", borderRadius: 8, padding: "3px 8px" }}>{l.text}</span>
          </div>
        ))}
      </div>
      {c.summary && <div className="meta">➜ {c.summary}</div>}
      {writer && (
        <button className="btn unscripted" title={`${writer} writes what these two would really say, from scratch`} onClick={() => store.send({ type: "unscripted", convId: c.id })}>
          ✨ {c.source === "llm" ? "Ask Claude again" : "Hear it unscripted"}
        </button>
      )}
    </div>
  );
}
