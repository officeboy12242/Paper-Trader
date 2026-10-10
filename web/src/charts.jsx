import React, { useRef, useState } from 'react';

export function AreaChart({ points, color = '#F0B41E' }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  if (!points || points.length < 2) return <div className="empty">Collecting data…</div>;

  const W = 600, H = 160;
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const xy = points.map((p, i) => [
    (i / (points.length - 1)) * W,
    H - ((p.v - min) / span) * (H - 24) - 12,
  ]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const zeroY = H - ((0 - min) / span) * (H - 24) - 12;

  const onMove = (e) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.min(points.length - 1, Math.max(0, Math.round((px / W) * (points.length - 1))));
    setHover(idx);
  };

  const gradId = `ag-${color.replace('#', '')}`;

  return (
    <div className="chart-wrap" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.45" />
            <stop offset="60%"  stopColor={color} stopOpacity="0.10" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Zero line */}
        <line x1="0" x2={W} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeDasharray="4 5" />
        {/* Area fill */}
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${gradId})`} />
        {/* Line stroke */}
        <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
        {/* Crosshair */}
        {hover != null && (
          <>
            <line
              x1={xy[hover][0]} x2={xy[hover][0]}
              y1="0" y2={H}
              stroke="rgba(255,255,255,0.25)" strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle
              cx={xy[hover][0]} cy={xy[hover][1]} r="5"
              fill={color} stroke="rgba(8,12,24,0.9)" strokeWidth="2"
              style={{ filter: `drop-shadow(0 0 6px ${color})` }}
            />
          </>
        )}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: `${(xy[hover][0] / W) * 100}%` }}>
          <div className="ct-price" style={{ color }}>
            ${Number(points[hover].v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          {points[hover].ts && (
            <div className="ct-time">
              {new Date(points[hover].ts + 5.5 * 3600e3).toISOString().slice(0, 10)}
              {' · '}
              {new Date(points[hover].ts + 5.5 * 3600e3).toISOString().slice(11, 16)} IST
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DayBars({ rows }) {
  if (!rows?.length) return <div className="empty">No closed days yet</div>;
  const max = Math.max(...rows.map((r) => Math.abs(r.netPnl)), 1);
  return (
    <div className="daybars">
      {rows.slice(-16).map((r) => (
        <div key={r.key} className="daybar" title={`${r.key}: ₹${r.netPnl?.toLocaleString?.() ?? r.netPnl}`}>
          <div className="barwrap">
            <div
              className={`bar ${r.netPnl >= 0 ? 'p' : 'n'}`}
              style={{ height: `${Math.max(4, (Math.abs(r.netPnl) / max) * 100)}px` }}
            />
          </div>
          <div className="d">{String(r.key).slice(5)}</div>
        </div>
      ))}
    </div>
  );
}
