/* ==========================================================================
 * voice.js — 语音播报引擎（浏览器 TTS）+ 现场喊话话术库
 *
 * 设计要点：
 *  · 优先级队列：高危（跌倒 / 闯入危险区）可抢占正在播报的低危话术
 *  · 去重节流：同一句话在 voiceMinGap 秒内不重复，避免连续刷屏
 *  · 重复播报：高危话术默认连续播报 N 次，现场嘈杂也能听清
 *  · 优雅降级：不支持 TTS 时只出提示音 + 界面字幕，不阻断检测流程
 *  · 完全离线：使用系统内置语音合成，不联网、不上传任何数据
 * ========================================================================== */

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

export const VOICE_SUPPORTED = !!(
  synth && typeof window.SpeechSynthesisUtterance === 'function'
);

/* --------------------------------------------------------------------------
 * 自动告警话术：检测到对应行为时播报的内容
 * ------------------------------------------------------------------------ */
export const VOICE_SCRIPT = {
  '跌倒': {
    text: '请注意，工作区内有人摔倒',
    label: '跌倒告警',
    level: 'high',
    priority: 3,
    repeat: 2,
  },
  '进入危险区': {
    text: '危险区域，请立即离开',
    label: '闯入危险区',
    level: 'high',
    priority: 3,
    repeat: 1,
  },
  '人员滞留': {
    text: '请勿逗留',
    label: '滞留提醒',
    level: 'mid',
    priority: 2,
    repeat: 1,
  },
  '攀爬作业': {
    text: '请勿攀爬，注意高处坠落风险',
    label: '攀爬提醒',
    level: 'mid',
    priority: 2,
    repeat: 1,
  },
  '弯腰作业': {
    text: '请注意作业姿势，避免长时间弯腰',
    label: '姿势提醒',
    level: 'low',
    priority: 1,
    repeat: 1,
  },
};

/** 没有专用话术时的兜底文本 */
export function scriptFor(type) {
  return VOICE_SCRIPT[type] || {
    text: `${type}，请注意安全`,
    label: type,
    level: 'mid',
    priority: 2,
    repeat: 1,
  };
}

/* --------------------------------------------------------------------------
 * 手动喊话快捷键（界面「语音喊话台」上的按钮）
 * ------------------------------------------------------------------------ */
export const PRESETS = [
  { key: 'fall',   label: '人员摔倒',  hint: '高危', text: '请注意，工作区内有人摔倒', level: 'high' },
  { key: 'dwell',  label: '请勿逗留',  hint: '提醒', text: '请勿逗留，请立即离开该区域', level: 'mid' },
  { key: 'zone',   label: '离开危险区', hint: '高危', text: '危险区域，请勿靠近，请立即撤离', level: 'high' },
  { key: 'helmet', label: '佩戴安全帽', hint: '提醒', text: '请规范佩戴安全帽，系好下颚带', level: 'mid' },
  { key: 'climb',  label: '禁止攀爬',  hint: '提醒', text: '请勿攀爬货架与脚手架，防止高处坠落', level: 'mid' },
  { key: 'aisle',  label: '保持通道',  hint: '提示', text: '请保持消防通道畅通，勿堆放物料', level: 'low' },
  { key: 'slow',   label: '注意车辆',  hint: '提醒', text: '叉车通行，请作业人员注意避让', level: 'mid' },
  { key: 'evac',   label: '紧急撤离',  hint: '高危', text: '紧急情况，请全体人员立即撤离作业区', level: 'high' },
];

/* --------------------------------------------------------------------------
 * 语音引擎
 * ------------------------------------------------------------------------ */
