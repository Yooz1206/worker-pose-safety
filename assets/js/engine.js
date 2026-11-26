/* ==========================================================================
 * engine.js — 姿态引擎 / 多目标追踪 / 行为判定
 * 浏览器端 MediaPipe PoseLandmarker（33 关键点，多目标）
 * 追踪为 DeepSORT 思路的轻量实现：IoU + 质心距离级联匹配 + 轨迹老化
 * ========================================================================== */
import { FilesetResolver, PoseLandmarker } from '../vision/vision_bundle.js';

export const DEFAULT_CONFIG = {
  fallAngle: 62,        // 躯干倾角 >= 该值 → 跌倒候选
  bendAngle: 40,        // 弯腰判定起始角
  kneeStraight: 150,    // 膝关节伸直阈值
  loiterSec: 8,         // 滞留判定秒数
  maxPersons: 6,        // numPoses
  maxFps: 24,           // 处理帧率上限
  eventCooldown: 10,    // 同目标同事件冷却（秒）
  fallFrames: 6,        // 跌倒连续帧
  bendFrames: 4,        // 弯腰连续帧
  climbHold: 1.2,       // 攀爬举手保持时长（秒）
  confGate: 0.65,       // 事件记录的最低置信度
  modelQuality: 'lite', // lite / full

  // —— 语音播报 ——
  voiceEnabled: true,   // 总开关
  voiceURI: '',         // 指定音色（空 = 自动选择中文女声）
  voiceRate: 1.0,       // 语速
  voicePitch: 1.0,      // 音调
  voiceVolume: 0.9,     // 音量
  voiceMinGap: 6,       // 相同话术的最小播报间隔（秒）
  voiceRepeat: 2,       // 高危告警连续播报次数
  voiceHighOnly: false, // 仅播报高危
  reAlertSec: 30,       // 未处理高危告警的重播间隔（秒）

  sound: true,
  showSkeleton: true,
  showBox: true,
  mirror: true,
  saveThumb: true,
  scene: '车间A栋',
};

export const TYPE_META = {
  '正常作业':   { level: 'low',  color: '#34d399' },
  '弯腰作业':   { level: 'mid',  color: '#fbbf24' },
  '攀爬作业':   { level: 'mid',  color: '#f59e0b' },
  '人员滞留':   { level: 'mid',  color: '#fb923c' },
  '进入危险区': { level: 'high', color: '#f43f5e' },
  '跌倒':       { level: 'high', color: '#ff3b5c' },
  '人工喊话':   { level: 'mid',  color: '#a78bfa' },
};

// COCO / PoseLandmarker 常用连线（不含肩-对侧髋的交叉对角线，避免躯干被画成 X 形）
export const SKELETON = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32],
];

export const PALETTE = ['#22d3ee', '#a78bfa', '#34d399', '#f472b6', '#38bdf8', '#facc15', '#fb923c', '#4ade80'];

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function mid(a, b) {
  if (!a || !b) return { x: 0, y: 0, visibility: 0 };
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

/** 躯干与竖直方向夹角（0° = 直立，90° = 完全横躺） */
export function torsoAngle(lm) {
  const s = mid(lm[11], lm[12]);
  const h = mid(lm[23], lm[24]);
  const dx = s.x - h.x;
  const dy = s.y - h.y;
  return Math.abs(Math.atan2(dx, -dy)) * 180 / Math.PI;
}

/** 三点夹角（b 为顶点） */
export function jointAngle(a, b, c) {
  if (!a || !b || !c) return 180;
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-6 || n2 < 1e-6) return 180;
  const cos = clamp((v1x * v2x + v1y * v2y) / (n1 * n2), -1, 1);
  return Math.acos(cos) * 180 / Math.PI;
}

