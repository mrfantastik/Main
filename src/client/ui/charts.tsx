import { useMemo, useRef, useState } from "react";

// Small inline-SVG charts for a dark UI. Specs: 2px lines, hairline solid
// grid, 10% area wash, end dot r=4 with a 2px surface ring, legend for 2+
// series (line keys), crosshair + one tooltip listing every series.
// Categorical order validated for the dark surface (dataviz validator).

export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const SURFACE = "#161d28";
const GRID = "#263044";
const TEXT_2 = "#8d9ab0";

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function compact(v: number, fmt?: (v: number) => string): string {
  if (fmt) return fmt(v);
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (a >= 100) return v.toFixed(0);
  return Number(v.toFixed(2)).toString();
}

export function Sparkline({ values, height = 32, color = SERIES[0], format }: { values: number[]; height?: number; color?: string; format?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 300;
  const H = height;
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 5;
  const x = (i: number) => pad + (i / (values.length - 1)) * (W - pad * 2);
  const y = (v: number) => (max === min ? H / 2 : pad + (1 - (v - min) / (max - min)) * (H - pad * 2));
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = values.length - 1;
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(last, Math.round(((px - pad) / (W - pad * 2)) * last))));
  };
  return (
    <div className="chart-wrap" style={{ position: "relative" }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <path d={`${d}L${x(last)},${H}L${x(0)},${H}Z`} fill={color} opacity={0.1} />
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke={TEXT_2} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div style={{ position: "absolute", right: 0, top: -2, fontSize: 11, color: "#e6ebf3", fontWeight: 700 }}>
        {compact(values[hover ?? last], format)}
        {hover !== null && <span className="muted" style={{ fontWeight: 500 }}> (point {hover + 1})</span>}
      </div>
    </div>
  );
}

export interface Series {
  name: string;
  values: number[];
  color?: string;
}

export function LineChart({
  series,
  xLabels,
  height = 170,
  format,
  zeroBase = false,
}: {
  series: Series[];
  xLabels: string[];
  height?: number;
  format?: (v: number) => string;
  zeroBase?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 560;
  const H = height;
  const left = 44;
  const right = 12;
  const top = 10;
  const bottom = 22;
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values);
  const { ticks, min, max } = useMemo(() => {
    let lo = all.length ? Math.min(...all) : 0;
    let hi = all.length ? Math.max(...all) : 1;
    if (zeroBase) lo = Math.min(0, lo);
    if (lo === hi) hi = lo + 1;
    const t = niceTicks(lo, hi);
    return { ticks: t, min: Math.min(lo, t[0]), max: Math.max(hi, t[t.length - 1]) };
  }, [all.join(","), zeroBase]);
  if (n < 2) return <div className="empty">Collecting data… (charts fill in as the hours pass)</div>;
  const x = (i: number) => left + (i / (n - 1)) * (W - left - right);
  const y = (v: number) => top + (1 - (v - min) / (max - min)) * (H - top - bottom);
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - left) / (W - left - right)) * (n - 1)))));
  };
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  return (
    <div className="chart-wrap" style={{ position: "relative" }}>
      {series.length > 1 && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: TEXT_2, marginBottom: 4 }}>
          {series.map((s, i) => (
            <span key={s.name} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <svg width="14" height="4">
                <line x1="0" x2="14" y1="2" y2="2" stroke={s.color ?? SERIES[i]} strokeWidth="2" strokeLinecap="round" />
              </svg>
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ height: "auto" }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={left - 6} y={y(t)} fill={TEXT_2} fontSize={10} textAnchor="end" dominantBaseline="middle">
              {compact(t, format)}
            </text>
          </g>
        ))}
        {xLabels.map((l, i) =>
          i % labelEvery === 0 && i < n ? (
            <text key={i} x={x(i)} y={H - 6} fill={TEXT_2} fontSize={10} textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s, si) => {
          const col = s.color ?? SERIES[si];
          const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
          const li = s.values.length - 1;
          return (
            <g key={s.name}>
              {series.length === 1 && <path d={`${d}L${x(li)},${y(min)}L${x(0)},${y(min)}Z`} fill={col} opacity={0.1} />}
              <path d={d} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(li)} cy={y(s.values[li])} r={4} fill={col} stroke={SURFACE} strokeWidth={2} />
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={top} y2={H - bottom} stroke={TEXT_2} strokeWidth={1} />
            {series.map((s, si) =>
              s.values[hover] !== undefined ? <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color ?? SERIES[si]} stroke={SURFACE} strokeWidth={2} /> : null,
            )}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          style={{
            position: "absolute",
            top: series.length > 1 ? 24 : 4,
            left: `${(x(hover) / W) * 100}%`,
            transform: hover > n / 2 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            background: "#0f141c",
            border: "1px solid #2a3548",
            borderRadius: 6,
            padding: "5px 8px",
            fontSize: 11,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 2,
          }}
        >
          <div className="muted">{xLabels[hover]}</div>
          {series.map((s, si) => (
            <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="12" height="4">
                <line x1="0" x2="12" y1="2" y2="2" stroke={s.color ?? SERIES[si]} strokeWidth="2" strokeLinecap="round" />
              </svg>
              <b>{s.values[hover] !== undefined ? compact(s.values[hover], format) : "—"}</b>
              <span className="muted">{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BarList({ rows, format, color = SERIES[0] }: { rows: { label: string; value: number; sub?: string; onClick?: () => void }[]; format?: (v: number) => string; color?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((r, i) => (
        <div
          key={r.label + i}
          onPointerEnter={() => setHover(i)}
          onPointerLeave={() => setHover(null)}
          onClick={r.onClick}
          style={{ display: "grid", gridTemplateColumns: "minmax(80px, 38%) 1fr auto", gap: 8, alignItems: "center", fontSize: 12, cursor: r.onClick ? "pointer" : "default" }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.sub ? `${r.label} — ${r.sub}` : r.label}>
            {r.label}
            {r.sub && <span className="muted"> · {r.sub}</span>}
          </span>
          <svg viewBox="0 0 100 12" preserveAspectRatio="none" style={{ height: 12, width: "100%" }}>
            <rect
              x={0}
              y={0}
              width={Math.max(1.5, (Math.abs(r.value) / max) * 100)}
              height={12}
              rx={2}
              fill={r.value < 0 ? SERIES[7] : color}
              opacity={hover === null || hover === i ? 1 : 0.6}
            />
          </svg>
          <b style={{ fontVariantNumeric: "tabular-nums", minWidth: 52, textAlign: "right" }}>{format ? format(r.value) : compact(r.value)}</b>
        </div>
      ))}
    </div>
  );
}
