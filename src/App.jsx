import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Clock, User, Bookmark, ArrowRight, ArrowLeft, MoreVertical, Play, Pause,
  Square, SkipForward, Check, ChevronRight, Search, Filter, Settings as SettingsIcon,
  TrendingUp, Bell, Volume2, VolumeX, Moon, History as HistoryIcon, Home as HomeIcon,
  Flag, X, Camera, Award, Sparkles, ArrowUpDown, Vibrate, ChevronDown, Trash2, RotateCcw
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";

/* ============================================================================
   CONSTANTS
   ============================================================================ */

const STORAGE_KEYS = {
  PROFILE: "profile",
  SETTINGS: "settings",
  SESSIONS: "sessions",
  ACTIVE: "activeTimer",
};

const DEFAULT_SETTINGS = {
  soundEnabled: true,
  hapticsEnabled: true,
  reducedMotion: false,
  animationQuality: "high", // 'high' | 'medium' | 'low'
  notificationsEnabled: false,
  defaultHours: 0,
  defaultMinutes: 25,
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ============================================================================
   PURE UTILITIES (no component state — safe to call from anywhere)
   ============================================================================ */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// HH:MM:SS — used only for the live active-timer digital readout
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

// M:SS style — used in lists ("45:00", "20:15")
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${pad2(sec)}`;
}

function formatMinutesShort(totalSeconds) {
  const m = Math.round(totalSeconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatSessionDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (isSameDay(d, now)) return `Today, ${time}`;
  if (isSameDay(d, yesterday)) return `Yesterday, ${time}`;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) + `, ${time}`;
}

function formatSessionDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function slugifyUsername(name) {
  return "@" + (name || "you").toLowerCase().trim().replace(/[^a-z0-9]+/g, "").slice(0, 16);
}

/* Score model — reflects real behavior:
   - completed sessions score high, with a modest bonus for longer focus
   - stopped / skipped sessions score by how much of the plan was completed,
     with skip penalized a little harder than stop (mirrors the reference data) */
function calculateScore(status, elapsedSec, plannedSec) {
  const ratio = plannedSec > 0 ? clamp(elapsedSec / plannedSec, 0, 1) : 0;
  let score;
  if (status === "completed") {
    const durationBonus = Math.min(plannedSec / 3600, 1) * 1.7;
    score = 7.9 + durationBonus + ratio * 0.4;
  } else if (status === "stopped") {
    score = ratio * 8.3;
  } else {
    score = ratio * 6.3;
  }
  return Math.round(clamp(score, 0, 10) * 10) / 10;
}

function computeStats(sessions) {
  const total = sessions.length;
  const completed = sessions.filter((s) => s.status === "completed").length;
  const stopped = sessions.filter((s) => s.status === "stopped").length;
  const skipped = sessions.filter((s) => s.status === "skipped").length;
  const avgScore = total ? sessions.reduce((a, s) => a + s.score, 0) / total : 0;
  const consistency = total ? Math.round((completed / total) * 100) : 0;
  const totalFocusedSeconds = sessions.reduce(
    (a, s) => a + (s.status === "completed" ? s.plannedDuration : s.elapsedDuration),
    0
  );
  const longest = sessions.reduce((max, s) => Math.max(max, s.elapsedDuration), 0);
  const avgDuration = total ? sessions.reduce((a, s) => a + s.elapsedDuration, 0) / total : 0;

  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  sessions.forEach((s) => {
    dayCounts[new Date(s.startTime).getDay()]++;
  });
  let bestDayIdx = 0;
  dayCounts.forEach((c, i) => {
    if (c > dayCounts[bestDayIdx]) bestDayIdx = i;
  });
  const bestDay = total ? DAY_NAMES[bestDayIdx] : "—";

  return {
    total,
    completed,
    stopped,
    skipped,
    avgScore: Math.round(avgScore * 10) / 10,
    consistency,
    totalFocusedSeconds,
    longest,
    avgDuration,
    bestDay,
  };
}

function last7DaysData(sessions) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    days.push(d);
  }
  return days.map((d) => {
    const label = d.toLocaleDateString("en-US", { weekday: "short" });
    const mins = sessions
      .filter((s) => isSameDay(new Date(s.startTime), d))
      .reduce((a, s) => a + s.elapsedDuration / 60, 0);
    return { label, minutes: Math.round(mins) };
  });
}

/* Timer math — always derived from real timestamps, never decremented per-frame */
function remainingSecondsOf(t) {
  if (!t) return 0;
  const now = t.status === "paused" ? t.pausedAt : Date.now();
  const elapsedMs = now - t.startTime - t.totalPausedMs;
  return Math.max(0, t.plannedDuration - elapsedMs / 1000);
}

function buildSession(t, status) {
  const remaining = remainingSecondsOf(t);
  const elapsed =
    status === "completed" ? t.plannedDuration : Math.max(0, Math.round(t.plannedDuration - remaining));
  return {
    id: t.id,
    timerName: t.timerName,
    plannedDuration: t.plannedDuration,
    elapsedDuration: elapsed,
    remainingDuration: Math.max(0, Math.round(t.plannedDuration - elapsed)),
    status,
    score: calculateScore(status, elapsed, t.plannedDuration),
    startTime: new Date(t.startTime).toISOString(),
    endTime: new Date().toISOString(),
    completionPercentage: t.plannedDuration > 0 ? Math.round((elapsed / t.plannedDuration) * 100) : 0,
  };
}

/* ============================================================================
   STORAGE (window.storage — persists across sessions; personal, not shared)
   ============================================================================ */

async function storageGet(key) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch (e) {
    return null;
  }
}
async function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}
async function storageDelete(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (e) {
    /* key may not exist — fine */
  }
}

/* ============================================================================
   SOUND + HAPTICS (best-effort web equivalents; gated by settings)
   ============================================================================ */

let _audioCtx = null;
function getAudioCtx() {
  try {
    if (!_audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) _audioCtx = new AC();
    }
    if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume();
    return _audioCtx;
  } catch (e) {
    return null;
  }
}
function playTone(freq, duration, gainPeak, delay) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t0 = ctx.currentTime + (delay || 0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  } catch (e) {}
}
function playClick(settings) {
  if (!settings || !settings.soundEnabled) return;
  playTone(720, 0.07, 0.07, 0);
}
function playCompletionChime(settings) {
  if (!settings || !settings.soundEnabled) return;
  playTone(523.25, 0.55, 0.11, 0);
  playTone(659.25, 0.55, 0.11, 0.12);
  playTone(783.99, 0.65, 0.13, 0.24);
}
function vibrate(settings, pattern) {
  if (!settings || !settings.hapticsEnabled) return;
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) {}
}
function maybeNotify(settings, session) {
  if (!settings || !settings.notificationsEnabled) return;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      new Notification(`${session.timerName} completed`, {
        body: "Your focus session is done. Nice work.",
        silent: false,
      });
    }
  } catch (e) {}
}

/* ============================================================================
   SMALL UI PRIMITIVES
   ============================================================================ */

function GlassPanel({ children, className = "", style = {}, onClick }) {
  return (
    <div className={`glass-panel ${className}`} style={style} onClick={onClick}>
      {children}
    </div>
  );
}

function PillButton({ children, onClick, icon, disabled, variant = "light", style = {} }) {
  return (
    <button
      className={`pill-button ${variant === "light" ? "pill-light" : "pill-dark"}`}
      onClick={onClick}
      disabled={disabled}
      style={style}
    >
      <span className="pill-label">{children}</span>
      {icon && <span className="pill-icon-circle">{icon}</span>}
    </button>
  );
}

function CircleIconButton({ onClick, children, size = 44, ariaLabel, active, tone = "default" }) {
  return (
    <button
      className={`circle-icon-btn tone-${tone} ${active ? "active" : ""}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function MiniScoreRing({ score, status, size = 44 }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const frac = clamp(score / 10, 0, 1);
  const color =
    status === "skipped" ? "var(--accent-warm-2)" : status === "stopped" ? "var(--text-dim)" : "#ffffff";
  return (
    <svg width={size} height={size} className="mini-score-ring" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={2.5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" className="mini-score-text">
        {score.toFixed(1)}
      </text>
    </svg>
  );
}

function StatusPill({ status }) {
  const map = {
    completed: { label: "Completed", icon: <Check size={12} /> },
    stopped: { label: "Stopped", icon: <Square size={10} /> },
    skipped: { label: "Skipped", icon: <SkipForward size={12} /> },
  };
  const m = map[status] || map.completed;
  return (
    <span className={`status-pill status-${status}`}>
      {m.icon}
      {m.label}
    </span>
  );
}

function ScreenShell({ children, screenKey, reducedMotion }) {
  return (
    <div key={screenKey} className={`screen-shell ${reducedMotion ? "no-motion" : "screen-enter"}`}>
      {children}
    </div>
  );
}

function EmptyState({ icon, title, subtitle }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {subtitle && <div className="empty-subtitle">{subtitle}</div>}
    </div>
  );
}

/* ============================================================================
   BACKGROUND: flowing particle wave field (welcome screen + ambient use)
   Reference: dense dot terrain with slow-moving bright ridge highlights.
   ============================================================================ */

function ParticleField({ quality = "high", reducedMotion = false, density = 1 }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ reducedMotion });
  useEffect(() => {
    stateRef.current = { reducedMotion };
  }, [reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf;
    let w, h, dpr;
    let cols, rows, spacing;
    const counts = { high: 1, medium: 0.65, low: 0.4 };
    const qMul = (counts[quality] || 1) * density;

    function resize() {
      w = canvas.parentElement.clientWidth;
      h = canvas.parentElement.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      spacing = Math.max(12, 16 / qMul);
      cols = Math.ceil(w / spacing) + 2;
      rows = Math.ceil(h / spacing) + 2;
    }
    resize();
    const onResize = () => resize();
    window.addEventListener("resize", onResize);

    let t0 = performance.now();
    let phase = 0;

    function frame(t) {
      const dt = Math.min(0.05, (t - t0) / 1000);
      t0 = t;
      if (!stateRef.current.reducedMotion) phase += dt * 0.35;
      draw();
      raf = requestAnimationFrame(frame);
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = i * spacing;
          const y = j * spacing;
          // flowing ridge: sum of two travelling sine waves creates organic terrain-like brightness
          const wave =
            Math.sin(x * 0.012 + phase * 1.3 + y * 0.01) * 0.5 +
            Math.sin(y * 0.02 - phase * 0.9 + x * 0.006) * 0.5;
          const bright = clamp(0.06 + Math.pow(Math.max(0, wave), 3) * 0.9, 0.04, 1);
          const r = 0.55 + bright * 0.9;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${(0.08 + bright * 0.55).toFixed(3)})`;
          ctx.fill();
        }
      }
    }

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [quality, density]);

  return <canvas ref={canvasRef} className="particle-field-canvas" />;
}

/* ============================================================================
   THE SIGNATURE 3D ELEMENT: rotating particle torus (active timer visual)
   Recreated from the reference clip: hundreds of shaded points on a torus,
   duotone lit (warm amber on the light side, cool white/gray in shadow),
   rotating continuously, reacting to timer state.
   ============================================================================ */

function normalize(v) {
  const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function TimerVisual({ progressRef, statusRef, quality, reducedMotion, size = 260 }) {
  const canvasRef = useRef(null);
  const pointsRef = useRef([]);
  const liveRef = useRef({ quality, reducedMotion });
  useEffect(() => {
    liveRef.current = { quality, reducedMotion };
  }, [quality, reducedMotion]);

  useEffect(() => {
    const counts = { high: { u: 46, v: 15 }, medium: { u: 30, v: 11 }, low: { u: 18, v: 8 } };
    const { u: U, v: V } = counts[quality] || counts.high;
    const pts = [];
    for (let i = 0; i < U; i++) {
      for (let j = 0; j < V; j++) {
        pts.push({ u: (i / U) * Math.PI * 2, v: (j / V) * Math.PI * 2 });
      }
    }
    pointsRef.current = pts;
  }, [quality]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const R = size * 0.235;
    const r = size * 0.112;
    const tilt = (61 * Math.PI) / 180;
    const cosP = Math.cos(tilt);
    const sinP = Math.sin(tilt);
    const lightDir = normalize({ x: -0.5, y: -0.68, z: 0.55 });
    const cool = { r: 205, g: 210, b: 220 };
    const warm = { r: 255, g: 122, b: 58 };

    let rafId;
    let lastT = performance.now();
    let rotation = 0;

    function frame(t) {
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      const { quality: q, reducedMotion: rm } = liveRef.current;
      const pg = progressRef.current; // remaining/planned, 0..1
      const st = statusRef.current;
      if (!rm) {
        const urgency = st === "completed" ? 1.8 : 1 + (1 - pg) * 0.65;
        const speedMul = st === "paused" ? 0.1 : 1;
        rotation += dt * 0.3 * urgency * speedMul;
      }
      draw(rotation, st);
      rafId = requestAnimationFrame(frame);
    }

    function draw(theta, st) {
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      const cy = size / 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const flash = st === "completed" ? 1 : 0;

      const proj = pointsRef.current.map(({ u, v }) => {
        const x = (R + r * Math.cos(v)) * Math.cos(u);
        const y = (R + r * Math.cos(v)) * Math.sin(u);
        const z = r * Math.sin(v);
        const nx = Math.cos(v) * Math.cos(u);
        const ny = Math.cos(v) * Math.sin(u);
        const nz = Math.sin(v);

        const y1 = y * cosP - z * sinP;
        const z1 = y * sinP + z * cosP;
        const x1 = x;
        const ny1 = ny * cosP - nz * sinP;
        const nz1 = ny * sinP + nz * cosP;
        const nx1 = nx;

        const x2 = x1 * cosT + z1 * sinT;
        const z2 = -x1 * sinT + z1 * cosT;
        const y2 = y1;
        const nx2 = nx1 * cosT + nz1 * sinT;
        const nz2 = -nx1 * sinT + nz1 * cosT;
        const ny2 = ny1;

        const b = clamp(nx2 * lightDir.x + ny2 * lightDir.y + nz2 * lightDir.z, 0.08, 1);
        const mix = clamp((Math.cos(u) + 1) / 2 + flash * 0.4, 0, 1); // angular duotone, attached to the object
        return { x: x2, y: y2, z: z2, b, mix };
      });
      proj.sort((a, b) => a.z - b.z);

      proj.forEach((p) => {
        const ds = 1 + (p.z * 0.18) / R;
        const px = cx + p.x * ds;
        const py = cy + p.y * ds;
        const rad = Math.max(0.75, size * 0.0105 * ds * (0.55 + p.b));
        const cr = Math.round(cool.r + (warm.r - cool.r) * p.mix);
        const cg = Math.round(cool.g + (warm.g - cool.g) * p.mix);
        const cb = Math.round(cool.b + (warm.b - cool.b) * p.mix);
        const rr = Math.round(cr * p.b);
        const gg = Math.round(cg * p.b);
        const bb = Math.round(cb * p.b);
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rr},${gg},${bb},${(0.32 + p.b * 0.68).toFixed(3)})`;
        ctx.fill();
      });
    }

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  return <canvas ref={canvasRef} className="timer-visual-canvas" />;
}