/** 由关键点外扩得到人体包围框（归一化坐标） */
export function boxFromLandmarks(lm) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0, strong = 0;
  for (const p of lm) {
    if (!p) continue;
    const vis = p.visibility == null ? 1 : p.visibility;
    if (vis < 0.3) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    strong++;
  }
  if (strong < 4) {
    minX = 1; minY = 1; maxX = 0; maxY = 0;
    for (const p of lm) {
      if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (maxX <= minX || maxY <= minY) return { x: 0, y: 0, w: 0, h: 0 };
  const padX = (maxX - minX) * 0.12;
  const padTop = (maxY - minY) * 0.12;
  const padBottom = (maxY - minY) * 0.04;
  return {
    x: clamp(minX - padX, 0, 1),
    y: clamp(minY - padTop, 0, 1),
    w: clamp((maxX - minX) + padX * 2, 0, 1),
    h: clamp((maxY - minY) + padTop + padBottom, 0, 1),
  };
}

/**
 * 关键点自适应平滑：慢动作做平滑去抖，快动作立即跟随，避免骨架"拖影"或"滞后"
 */
export function blendLandmarks(prev, next, alpha = 0.55) {
  if (!prev || prev.length !== next.length) return next;
  const out = new Array(next.length);
  for (let i = 0; i < next.length; i++) {
    const p = prev[i], n = next[i];
    if (!p || !n) { out[i] = n; continue; }
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    const a = d > 0.05 ? 0.9 : (d > 0.015 ? 0.7 : alpha);
    out[i] = {
      x: p.x + (n.x - p.x) * a,
      y: p.y + (n.y - p.y) * a,
      z: (p.z || 0) + ((n.z || 0) - (p.z || 0)) * a,
      visibility: n.visibility,
    };
  }
  return out;
}

export function iou(a, b) {  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = x2 - x1, ih = y2 - y1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni <= 0 ? 0 : inter / uni;
}

export function pointInPoly(pt, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const hit = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < ((xj - xi) * (pt.y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

/* ============================ 追踪器 ============================ */
export class Tracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.tracks = [];
    this.totalIds = 0;
    this.nextId = 1;
  }

  reset() {
    this.tracks = [];
    this.totalIds = 0;
    this.nextId = 1;
  }

  _create(det, now) {
    const id = this.nextId++;
    this.totalIds = Math.max(this.totalIds, id);
    const t = {
      id,
      color: PALETTE[(id - 1) % PALETTE.length],
      box: { ...det.box },
      lm: det.lm,
      vx: 0,
      vy: 0,
      hits: 1,
      frames: 1,
      lastTs: now,
      firstTs: now,
      hist: [{ ts: now, hipY: mid(det.lm[23], det.lm[24]).y, box: { ...det.box } }],
      fallHold: 0,
      bendHold: 0,
      handsUpSince: null,
      zoneSince: null,
      type: '正常作业',
      conf: 0.9,
      level: 'low',
      zone: null,
      metrics: {},
      flags: {},
    };
    this.tracks.push(t);
    return t;
  }

  /** 按速度外推的预测框（占位卡尔曼，抑制快速移动时的 ID 抖动） */
  _predict(t, now) {
    const dt = Math.min((now - t.lastTs) / 1000, 0.4);
    return {
      x: t.box.x + t.vx * dt,
      y: t.box.y + t.vy * dt,
      w: t.box.w,
      h: t.box.h,
    };
  }

  _merge(t, det, now) {
    const dt = Math.max((now - t.lastTs) / 1000, 1e-3);
    const a = 0.65;
    const prevCx = t.box.x + t.box.w / 2;
    const prevCy = t.box.y + t.box.h / 2;

    t.box = {
      x: t.box.x * (1 - a) + det.box.x * a,
      y: t.box.y * (1 - a) + det.box.y * a,
      w: t.box.w * (1 - a) + det.box.w * a,
      h: t.box.h * (1 - a) + det.box.h * a,
    };

    // 速度估计（指数平滑，限制在 ±2.5/s 内，避免误检把速度带飞）
    const ncx = det.box.x + det.box.w / 2;
    const ncy = det.box.y + det.box.h / 2;
    const mvx = clamp((ncx - prevCx) / dt, -2.5, 2.5);
    const mvy = clamp((ncy - prevCy) / dt, -2.5, 2.5);
    t.vx = t.vx * 0.6 + mvx * 0.4;
    t.vy = t.vy * 0.6 + mvy * 0.4;

    t.lm = blendLandmarks(t.lm, det.lm, 0.55);
    t.hits++;
    t.frames++;
    t.lastTs = now;
    const hipY = mid(det.lm[23], det.lm[24]).y;
    t.hist.push({ ts: now, hipY, box: { ...t.box } });
    if (t.hist.length > 45) t.hist.shift();
  }

  update(dets, now) {
    const pairs = [];
    for (const t of this.tracks) {
      const pred = this._predict(t, now);
      for (const d of dets) {
        const i = iou(pred, d.box);
        const c1x = pred.x + pred.w / 2, c1y = pred.y + pred.h / 2;
        const c2x = d.box.x + d.box.w / 2, c2y = d.box.y + d.box.h / 2;
        const dist = Math.hypot(c1x - c2x, c1y - c2y);
        const size = Math.max(0.12, (Math.min(t.box.w + t.box.h, d.box.w + d.box.h)) / 2);
        const cost = (1 - i) + (dist / size) * 0.55;
        if (cost < 1.1) pairs.push({ t, d, cost, dist, size });
      }
    }
    pairs.sort((p, q) => p.cost - q.cost);

    const usedT = new Set(), usedD = new Set();
    for (const p of pairs) {
      if (usedT.has(p.t) || usedD.has(p.d)) continue;
      usedT.add(p.t);
      usedD.add(p.d);
      this._merge(p.t, p.d, now);
    }
    for (const d of dets) {
      if (usedD.has(d)) continue;
      this._create(d, now);
    }
    // 未匹配的轨迹：保留 1.2s 做惯性外推，便于遮挡恢复
    this.tracks = this.tracks.filter(t => now - t.lastTs < 1200);
    for (const t of this.tracks) {
      if (now - t.lastTs > 60) {
        t.box.x += t.vx * 0.016;
        t.box.y += t.vy * 0.016;
        t.vx *= 0.9;
        t.vy *= 0.9;
      }
    }
    return this.tracks;
  }
}

/* ============================ 行为判定 ============================ */
export class Analyzer {
  constructor(cfg) {
    this.cfg = cfg;
  }

  /** 返回 { type, conf, level, zone, metrics, flags } */
  analyze(t, zones, now, flagsEnabled = {}) {
    const cfg = this.cfg;
    const lm = t.lm;
    const meta = TYPE_META;
    const res = { type: '正常作业', conf: 0.9, level: 'low', zone: null, metrics: {}, flags: {} };
    if (!lm || lm.length < 29) return res;

    const sh = mid(lm[11], lm[12]);
    const hp = mid(lm[23], lm[24]);
    const ang = torsoAngle(lm);
    const knee = Math.max(
      jointAngle(lm[23], lm[25], lm[27]),
      jointAngle(lm[24], lm[26], lm[28])
    );
    const aspect = t.box.w / Math.max(t.box.h, 1e-6);

    // 髋部在近 0.8s 内的下落量（跌倒的强特征）
    let drop = 0;
    if (t.hist.length > 2) {
      const base = t.hist.find(h => now - h.ts <= 800) || t.hist[0];
      drop = hp.y - base.hipY;
    }

    // 手部：过肩 / 过头顶是两个不同门槛，攀爬必须过顶
    const nose = lm[0] || sh;
    const wl = lm[15], wr = lm[16];
    const handVis = Math.min(wl?.visibility ?? 0, wr?.visibility ?? 0);
    const highHand = handVis > 0.3 ? Math.max(wl.y, wr.y) : 1;
    const handsUp = handVis > 0.3 && highHand < sh.y - 0.02;
    const handsOverHead = handVis > 0.3 && highHand < nose.y - 0.01;

    const coreVis = [lm[11], lm[12], lm[23], lm[24]].reduce((s, p) => s + (p?.visibility ?? 1), 0) / 4;
    res.metrics = {
      angle: Math.round(ang),
      knee: Math.round(knee),
      aspect: +aspect.toFixed(2),
      drop: +drop.toFixed(3),
      dwell: t.zoneSince ? Math.round((now - t.zoneSince) / 1000) : 0,
      handsUp,
      handsOverHead,
      life: Math.round((now - t.firstTs) / 1000),
      vis: +coreVis.toFixed(2),
    };

    // ---- 区域判定 ----
    let zoneHit = null;
    if (flagsEnabled.zone !== false) {
      for (const z of zones) {
        if (z.points && z.points.length >= 3 && pointInPoly(hp, z.points)) { zoneHit = z; break; }
      }
    }
    if (zoneHit) {
      if (!t.zoneSince) t.zoneSince = now;
    } else {
      t.zoneSince = null;
    }
    res.zone = zoneHit ? zoneHit.name : null;
    res.flags.inZone = !!zoneHit;

    // ---- 跌倒 ----
    let fallScore = 0;
    if (flagsEnabled.fall !== false) {
      if (ang >= cfg.fallAngle) fallScore += 0.5;
      if (aspect >= 1.2) fallScore += 0.35;
      if (drop > 0.12) fallScore += 0.3;
      if (ang >= cfg.fallAngle && aspect >= 1.0) fallScore += 0.15;
      fallScore = Math.min(fallScore, 1);
      t.fallHold = fallScore >= 0.6 ? t.fallHold + 1 : Math.max(0, t.fallHold - 2);
    }
    res.flags.fallScore = +fallScore.toFixed(2);

    // ---- 弯腰：躯干前倾 + 腿部相对伸直 + 持续保持（抑制路过、侧身、低头误判）
    const bendCond = flagsEnabled.bend !== false &&
      ang >= cfg.bendAngle && ang < cfg.fallAngle - 4 && knee >= cfg.kneeStraight;
    t.bendHold = bendCond ? Math.min(t.bendHold + 1, 40) : Math.max(0, t.bendHold - 2);
    res.flags.bendHold = t.bendHold;

    // ---- 攀爬（双手持续举过头顶）----
    if (flagsEnabled.bend !== false && handsOverHead) {
      if (!t.handsUpSince) t.handsUpSince = now;
    } else {
      t.handsUpSince = null;
    }
    const climbHeld = t.handsUpSince ? (now - t.handsUpSince) / 1000 : 0;
    res.flags.climbHeld = +climbHeld.toFixed(1);

    // ---- 按优先级输出（新生轨迹先稳定 5 帧再参与动作判定，避免抖动误报）----
    const dwell = t.zoneSince ? (now - t.zoneSince) / 1000 : 0;
    const warming = t.hits < 5;

    if (!warming && t.fallHold >= cfg.fallFrames) {
      res.type = '跌倒';
      res.conf = clamp(0.62 + fallScore * 0.35, 0, 0.99);
    } else if (zoneHit) {
      if (flagsEnabled.loiter !== false && dwell >= cfg.loiterSec) {
        res.type = '人员滞留';
        res.conf = clamp(0.6 + Math.min(dwell / (cfg.loiterSec * 3), 1) * 0.35, 0, 0.98);
      } else {
        res.type = '进入危险区';
        res.conf = clamp(0.72 + Math.min((ang / 180) * 0.2, 0.2), 0, 0.98);
      }
    } else if (!warming && climbHeld >= cfg.climbHold) {
      res.type = '攀爬作业';
      res.conf = clamp(0.62 + Math.min(climbHeld / (cfg.climbHold * 4), 1) * 0.32, 0, 0.96);
    } else if (!warming && t.bendHold >= cfg.bendFrames) {
      res.type = '弯腰作业';
      const over = (ang - cfg.bendAngle) / Math.max(cfg.fallAngle - cfg.bendAngle, 1);
      res.conf = clamp(0.6 + Math.min(over, 1) * 0.32, 0, 0.96);
    } else {
      res.type = '正常作业';
      res.conf = clamp(0.62 + coreVis * 0.36, 0.5, 0.99);
    }

    res.level = (meta[res.type] || meta['正常作业']).level;
    return res;
  }

  /**
   * 单帧判定（静态图片）：没有时序信息，只用几何关系做「此刻」的姿态判断。
   * 持续类规则（跌倒连续帧、弯腰连续帧、攀爬保持时长、滞留时长）无法在单帧成立，
   * 因此这里改用「躯干倾角 + 包围框横置 + 膝关节伸直 + 双手过顶」这些单帧可判的特征，
   * 结果结构与 analyze() 保持一致，便于共用渲染 / 事件 / 告警逻辑。
   */
  analyzeStatic(t, zones, now, flagsEnabled = {}) {
    const cfg = this.cfg;
    const lm = t.lm;
    const meta = TYPE_META;
    const res = { type: '正常作业', conf: 0.9, level: 'low', zone: null, metrics: {}, flags: {} };
    if (!lm || lm.length < 29) return res;

    const sh = mid(lm[11], lm[12]);
    const hp = mid(lm[23], lm[24]);
    const ang = torsoAngle(lm);
    const knee = Math.max(
      jointAngle(lm[23], lm[25], lm[27]),
      jointAngle(lm[24], lm[26], lm[28])
    );
    const aspect = t.box.w / Math.max(t.box.h, 1e-6);

    const nose = lm[0] || sh;
    const wl = lm[15], wr = lm[16];
    const handVis = Math.min(wl?.visibility ?? 0, wr?.visibility ?? 0);
    const highHand = handVis > 0.3 ? Math.max(wl.y, wr.y) : 1;
    const handsUp = handVis > 0.3 && highHand < sh.y - 0.02;
    const handsOverHead = handVis > 0.3 && highHand < nose.y - 0.01;

    const coreVis = [lm[11], lm[12], lm[23], lm[24]].reduce((s, p) => s + (p?.visibility ?? 1), 0) / 4;

    // ---- 区域判定（静态图不打滞留，只判「是否在危险区内」）----
    let zoneHit = null;
    if (flagsEnabled.zone !== false) {
      for (const z of zones) {
        if (z.points && z.points.length >= 3 && pointInPoly(hp, z.points)) { zoneHit = z; break; }
      }
    }
    res.zone = zoneHit ? zoneHit.name : null;
    res.flags.inZone = !!zoneHit;

    // ---- 单帧证据：躯干接近水平 + 包围框横置 → 倒地 ----
    let fallScore = 0;
    if (flagsEnabled.fall !== false) {
      if (ang >= cfg.fallAngle) fallScore += 0.55;
      if (aspect >= 1.15) fallScore += 0.35;
      if (ang >= cfg.fallAngle && aspect >= 1.0) fallScore += 0.1;
      fallScore = Math.min(fallScore, 1);
    }
    res.flags.fallScore = +fallScore.toFixed(2);

    // ---- 单帧证据：躯干前倾 + 腿相对伸直 → 弯腰 ----
    const bendCond = flagsEnabled.bend !== false &&
      ang >= cfg.bendAngle && ang < cfg.fallAngle - 4 && knee >= cfg.kneeStraight;
    res.flags.bendCond = bendCond;

    res.metrics = {
      angle: Math.round(ang),
      knee: Math.round(knee),
      aspect: +aspect.toFixed(2),
      drop: 0,
      dwell: 0,
      handsUp,
      handsOverHead,
      life: 0,
      vis: +coreVis.toFixed(2),
      still: true,
    };

    if (fallScore >= 0.6) {
      res.type = '跌倒';
      res.conf = clamp(0.62 + fallScore * 0.35, 0, 0.99);
    } else if (zoneHit) {
      res.type = '进入危险区';
      res.conf = clamp(0.72 + Math.min((ang / 180) * 0.2, 0.2), 0, 0.98);
    } else if (flagsEnabled.bend !== false && handsOverHead) {
      res.type = '攀爬作业';
      res.conf = clamp(0.62 + Math.min(Math.max(nose.y - highHand, 0) * 4, 1) * 0.3, 0, 0.96);
    } else if (bendCond) {
      res.type = '弯腰作业';
      const over = (ang - cfg.bendAngle) / Math.max(cfg.fallAngle - cfg.bendAngle, 1);
      res.conf = clamp(0.6 + Math.min(over, 1) * 0.32, 0, 0.96);
    } else {
      res.type = '正常作业';
      res.conf = clamp(0.62 + coreVis * 0.36, 0.5, 0.99);
    }

    res.level = (meta[res.type] || meta['正常作业']).level;
    return res;
  }
}

/* ============================ 姿态引擎 ============================ */
export class PoseEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.landmarker = null;
    this.quality = cfg.modelQuality === 'full' ? 'full' : 'lite';
    this.lastError = null;
  }

  async init() {
    // 模型路径在初始化时解析，保证「切换精度 → 重启采集」能真正生效
    const q = this.cfg.modelQuality === 'full' ? 'full' : 'lite';
    this.quality = q;
    const localPath = new URL(`../models/pose_landmarker_${q}.task`, import.meta.url).href;
    const litePath = new URL('../models/pose_landmarker_lite.task', import.meta.url).href;
    const remotePath = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${q}/float16/1/pose_landmarker_${q}.task`;

    const wasmBase = new URL('../vision/wasm', import.meta.url).href;
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);

    const build = (modelPath, delegate) => ({
      baseOptions: { modelAssetPath: modelPath, delegate },
      runningMode: 'VIDEO',
      numPoses: this.cfg.maxPersons,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.3,
      outputSegmentationMasks: false,
    });

    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, build(localPath, 'GPU'));
    } catch (e1) {
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(fileset, build(localPath, 'CPU'));
      } catch (e2) {
        try {
          this.landmarker = await PoseLandmarker.createFromOptions(fileset, build(remotePath, 'CPU'));
        } catch (e3) {
          // 高精度模型不可用时退回 lite
          this.quality = 'lite';
          this.landmarker = await PoseLandmarker.createFromOptions(fileset, build(litePath, 'CPU'));
        }
      }
    }
    return this.landmarker;
  }

  async ensure() {
    if (!this.landmarker) await this.init();
    return this.landmarker;
  }

  detect(video, ts) {
    if (!this.landmarker) return [];
    const out = this.landmarker.detectForVideo(video, ts);
    return (out && out.landmarks) ? out.landmarks : [];
  }

  close() {
    try { this.landmarker?.close(); } catch (e) { /* noop */ }
    this.landmarker = null;
  }
}
