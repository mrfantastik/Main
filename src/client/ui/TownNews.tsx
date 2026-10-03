import { store, useStore } from "../net/store";
import { aiName } from "./format";

/** What's going on in town right now, over the map. Click to look at who or where. */
export function TownNews() {
  const list = useStore((s) => s.state?.happenings ?? []);
  const ai = aiName(useStore((s) => s.state?.ai.free));
  const active = list.filter((h) => h.active && h.kind !== "sculpture").slice(0, 3);
  if (active.length === 0) return null;
  return (
    <div className="town-news" aria-label="Happening now">
      {active.map((h) => (
        <button
          key={h.id}
          className="town-chip"
          title={`${h.text} (${h.known} of 20 have heard)`}
          onClick={() => {
            if (h.businessId) store.select({ kind: "business", id: h.businessId });
            else if (h.subject) store.select({ kind: "citizen", id: h.subject });
          }}
        >
          <span aria-hidden>{h.icon}</span> {h.title}
          {h.source === "llm" && <span className="chip llm">✨ {ai}</span>}
        </button>
      ))}
    </div>
  );
}