/* ============================================================================
   PROGRESS RING — circular countdown scale around the 3D visual
   ============================================================================ */

function ProgressRing({ remainingRatio, plannedMinutes, size = 300, strokeWidth = 3 }) {
  const r = size / 2 - strokeWidth * 5;
  const C = 2 * Math.PI * r;
  const dashOffset = C * (1 - remainingRatio);
  const tickCount = 48;
  const labels = [
    Math.max(1, Math.round(plannedMinutes)),
    Math.max(0, Math.round(plannedMinutes * 0.75)),
    Math.max(0, Math.round(plannedMinutes * 0.5)),
    Math.max(0, Math.round(plannedMinutes * 0.25)),
  ];

  const ticks = [];
  for (let i = 0; i < tickCount; i++) {
    const angle = (i / tickCount) * 360;
    const rad = ((angle - 90) * Math.PI) / 180;
    const inner = r - 7;
    const outer = r + 7;
    const x1 = size / 2 + inner * Math.cos(rad);
    const y1 = size / 2 + inner * Math.sin(rad);
    const x2 = size / 2 + outer * Math.cos(rad);
    const y2 = size / 2 + outer * Math.sin(rad);
    const lit = angle / 360 <= remainingRatio;
    ticks.push(
      <line
        key={i}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={lit ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.1)"}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    );
  }

  return (
    <svg width={size} height={size} className="progress-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#ffffff"
        strokeWidth={strokeWidth}
        strokeDasharray={C}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="progress-ring-arc"
      />
      {ticks}
      {labels.map((lab, i) => {
        const angle = i * 90;
        const rad = ((angle - 90) * Math.PI) / 180;
        const lr = r + 24;
        const x = size / 2 + lr * Math.cos(rad);
        const y = size / 2 + lr * Math.sin(rad);
        return (
          <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="ring-label">
            {lab}
          </text>
        );
      })}
    </svg>
  );
}

/* ============================================================================
   DETERMINISTIC PSEUDO-RANDOM (for the member-card barcode/QR pattern —
   stable per member, but not hand-authored fake data)
   ============================================================================ */

function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return function next() {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================================
   MEMBER CARD — flips between front (identity) and back (holographic id)
   ============================================================================ */

function MemberCard({ profile, onEditAvatar }) {
  const [flipped, setFlipped] = useState(false);
  const rand = useMemo(() => seededRandom(profile.memberId + "|" + profile.name), [profile.memberId, profile.name]);
  const barcodeBars = useMemo(() => Array.from({ length: 26 }, () => 1 + Math.floor(rand() * 3)), [rand]);
  const qrCells = useMemo(() => Array.from({ length: 64 }, () => rand() > 0.52), [rand]);

  return (
    <div className="member-card-scene">
      <div
        className={`member-card-wrap ${flipped ? "flipped" : ""}`}
        onClick={() => setFlipped((f) => !f)}
        role="button"
        tabIndex={0}
        aria-label="Member card, tap to flip"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setFlipped((f) => !f);
        }}
      >
        <div className="member-card-inner">
          <div className="member-card-face member-card-front">
            <button
              className="member-avatar"
              onClick={(e) => {
                e.stopPropagation();
                onEditAvatar && onEditAvatar();
              }}
              aria-label="Change profile photo"
            >
              {profile.avatarDataUrl ? (
                <img src={profile.avatarDataUrl} alt="" />
              ) : (
                <span>{initials(profile.name)}</span>
              )}
            </button>
            <div className="member-name">{profile.name}</div>
            <div className="member-username">{slugifyUsername(profile.name)}</div>
            <div className="member-id-block">
              <div className="member-id-label">MEMBER ID</div>
              <div className="member-id-value">{profile.memberId}</div>
            </div>
            <div className="member-since">Member since {formatSessionDateShort(profile.memberSince)}</div>
          </div>
          <div className="member-card-face member-card-back">
            <div className="member-back-lines" aria-hidden="true">
              {Array.from({ length: 10 }).map((_, i) => (
                <span key={i} style={{ top: `${i * 11}%` }} />
              ))}
            </div>
            <div className="member-back-glow" />
            <div className="member-back-grid" aria-hidden="true">
              {qrCells.map((on, i) => (
                <span key={i} className={on ? "cell-on" : "cell-off"} />
              ))}
            </div>
            <div className="member-back-shapes" aria-hidden="true">
              <span className="shape-tri" />
              <span className="shape-x">✕</span>
              <span className="shape-circle" />
            </div>
            <div className="member-back-id">{profile.memberId}</div>
            <div className="member-barcode" aria-hidden="true">
              {barcodeBars.map((w, i) => (
                <span key={i} style={{ width: w }} />
              ))}
            </div>
            <div className="member-back-label">TIMER MEMBER CARD</div>
          </div>
        </div>
      </div>
      <div className="member-card-hint">Tap card to flip</div>
    </div>
  );
}

/* ============================================================================
   WELCOME / ONBOARDING SCREEN
   ============================================================================ */