export class VoiceEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.supported = VOICE_SUPPORTED;
    this.voices = [];
    this.voice = null;
    this.queue = [];
    this.job = null;
    this.speaking = false;
    this.seq = 0;
    this.token = 0;
    this.recent = new Map();
    this.handlers = new Map();
    this.unlocked = false;
    this._utt = null;
    if (this.supported) this._bindVoices();
  }

  /* ---------- 事件订阅 ---------- */
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event).delete(fn);
  }

  _emit(event, payload) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (e) { /* 单个回调异常不影响播报 */ }
    }
  }

  /* ---------- 音色 ---------- */
  _bindVoices() {
    const load = () => {
      const all = (synth.getVoices && synth.getVoices()) || [];
      if (!all.length) return;
      this.voices = all.slice().sort((a, b) => {
        const za = /^zh/i.test(a.lang || '') ? 0 : 1;
        const zb = /^zh/i.test(b.lang || '') ? 0 : 1;
        if (za !== zb) return za - zb;
        return String(a.name).localeCompare(String(b.name));
      });
      const want = this.cfg.voiceURI;
      this.voice = (want && this.voices.find(v => v.voiceURI === want)) || this._autoVoice();
      this._emit('voices', this.voices);
    };
    load();
    try {
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', load);
      else synth.onvoiceschanged = load;
    } catch (e) { /* noop */ }
    // 部分浏览器首次 getVoices() 返回空数组，延迟再取
    setTimeout(load, 400);
    setTimeout(load, 1500);
  }

  _autoVoice() {
    const zh = this.voices.filter(v => /^zh/i.test(v.lang || ''));
    return zh.find(v => /xiaoxiao|xiaoyi|huihui|yaoyao|tingting|meijia|female|女/i.test(v.name))
      || zh.find(v => v.localService)
      || zh[0]
      || this.voices[0]
      || null;
  }

  setVoice(uri) {
    this.cfg.voiceURI = uri || '';
    this.voice = (uri && this.voices.find(v => v.voiceURI === uri)) || this._autoVoice();
    this._emit('voices', this.voices);
  }

  get voiceName() {
    return this.voice ? this.voice.name : '系统默认';
  }

  get langName() {
    return this.voice ? this.voice.lang : 'zh-CN';
  }

  /** 浏览器音频上下文需要一次用户手势才能出声 */
  unlock() {
    if (!this.supported || this.unlocked) return;
    this.unlocked = true;
    try {
      synth.resume();
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch (e) { /* noop */ }
  }

  /* ---------- 播报 ---------- */
  /**
   * @returns {{ok:boolean, reason?:string, job?:object}}
   * reason: unsupported | disabled | empty | dup
   */
  speak(text, opt = {}) {
    const o = {
      priority: 1,
      repeat: 1,
      force: false,
      tag: null,
      gap: null,
      kind: 'auto',
      ...opt,
    };
    if (!this.supported) return { ok: false, reason: 'unsupported' };
    if (!this.cfg.voiceEnabled) return { ok: false, reason: 'disabled' };

    const t = String(text || '').trim().slice(0, 120);
    if (!t) return { ok: false, reason: 'empty' };

    const now = Date.now();
    const gap = Math.max(0, Number(o.gap ?? this.cfg.voiceMinGap ?? 6)) * 1000;
    const last = this.recent.get(t) || 0;
    if (!o.force && gap > 0 && now - last < gap) return { ok: false, reason: 'dup' };
    this.recent.set(t, now);
    if (this.recent.size > 80) {
      // 简单淘汰：删掉最旧的一半
      const keep = Array.from(this.recent.entries()).sort((a, b) => b[1] - a[1]).slice(0, 40);
      this.recent = new Map(keep);
    }

    // 高危告警抢占低危播报
    if (o.priority >= 3 && this.speaking && this.job && this.job.priority < o.priority) {
      this._abort('preempt');
    }

    const job = {
      seq: ++this.seq,
      text: t,
      priority: Math.max(1, Number(o.priority) || 1),
      repeat: Math.max(1, Math.min(5, Number(o.repeat) || 1)),
      done: 0,
      tag: o.tag,
      kind: o.kind,
      ts: now,
      cancelled: false,
    };
    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    this._pump();
    return { ok: true, job };
  }

  _abort(reason) {
    this.token++;
    try { synth.cancel(); } catch (e) { /* noop */ }
    const job = this.job;
    this.job = null;
    this.speaking = false;
    if (job) {
      job.cancelled = true;
      this._emit('end', { job, aborted: reason });
    }
  }

  stopAll() {
    this.queue.length = 0;
    this._abort('stop');
    this._emit('idle', null);
  }

  _pump() {
    if (!this.supported || this.speaking) return;
    if (!this.cfg.voiceEnabled) { this.queue.length = 0; this._emit('idle', null); return; }
    const job = this.queue.shift();
    if (!job) { this._emit('idle', null); return; }
    this.speaking = true;
    this.job = job;
    this._emit('start', { job });
    this._say(job);
  }

  _say(job) {
    if (!this.supported || job.cancelled || !this.speaking) return;
    const token = ++this.token;

    const u = new SpeechSynthesisUtterance(job.text);
    u.lang = this.langName || 'zh-CN';
    if (this.voice) { try { u.voice = this.voice; } catch (e) { /* noop */ } }
    u.rate = Math.min(2, Math.max(0.5, Number(this.cfg.voiceRate) || 1));
    u.pitch = Math.min(2, Math.max(0, Number(this.cfg.voicePitch) || 1));
    u.volume = Math.min(1, Math.max(0, Number(this.cfg.voiceVolume ?? 0.9)));

    const finish = (why) => {
      if (token !== this.token || job.cancelled) return;
      job.done++;
      if (job.done < job.repeat) {
        setTimeout(() => this._say(job), 280);
        return;
      }
      this.speaking = false;
      this.job = null;
      this._emit('end', { job, why });
      setTimeout(() => this._pump(), 90);
    };

    u.onend = () => finish('end');
    u.onerror = () => finish('error');

    this._utt = u; // 保持引用，防止 Chrome 回收 utterance 导致 onend 不触发
    setTimeout(() => {
      if (token !== this.token || job.cancelled) return;
      try {
        synth.speak(u);
      } catch (e) {
        finish('error');
      }
    }, 60);
  }

  /** 试听：无视开关与节流 */
  test(text) {
    if (!this.supported) return { ok: false, reason: 'unsupported' };
    const prev = this.cfg.voiceEnabled;
    this.cfg.voiceEnabled = true;
    const r = this.speak(text || '语音播报测试，请注意，工作区内有人摔倒', {
      priority: 1, repeat: 1, force: true, gap: 0, kind: 'test',
    });
    this.cfg.voiceEnabled = prev;
    return r;
  }
}
