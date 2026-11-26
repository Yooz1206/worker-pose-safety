/* ==========================================================================
 * alerts.js — 告警中心
 *
 * 检测结果与人工喊话统一写入同一个告警队列，主界面据此渲染：
 *   · 顶部告警横幅
 *   · 右侧「待处理告警」卡片
 *   · 事件记录表的播报 / 处理状态列
 *
 * 每条告警是有状态的：待处理 → 已处理 / 已忽略，
 * 未处理的高危告警会按 reAlertSec 反复播报，直到有人确认。
 * ========================================================================== */

export const LEVEL_RANK = { low: 1, mid: 2, high: 3 };

export const SOURCE_META = {
  auto: { label: '自动识别', short: '自动' },
  manual: { label: '人工喊话', short: '人工' },
  realert: { label: '超时重播', short: '重播' },
};

export class AlertCenter {
  constructor(cfg) {
    this.cfg = cfg;
    this.items = [];
    this.seq = 0;
    this.listeners = new Set();
    this.max = 160;
    this.voicedTotal = 0;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const pending = this.pending();
    for (const fn of this.listeners) {
      try { fn(this.items, pending, this); } catch (e) { /* noop */ }
    }
  }

  /**
   * 新建一条告警。同一来源、同一人员、同一类型在冷却时间内会合并计数，
   * 避免同一动作在队列里刷出一长串重复条目。
   */
  raise(input = {}) {
    const now = Date.now();
    const {
      type = '安全告警',
      level = 'mid',
      text = '',
      label = '',
      personId = null,
      zone = null,
      conf = 0,
      source = 'auto',
      thumb = null,
      priority = 2,
    } = input;

    const cd = Math.max(3, Number(this.cfg.eventCooldown) || 10) * 1000;
    const dup = this.items.find(a =>
      a.status === 'new'
      && a.source === source
      && a.type === type
      && a.personId === personId
      && now - a.lastTs < cd);

    if (dup) {
      dup.count++;
      dup.lastTs = now;
      dup.conf = Math.max(dup.conf, conf);
      if ((LEVEL_RANK[level] || 0) > (LEVEL_RANK[dup.level] || 0)) {
        dup.level = level;
        dup.priority = priority;
      }
      this._emit();
      return dup;
    }

    const item = {
      id: `AL${++this.seq}`,
      ts: now,
      lastTs: now,
      type,
      label: label || type,
      level,
      priority,
      text,
      personId,
      zone,
      conf,
      source,
      thumb,
      status: 'new',      // new | acked | ignored
      count: 1,
      voice: 'queued',    // queued | speaking | done | dup | off | skip | fail
      voiceRounds: 0,
      lastVoiceAt: 0,
      ackAt: 0,
      ackBy: '',
    };
    this.items.unshift(item);
    if (this.items.length > this.max) this.items.length = this.max;
    this._emit();
    return item;
  }

  find(id) {
    return this.items.find(a => a.id === id) || null;
  }

  ack(id, by = '值班员') {
    const a = this.find(id);
    if (!a) return null;
    if (a.status !== 'new') return a;
    a.status = 'acked';
    a.ackAt = Date.now();
    a.ackBy = by;
    this._emit();
    return a;
  }

  ignore(id) {
    const a = this.find(id);
    if (!a) return null;
    if (a.status !== 'new') return a;
    a.status = 'ignored';
    a.ackAt = Date.now();
    a.ackBy = '忽略';
    this._emit();
    return a;
  }

  markVoice(id, state) {
    const a = this.find(id);
    if (!a) return;
    a.voice = state;
    if (state === 'speaking') {
      a.voiceRounds++;
      a.lastVoiceAt = Date.now();
      this.voicedTotal++;
    }
    this._emit();
  }

  /** 需要重播的高危未处理告警 */
  dueForRealert(now = Date.now()) {
    const gap = Math.max(10, Number(this.cfg.reAlertSec) || 30) * 1000;
    return this.items.filter(a =>
      a.status === 'new'
      && a.level === 'high'
      && a.voiceRounds < 4
      && now - (a.lastVoiceAt || a.ts) >= gap);
  }

  pending() {
    return this.items.filter(a => a.status === 'new');
  }

  highPending() {
    return this.items.filter(a => a.status === 'new' && a.level === 'high');
  }

  counts() {
    const c = { high: 0, mid: 0, low: 0 };
    for (const a of this.pending()) c[a.level] = (c[a.level] || 0) + 1;
    return c;
  }

  stats() {
    const acked = this.items.filter(a => a.status === 'acked').length;
    const ignored = this.items.filter(a => a.status === 'ignored').length;
    return {
      total: this.items.length,
      pending: this.pending().length,
      highPending: this.highPending().length,
      acked,
      ignored,
      voiced: this.voicedTotal,
    };
  }

  clear() {
    this.items = [];
    this.seq = 0;
    this.voicedTotal = 0;
    this._emit();
  }
}