function WelcomeScreen({ onSubmit, settings }) {
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [touched, setTouched] = useState(false);
  const canSubmit = name.trim().length > 0;

  const handleSubmit = () => {
    setTouched(true);
    if (!canSubmit) return;
    playClick(settings);
    vibrate(settings, 20);
    onSubmit({ name: name.trim(), workspaceName: workspace.trim() || "My Timer" });
  };

  return (
    <div className="screen welcome-screen">
      <div className="welcome-bg">
        <ParticleField quality={settings.animationQuality} reducedMotion={settings.reducedMotion} />
      </div>
      <GlassPanel className="welcome-panel">
        <div className="welcome-icon">
          <Clock size={24} />
        </div>
        <h1 className="welcome-title">Welcome</h1>
        <p className="welcome-subtitle">Let's personalize your timer experience</p>
        <div className="welcome-divider" />

        <div className="welcome-field">
          <div className="welcome-field-head">
            <User size={15} />
            <span className="welcome-field-title">Enter your name</span>
          </div>
          <div className="welcome-field-desc">This helps us personalize your experience</div>
          <div className={`glass-input ${touched && !canSubmit ? "input-error" : ""}`}>
            <User size={15} className="glass-input-icon" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              maxLength={40}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
              aria-label="Your name"
            />
          </div>
          {touched && !canSubmit && <div className="field-error">Please enter your name to continue</div>}
        </div>

        <div className="welcome-field">
          <div className="welcome-field-head">
            <Bookmark size={15} />
            <span className="welcome-field-title">Create your space</span>
          </div>
          <div className="welcome-field-desc">Give your timer a name to make it uniquely yours</div>
          <div className="glass-input">
            <Bookmark size={15} className="glass-input-icon" />
            <input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="My Timer"
              maxLength={30}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
              aria-label="Timer workspace name"
            />
          </div>
        </div>

        <PillButton onClick={handleSubmit} icon={<ArrowRight size={16} color="#050505" />}>
          Get Started
        </PillButton>
        <div className="welcome-credit">Your data stays on this device</div>
      </GlassPanel>
    </div>
  );
}

/* ============================================================================
   HOME / MEMBER PROFILE SCREEN
   ============================================================================ */

function StatCell({ icon, label, value, unit }) {
  return (
    <div className="stat-cell">
      <div className="stat-icon">{icon}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function ConsistencyRing({ value, size = 60 }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="consistency-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#ffffff"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.8s ease" }}
      />
    </svg>
  );
}

function HomeScreen({ profile, sessions, settings, onNavigate, onNewTimer, onEditAvatar }) {
  const stats = useMemo(() => computeStats(sessions), [sessions]);
  const recent = sessions.slice(0, 5);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="screen home-screen">
      <div className="home-header">
        <div>
          <div className="home-greeting">
            {greeting}, {profile.name.split(" ")[0]}
          </div>
          <div className="home-workspace">{profile.workspaceName}</div>
        </div>
        <CircleIconButton ariaLabel="Open settings" onClick={() => onNavigate("settings")}>
          <MoreVertical size={18} />
        </CircleIconButton>
      </div>

      <MemberCard profile={profile} onEditAvatar={onEditAvatar} />

      <GlassPanel className="stats-panel">
        <StatCell icon={<Clock size={15} />} label="Total Timers" value={stats.total} />
        <div className="stat-divider" />
        <StatCell icon={<Flag size={15} />} label="Completed" value={stats.completed} />
        <div className="stat-divider" />
        <StatCell icon={<Square size={13} />} label="Stopped" value={stats.stopped} />
        <div className="stat-divider" />
        <StatCell icon={<SkipForward size={15} />} label="Skipped" value={stats.skipped} />
      </GlassPanel>

      <div className="section-header">
        <span>Recent Timers</span>
        <button className="link-button" onClick={() => onNavigate("history")}>
          View All <ChevronRight size={14} />
        </button>
      </div>

      {recent.length === 0 ? (
        <GlassPanel className="recent-empty">
          <EmptyState icon={<Clock size={20} />} title="No sessions yet" subtitle="Start your first timer below to see it here." />
        </GlassPanel>
      ) : (
        <GlassPanel className="recent-list">
          {recent.map((s, i) => (
            <div className="recent-row" key={s.id}>
              <div className="recent-icon">
                <RotateCcw size={15} />
              </div>
              <div className="recent-main">
                <div className="recent-name">{s.timerName}</div>
                <div className="recent-date">{formatSessionDate(s.startTime)}</div>
              </div>
              <div className="recent-right">
                <StatusPill status={s.status} />
                <div className="recent-duration">
                  {s.status === "completed"
                    ? formatDuration(s.plannedDuration)
                    : `${formatDuration(s.elapsedDuration)} / ${formatDuration(s.plannedDuration)}`}
                </div>
              </div>
              <MiniScoreRing score={s.score} status={s.status} size={38} />
            </div>
          ))}
        </GlassPanel>
      )}

      <GlassPanel className="score-panel">
        <div className="score-block">
          <div className="score-label">Overall Score</div>
          <div className="score-value">
            {stats.avgScore.toFixed(1)}
            <span className="score-max">/10</span>
          </div>
        </div>
        <div className="score-divider" />
        <div className="score-block">
          <div className="score-label">Consistency</div>
          <div className="score-value-sm">{stats.consistency}%</div>
          <div className="score-sub">
            {stats.total === 0 ? "Let's begin" : stats.consistency >= 60 ? "Keep it up!" : "You can do better"}
          </div>
        </div>
        <ConsistencyRing value={stats.consistency} />
      </GlassPanel>

      <div className="home-bottom-spacer" />
      <button className="fab" onClick={onNewTimer} aria-label="Start a new timer">
        <Play size={20} fill="#050505" color="#050505" />
      </button>
    </div>
  );
}

/* ============================================================================
   WHEEL PICKER — real scroll/snap wheel, not a fake animated number
   ============================================================================ */

