import type { ConversationDTO } from "../../shared/protocol";
import { store, useStore } from "../net/store";
import { Avatar } from "./CitizenList";
import { aiName, when } from "./format";

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
  const ai = aiName(useStore((s) => s.state?.ai));
  const citizens = useStore((s) => s.state?.citizens);
  const colorOf = (id: string) => citizens?.find((x) => x.id === id)?.color ?? "#8a93a8";
  return (
    <div className="item" style={{ borderColor: c.source === "llm" ? "var(--llm)" : undefined }}>
      <div className="meta" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span className="chip">{TOPIC[c.topic] ?? c.topic}</span>
        <span>
          {when(c.t)} · {c.place}
        </span>
        {c.source === "llm" ? <span className="chip llm">{c.spoken ? "🧠 each speaking for themselves" : `✨ ${ai}`}</span> : <span className="chip">{c.topic === "chat" ? "improvised" : "built-in AI"}</span>}
        {c.live && <span className="chip good">talking now</span>}
      </div>
      {c.topics.length > 0 && <div className="meta">Talked about: {c.topics.join(" · ")}</div>}
      <div className="tlines">
        {c.lines.map((l, i) => {
          const left = l.speaker === c.a;
          const first = i === 0 || c.lines[i - 1].speaker !== l.speaker;
          const color = colorOf(l.speaker);
          return (
            <div key={i} className={`tline ${left ? "left" : "right"}${first ? " first" : ""}`}>
              <button className="tav" title={`See ${l.name}`} onClick={() => store.select({ kind: "citizen", id: l.speaker })} style={{ visibility: first ? "visible" : "hidden" }}>
                <Avatar name={l.name} color={color} small />
              </button>
              <div className="tbody">
                {first && (
                  <span className="tname" style={{ color }}>
                    {l.name}
                  </span>
                )}
                <span className="tbubble" style={{ ["--c" as string]: color }}>
                  {l.text}
                </span>
              </div>
            </div>
          );
        })}
        {c.writing && (
          <div className={`tline ${c.lines.length % 2 === 0 ? "left" : "right"}`}>
            <span className="tav">
              <Avatar name={c.lines.length % 2 === 0 ? c.aName : c.bName} color={colorOf(c.lines.length % 2 === 0 ? c.a : c.b)} small />
            </span>
            <div className="tbody">
              <span className="bubble typing" title={`${c.lines.length % 2 === 0 ? c.aName : c.bName} is speaking…`}>
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>
      {c.summary && <div className="meta">➜ {c.summary}</div>}
    </div>
  );
}
