import { useEffect, useRef, useState } from "react";
import type { CitizenDetail } from "../../shared/protocol";
import type { BotCard } from "../../sim/types";
import { store, useStore } from "../net/store";
import { Avatar } from "./CitizenList";

// A citizen's chatbot: talk to them yourself, and see or rewrite the character
// card the AI speaks from (who they are, how they talk, what they care about,
// their secret, your own instructions, how adventurous and chatty they are).

/** Talk to them: their chatbot answers in character. */
function Talk({ d }: { d: CitizenDetail }) {
  const ai = useStore((s) => s.state?.ai);
  const canTalk = !!ai && ai.mode === "llm" && (ai.brain ? ai.brain.state === "ready" : ai.available);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [d.playerChat.length, d.chatWaiting]);
  const send = (t: string) => {
    const said = t.trim();
    if (!said || !canTalk || d.chatWaiting) return;
    store.send({ type: "chat", id: d.id, text: said });
    setText("");
  };
  const friend = d.relationships.find((r) => r.affinity > 20)?.name ?? d.relationships[0]?.name;
  const starters = ["How are you, really?", "What's on your mind?", "Tell me about yourself.", ...(friend ? [`What do you make of ${friend}?`] : []), "What do you want out of life?"];
  return (
    <div className="box">
      <h3>💬 Talk to {d.name}</h3>
      <div ref={list} className="chatlog">
        {d.playerChat.length === 0 && !d.chatWaiting && (
          <div className="muted" style={{ textAlign: "center", padding: 12 }}>
            {canTalk ? `Say something to ${d.name}. They'll answer as themselves, from their chatbot below, how they feel today and what's been happening to them.` : "Wake the town's brain (🧠 AI) to talk to them."}
          </div>
        )}
        {d.playerChat.map((l, i) => (
          <div key={i} className={`chatmsg ${l.me ? "them" : "you"}`}>
            {l.me && <Avatar name={d.name} color={d.color} small />}
            <span className="bubble">{l.text}</span>
          </div>
        ))}
        {d.chatWaiting && (
          <div className="chatmsg them">
            <Avatar name={d.name} color={d.color} small />
            <span className="bubble typing">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>
      {canTalk && d.playerChat.length < 2 && (
        <div className="starters">
          {starters.map((s) => (
            <button key={s} className="chip" onClick={() => send(s)} disabled={d.chatWaiting}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="chatform"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={canTalk ? `Say something to ${d.name}…` : "The town's brain is asleep"} disabled={!canTalk} maxLength={300} aria-label={`Message to ${d.name}`} />
        <button className="btn unscripted" type="submit" disabled={!canTalk || d.chatWaiting || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="flabel">{label}</span>
      {children}
      <span className="fhint">{hint}</span>
    </label>
  );
}

/** Their character card: what the AI speaks from. Everything can be rewritten. */
function CardEditor({ d }: { d: CitizenDetail }) {
  const [card, setCard] = useState<BotCard>(d.bot);
  const [dirty, setDirty] = useState(false);
  // A different person, or their card changed elsewhere: start from theirs.
  useEffect(() => {
    if (!dirty) setCard(d.bot);
  }, [d.id, JSON.stringify(d.bot)]);
  useEffect(() => setDirty(false), [d.id]);
  const set = <K extends keyof BotCard>(k: K, v: BotCard[K]) => {
    setCard((c) => ({ ...c, [k]: v }));
    setDirty(true);
  };
  const area = (k: "bio" | "voice" | "cares" | "instructions", rows: number, max: number) => <textarea rows={rows} maxLength={max} value={card[k]} onChange={(e) => set(k, e.target.value)} />;
  return (
    <div className="box">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        🤖 {d.name}'s chatbot {card.custom ? <span className="chip llm">your version</span> : <span className="chip">made from their personality</span>}
      </h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        This is the character card the AI speaks from, in every conversation they have and when you talk to them. Rewrite anything: their
        story, how they talk, what they care about, a secret, or instructions of your own. How they feel, what's happened to them and what they
        remember about people are added each time.
      </p>
      <Field label="Who they are" hint="Their story, as if you're telling them about themselves.">
        {area("bio", 3, 600)}
      </Field>
      <Field label="How they talk" hint="Their voice: formal, blunt, sarcastic, warm, nervous… in your own words.">
        {area("voice", 2, 300)}
      </Field>
      <Field label="Things they'd say" hint="One per line. These teach the AI their voice better than anything.">
        <textarea
          rows={4}
          value={card.examples.join("\n")}
          onChange={(e) =>
            set(
              "examples",
              e.target.value.split("\n").map((x) => x.slice(0, 160)),
            )
          }
        />
      </Field>
      <Field label="What they care about" hint="Values, loves and hates, fears and dreams, habits.">
        {area("cares", 3, 600)}
      </Field>
      <Field label="Their secret" hint="Something they keep to themselves unless they really trust someone.">
        <input value={card.secret} maxLength={300} onChange={(e) => set("secret", e.target.value)} />
      </Field>
      <Field label="Your instructions" hint="Anything else: 'flirts with everyone', 'always talks about football', 'is secretly a spy'…">
        {area("instructions", 2, 500)}
      </Field>
      <div className="sliders">
        <label>
          <span>Steady</span>
          <input type="range" min={0} max={100} value={Math.round(card.creativity * 100)} onChange={(e) => set("creativity", Number(e.target.value) / 100)} aria-label="Creativity" />
          <span>Wild</span>
        </label>
        <label>
          <span>Few words</span>
          <input type="range" min={0} max={100} value={Math.round(card.chattiness * 100)} onChange={(e) => set("chattiness", Number(e.target.value) / 100)} aria-label="Chattiness" />
          <span>Chatterbox</span>
        </label>
      </div>
      <div className="god-row">
        <button
          className="btn unscripted"
          disabled={!dirty}
          onClick={() => {
            store.send({ type: "bot", id: d.id, card: { ...card, examples: card.examples.map((x) => x.trim()).filter(Boolean) } });
            setDirty(false);
          }}
        >
          💾 Save {d.name}'s chatbot
        </button>
        {dirty && (
          <button
            className="btn"
            onClick={() => {
              setCard(d.bot);
              setDirty(false);
            }}
          >
            Undo changes
          </button>
        )}
        {d.bot.custom && !dirty && (
          <button className="btn" onClick={() => store.send({ type: "bot", id: d.id, card: null })}>
            ↺ Back to how they were
          </button>
        )}
      </div>
    </div>
  );
}

export function ChatbotTab({ d }: { d: CitizenDetail }) {
  return (
    <>
      <Talk d={d} />
      <CardEditor d={d} />
    </>
  );
}