function WheelColumn({ value, max, onChange, settings, itemHeight = 54, visibleCount = 5 }) {
  const containerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(value * itemHeight);
  const settleTimeout = useRef(null);
  const didInit = useRef(false);
  const padCount = Math.floor(visibleCount / 2);

  useEffect(() => {
    if (containerRef.current && !didInit.current) {
      containerRef.current.scrollTop = value * itemHeight;
      setScrollTop(value * itemHeight);
      didInit.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleScroll = (e) => {
    const st = e.target.scrollTop;
    setScrollTop(st);
    if (settleTimeout.current) clearTimeout(settleTimeout.current);
    settleTimeout.current = setTimeout(() => {
      const idx = Math.round(st / itemHeight);
      const clamped = clamp(idx, 0, max);
      if (containerRef.current) {
        containerRef.current.scrollTo({ top: clamped * itemHeight, behavior: "smooth" });
      }
      if (clamped !== value) {
        onChange(clamped);
        vibrate(settings, 6);
      }
    }, 110);
  };

  const items = [];
  for (let i = -padCount; i <= max + padCount; i++) items.push(i);

  return (
    <div className="wheel-viewport" style={{ height: itemHeight * visibleCount }}>
      <div className="wheel-scroll" ref={containerRef} onScroll={handleScroll}>
        {items.map((i) => {
          const isReal = i >= 0 && i <= max;
          const centerIndex = scrollTop / itemHeight;
          const dist = Math.abs(i - centerIndex);
          const opacity = isReal ? clamp(1 - dist * 0.4, 0.12, 1) : 0;
          const scale = clamp(1 - dist * 0.16, 0.6, 1);
          const selected = dist < 0.5;
          return (
            <div
              key={i}
              className={`wheel-item ${selected ? "wheel-item-selected" : ""}`}
              style={{ height: itemHeight, opacity, transform: `scale(${scale})` }}
            >
              {isReal ? pad2(i) : ""}
            </div>
          );
        })}
      </div>
      <div className="wheel-center-band" aria-hidden="true" />
    </div>
  );
}

function DecorativeArc({ reducedMotion }) {
  const path = "M 14 14 Q 96 14 96 74";
  return (
    <svg viewBox="0 0 110 88" className="decorative-arc" aria-hidden="true">
      <defs>
        <linearGradient id="arcGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.95" />
        </linearGradient>
      </defs>
      <path d={path} fill="none" stroke="url(#arcGrad)" strokeWidth="3" strokeLinecap="round" />
      {!reducedMotion ? (
        <circle r="4.5" fill="#ffffff" className="arc-orb">
          <animateMotion dur="3.4s" repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear" path={path} />
        </circle>
      ) : (
        <circle cx="96" cy="74" r="4.5" fill="#ffffff" />
      )}
    </svg>
  );
}

/* ============================================================================
   SET TIMER SCREEN
   ============================================================================ */

function SetTimerScreen({ onBack, onStart, settings, defaultHours, defaultMinutes }) {
  const [hours, setHours] = useState(defaultHours ?? 0);
  const [minutes, setMinutes] = useState(defaultMinutes ?? 25);
  const [timerName, setTimerName] = useState("");
  const totalSeconds = hours * 3600 + minutes * 60;
  const canStart = totalSeconds > 0;

  const handleStart = () => {
    if (!canStart) return;
    playClick(settings);
    vibrate(settings, 25);
    onStart({ hours, minutes, timerName: timerName.trim() || "Focus Session" });
  };

  return (
    <div className="screen set-timer-screen">
      <div className="set-timer-header">
        <CircleIconButton ariaLabel="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </CircleIconButton>
        <DecorativeArc reducedMotion={settings.reducedMotion} />
      </div>
      <h1 className="set-timer-title">Set Time</h1>
      <p className="set-timer-subtitle">Choose the time duration</p>

      <div className="glass-input timer-name-input">
        <Bookmark size={15} className="glass-input-icon" />
        <input
          value={timerName}
          onChange={(e) => setTimerName(e.target.value)}
          placeholder="Name this session"
          maxLength={30}
          aria-label="Session name"
        />
      </div>

      <GlassPanel className="wheel-panel">
        <div className="wheel-columns">
          <div className="wheel-column-block">
            <WheelColumn value={minutes} max={59} onChange={setMinutes} settings={settings} />
            <div className="wheel-column-label">Minutes</div>
          </div>
          <div className="wheel-divider-line" />
          <div className="wheel-column-block">
            <WheelColumn value={hours} max={23} onChange={setHours} settings={settings} />
            <div className="wheel-column-label">Hours</div>
          </div>
        </div>
      </GlassPanel>

      <PillButton onClick={handleStart} disabled={!canStart} icon={<Play size={14} color="#050505" fill="#050505" />}>
        Start Timer
      </PillButton>
      {!canStart && <div className="field-error center">Choose a duration greater than zero</div>}
    </div>
  );
}

/* ============================================================================
   ACTIVE TIMER SCREEN — the centerpiece
   ============================================================================ */

function ActiveTimerScreen({ activeTimer, settings, onPause, onResume, onStop, onSkip }) {
  const [, forceTick] = useState(0);
  const progressRef = useRef(1);
  const statusRef = useRef(activeTimer.status);
  const [confirmAction, setConfirmAction] = useState(null);

  useEffect(() => {
    setConfirmAction(null);
  }, [activeTimer.id]);

  useEffect(() => {
    const update = () => {
      const remaining = remainingSecondsOf(activeTimer);
      progressRef.current = activeTimer.plannedDuration > 0 ? remaining / activeTimer.plannedDuration : 0;
      statusRef.current = activeTimer.status;
      forceTick((t) => t + 1);
    };
    update();
    if (activeTimer.status !== "running") return;
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [activeTimer]);

  const remaining = remainingSecondsOf(activeTimer);
  const remainingRatio = activeTimer.plannedDuration > 0 ? clamp(remaining / activeTimer.plannedDuration, 0, 1) : 0;
  const plannedMinutes = activeTimer.plannedDuration / 60;

  const requestConfirm = (action, fn) => {
    if (confirmAction === action) {
      setConfirmAction(null);
      fn();
    } else {
      setConfirmAction(action);
      vibrate(settings, 15);
      setTimeout(() => setConfirmAction((c) => (c === action ? null : c)), 3000);
    }
  };

  return (
    <div className="screen active-timer-screen">
      <div className="active-timer-bg">
        <ParticleField quality="low" reducedMotion={settings.reducedMotion} density={0.45} />
      </div>

      <div className="timer-name-label">{activeTimer.timerName}</div>

      <div className="visual-stack">
        <ProgressRing remainingRatio={remainingRatio} plannedMinutes={plannedMinutes} size={296} />
        <div className="visual-stack-inner">
          <TimerVisual
            progressRef={progressRef}
            statusRef={statusRef}
            quality={settings.animationQuality}
            reducedMotion={settings.reducedMotion}
            size={182}
          />
        </div>
      </div>

      <div className="digital-capsule">
        <Clock size={15} />
        <span className="digital-readout">{formatClock(remaining)}</span>
      </div>

      <button
        className={`pause-button ${activeTimer.status === "paused" ? "is-paused" : ""}`}
        onClick={() => {
          playClick(settings);
          activeTimer.status === "running" ? onPause() : onResume();
        }}
        aria-label={activeTimer.status === "running" ? "Pause timer" : "Resume timer"}
      >
        {activeTimer.status === "running" ? <Pause size={24} /> : <Play size={24} fill="#fff" />}
      </button>

      <div className="secondary-controls">
        <button
          className={`secondary-btn ${confirmAction === "stop" ? "confirming" : ""}`}
          onClick={() => requestConfirm("stop", onStop)}
        >
          <Square size={13} />
          {confirmAction === "stop" ? "Tap to confirm" : "Stop"}
        </button>
        <button
          className={`secondary-btn ${confirmAction === "skip" ? "confirming" : ""}`}
          onClick={() => requestConfirm("skip", onSkip)}
        >
          <SkipForward size={13} />
          {confirmAction === "skip" ? "Tap to confirm" : "Skip"}
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   COMPLETION SCREEN
   ============================================================================ */

function CompletionScreen({ session, settings, onDone, onStartAnother }) {
  const [phase, setPhase] = useState(settings.reducedMotion ? "settled" : "burst");
  useEffect(() => {
    if (settings.reducedMotion) return;
    const t = setTimeout(() => setPhase("settled"), 900);
    return () => clearTimeout(t);
  }, [settings.reducedMotion]);

  const progressRef = useRef(0);
  const statusRef = useRef("completed");

  return (
    <div className="screen completion-screen">
      <div className={`completion-glow ${phase}`} aria-hidden="true" />
      <div className="visual-stack completion-visual">
        <TimerVisual
          progressRef={progressRef}
          statusRef={statusRef}
          quality={settings.animationQuality}
          reducedMotion={settings.reducedMotion}
          size={168}
        />
      </div>
      <div className={`completion-check ${phase}`}>
        <Check size={26} />
      </div>
      <h1 className="completion-title">Completed</h1>
      <div className="completion-name">{session.timerName}</div>

      <GlassPanel className="completion-stats">
        <div className="completion-stat">
          <div className="completion-stat-label">Duration</div>
          <div className="completion-stat-value">{formatMinutesShort(session.elapsedDuration)}</div>
        </div>
        <div className="score-divider" />
        <div className="completion-stat">
          <div className="completion-stat-label">Score</div>
          <div className="completion-stat-value">
            {session.score.toFixed(1)}
            <span className="score-max">/10</span>
          </div>
        </div>
      </GlassPanel>

      <div className="completion-actions">
        <PillButton onClick={onDone}>Done</PillButton>
        <button className="ghost-button" onClick={onStartAnother}>
          Start Another
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   HISTORY SCREEN — filter, search, sort, and a detail view
   ============================================================================ */

function DetailRow({ label, value }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}

function SessionDetailModal({ session, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <GlassPanel className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{session.timerName}</h2>
          <CircleIconButton ariaLabel="Close" onClick={onClose} size={34}>
            <X size={15} />
          </CircleIconButton>
        </div>
        <StatusPill status={session.status} />
        <div className="detail-grid">
          <DetailRow label="Date" value={formatSessionDateShort(session.startTime)} />
          <DetailRow
            label="Start time"
            value={new Date(session.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          />
          <DetailRow
            label="End time"
            value={new Date(session.endTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          />
          <DetailRow label="Planned duration" value={formatMinutesShort(session.plannedDuration)} />
          <DetailRow label="Actual duration" value={formatMinutesShort(session.elapsedDuration)} />
          <DetailRow label="Completion" value={`${session.completionPercentage}%`} />
          <DetailRow label="Score" value={`${session.score.toFixed(1)} / 10`} />
        </div>
      </GlassPanel>
    </div>
  );
}

function HistoryScreen({ sessions, onBack }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [selected, setSelected] = useState(null);

  const filtered = useMemo(() => {
    let list = sessions;
    if (filter !== "all") list = list.filter((s) => s.status === filter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((s) => s.timerName.toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) => {
      const da = new Date(a.startTime).getTime();
      const db = new Date(b.startTime).getTime();
      return sort === "newest" ? db - da : da - db;
    });
    return list;
  }, [sessions, filter, query, sort]);

  const filters = [
    { key: "all", label: "All" },
    { key: "completed", label: "Completed" },
    { key: "stopped", label: "Stopped" },
    { key: "skipped", label: "Skipped" },
  ];

  return (
    <div className="screen history-screen">
      <div className="sub-header">
        <CircleIconButton ariaLabel="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </CircleIconButton>
        <h1 className="sub-header-title">History</h1>
        <CircleIconButton ariaLabel="Toggle sort order" onClick={() => setSort((s) => (s === "newest" ? "oldest" : "newest"))}>
          <ArrowUpDown size={16} />
        </CircleIconButton>
      </div>

      <div className="glass-input search-input">
        <Search size={15} className="glass-input-icon" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sessions" aria-label="Search sessions" />
      </div>

      <div className="filter-row">
        {filters.map((f) => (
          <button key={f.key} className={`filter-chip ${filter === f.key ? "active" : ""}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <GlassPanel className="recent-empty">
          <EmptyState icon={<Search size={20} />} title="No sessions found" subtitle="Try a different filter or search term." />
        </GlassPanel>
      ) : (
        <GlassPanel className="recent-list">
          {filtered.map((s) => (
            <div
              className="recent-row"
              key={s.id}
              onClick={() => setSelected(s)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSelected(s);
              }}
            >
              <div className="recent-icon">
                <RotateCcw size={15} />
              </div>
              <div className="recent-main">
                <div className="recent-name">{s.timerName}</div>
                <div className="recent-date">{formatSessionDate(s.startTime)}</div>
              </div>
              <div className="recent-right">
                <StatusPill status={s.status} />
                <div className="recent-duration">
                  {s.status === "completed"
                    ? formatDuration(s.plannedDuration)
                    : `${formatDuration(s.elapsedDuration)} / ${formatDuration(s.plannedDuration)}`}
                </div>
              </div>
              <MiniScoreRing score={s.score} status={s.status} size={38} />
            </div>
          ))}
        </GlassPanel>
      )}

      {selected && <SessionDetailModal session={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/* ============================================================================
   ANALYTICS SCREEN
   ============================================================================ */

function AnalyticsScreen({ sessions, onBack }) {
  const stats = useMemo(() => computeStats(sessions), [sessions]);
  const chartData = useMemo(() => last7DaysData(sessions), [sessions]);
  const pieColors = { Completed: "#ffffff", Stopped: "#8b8b92", Skipped: "#ff7a45" };
  const pieData = useMemo(
    () =>
      [
        { name: "Completed", value: stats.completed },
        { name: "Stopped", value: stats.stopped },
        { name: "Skipped", value: stats.skipped },
      ].filter((d) => d.value > 0),
    [stats]
  );

  return (
    <div className="screen analytics-screen">
      <div className="sub-header">
        <CircleIconButton ariaLabel="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </CircleIconButton>
        <h1 className="sub-header-title">Analytics</h1>
        <div style={{ width: 38 }} />
      </div>

      <div className="analytics-grid">
        <GlassPanel className="analytics-cell">
          <div className="a-label">Total Sessions</div>
          <div className="a-value">{stats.total}</div>
        </GlassPanel>
        <GlassPanel className="analytics-cell">
          <div className="a-label">Focused Time</div>
          <div className="a-value">{formatMinutesShort(stats.totalFocusedSeconds)}</div>
        </GlassPanel>
        <GlassPanel className="analytics-cell">
          <div className="a-label">Completion Rate</div>
          <div className="a-value">{stats.total ? Math.round((stats.completed / stats.total) * 100) : 0}%</div>
        </GlassPanel>
        <GlassPanel className="analytics-cell">
          <div className="a-label">Stop Rate</div>
          <div className="a-value">{stats.total ? Math.round((stats.stopped / stats.total) * 100) : 0}%</div>
        </GlassPanel>
        <GlassPanel className="analytics-cell">
          <div className="a-label">Skip Rate</div>
          <div className="a-value">{stats.total ? Math.round((stats.skipped / stats.total) * 100) : 0}%</div>
        </GlassPanel>
        <GlassPanel className="analytics-cell">
          <div className="a-label">Consistency</div>
          <div className="a-value">{stats.consistency}%</div>
        </GlassPanel>
        <GlassPanel className="analytics-cell">
          <div className="a-label">Best Day</div>
          <div className="a-value a-value-text">{stats.bestDay}</div>
        </GlassPanel>
        <GlassPanel className="analytics-cell">
          <div className="a-label">Longest Session</div>
          <div className="a-value">{formatMinutesShort(stats.longest)}</div>
        </GlassPanel>
        <GlassPanel className="analytics-cell">
          <div className="a-label">Avg Duration</div>
          <div className="a-value">{formatMinutesShort(stats.avgDuration)}</div>
        </GlassPanel>
      </div>

      <GlassPanel className="chart-panel">
        <div className="chart-title">Focused minutes — last 7 days</div>
        {stats.total === 0 ? (
          <EmptyState icon={<TrendingUp size={20} />} title="No data yet" subtitle="Complete a session to see trends here." />
        ) : (
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={chartData} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="label" stroke="#5a5a62" tick={{ fill: "#8b8b92", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis stroke="#5a5a62" tick={{ fill: "#8b8b92", fontSize: 11 }} axisLine={false} tickLine={false} width={26} />
              <Tooltip
                contentStyle={{
                  background: "rgba(15,15,17,0.94)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 12,
                  color: "#fff",
                  fontSize: 12,
                }}
                labelStyle={{ color: "#8b8b92" }}
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
              />
              <Bar dataKey="minutes" radius={[6, 6, 6, 6]} fill="#ffffff" fillOpacity={0.85} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </GlassPanel>

      {pieData.length > 0 && (
        <GlassPanel className="chart-panel">
          <div className="chart-title">Session outcomes</div>
          <div className="pie-row">
            <ResponsiveContainer width={130} height={130}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={38} outerRadius={58} paddingAngle={3} stroke="none">
                  {pieData.map((d, i) => (
                    <Cell key={i} fill={pieColors[d.name]} fillOpacity={d.name === "Completed" ? 0.95 : 0.72} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pie-legend">
              {pieData.map((d) => (
                <div className="pie-legend-item" key={d.name}>
                  <span className="pie-dot" style={{ background: pieColors[d.name] }} />
                  {d.name} · {d.value}
                </div>
              ))}
            </div>
          </div>
        </GlassPanel>
      )}
    </div>
  );
}

/* ============================================================================
   SETTINGS SCREEN
   ============================================================================ */

function ToggleRow({ icon, label, value, onChange }) {
  return (
    <div className="toggle-row">
      <div className="toggle-left">
        {icon}
        <span>{label}</span>
      </div>
      <button
        className={`toggle-switch ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
        aria-label={label}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

function SettingsScreen({ profile, settings, sessionsCount, onBack, onUpdateProfile, onUpdateSettings, onClearHistory, onAvatarFile }) {
  const [name, setName] = useState(profile.name);
  const [workspace, setWorkspace] = useState(profile.workspaceName);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileInputRef = useRef(null);

  const saveProfile = () => {
    const trimmedName = name.trim() || profile.name;
    const trimmedWorkspace = workspace.trim() || profile.workspaceName;
    if (trimmedName !== profile.name || trimmedWorkspace !== profile.workspaceName) {
      onUpdateProfile({ ...profile, name: trimmedName, workspaceName: trimmedWorkspace });
    }
  };

  const requestNotifications = async () => {
    try {
      if (typeof Notification === "undefined") return;
      const perm = await Notification.requestPermission();
      onUpdateSettings({ ...settings, notificationsEnabled: perm === "granted" });
    } catch (e) {}
  };

  const qualityOptions = ["low", "medium", "high"];

  return (
    <div className="screen settings-screen">
      <div className="sub-header">
        <CircleIconButton ariaLabel="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </CircleIconButton>
        <h1 className="sub-header-title">Settings</h1>
        <div style={{ width: 38 }} />
      </div>

      <div className="settings-section-title">Profile</div>
      <GlassPanel className="settings-panel">
        <div className="settings-avatar-row">
          <button className="settings-avatar" onClick={() => fileInputRef.current && fileInputRef.current.click()} aria-label="Change profile photo">
            {profile.avatarDataUrl ? <img src={profile.avatarDataUrl} alt="" /> : <span>{initials(profile.name)}</span>}
            <span className="settings-avatar-badge">
              <Camera size={11} />
            </span>
          </button>
          <div className="settings-avatar-hint">Tap to change photo</div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => e.target.files && e.target.files[0] && onAvatarFile(e.target.files[0])}
        />
        <div className="settings-field">
          <label>Name</label>
          <div className="glass-input">
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={saveProfile} maxLength={40} aria-label="Name" />
          </div>
        </div>
        <div className="settings-field">
          <label>Workspace name</label>
          <div className="glass-input">
            <input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              onBlur={saveProfile}
              maxLength={30}
              aria-label="Workspace name"
            />
          </div>
        </div>
      </GlassPanel>

      <div className="settings-section-title">Preferences</div>
      <GlassPanel className="settings-panel">
        <ToggleRow
          icon={<Volume2 size={16} />}
          label="Sound"
          value={settings.soundEnabled}
          onChange={(v) => onUpdateSettings({ ...settings, soundEnabled: v })}
        />
        <ToggleRow
          icon={<Vibrate size={16} />}
          label="Haptics"
          value={settings.hapticsEnabled}
          onChange={(v) => onUpdateSettings({ ...settings, hapticsEnabled: v })}
        />
        <ToggleRow
          icon={<Moon size={16} />}
          label="Reduced motion"
          value={settings.reducedMotion}
          onChange={(v) => onUpdateSettings({ ...settings, reducedMotion: v })}
        />
        <div className="toggle-row">
          <div className="toggle-left">
            <Sparkles size={16} />
            <span>Animation quality</span>
          </div>
          <div className="segmented">
            {qualityOptions.map((q) => (
              <button
                key={q}
                className={`segmented-btn ${settings.animationQuality === q ? "active" : ""}`}
                onClick={() => onUpdateSettings({ ...settings, animationQuality: q })}
              >
                {q[0].toUpperCase() + q.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="toggle-row">
          <div className="toggle-left">
            <Bell size={16} />
            <span>Notifications</span>
          </div>
          {settings.notificationsEnabled ? (
            <span className="settings-note">Enabled</span>
          ) : (
            <button className="settings-inline-btn" onClick={requestNotifications}>
              Enable
            </button>
          )}
        </div>
      </GlassPanel>

      <div className="settings-section-title">Data</div>
      <GlassPanel className="settings-panel">
        <div className="toggle-row">
          <div className="toggle-left">
            <HistoryIcon size={16} />
            <span>{sessionsCount} saved sessions</span>
          </div>
          <button
            className={`settings-inline-btn ${confirmClear ? "danger" : ""}`}
            onClick={() => {
              if (confirmClear) {
                onClearHistory();
                setConfirmClear(false);
              } else {
                setConfirmClear(true);
                setTimeout(() => setConfirmClear(false), 3000);
              }
            }}
          >
            <Trash2 size={13} /> {confirmClear ? "Confirm" : "Clear"}
          </button>
        </div>
      </GlassPanel>

      <div className="settings-section-title">About</div>
      <GlassPanel className="settings-panel about-panel">
        <div className="about-line">Premium 3D Timer</div>
        <div className="about-sub">
          Every screen here is fully functional — timers, history, and stats are all saved on this device.
        </div>
      </GlassPanel>
    </div>
  );
}

/* ============================================================================
   APP SHELL — state, persistence, navigation, and the timer lifecycle
   ============================================================================ */

export default function TimerApp() {
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState("welcome");
  const [profile, setProfile] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [sessions, setSessions] = useState([]);
  const [activeTimer, setActiveTimer] = useState(null);
  const [lastSession, setLastSession] = useState(null);

  // ---- load persisted state on mount ----
  useEffect(() => {
    (async () => {
      const [p, s, sess, act] = await Promise.all([
        storageGet(STORAGE_KEYS.PROFILE),
        storageGet(STORAGE_KEYS.SETTINGS),
        storageGet(STORAGE_KEYS.SESSIONS),
        storageGet(STORAGE_KEYS.ACTIVE),
      ]);
      const loadedSettings = s ? { ...DEFAULT_SETTINGS, ...s } : DEFAULT_SETTINGS;
      const loadedSessions = Array.isArray(sess) ? sess : [];
      setSettings(loadedSettings);
      setSessions(loadedSessions);

      if (p) {
        setProfile(p);
        if (act) {
          // A timer was running when the tab last closed — resolve it from real
          // timestamps rather than assuming it's still going.
          const remaining = remainingSecondsOf(act);
          if (remaining <= 0) {
            const session = buildSession(act, "completed");
            const updated = [session, ...loadedSessions];
            setSessions(updated);
            storageSet(STORAGE_KEYS.SESSIONS, updated);
            storageDelete(STORAGE_KEYS.ACTIVE);
            setScreen("home");
          } else {
            setActiveTimer(act);
            setScreen("activeTimer");
          }
        } else {
          setScreen("home");
        }
      } else {
        setScreen("welcome");
      }
      setLoading(false);
    })();
  }, []);

  // ---- authoritative completion watcher ----
  useEffect(() => {
    if (!activeTimer || activeTimer.status !== "running") return;
    const interval = setInterval(() => {
      const remaining = remainingSecondsOf(activeTimer);
      if (remaining <= 0) finalizeSession("completed");
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTimer]);

  function finalizeSession(status) {
    if (!activeTimer) return;
    const session = buildSession(activeTimer, status);
    const updated = [session, ...sessions];
    setSessions(updated);
    storageSet(STORAGE_KEYS.SESSIONS, updated);
    setActiveTimer(null);
    storageDelete(STORAGE_KEYS.ACTIVE);
    setLastSession(session);
    setScreen(status === "completed" ? "completion" : "home");
    if (status === "completed") {
      playCompletionChime(settings);
      vibrate(settings, [120, 60, 120]);
      maybeNotify(settings, session);
    } else {
      vibrate(settings, 50);
    }
  }

  function handleOnboardingSubmit({ name, workspaceName }) {
    const newProfile = {
      name,
      workspaceName,
      memberId: String(1 + Math.floor(Math.random() * 998)).padStart(3, "0"),
      memberSince: new Date().toISOString(),
      avatarDataUrl: null,
    };
    setProfile(newProfile);
    storageSet(STORAGE_KEYS.PROFILE, newProfile);
    setScreen("home");
  }

  function handleUpdateProfile(next) {
    setProfile(next);
    storageSet(STORAGE_KEYS.PROFILE, next);
  }

  function handleUpdateSettings(next) {
    setSettings(next);
    storageSet(STORAGE_KEYS.SETTINGS, next);
  }

  function handleAvatarFile(file) {
    if (!file || !profile) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 200;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        const next = { ...profile, avatarDataUrl: dataUrl };
        setProfile(next);
        storageSet(STORAGE_KEYS.PROFILE, next);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function handleClearHistory() {
    setSessions([]);
    storageSet(STORAGE_KEYS.SESSIONS, []);
  }

  function handleStartTimer({ hours, minutes, timerName }) {
    const plannedDuration = hours * 3600 + minutes * 60;
    if (plannedDuration <= 0) return;
    const t = {
      id: uid(),
      timerName,
      plannedDuration,
      startTime: Date.now(),
      pausedAt: null,
      totalPausedMs: 0,
      status: "running",
    };
    setActiveTimer(t);
    storageSet(STORAGE_KEYS.ACTIVE, t);
    setScreen("activeTimer");
    playClick(settings);
    vibrate(settings, 40);
  }

  function handlePause() {
    if (!activeTimer || activeTimer.status !== "running") return;
    const updated = { ...activeTimer, status: "paused", pausedAt: Date.now() };
    setActiveTimer(updated);
    storageSet(STORAGE_KEYS.ACTIVE, updated);
    vibrate(settings, 30);
  }

  function handleResume() {
    if (!activeTimer || activeTimer.status !== "paused") return;
    const pausedDuration = Date.now() - activeTimer.pausedAt;
    const updated = {
      ...activeTimer,
      status: "running",
      totalPausedMs: activeTimer.totalPausedMs + pausedDuration,
      pausedAt: null,
    };
    setActiveTimer(updated);
    storageSet(STORAGE_KEYS.ACTIVE, updated);
    vibrate(settings, 30);
  }

  function goBack() {
    const map = { setTimer: "home", history: "home", analytics: "home", settings: "home" };
    setScreen(map[screen] || "home");
  }

  const showBottomNav = profile && !["welcome", "activeTimer", "completion"].includes(screen);

  if (loading) {
    return (
      <div className="app-root loading-root">
        <style>{APP_CSS}</style>
        <div className="loading-spinner" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="app-root">
      <style>{APP_CSS}</style>
      <div className="app-frame">
        <ScreenShell screenKey={screen} reducedMotion={settings.reducedMotion}>
          {screen === "welcome" && <WelcomeScreen onSubmit={handleOnboardingSubmit} settings={settings} />}

          {screen === "home" && profile && (
            <HomeScreen
              profile={profile}
              sessions={sessions}
              settings={settings}
              onNavigate={setScreen}
              onNewTimer={() => setScreen("setTimer")}
              onEditAvatar={() => setScreen("settings")}
            />
          )}

          {screen === "setTimer" && (
            <SetTimerScreen
              onBack={goBack}
              onStart={handleStartTimer}
              settings={settings}
              defaultHours={settings.defaultHours}
              defaultMinutes={settings.defaultMinutes}
            />
          )}

          {screen === "activeTimer" && activeTimer && (
            <ActiveTimerScreen
              activeTimer={activeTimer}
              settings={settings}
              onPause={handlePause}
              onResume={handleResume}
              onStop={() => finalizeSession("stopped")}
              onSkip={() => finalizeSession("skipped")}
            />
          )}

          {screen === "completion" && lastSession && (
            <CompletionScreen
              session={lastSession}
              settings={settings}
              onDone={() => setScreen("home")}
              onStartAnother={() => setScreen("setTimer")}
            />
          )}

          {screen === "history" && <HistoryScreen sessions={sessions} onBack={goBack} />}

          {screen === "analytics" && <AnalyticsScreen sessions={sessions} onBack={goBack} />}

          {screen === "settings" && profile && (
            <SettingsScreen
              profile={profile}
              settings={settings}
              sessionsCount={sessions.length}
              onBack={goBack}
              onUpdateProfile={handleUpdateProfile}
              onUpdateSettings={handleUpdateSettings}
              onClearHistory={handleClearHistory}
              onAvatarFile={handleAvatarFile}
            />
          )}
        </ScreenShell>
      </div>

      {showBottomNav && (
        <nav className="bottom-nav">
          <button className={`nav-btn ${screen === "home" ? "active" : ""}`} onClick={() => setScreen("home")}>
            <HomeIcon size={18} />
            <span>Home</span>
          </button>
          <button className={`nav-btn ${screen === "history" ? "active" : ""}`} onClick={() => setScreen("history")}>
            <HistoryIcon size={18} />
            <span>History</span>
          </button>
          <button className={`nav-btn ${screen === "analytics" ? "active" : ""}`} onClick={() => setScreen("analytics")}>
            <TrendingUp size={18} />
            <span>Analytics</span>
          </button>
          <button className={`nav-btn ${screen === "settings" ? "active" : ""}`} onClick={() => setScreen("settings")}>
            <SettingsIcon size={18} />
            <span>Settings</span>
          </button>
        </nav>
      )}
    </div>
  );
}

/* ============================================================================
   STYLES — dark glass / 3D / cinematic design system
   ============================================================================ */

const APP_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap');

* { box-sizing: border-box; }

.app-root {
  --bg: #050506;
  --panel: rgba(255,255,255,0.045);
  --panel-strong: rgba(255,255,255,0.08);
  --panel-border: rgba(255,255,255,0.13);
  --panel-border-soft: rgba(255,255,255,0.08);
  --text: #f5f5f6;
  --text-dim: #8b8b92;
  --text-dimmer: #5a5a62;
  --warm: #ff7a45;
  --warm-2: #ff5252;
  --radius-lg: 28px;
  --radius-md: 20px;
  --radius-sm: 13px;
  --font-display: 'Space Grotesk', 'Manrope', sans-serif;
  --font-body: 'Manrope', -apple-system, sans-serif;

  position: relative;
  width: 100%;
  min-height: 100vh;
  background: radial-gradient(ellipse 120% 60% at 50% -10%, #131316 0%, #050506 55%);
  color: var(--text);
  font-family: var(--font-body);
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}
.app-root, .app-root * { box-sizing: border-box; }
.app-root button { font-family: var(--font-body); }
.app-root input { font-family: var(--font-body); color: var(--text); }

.app-frame {
  max-width: 480px;
  margin: 0 auto;
  min-height: 100vh;
  padding: 18px 16px 100px;
  position: relative;
}

.loading-root { display: flex; align-items: center; justify-content: center; }
.loading-spinner {
  width: 34px; height: 34px; border-radius: 50%;
  border: 2.5px solid rgba(255,255,255,0.12); border-top-color: #fff;
  animation: spin 0.85s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- screen transitions ---------- */
.screen-shell { width: 100%; }
.screen-enter { animation: screenIn 0.42s cubic-bezier(0.16,1,0.3,1); }
.no-motion { }
@keyframes screenIn {
  from { opacity: 0; transform: translateY(10px) scale(0.99); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.screen { display: flex; flex-direction: column; gap: 14px; position: relative; }

/* ---------- glass panel ---------- */
.glass-panel {
  position: relative;
  background: linear-gradient(155deg, rgba(255,255,255,0.065), rgba(255,255,255,0.018));
  border: 1px solid var(--panel-border-soft);
  border-radius: var(--radius-lg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 24px 48px -24px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.07);
  padding: 18px;
}

/* ---------- buttons ---------- */
.pill-button {
  width: 100%; display: flex; align-items: center; justify-content: center; position: relative;
  background: linear-gradient(180deg,#ffffff,#e7e7ea);
  border: none; border-radius: 999px; padding: 17px 8px 17px 22px;
  font-weight: 700; font-size: 15px; color: #0a0a0a; cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
  box-shadow: 0 14px 26px -10px rgba(255,255,255,0.18);
}
.pill-button:active { transform: scale(0.98); }
.pill-button:disabled { opacity: 0.38; cursor: not-allowed; }
.pill-label { flex: 1; text-align: center; letter-spacing: 0.2px; }
.pill-icon-circle {
  position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
  width: 38px; height: 38px; border-radius: 50%; background: #0a0a0a;
  display: flex; align-items: center; justify-content: center;
}
.pill-dark { background: rgba(255,255,255,0.07); color: #fff; border: 1px solid var(--panel-border); box-shadow: none; }
.pill-dark .pill-icon-circle { background: rgba(255,255,255,0.12); }

.ghost-button {
  width: 100%; background: transparent; border: 1px solid var(--panel-border);
  color: var(--text); border-radius: 999px; padding: 15px; font-weight: 600; font-size: 14px; cursor: pointer;
  transition: background 0.15s;
}
.ghost-button:active { background: rgba(255,255,255,0.06); }

.circle-icon-btn {
  border-radius: 50%; border: 1px solid var(--panel-border-soft); background: rgba(255,255,255,0.05);
  display: flex; align-items: center; justify-content: center; color: var(--text); cursor: pointer; flex-shrink: 0;
  transition: background 0.15s, transform 0.12s;
}
.circle-icon-btn:active { transform: scale(0.9); }
.circle-icon-btn.active { background: #fff; color: #0a0a0a; }

.link-button {
  background: none; border: none; color: var(--text-dim); font-size: 13px; font-weight: 600;
  display: flex; align-items: center; gap: 2px; cursor: pointer; padding: 4px;
}

.fab {
  position: fixed; right: max(20px, calc(50vw - 240px + 20px)); bottom: 96px;
  width: 58px; height: 58px; border-radius: 50%; border: none;
  background: linear-gradient(180deg,#ffffff,#e7e7ea);
  box-shadow: 0 16px 32px -10px rgba(255,255,255,0.35), 0 0 0 6px rgba(255,255,255,0.04);
  display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 20;
  transition: transform 0.15s;
}
.fab:active { transform: scale(0.93); }

/* ---------- inputs ---------- */
.glass-input {
  display: flex; align-items: center; gap: 10px;
  background: rgba(255,255,255,0.04); border: 1px solid var(--panel-border-soft);
  border-radius: var(--radius-sm); padding: 14px 16px; transition: border-color 0.15s, background 0.15s;
}
.glass-input:focus-within { border-color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.06); }
.glass-input.input-error { border-color: rgba(255,82,82,0.6); }
.glass-input input {
  flex: 1; background: none; border: none; outline: none; font-size: 14.5px; color: var(--text);
}
.glass-input input::placeholder { color: var(--text-dimmer); }
.glass-input-icon { color: var(--text-dim); flex-shrink: 0; }
.field-error { color: var(--warm-2); font-size: 12px; margin-top: 6px; padding-left: 4px; }
.field-error.center { text-align: center; padding-left: 0; }

/* ---------- welcome screen ---------- */
.welcome-screen { min-height: calc(100vh - 118px); justify-content: center; }
.welcome-bg { position: fixed; inset: 0; z-index: 0; opacity: 0.75; pointer-events: none; }
.welcome-panel { position: relative; z-index: 1; padding: 30px 24px 26px; }
.welcome-icon {
  width: 52px; height: 52px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.7);
  display: flex; align-items: center; justify-content: center; margin-bottom: 18px;
  box-shadow: 0 0 22px rgba(255,255,255,0.35), inset 0 0 12px rgba(255,255,255,0.15);
}
.welcome-title { font-family: var(--font-display); font-size: 30px; font-weight: 700; margin: 0 0 6px; }
.welcome-subtitle { color: var(--text-dim); font-size: 14px; margin: 0; }
.welcome-divider { height: 1px; background: rgba(255,255,255,0.1); margin: 20px 0; }
.welcome-field { margin-bottom: 18px; }
.welcome-field-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.welcome-field-title { font-weight: 700; font-size: 15px; }
.welcome-field-desc { color: var(--text-dim); font-size: 12.5px; margin: 0 0 10px 23px; line-height: 1.4; }
.welcome-credit { text-align: center; font-size: 12px; font-style: italic; color: var(--text-dimmer); margin-top: 16px; }

/* ---------- particle canvas ---------- */
.particle-field-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }

/* ---------- home screen ---------- */
.home-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.home-greeting { font-family: var(--font-display); font-size: 19px; font-weight: 600; }
.home-workspace { color: var(--text-dim); font-size: 12.5px; margin-top: 2px; }

.member-card-scene { perspective: 1400px; margin: 4px 0 2px; }
.member-card-wrap { position: relative; width: 100%; height: 200px; cursor: pointer; }
.member-card-inner {
  position: relative; width: 100%; height: 100%; transition: transform 0.7s cubic-bezier(0.4,0.2,0.2,1);
  transform-style: preserve-3d;
}
.member-card-wrap.flipped .member-card-inner { transform: rotateY(180deg); }
.member-card-face {
  position: absolute; inset: 0; border-radius: var(--radius-lg); backface-visibility: hidden;
  -webkit-backface-visibility: hidden; overflow: hidden; padding: 20px;
  border: 1px solid var(--panel-border-soft);
  box-shadow: 0 24px 48px -20px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08);
}
.member-card-front {
  background: linear-gradient(160deg, rgba(255,255,255,0.07), rgba(255,255,255,0.015));
  backdrop-filter: blur(16px);
}
.member-avatar {
  width: 52px; height: 52px; border-radius: 50%; background: linear-gradient(160deg,#3a3a3f,#1a1a1c);
  border: 1px solid rgba(255,255,255,0.18); display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display); font-weight: 700; font-size: 16px; color: #fff; margin-bottom: 10px;
  cursor: pointer; overflow: hidden; padding: 0;
}
.member-avatar img { width: 100%; height: 100%; object-fit: cover; }
.member-name { font-family: var(--font-display); font-size: 18px; font-weight: 700; }
.member-username { color: var(--text-dim); font-size: 12.5px; margin-top: 1px; }
.member-id-block { margin-top: 14px; }
.member-id-label { font-size: 9.5px; letter-spacing: 1.2px; color: var(--text-dimmer); font-weight: 700; }
.member-id-value { font-family: var(--font-display); font-size: 20px; font-weight: 700; margin-top: 1px; }
.member-since { position: absolute; bottom: 18px; left: 20px; font-size: 11px; color: var(--text-dim); }

.member-card-back {
  transform: rotateY(180deg);
  background: linear-gradient(115deg, #141416 45%, #ff6a35 148%);
}
.member-back-lines { position: absolute; inset: 0; opacity: 0.15; }
.member-back-lines span { position: absolute; left: -10%; width: 120%; height: 1px; background: #fff; transform: rotate(-6deg); }
.member-back-glow {
  position: absolute; right: -30%; top: -20%; width: 90%; height: 140%; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,122,69,0.55), transparent 65%); filter: blur(6px);
}
.member-back-grid {
  position: absolute; top: 18px; left: 20px; width: 64px; height: 64px;
  display: grid; grid-template-columns: repeat(8, 1fr); gap: 1.5px; opacity: 0.85;
}
.member-back-grid .cell-on { background: #e8e8ea; border-radius: 1px; }
.member-back-grid .cell-off { background: transparent; }
.member-back-shapes { position: absolute; top: 24px; right: 22px; display: flex; flex-direction: column; gap: 10px; opacity: 0.5; }
.shape-tri { width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 13px solid #fff; }
.shape-x { color: #fff; font-size: 15px; font-weight: 700; }
.shape-circle { width: 15px; height: 15px; border-radius: 50%; border: 2px solid #fff; }
.member-back-id { position: absolute; bottom: 40px; left: 20px; font-family: var(--font-display); font-size: 22px; font-weight: 700; color: #fff; }
.member-back-label { position: absolute; bottom: 40px; right: 20px; font-size: 8.5px; letter-spacing: 1px; color: rgba(255,255,255,0.75); font-weight: 700; }
.member-barcode { position: absolute; bottom: 18px; left: 20px; right: 20px; display: flex; gap: 2px; align-items: flex-end; height: 14px; }
.member-barcode span { display: block; height: 100%; background: rgba(255,255,255,0.8); }
.member-card-hint { text-align: center; font-size: 10.5px; color: var(--text-dimmer); margin-top: 8px; }

/* ---------- stats panel ---------- */
.stats-panel { display: flex; align-items: center; padding: 16px 8px; }
.stat-cell { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px; text-align: center; }
.stat-icon { color: var(--text-dim); }
.stat-value { font-family: var(--font-display); font-size: 20px; font-weight: 700; }
.stat-label { font-size: 10px; color: var(--text-dim); }
.stat-divider { width: 1px; align-self: stretch; background: rgba(255,255,255,0.08); margin: 2px 0; }

.section-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 0; }
.section-header span { font-weight: 700; font-size: 15px; }

.recent-list { padding: 6px 16px; }
.recent-empty { padding: 26px 16px; }
.recent-row { display: flex; align-items: center; gap: 10px; padding: 13px 0; border-bottom: 1px solid rgba(255,255,255,0.06); cursor: pointer; }
.recent-row:last-child { border-bottom: none; }
.recent-icon {
  width: 34px; height: 34px; border-radius: 50%; background: rgba(255,255,255,0.06); flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: var(--text-dim);
}
.recent-main { flex: 1; min-width: 0; }
.recent-name { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recent-date { font-size: 11px; color: var(--text-dim); margin-top: 1px; }
.recent-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.recent-duration { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

.status-pill {
  display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700;
  padding: 4px 9px; border-radius: 999px; white-space: nowrap;
}
.status-completed { background: rgba(255,255,255,0.12); color: #fff; }
.status-stopped { background: rgba(139,139,146,0.18); color: #b8b8bd; }
.status-skipped { background: rgba(255,82,82,0.16); color: #ff8a7a; }

.mini-score-ring { flex-shrink: 0; }
.mini-score-text { font-size: 10.5px; font-weight: 700; fill: var(--text); font-family: var(--font-body); }

.score-panel { display: flex; align-items: center; gap: 14px; }
.score-block { flex-shrink: 0; }
.score-label { font-size: 11px; color: var(--text-dim); margin-bottom: 3px; }
.score-value { font-family: var(--font-display); font-size: 26px; font-weight: 700; }
.score-value-sm { font-family: var(--font-display); font-size: 20px; font-weight: 700; }
.score-max { font-size: 13px; color: var(--text-dim); font-weight: 500; }
.score-sub { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }
.score-divider { width: 1px; align-self: stretch; background: rgba(255,255,255,0.08); }
.score-panel .score-block:last-of-type { flex: 1; }

.home-bottom-spacer { height: 8px; }

/* ---------- sub-header (History / Analytics / Settings) ---------- */
.sub-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.sub-header-title { font-family: var(--font-display); font-size: 18px; font-weight: 700; margin: 0; }

/* ---------- set timer screen ---------- */
.set-timer-header { display: flex; align-items: flex-start; justify-content: space-between; }
.decorative-arc { width: 84px; height: 68px; overflow: visible; }
.arc-orb { filter: drop-shadow(0 0 6px rgba(255,255,255,0.9)); }
.set-timer-title { font-family: var(--font-display); font-size: 27px; font-weight: 700; margin: 6px 0 0; }
.set-timer-subtitle { color: var(--text-dim); font-size: 13.5px; margin: 0; }
.timer-name-input { margin-top: 2px; }

.wheel-panel { padding: 10px 0 18px; }
.wheel-columns { display: flex; align-items: stretch; justify-content: center; }
.wheel-column-block { flex: 1; display: flex; flex-direction: column; align-items: center; }
.wheel-divider-line { width: 1px; background: rgba(255,255,255,0.1); margin: 8px 0; }
.wheel-column-label { color: var(--text-dim); font-size: 12px; margin-top: 4px; letter-spacing: 0.3px; }
.wheel-viewport { position: relative; width: 100%; overflow: hidden; }
.wheel-scroll {
  height: 100%; overflow-y: scroll; scroll-snap-type: y mandatory;
  scrollbar-width: none; -ms-overflow-style: none;
}
.wheel-scroll::-webkit-scrollbar { display: none; }
.wheel-item {
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display); font-size: 28px; font-weight: 600; color: var(--text);
  scroll-snap-align: center;
}
.wheel-item-selected { color: #fff; text-shadow: 0 0 18px rgba(255,255,255,0.5); }
.wheel-center-band {
  position: absolute; left: 6%; right: 6%; top: 50%; height: 54px; transform: translateY(-50%);
  border-top: 1px solid rgba(255,255,255,0.16); border-bottom: 1px solid rgba(255,255,255,0.16);
  pointer-events: none;
}

/* ---------- active timer screen ---------- */
.active-timer-screen { align-items: center; text-align: center; padding-top: 6px; min-height: calc(100vh - 118px); justify-content: center; }
.active-timer-bg { position: fixed; inset: 0; z-index: -1; opacity: 0.5; pointer-events: none; }
.timer-name-label { font-weight: 700; font-size: 15px; color: var(--text-dim); letter-spacing: 0.2px; }
.visual-stack { position: relative; width: 296px; max-width: 82vw; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; margin: 6px auto; }
.progress-ring { position: absolute; inset: 0; width: 100%; height: 100%; }
.progress-ring-arc { transition: stroke-dashoffset 1s linear; filter: drop-shadow(0 0 8px rgba(255,255,255,0.55)); }
.ring-label { fill: var(--text-dim); font-size: 12px; font-weight: 600; font-family: var(--font-body); }
.visual-stack-inner { position: relative; z-index: 1; }
.timer-visual-canvas { filter: drop-shadow(0 0 26px rgba(255,255,255,0.16)); }
.completion-visual .timer-visual-canvas { filter: drop-shadow(0 0 30px rgba(255,150,80,0.35)); }

.digital-capsule {
  display: inline-flex; align-items: center; gap: 9px; background: rgba(255,255,255,0.05);
  border: 1px solid var(--panel-border-soft); border-radius: 999px; padding: 12px 22px; margin-top: 4px;
}
.digital-readout { font-family: var(--font-display); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0.5px; }

.pause-button {
  width: 74px; height: 74px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.75);
  background: rgba(255,255,255,0.04); color: #fff; display: flex; align-items: center; justify-content: center;
  cursor: pointer; margin-top: 18px; box-shadow: 0 0 26px rgba(255,255,255,0.28), inset 0 0 14px rgba(255,255,255,0.08);
  transition: transform 0.15s;
}
.pause-button:active { transform: scale(0.94); }
.pause-button.is-paused { background: rgba(255,122,69,0.12); border-color: rgba(255,150,90,0.85); box-shadow: 0 0 26px rgba(255,130,70,0.3); }

.secondary-controls { display: flex; gap: 12px; margin-top: 18px; }
.secondary-btn {
  display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.05);
  border: 1px solid var(--panel-border-soft); color: var(--text-dim); padding: 10px 18px; border-radius: 999px;
  font-size: 12.5px; font-weight: 600; cursor: pointer; transition: all 0.15s;
}
.secondary-btn.confirming { background: rgba(255,82,82,0.14); border-color: rgba(255,110,110,0.5); color: #ff9a8a; }

/* ---------- completion screen ---------- */
.completion-screen { align-items: center; text-align: center; padding-top: 30px; min-height: calc(100vh - 118px); justify-content: center; }
.completion-glow {
  position: absolute; top: 10%; left: 50%; width: 280px; height: 280px; transform: translateX(-50%);
  border-radius: 50%; background: radial-gradient(circle, rgba(255,150,80,0.28), transparent 65%);
  filter: blur(10px); transition: opacity 1s ease, transform 1s ease; z-index: -1;
}
.completion-glow.burst { opacity: 1; transform: translateX(-50%) scale(1.3); }
.completion-glow.settled { opacity: 0.55; transform: translateX(-50%) scale(1); }
.completion-visual { width: 190px; margin: 0 auto -30px; }
.completion-check {
  width: 52px; height: 52px; border-radius: 50%; background: #fff; color: #0a0a0a;
  display: flex; align-items: center; justify-content: center; margin: 0 auto 4px;
  box-shadow: 0 0 30px rgba(255,255,255,0.5); transition: transform 0.5s cubic-bezier(0.34,1.56,0.64,1);
}
.completion-check.burst { transform: scale(0); }
.completion-check.settled { transform: scale(1); }
.completion-title { font-family: var(--font-display); font-size: 24px; font-weight: 700; margin: 4px 0 0; }
.completion-name { color: var(--text-dim); font-size: 14px; margin-top: 2px; }
.completion-stats { display: flex; width: 100%; margin-top: 10px; }
.completion-stat { flex: 1; text-align: center; }
.completion-stat-label { font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
.completion-stat-value { font-family: var(--font-display); font-size: 21px; font-weight: 700; }
.completion-actions { width: 100%; display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }

/* ---------- history screen ---------- */
.search-input { margin-top: 2px; }
.filter-row { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
.filter-chip {
  flex-shrink: 0; background: rgba(255,255,255,0.04); border: 1px solid var(--panel-border-soft);
  color: var(--text-dim); padding: 9px 16px; border-radius: 999px; font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: all 0.15s;
}
.filter-chip.active { background: #fff; color: #0a0a0a; border-color: #fff; }

.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
  display: flex; align-items: flex-end; justify-content: center; z-index: 50; padding: 0;
  animation: fadeIn 0.2s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.modal-panel {
  width: 100%; max-width: 480px; border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  animation: slideUp 0.3s cubic-bezier(0.16,1,0.3,1); max-height: 80vh; overflow-y: auto;
}
@keyframes slideUp { from { transform: translateY(30px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.modal-header h2 { font-family: var(--font-display); font-size: 18px; margin: 0; }
.detail-grid { margin-top: 14px; display: flex; flex-direction: column; gap: 11px; }
.detail-row { display: flex; align-items: center; justify-content: space-between; font-size: 13.5px; }
.detail-label { color: var(--text-dim); }
.detail-value { font-weight: 600; font-variant-numeric: tabular-nums; }

/* ---------- analytics screen ---------- */
.analytics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.analytics-cell { padding: 14px 10px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.a-label { font-size: 10px; color: var(--text-dim); line-height: 1.3; }
.a-value { font-family: var(--font-display); font-size: 19px; font-weight: 700; }
.a-value-text { font-size: 15px; }
.chart-panel { padding-bottom: 8px; }
.chart-title { font-weight: 700; font-size: 13.5px; margin-bottom: 6px; }
.pie-row { display: flex; align-items: center; gap: 6px; }
.pie-legend { display: flex; flex-direction: column; gap: 8px; }
.pie-legend-item { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-dim); }
.pie-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }

/* ---------- settings screen ---------- */
.settings-section-title { font-size: 11.5px; font-weight: 700; letter-spacing: 0.6px; color: var(--text-dim); text-transform: uppercase; padding: 6px 6px 0; }
.settings-panel { display: flex; flex-direction: column; gap: 14px; }
.settings-avatar-row { display: flex; align-items: center; gap: 12px; }
.settings-avatar {
  position: relative; width: 56px; height: 56px; border-radius: 50%; border: none; padding: 0; cursor: pointer;
  background: linear-gradient(160deg,#3a3a3f,#1a1a1c); display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display); font-weight: 700; font-size: 17px; color: #fff; overflow: hidden;
}
.settings-avatar img { width: 100%; height: 100%; object-fit: cover; }
.settings-avatar-badge {
  position: absolute; bottom: -2px; right: -2px; width: 20px; height: 20px; border-radius: 50%;
  background: #fff; color: #0a0a0a; display: flex; align-items: center; justify-content: center;
  border: 2px solid #0a0a0a;
}
.settings-avatar-hint { font-size: 12.5px; color: var(--text-dim); }
.settings-field label { font-size: 11.5px; color: var(--text-dim); display: block; margin-bottom: 6px; }

.toggle-row { display: flex; align-items: center; justify-content: space-between; }
.toggle-left { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text); }
.toggle-switch {
  width: 44px; height: 26px; border-radius: 999px; border: none; background: rgba(255,255,255,0.14);
  position: relative; cursor: pointer; transition: background 0.2s; flex-shrink: 0;
}
.toggle-switch.on { background: #fff; }
.toggle-knob {
  position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff;
  transition: transform 0.2s; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.toggle-switch.on .toggle-knob { transform: translateX(18px); background: #0a0a0a; }

.segmented { display: flex; background: rgba(255,255,255,0.05); border-radius: 999px; padding: 3px; }
.segmented-btn { background: none; border: none; color: var(--text-dim); font-size: 11.5px; font-weight: 600; padding: 6px 11px; border-radius: 999px; cursor: pointer; }
.segmented-btn.active { background: #fff; color: #0a0a0a; }

.settings-note { font-size: 12.5px; color: var(--text-dim); }
.settings-inline-btn {
  display: flex; align-items: center; gap: 5px; background: rgba(255,255,255,0.08); border: 1px solid var(--panel-border-soft);
  color: var(--text); font-size: 12px; font-weight: 600; padding: 7px 13px; border-radius: 999px; cursor: pointer;
}
.settings-inline-btn.danger { background: rgba(255,82,82,0.16); border-color: rgba(255,110,110,0.4); color: #ff8a7a; }
.about-panel { gap: 6px; }
.about-line { font-weight: 700; font-size: 14.5px; }
.about-sub { font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }

/* ---------- empty state ---------- */
.empty-state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 10px; color: var(--text-dim); }
.empty-icon { width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
.empty-title { font-weight: 700; font-size: 14px; color: var(--text); }
.empty-subtitle { font-size: 12.5px; }

/* ---------- bottom nav ---------- */
.bottom-nav {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 15;
  max-width: 480px; margin: 0 auto; display: flex; justify-content: space-around;
  background: rgba(10,10,11,0.82); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid rgba(255,255,255,0.08); padding: 10px 6px calc(10px + env(safe-area-inset-bottom, 0px));
}
.nav-btn {
  background: none; border: none; color: var(--text-dimmer); display: flex; flex-direction: column; align-items: center;
  gap: 3px; font-size: 10px; font-weight: 600; cursor: pointer; padding: 4px 10px; border-radius: 12px; transition: color 0.15s;
}
.nav-btn.active { color: #fff; }

/* ---------- reduced motion ---------- */
.no-motion, .no-motion * { animation-duration: 0.001s !important; transition-duration: 0.001s !important; }

/* ---------- responsive ---------- */
@media (max-width: 360px) {
  .visual-stack { width: 260px; }
  .wheel-item { font-size: 24px; }
  .analytics-grid { gap: 8px; }
}

/* Android / mobile WebView refinements */
html, body, #root { min-height: 100%; }
body { overscroll-behavior: none; -webkit-tap-highlight-color: transparent; }
button, input { font: inherit; }
input { -webkit-user-select: text; user-select: text; }
`;
