/* ==========================================================================
 * app.js — 主程序：摄像头接入 / 实时分析循环 / 事件与统计 / 交互绘制
 * ========================================================================== */
import {
  PoseEngine, Tracker, Analyzer, DEFAULT_CONFIG, TYPE_META, SKELETON,
  boxFromLandmarks, mid, clamp,
} from './engine.js?v=20261126b';
import { VoiceEngine, VOICE_SUPPORTED, VOICE_SCRIPT, PRESETS, scriptFor } from './voice.js';
import { AlertCenter, SOURCE_META } from './alerts.js';
import * as store from './store.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ------------------------------ 状态 ------------------------------ */
const S = {
  cfg: { ...DEFAULT_CONFIG, ...store.loadConfig() },
  engine: null,
  tracker: null,
  analyzer: null,
  zones: [],

  video: null,
  overlay: null,
  ctx: null,
  wrap: null,
  view: { w: 0, h: 0 },

  stream: null,
  source: 'camera',
  mode: 'live',        // live（摄像头/视频）| image（静态图片单帧检测）
  img: null,           // 当前载入的图片元素
  imgUrl: '',          // 图片 blob URL（切换时释放）
  imgName: '',
  imgStats: null,      // 本次图片检测的汇总
  running: false,
  paused: false,
  rafId: 0,
  lastProcess: 0,
  fpsBuf: [],

  events: [],
  counts: {},
  violators: new Set(),
  normalLogged: new Set(),
  lastEvent: new Map(),

  session: null,
  persistTimer: 0,

  selectedId: null,
  drawing: false,
  draft: [],
  filter: 'all',
  engineDirty: false,
  todayCount: 0,

  // —— 语音播报 / 告警中心 ——
  voice: null,
  alerts: null,
  bcast: [],           // 播报流水（含自动 / 人工 / 重播）
  focusAlertId: null,  // 顶部横幅当前展示的告警
  voiceJob: null,      // 正在播报的任务
};

/* ------------------------------ 启动 ------------------------------ */
function boot() {
  S.video = $('#video');
  S.overlay = $('#overlay');
  S.wrap = $('#videoWrap');
  S.ctx = S.overlay.getContext('2d');
  S.zones = store.loadZones() || [];

  S.analyzer = new Analyzer(S.cfg);
  S.tracker = new Tracker(S.cfg);
  S.engine = new PoseEngine(S.cfg);
  S.voice = new VoiceEngine(S.cfg);
  S.alerts = new AlertCenter(S.cfg);

  S.video.style.transform = S.cfg.mirror ? 'scaleX(-1)' : 'none';
  S.todayCount = computeToday();

  bindTabs();
  bindToolbar();
  bindSettings();
  bindMisc();
  bindVoiceUI();
  syncSettingsUI();
  renderZonesList();
  renderEventTable();
  refreshLivePanels();
  renderDonut();
  renderHistory();
  renderStats();
  renderPresets();
  renderAlertQueue();
  renderBcastLog();

  resizeOverlay();
  new ResizeObserver(resizeOverlay).observe(S.wrap);
  window.addEventListener('beforeunload', finalizeSession);
  setInterval(tickClock, 1000);
  setInterval(refreshLivePanels, 250);
  setInterval(escalatePending, 3000);
  tickClock();

  // 调试句柄（可在控制台查看内部状态，不影响使用）
  window.__WSM = S;
  probeModelQuality();
}

/** 探测高精度模型是否随包提供，缺失则隐藏该选项，避免用户选了却静默回退 */
async function probeModelQuality() {
  const el = $('select[data-cfg="modelQuality"]');
  if (!el) return;
  try {
    const url = new URL('../models/pose_landmarker_full.task', import.meta.url).href;
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) throw new Error('missing');
  } catch (e) {
    el.querySelector('option[value="full"]')?.remove();
    if (S.cfg.modelQuality === 'full') {
      S.cfg.modelQuality = 'lite';
      el.value = 'lite';
      store.saveConfig(S.cfg);
    }
  }
}

function tickClock() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  $('#clockPill').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------ 视图切换 ------------------------------ */
function bindTabs() {
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
      const view = btn.dataset.view;
      $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
      if (view === 'stats') { renderStats(); }
      if (view === 'history') { renderHistory(); }
      if (view === 'live') { resizeOverlay(); renderDonut(); renderEventTable(); }
    });
  });
}

/* ------------------------------ 摄像头 ------------------------------ */
async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const sel = $('#camSelect');
    const cur = sel.value;
    sel.innerHTML = '<option value="">默认摄像头</option>' +
      cams.map((c, i) => `<option value="${c.deviceId}">${c.label || `摄像头 ${i + 1}`}</option>`).join('');
    sel.value = cur;
  } catch (e) { /* ignore */ }
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持摄像头调用，请使用 Chrome / Edge 打开');
  }
  const deviceId = $('#camSelect').value;
  const constraints = {
    audio: false,
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  };

  // 摄像头刚释放时常有短暂的 NotReadableError，重试几次再报错
  let stream = null;
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (e) {
      lastErr = e;
      if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') throw e;
      await new Promise(r => setTimeout(r, 350));
    }
  }
  if (!stream) throw lastErr;

  S.stream = stream;
  S.video.srcObject = stream;
  S.video.style.display = 'block';
  await S.video.play();
  await listCameras();
}

function setStageError(msg) {
  const el = $('#stageError');
  if (!el) return;
  if (!msg) { el.classList.remove('show'); el.textContent = ''; return; }
  el.textContent = msg;
  el.classList.add('show');
}

async function start() {
  if (S.running) return;
  if (S.mode === 'image') exitImageMode();   // 从图片模式切回实时采集
  setStageError('');
  $('#stageInfo').textContent = '正在加载关键点模型…';

  try {
    const desiredQuality = S.cfg.modelQuality === 'full' ? 'full' : 'lite';
    if (S.engineDirty || (S.engine.landmarker && S.engine.quality !== desiredQuality)) {
      S.engine.close();
      S.engine = new PoseEngine(S.cfg);
      S.engineDirty = false;
    }
    await S.engine.ensure();
    if (S.cfg.modelQuality === 'full' && S.engine.quality === 'lite') {
      toast('高精度模型不可用，已回退标准模型');
    }
    setPill('#modelPill', `模型就绪 · ${S.engine.quality === 'full' ? 'FULL' : 'LITE'} · ${S.cfg.maxPersons}P`, 'ok');

    if (S.source === 'camera' && !S.stream) {
      $('#stageInfo').textContent = '正在请求摄像头权限…';
      await openCamera();
    }
    if (S.source === 'video' && S.video.src) {
      try { await S.video.play(); } catch (e) { /* 用户手势下一般可播放 */ }
    }

    S.paused = false;
    S.running = true;
    S.lastProcess = 0;
    S.fpsBuf = [];
    S.tracker.reset();
    S.events = [];
    S.counts = {};
    S.violators.clear();
    S.normalLogged.clear();
    S.lastEvent.clear();
    S.session = { id: `S${Date.now()}`, start: Date.now(), end: null, events: [], source: S.source };
    S.selectedId = null;
    S.alerts.clear();
    S.bcast = [];
    S.focusAlertId = null;
    renderBcastLog();
    renderAlertQueue();
    updateAlertBanner();
    S.voice?.unlock();

    $('#btnStart').disabled = true;
    $('#btnStop').disabled = false;
    $('#stageInfo').textContent = S.source === 'camera' ? '摄像头采集 · 实时分析' : '视频文件 · 离线分析';
    renderEventTable();
    refreshLivePanels();
    loop();
    toast('已开始实时分析');
  } catch (err) {
    console.error(err);
    setStageError(friendlyError(err));
    setPill('#modelPill', '启动失败', 'err');
    $('#stageInfo').textContent = '未启动';
  }
}

function stop() {
  if (S.mode === 'image') { exitImageMode({ toastText: '已停止图片检测，本次结果已存档' }); return; }
  S.running = false;
  cancelAnimationFrame(S.rafId);
  if (S.frameCb && S.video.cancelVideoFrameCallback) {
    try { S.video.cancelVideoFrameCallback(S.frameCb); } catch (e) { /* noop */ }
    S.frameCb = 0;
  }
  if (S.stream) {
    S.stream.getTracks().forEach(t => t.stop());
    S.stream = null;
  }
  if (S.source === 'video') {
    S.video.pause();
  }
  S.video.srcObject = null;
  $('#btnStart').disabled = false;
  $('#btnStop').disabled = true;
  $('#btnZoneDone').disabled = true;
  $('#stageInfo').textContent = '已停止';
  finalizeSession();
  clearOverlay();
  setPill('#fpsPill', 'FPS --', '');
  setStageError('');
  S.voice?.stopAll();
  hideSpeechBar();
  toast('已停止采集，本次会话已存档');
}

function friendlyError(err) {
  const name = err?.name || '';
  const msg = err?.message || String(err);
  if (name === 'NotAllowedError' || /Permission|denied/i.test(msg)) {
    return '摄像头权限被拒绝\n请在地址栏左侧的相机图标中允许摄像头，然后重新启动。';
  }
  if (name === 'NotFoundError' || /Requested device not found/i.test(msg)) {
    return '未检测到可用摄像头\n请确认设备已连接，或在右上角下拉框中切换其它摄像头。';
  }
  if (name === 'NotReadableError') {
    return '摄像头被其它程序占用\n请关闭正在使用摄像头的软件（会议 / 直播工具）后重试。';
  }
  return `启动失败：${msg}`;
}

/* ------------------------------ 图片静态检测 ------------------------------ */
/* 上传一张现场照片 → 单帧关键点提取 → 几何判定 → 事件/告警/标注图
   与实时采集共用轨迹、面板、事件表与语音闭环，只是不做时序累积 */

function setStageMode(mode) {
  const el = $('#liveTag');
  if (!el) return;
  const isImg = mode === 'image';
  el.className = `live${isImg ? ' img' : ''}`;
  el.innerHTML = `<i></i>${isImg ? 'IMAGE' : 'LIVE'}`;
}

/** 图片尺寸（S.img 可能是 <img>，也可能是降采样后的 <canvas>） */
function imgSize() {
  const im = S.img;
  if (!im) return { w: 0, h: 0 };
  return { w: im.width || im.naturalWidth || 0, h: im.height || im.naturalHeight || 0 };
}

/* —— 载入遮罩：线上首次推理要现下载模型，必须让用户看见“正在进行” —— */
function showImgLoading(title, sub, isErr) {
  const el = $('#imgLoading');
  if (!el) return;
  const t = $('#ilTitle'), s = $('#ilSub');
  if (t) t.textContent = title || '处理中…';
  if (s) s.textContent = sub || '';
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
}

function hideImgLoading() {
  const el = $('#imgLoading');
  if (el) el.classList.remove('show', 'err');
}

/** 等浏览器真正画完一帧。
 *  单帧推理是同步阻塞的，遮罩如果在阻塞之后才轮到重绘，用户整段时间里看不到任何反馈。 */
function nextPaint() {
  return new Promise(r => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0)));
  });
}

/** 图片统一入口：把任何失败都变成界面上看得见的原因，而不是静默什么都不发生 */
async function pickImage(file) {
  try {
    await loadImageFile(file);
  } catch (err) {
    const msg = (err && err.message) || '图片载入失败';
    hideImgLoading();
    toast(msg.split('\n')[0]);
    setStageError(`${msg}\n可尝试：换 JPG / PNG 格式，或先截图再上传。`);
    $('#stageInfo').textContent = '图片载入失败';
  }
}

/** 载入图片文件并立即做一次单帧检测 */
async function loadImageFile(file) {
  if (!file) return;

  const name = file.name || '粘贴的图片';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const type = file.type || '';
  const isHeic = /^(heic|heif)$/.test(ext) || /heic|heif/i.test(type);
  const isImage = /^image\//.test(type) || /\.(png|jpe?g|webp|bmp|gif|avif|heic|heif)$/i.test(name);

  if (!isImage) throw new Error(`「${name}」不是图片，请选 jpg / png / webp 图片`);
  if (isHeic) {
    throw new Error('HEIC / HEIF 照片浏览器无法解码\n请先在相册导出为 JPG，或对照片截图后再上传。');
  }

  showImgLoading('正在读取图片…', name);
  $('#stageInfo').textContent = `正在载入 ${name}…`;

  if (S.running && S.mode === 'live') stop();     // 先停掉摄像头 / 视频

  cancelAnimationFrame(S.rafId);
  S.running = false;
  setStageError('');

  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片解码失败，可能文件已损坏或格式不受支持'));
      im.src = url;
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }

  // 手机直出的大图（4000px+）先等比降采样，解码内存与推理耗时都能降一个量级
  const MAX = 2400;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  let src = img;
  if (iw > MAX || ih > MAX) {
    const k = Math.min(MAX / iw, MAX / ih);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(iw * k));
    cv.height = Math.max(1, Math.round(ih * k));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    src = cv;
    showImgLoading('图片分辨率过高，已等比压缩', `${iw}×${ih} → ${cv.width}×${cv.height}`);
  }

  if (S.imgUrl) URL.revokeObjectURL(S.imgUrl);
  S.imgUrl = url;
  S.img = src;
  S.imgName = name;
  S.mode = 'image';
  S.source = 'image';

  try { S.video.pause(); } catch (e) { /* noop */ }
  S.video.srcObject = null;
  S.video.style.display = 'none';

  const stageImg = $('#stageImage');
  stageImg.src = url;
  stageImg.hidden = false;

  // 退出正在绘制的危险区状态，避免在图片上误点
  S.drawing = false;
  S.draft = [];
  S.wrap.classList.remove('drawing', 'dragover');
  $('#btnZone').classList.remove('primary');
  $('#btnZone').textContent = '绘制危险区';
  $('#btnZoneDone').disabled = true;

  setStageMode('image');
  S.paused = false;
  $('#btnStart').disabled = false;
  $('#btnStop').disabled = false;

  resizeOverlay();
  S.imgStats = null;
  renderImgResult();
  await analyzeImage();
}

/** 对当前图片执行一次单帧检测 */
async function analyzeImage() {
  if (S.mode !== 'image' || !S.img) return;
  const t0 = performance.now();
  const { w: iw, h: ih } = imgSize();

  $('#imgCard').hidden = false;
  $('#imgMeta').textContent = `${iw}×${ih}`;
  $('#imgSum').innerHTML = '<span class="img-stat">正在加载关键点模型…</span>';
  $('#imgList').innerHTML = '';
  $('#stageInfo').textContent = '正在提取骨骼关键点…';
  setPill('#modelPill', '模型加载中', 'warn');
  setStageError('');
  const warm = !!(S.engine && S.engine.landmarker);
  showImgLoading(
    warm ? '正在分析姿态…' : '正在加载关键点模型…',
    warm ? `${iw}×${ih}` : '首次使用需下载模型文件，约 5~15 秒，请勿关闭页面'
  );

  try {
    const desiredQuality = S.cfg.modelQuality === 'full' ? 'full' : 'lite';
    if (S.engineDirty || (S.engine.landmarker && S.engine.quality !== desiredQuality)) {
      S.engine.close();
      S.engine = new PoseEngine(S.cfg);
      S.engineDirty = false;
    }
    await S.engine.ensure();
    showImgLoading('正在分析姿态…', `${iw}×${ih} · ${S.imgName}`);
    await nextPaint();          // 先让遮罩真正画出来，再进入同步推理
    // 每次检测都当一次独立的「图片会话」，避免与上一次结果混在一起
    S.tracker.reset();
    S.events = [];
    S.counts = {};
    S.violators.clear();
    S.normalLogged.clear();
    S.lastEvent.clear();
    S.selectedId = null;
    S.alerts.clear();
    S.bcast = [];
    S.focusAlertId = null;
    S.session = { id: `S${Date.now()}`, start: Date.now(), end: null, events: [], source: 'image' };
    renderBcastLog();
    renderAlertQueue();
    updateAlertBanner();
    S.voice?.unlock();

    const now = performance.now();
    const dT0 = performance.now();
    const lms = S.engine.detect(S.img, Math.round(now));
    const inferMs = Math.round(performance.now() - dT0);
    const dets = [];
    for (const lm of lms) {
      const box = boxFromLandmarks(lm);
      if (box.w < 0.02 || box.h < 0.03) continue;
      dets.push({ lm, box });
    }
    S.tracker.update(dets, now);

    const flags = {
      fall: flagOn('fall'),
      bend: flagOn('bend'),
      zone: flagOn('zone'),
      loiter: flagOn('loiter'),
    };

    for (const t of S.tracker.tracks) {
      const r = S.analyzer.analyzeStatic(t, flagOn('zone') ? S.zones : [], now, flags);
      t.type = r.type;
      t.conf = r.conf;
      t.level = r.level;
      t.zone = r.zone;
      t.metrics = r.metrics;
      t.flags = r.flags;
      if (flagOn('record')) recordImageEvent(t);
    }

    const tracks = S.tracker.tracks;
    const ms = Math.round(performance.now() - t0);
    S.imgStats = {
      name: S.imgName,
      w: iw,
      h: ih,
      ms,
      infer: inferMs,
      total: tracks.length,
      danger: tracks.filter(x => x.level !== 'low').length,
      inZone: tracks.filter(x => x.zone).length,
    };

    setPill('#modelPill', `模型就绪 · ${S.engine.quality === 'full' ? 'FULL' : 'LITE'} · ${S.cfg.maxPersons}P`, 'ok');
    setPill('#fpsPill', `单帧 ${inferMs}ms`, inferMs < 1200 ? 'ok' : 'warn');
    $('#stageInfo').textContent = `图片 · 单帧检测 · ${tracks.length} 人 · 推理 ${inferMs}ms`;

    S.running = true;
    hideImgLoading();
    renderImgResult();
    refreshLivePanels();
    renderDonut();
    draw();
    S._lastDraw = performance.now();
    imageLoop(performance.now());
    finalizeSession();

    if (!tracks.length) toast('未检测到人体，换一张人物更清晰的图片试试');
    else toast(`检测完成：${tracks.length} 人，${S.imgStats.danger} 个危险姿态`);
  } catch (err) {
    console.error(err);
    hideImgLoading();
    S.running = false;
    setPill('#modelPill', '检测失败', 'err');
    setPill('#fpsPill', 'FPS --', '');
    $('#stageInfo').textContent = '检测失败';
    $('#imgMeta').textContent = 'FAILED';
    $('#imgSum').innerHTML = '<span class="img-stat hot">检测失败，详见画面底部提示</span>';
    setStageError(`图片检测失败：${err.message || err}\n请确认图片完整可用，或换一张重试。`);
  }
}

/** 图片模式下的重绘循环：只画叠加层，不重复推理 */
function imageLoop(ts) {
  if (S.mode !== 'image' || !S.running) return;
  const t = typeof ts === 'number' ? ts : performance.now();
  if (!S._lastDraw || t - S._lastDraw >= 66) {
    S._lastDraw = t;
    draw();
  }
  S.rafId = requestAnimationFrame(imageLoop);
}

/** 图片里的每个人只落一条事件，危险姿态同时进告警队列并播报 */
function recordImageEvent(t) {
  const thumb = captureThumb(t);
  const ev = pushEvent(t.type, { id: t.id, conf: t.conf, zone: t.zone, thumb });
  if (t.type === '正常作业') return;
  triggerAlert(t, ev, thumb);
  if (S.cfg.sound) beep(t.level);
}

function renderImgResult() {
  const card = $('#imgCard');
  const sum = $('#imgSum');
  const list = $('#imgList');
  if (!card || !sum || !list) return;
  card.hidden = false;

  const st = S.imgStats;
  if (!st) {
    sum.innerHTML = '';
    list.innerHTML = '<li class="detail-empty" style="cursor:default;border:0;background:none;padding:0">'
      + '正在检测…</li>';
    return;
  }

  $('#imgMeta').textContent = `${st.w}×${st.h} · 共 ${st.ms}ms`;
  sum.innerHTML = `
    <span class="img-stat"><b>${st.total}</b>检测人数</span>
    <span class="img-stat ${st.danger ? 'hot' : ''}"><b>${st.danger}</b>危险姿态</span>
    <span class="img-stat ${st.inZone ? 'warn' : ''}"><b>${st.inZone}</b>区域违规</span>
    <span class="img-stat"><b>${st.infer}</b>ms 单帧推理</span>`;

  const tracks = S.tracker.tracks;
  if (!tracks.length) {
    list.innerHTML = '<li class="detail-empty" style="cursor:default;border:0;background:none;padding:0">'
      + '未检测到人体骨骼。换一张人物更清晰、全身入镜的图片，或确认左侧「人员检测 / 关键点姿态估计」处于开启状态。</li>';
    return;
  }

  list.innerHTML = tracks.map(t => {
    const meta = TYPE_META[t.type] || TYPE_META['正常作业'];
    const m = t.metrics || {};
    return `<li data-id="${t.id}" class="${S.selectedId === t.id ? 'sel' : ''}">
      <i class="ii-dot" style="background:${meta.color}"></i>
      <b class="ii-id">ID ${t.id}</b>
      <span class="ii-type" style="color:${meta.color}">${esc(t.type)}</span>
      <span class="ii-meta">倾角 ${m.angle ?? 0}° · 膝 ${m.knee ?? 0}°<br>${esc(t.zone || '安全区')} · 置信 ${Number(t.conf).toFixed(2)}</span>
    </li>`;
  }).join('');
}

/** 把当前图片连同骨骼 / 目标框 / 危险区一起导出为 PNG */
function exportAnnotated() {
  if (S.mode !== 'image' || !S.img) { toast('请先上传一张图片'); return; }
  const { w, h } = sourceSize();
  if (!w || !h) { toast('图片尺寸异常，无法导出'); return; }

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.drawImage(S.img, 0, 0, w, h);

  // 临时切换绘制上下文与开关，让标注落在原图分辨率上（不镜像）
  const prev = {
    ctx: S.ctx, view: S.view, mirror: S.cfg.mirror,
    skeleton: S.cfg.showSkeleton, box: S.cfg.showBox, selected: S.selectedId,
  };
  S.ctx = g;
  S.view = { w, h };
  S.cfg.mirror = false;
  S.cfg.showSkeleton = true;
  S.cfg.showBox = true;

  const P = p => ({ x: p.x * w, y: p.y * h });
  drawZones(g, P);
  for (const t of S.tracker.tracks) drawSkeleton(g, t, P);
  for (const t of S.tracker.tracks) drawBox(g, t, P);

  S.ctx = prev.ctx; S.view = prev.view; S.cfg.mirror = prev.mirror;
  S.cfg.showSkeleton = prev.skeleton; S.cfg.showBox = prev.box;

  const a = document.createElement('a');
  a.href = cv.toDataURL('image/png');
  a.download = `annotated-${store.fmtTime(Date.now()).replace(/[: ]/g, '-')}.png`;
  a.click();
  toast('已导出标注图（含骨骼与目标框）');
}

/** 退出图片模式，回到等待摄像头 / 视频的状态 */
function exitImageMode(opts = {}) {
  cancelAnimationFrame(S.rafId);
  hideImgLoading();
  S.running = false;
  S.mode = 'live';
  S.source = 'camera';
  S.img = null;
  S.imgStats = null;
  S._lastDraw = 0;
  if (S.imgUrl) { URL.revokeObjectURL(S.imgUrl); S.imgUrl = ''; }

  const img = $('#stageImage');
  if (img) { img.hidden = true; img.removeAttribute('src'); }
  S.video.style.display = 'block';

  S.tracker.reset();
  S.selectedId = null;
  S.lastProcess = 0;
  S.fpsBuf = [];
  clearOverlay();
  setStageMode('live');
  $('#imgCard').hidden = true;
  $('#btnStart').disabled = false;
  $('#btnStop').disabled = true;
  $('#stageInfo').textContent = '等待启动';
  setPill('#fpsPill', 'FPS --', '');

  finalizeSession();
  refreshLivePanels();
  renderEventTable();
  if (opts.toastText) toast(opts.toastText);
}

async function handleDroppedFile(file) {
  if (/^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|avif|heic|heif)$/i.test(file.name || '')) {
    return pickImage(file);
  }
  if (/^video\//.test(file.type)) {
    if (S.running) stop();
    if (S.mode === 'image') exitImageMode();
    S.source = 'video';
    S.video.style.display = 'block';
    S.video.srcObject = null;
    S.video.src = URL.createObjectURL(file);
    S.video.loop = true;
    try { await S.video.play(); } catch (err) { /* ignore */ }
    await start();
    toast(`已载入视频：${file.name}`);
    return;
  }
  throw new Error('只支持图片或视频文件');
}

/* ------------------------------ 分析循环 ------------------------------ */
/* 优先使用 requestVideoFrameCallback：只在真正有新视频帧时推理，
   避免同一帧被重复检测导致的骨骼抖动与 ID 跳变 */
function loop() {
  if (!S.running) return;
  tick();
  const v = S.video;
  if (v.requestVideoFrameCallback) {
    S.frameCb = v.requestVideoFrameCallback(loop);
  } else {
    S.rafId = requestAnimationFrame(loop);
  }
}

function tick() {
  const v = S.video;
  const now = performance.now();
  if (!S.paused && v.readyState >= 2 && v.videoWidth > 0) {
    const interval = 1000 / Math.max(6, S.cfg.maxFps);
    if (now - S.lastProcess >= interval) {
      S.lastProcess = now;
      try {
        processFrame(now);
      } catch (e) {
        console.warn('推理异常', e);
      }
    }
  }
  draw();
}

function processFrame(now) {
  const lms = S.engine.detect(S.video, Math.round(now));
  const dets = [];
  for (const lm of lms) {
    const box = boxFromLandmarks(lm);
    if (box.w < 0.02 || box.h < 0.03) continue;
    dets.push({ lm, box });
  }
  S.tracker.update(dets, now);

  const flags = {
    fall: flagOn('fall'),
    bend: flagOn('bend'),
    zone: flagOn('zone'),
    loiter: flagOn('loiter'),
  };

  for (const t of S.tracker.tracks) {
    const r = S.analyzer.analyze(t, flagOn('zone') ? S.zones : [], now, flags);
    t.type = r.type;
    t.conf = r.conf;
    t.level = r.level;
    t.zone = r.zone;
    t.metrics = r.metrics;
    t.flags = r.flags;
    if (flagOn('record')) handleEvent(t);
  }

  // fps
  S.fpsBuf.push(now);
  while (S.fpsBuf.length > 40) S.fpsBuf.shift();
  if (S.fpsBuf.length > 4) {
    const span = (S.fpsBuf[S.fpsBuf.length - 1] - S.fpsBuf[0]) / 1000;
    const fps = span > 0 ? (S.fpsBuf.length - 1) / span : 0;
    setPill('#fpsPill', `FPS ${fps.toFixed(1)}`, fps > 8 ? 'ok' : 'warn');
  }
}

function flagOn(name) {
  const el = $(`[data-flag="${name}"]`);
  return el ? el.checked : true;
}

/* ------------------------------ 事件 ------------------------------ */
function handleEvent(t) {
  const key = `${t.id}|${t.type}`;
  const last = S.lastEvent.get(key) || 0;
  const gap = S.cfg.eventCooldown * 1000;

  if (t.type !== '正常作业') {
    if (t.conf < S.cfg.confGate) return;      // 低置信度不落库，减少刷屏与误报
    if (performance.now() - last > gap) {
      S.lastEvent.set(key, performance.now());
      const thumb = captureThumb(t);
      const ev = pushEvent(t.type, { id: t.id, conf: t.conf, zone: t.zone, thumb });
      triggerAlert(t, ev, thumb);
      if (S.cfg.sound) beep(t.level);
    }
  } else if (!S.normalLogged.has(t.id) && t.hits >= 8) {
    S.normalLogged.add(t.id);
    pushEvent('正常作业', { id: t.id, conf: t.conf, zone: null, thumb: captureThumb(t) });
  }
}

/**
 * 核心闭环：检测结果 → 告警队列 → 语音播报 → 主界面反馈
 * 人工喊话走 sayNow()，最终同样写入告警队列，行为完全一致。
 */
function triggerAlert(t, ev, thumb) {
  const script = scriptFor(t.type);
  const alert = S.alerts.raise({
    type: t.type,
    label: script.label,
    level: t.level || script.level,
    text: script.text,
    priority: script.priority,
    personId: t.id,
    zone: t.zone || `${S.cfg.scene}1区`,
    conf: t.conf,
    source: 'auto',
    thumb: thumb || null,
  });

  if (ev) {
    ev.alertId = alert.id;
    ev.voiceText = script.text;
    renderEventTable();
  }

  speakAlert(alert, script);
  flashAlert(t.type, t.level, t.id, script.text);
  renderAlertQueue();
  updateAlertBanner();
}

/** 按配置决定是否出声，并把播报状态回写到告警条目 */
function speakAlert(alert, script, opts = {}) {
  if (!S.cfg.voiceEnabled) {
    alert.voice = 'off';
    S.alerts._emit();
    return null;
  }
  if (S.cfg.voiceHighOnly && alert.level !== 'high') {
    alert.voice = 'skip';
    S.alerts._emit();
    return null;
  }
  const repeat = alert.level === 'high'
    ? Math.max(1, Number(opts.repeat ?? script.repeat ?? S.cfg.voiceRepeat))
    : 1;

  const r = S.voice.speak(alert.text, {
    priority: script.priority || (alert.level === 'high' ? 3 : 2),
    repeat,
    tag: alert.id,
    kind: opts.kind || 'auto',
    force: !!opts.force,
    gap: opts.force ? 0 : null,
  });

  if (r.ok) {
    alert.voice = 'queued';
  } else {
    alert.voice = r.reason === 'dup' ? 'dup' : (r.reason === 'disabled' ? 'off' : 'fail');
  }
  S.alerts._emit();
  return r;
}

/** 未处理的高危告警按间隔自动重播，直到有人确认 */
function escalatePending() {
  if (!S.running || !S.cfg.voiceEnabled) return;
  if (S.mode === 'image') return;   // 静态图片是一次性判定，不做超时重播
  const due = S.alerts.dueForRealert();
  for (const a of due) {
    const r = S.voice.speak(a.text, {
      priority: 3,
      repeat: 1,
      tag: a.id,
      kind: 'realert',
      force: true,
      gap: 0,
    });
    if (r.ok) {
      // voiceRounds / lastVoiceAt 由 voice 的 start 事件统一记账，这里只兜底时间戳
      a.lastVoiceAt = Date.now();
      S.alerts._emit();
      updateAlertBanner();
    } else {
      a.lastVoiceAt = Date.now(); // 出声失败也不再死循环轰炸
    }
  }
}

/** 人工喊话（按钮 / 输入框） */
function sayNow(text, level = 'mid', meta = {}) {
  const msg = String(text || '').trim();
  if (!msg) { toast('请先输入播报内容'); return; }

  S.voice?.unlock();

  const alert = S.alerts.raise({
    type: meta.type || '人工喊话',
    label: meta.label || '人工喊话',
    level,
    text: msg,
    priority: level === 'high' ? 3 : (level === 'mid' ? 2 : 1),
    personId: meta.personId ?? null,
    zone: `${S.cfg.scene}1区`,
    conf: 1,
    source: 'manual',
    thumb: null,
  });

  const r = S.voice.speak(msg, {
    priority: level === 'high' ? 3 : (level === 'mid' ? 2 : 1),
    repeat: 1,
    force: true,
    gap: 0,
    tag: alert.id,
    kind: 'manual',
  });

  alert.voice = r.ok ? 'queued' : (r.reason === 'unsupported' ? 'fail' : 'off');

  // 人工喊话也留一条事件记录，便于追溯
  const ev = {
    ts: Date.now(),
    type: '人工喊话',
    id: '—',
    conf: 1,
    zone: `${S.cfg.scene}1区`,
    thumb: null,
    alertId: alert.id,
    voiceText: msg,
    manual: true,
  };
  S.events.unshift(ev);
  if (S.events.length > 400) S.events.pop();
  S.counts['人工喊话'] = (S.counts['人工喊话'] || 0) + 1;
  S.todayCount++;

  // 语音实际出声时由 voice 的 start 事件写入流水；未能出声则在这里补一条记录
  if (!r.ok) pushBcast({ text: msg, level, source: 'manual', alertId: alert.id });
  renderEventTable();
  renderAlertQueue();
  updateAlertBanner();
  refreshLivePanels();
  schedulePersist();

  if (!r.ok) {
    toast(r.reason === 'unsupported'
      ? '本机不支持语音合成，已仅记录喊话'
      : '语音已关闭，喊话仅写入记录（可在右上角开启）');
  }
}

/* ------------------------------ 播报流水 ------------------------------ */
function pushBcast({ text, level, source, alertId }) {
  S.bcast.unshift({ ts: Date.now(), text, level: level || 'mid', source: source || 'auto', alertId });
  if (S.bcast.length > 120) S.bcast.pop();
  renderBcastLog();
}

function renderBcastLog() {
  const ul = $('#bcastList');
  if (!ul) return;
  $('#bcastCount').textContent = `${S.bcast.length} 条`;
  if (!S.bcast.length) {
    ul.innerHTML = '<li class="detail-empty">暂无播报记录。</li>';
    return;
  }
  ul.innerHTML = S.bcast.slice(0, 40).map(b => {
    const sm = SOURCE_META[b.source] || SOURCE_META.auto;
    const cls = b.source === 'manual' ? 'manual' : (b.source === 'realert' ? 'replay' : '');
    return `<li data-level="${b.level}">
      <em>${store.fmtTime(b.ts).slice(11)}</em>
      <span class="bl-txt" title="${esc(b.text)}">${esc(b.text)}</span>
      <b class="${cls}">${sm.short}</b>
    </li>`;
  }).join('');
}

/* ------------------------------ 告警队列 / 横幅 ------------------------------ */
function renderAlertQueue() {
  const ul = $('#alertQueue');
  if (!ul) return;
  const pending = S.alerts.pending();
  const sub = $('#pendingSub');
  if (sub) sub.textContent = `${pending.length} 条`;

  const badge = $('#tabBadge');
  if (badge) {
    const n = S.alerts.highPending().length || pending.length;
    badge.hidden = !pending.length;
    badge.textContent = n > 99 ? '99+' : String(n);
  }

  if (!pending.length) {
    ul.innerHTML = '<li class="detail-empty">暂无待处理告警。检测到危险动作或手动喊话后会出现在这里。</li>';
    return;
  }
  ul.innerHTML = pending.slice(0, 40).map(a => {
    const sm = SOURCE_META[a.source] || SOURCE_META.auto;
    return `<li class="aq-item" data-level="${a.level}" data-alert="${a.id}">
      <div class="aq-top">
        <span class="aq-no">${a.id}</span>
        <b>${esc(a.label || a.type)}</b>
        ${a.personId != null ? `<span class="aq-no">ID ${a.personId}</span>` : ''}
        <em>${store.fmtTime(a.ts).slice(11)}</em>
      </div>
      <div class="aq-text">${esc(a.text)}</div>
      <div class="aq-foot">
        <span class="aq-src ${a.source === 'manual' ? 'manual' : ''}">${sm.short}</span>
        <span class="aq-zone" title="${esc(a.zone || '')}">${esc(a.zone || '—')}</span>
        ${a.count > 1 ? `<span class="aq-cnt">×${a.count}</span>` : ''}
        <span class="aq-btns">
          <button data-ack="${a.id}">处理</button>
          <button class="ign" data-ign="${a.id}">忽略</button>
        </span>
      </div>
    </li>`;
  }).join('');
}

function updateAlertBanner() {
  const banner = $('#alarmBanner');
  const wrap = $('#videoWrap');
  if (!banner) return;

  const high = S.alerts.highPending();
  const mid = S.alerts.pending().filter(a => a.level === 'mid');
  const target = high[0] || mid[0] || null;

  if (!target) {
    banner.classList.remove('show', 'mid');
    wrap?.classList.remove('alarm');
    S.focusAlertId = null;
    return;
  }

  // 有更高优先级的新告警时切换横幅内容
  if (S.focusAlertId !== target.id) {
    S.focusAlertId = target.id;
    $('#abTitle').textContent = target.label || target.type;
    $('#abText').textContent = target.text;
    $('#abMeta').textContent =
      `${target.personId != null ? `ID ${target.personId} · ` : ''}${target.zone || '—'} · ${store.fmtTime(target.ts).slice(11)}`;
    banner.dataset.alert = target.id;
  }
  banner.classList.add('show');
  banner.classList.toggle('mid', target.level !== 'high');
  wrap?.classList.toggle('alarm', target.level === 'high');
}

function ackAlert(id) {
  const a = S.alerts.ack(id);
  if (!a) return;
  markEventAck(a);
  renderAlertQueue();
  updateAlertBanner();
  renderEventTable();
  toast(`${a.id} 已处理`);
}

function ignoreAlert(id) {
  const a = S.alerts.ignore(id);
  if (!a) return;
  markEventAck(a);
  renderAlertQueue();
  updateAlertBanner();
  renderEventTable();
  toast(`${a.id} 已忽略`);
}

function markEventAck(a) {
  const ev = S.events.find(e => e.alertId === a.id);
  if (ev) {
    ev.ackStatus = a.status;
    ev.ackAt = a.ackAt;
  }
  finalizeSessionSoft();
}

function finalizeSessionSoft() {
  if (!S.session) return;
  S.session.events = S.events.slice(0, 240);
  S.session.end = Date.now();
  store.upsertSession(snapshotSession());
}

function pushEvent(type, info) {
  const meta = TYPE_META[type] || TYPE_META['正常作业'];
  const ev = {
    ts: Date.now(),
    type,
    id: info.id,
    conf: Number(info.conf || 0),
    zone: info.zone || `${S.cfg.scene}1区`,
    thumb: info.thumb || null,
    alertId: null,
    voiceText: '',
    ackStatus: type === '正常作业' ? 'none' : '',
  };
  S.events.unshift(ev);
  if (S.events.length > 400) S.events.pop();
  S.counts[type] = (S.counts[type] || 0) + 1;
  S.todayCount++;
  if (meta.level !== 'low') S.violators.add(ev.id);

  renderEventTable();
  refreshLivePanels();
  renderDonut();
  schedulePersist();
  return ev;
}

function schedulePersist() {
  if (!S.session) return;
  clearTimeout(S.persistTimer);
  S.persistTimer = setTimeout(() => {
    if (!S.session) return;
    S.session.events = S.events.slice(0, 240);
    S.session.end = Date.now();
    store.upsertSession(snapshotSession());
    renderHistory();
  }, 1200);
}

function snapshotSession() {
  const s = S.session || { id: `S${Date.now()}`, start: Date.now() };
  return {
    id: s.id,
    start: s.start,
    end: s.end || Date.now(),
    source: s.source || S.source,
    events: S.events.slice(0, 240),
    stats: {
      total: S.events.length,
      alerts: S.events.filter(e => e.type !== '正常作业').length,
      ids: Math.max(S.tracker.totalIds, S.events.reduce((m, e) => Math.max(m, e.id || 0), 0)),
    },
  };
}

function finalizeSession() {
  if (!S.session) return;
  S.session.events = S.events.slice(0, 240);
  S.session.end = Date.now();
  store.upsertSession(snapshotSession());
  renderHistory();
}

function captureThumb(t) {
  if (!S.cfg.saveThumb) return null;
  try {
    const src = sourceEl();
    const { w: vw, h: vh } = sourceSize();
    if (!vw || !vh) return null;
    const cv = document.createElement('canvas');
    cv.width = 176; cv.height = 99;
    const g = cv.getContext('2d');
    const b = t.box;
    const pad = 0.25;
    let sx = (b.x - b.w * pad) * vw;
    let sy = (b.y - b.h * pad) * vh;
    let sw = b.w * (1 + pad * 2) * vw;
    let sh = b.h * (1 + pad * 2) * vh;
    const ratio = 176 / 99;
    if (sw / sh > ratio) { const nh = sw / ratio; sy -= (nh - sh) / 2; sh = nh; }
    else { const nw = sh * ratio; sx -= (nw - sw) / 2; sw = nw; }
    sx = clamp(sx, 0, vw); sy = clamp(sy, 0, vh);
    g.drawImage(src, sx, sy, Math.min(sw, vw - sx), Math.min(sh, vh - sy), 0, 0, 176, 99);
    return cv.toDataURL('image/jpeg', 0.55);
  } catch (e) {
    return null;
  }
}

function flashAlert(type, level, id, voiceText) {
  const el = $('#stageAlert');
  el.textContent = `⚠ ${type} · ID ${id}`;
  el.classList.toggle('mid', level !== 'high');
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3600);

  // 语音字幕条也同时亮起，画面里能直接看到喊话内容
  if (voiceText) showSpeechBar(voiceText, level, type);
}

/* ------------------------------ 舞台语音字幕条 ------------------------------ */
function showSpeechBar(text, level, tag) {
  const bar = $('#speechBar');
  if (!bar) return;
  clearTimeout(S._barTimer);
  $('#speechText').textContent = text;
  $('#speechTag').textContent = tag ? String(tag).toUpperCase().slice(0, 8) : 'VOICE';
  bar.classList.add('show');
  bar.classList.toggle('hot', level === 'high');
  bar.classList.toggle('warm', level === 'mid');
}

function hideSpeechBar() {
  const bar = $('#speechBar');
  if (!bar) return;
  bar.classList.remove('show', 'hot', 'warm');
  $('#speechText').textContent = '语音播报就绪';
  $('#speechTag').textContent = 'IDLE';
  $('#voiceMeter')?.classList.remove('live', 'hot');
  setVoiceStatus('待命', '');
}

function setVoiceStatus(text, cls) {
  const el = $('#voiceStatus');
  if (!el) return;
  el.textContent = text;
  el.className = cls || '';
}

/* ------------------------------ 绘制 ------------------------------ */
function resizeOverlay() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = S.wrap.clientWidth || 0;
  const h = S.wrap.clientHeight || 0;
  if (!w || !h) return;
  S.overlay.width = Math.round(w * dpr);
  S.overlay.height = Math.round(h * dpr);
  S.overlay.style.width = `${w}px`;
  S.overlay.style.height = `${h}px`;
  S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S.view = { w, h };
}

/* 当前画面来源：摄像头 / 视频 / 图片统一走这里取元素与尺寸 */
function sourceEl() {
  return (S.mode === 'image' && S.img) ? S.img : S.video;
}

function sourceSize() {
  if (S.mode === 'image' && S.img) return imgSize();
  return { w: S.video.videoWidth || 16, h: S.video.videoHeight || 9 };
}

function frameRect() {
  const { w: vw, h: vh } = sourceSize();
  const { w, h } = S.view;
  const scale = Math.min(w / (vw || 16), h / (vh || 9));
  const dw = (vw || 16) * scale, dh = (vh || 9) * scale;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
}

/* 镜像只对摄像头实时画面有意义（自拍视角）；上传的图片按原图坐标绘制 */
const isMirror = () => S.cfg.mirror && S.mode === 'live';
const MX = x => (isMirror() ? 1 - x : x);

function clearOverlay() {
  if (!S.ctx) return;
  S.ctx.clearRect(0, 0, S.view.w, S.view.h);
}

function draw() {
  const ctx = S.ctx;
  if (!ctx || !S.view.w) return;
  const fr = frameRect();
  const P = p => ({ x: fr.x + MX(p.x) * fr.w, y: fr.y + p.y * fr.h });

  ctx.clearRect(0, 0, S.view.w, S.view.h);

  // 画面暗角，突出骨骼
  const vg = ctx.createRadialGradient(S.view.w / 2, S.view.h / 2, Math.min(S.view.w, S.view.h) * 0.35,
    S.view.w / 2, S.view.h / 2, Math.max(S.view.w, S.view.h) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(2,7,13,.45)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, S.view.w, S.view.h);

  drawZones(ctx, P);

  const tracks = S.tracker.tracks;
  for (const t of tracks) drawSkeleton(ctx, t, P);
  for (const t of tracks) drawBox(ctx, t, P);

  if (S.drawing) drawDraft(ctx, P, fr);
}

function drawZones(ctx, P) {
  S.zones.forEach((z, idx) => {
    if (!z.points || z.points.length < 3) return;
    ctx.save();
    ctx.beginPath();
    z.points.forEach((p, i) => {
      const q = P(p);
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(244,63,94,.10)';
    ctx.fill();
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(244,63,94,.75)';
    ctx.stroke();
    ctx.setLineDash([]);

    const c = P(z.points.reduce((acc, p) => ({ x: acc.x + p.x / z.points.length, y: acc.y + p.y / z.points.length }), { x: 0, y: 0 }));
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(244,63,94,.9)';
    ctx.textAlign = 'center';
    ctx.fillText(`${z.name} · 禁止入内`, c.x, c.y);
    ctx.restore();
  });
}

function drawDraft(ctx, P, fr) {
  if (!S.draft.length) return;
  ctx.save();
  ctx.beginPath();
  S.draft.forEach((p, i) => {
    const q = P(p);
    if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
  });
  ctx.strokeStyle = 'rgba(251,191,36,.95)';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  S.draft.forEach((p, i) => {
    const q = P(p);
    ctx.beginPath();
    ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.fillStyle = '#04121c';
    ctx.font = '600 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), q.x, q.y + 3);
  });
  ctx.restore();
}

function drawSkeleton(ctx, t, P) {
  if (!S.cfg.showSkeleton || !t.lm) return;
  const color = t.level === 'high' ? '#ff5573' : (t.level === 'mid' ? '#fbbf24' : '#22d3ee');
  const lm = t.lm;

  ctx.save();
  if (t.level === 'high') { ctx.shadowColor = 'rgba(255,70,105,.85)'; ctx.shadowBlur = 8; }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  for (const [a, b] of SKELETON) {
    const p1 = lm[a], p2 = lm[b];
    if (!p1 || !p2) continue;
    if ((p1.visibility ?? 1) < 0.3 || (p2.visibility ?? 1) < 0.3) continue;
    const q1 = P(p1), q2 = P(p2);
    ctx.moveTo(q1.x, q1.y);
    ctx.lineTo(q2.x, q2.y);
  }
  ctx.stroke();

  for (let i = 11; i < 29; i++) {
    const p = lm[i];
    if (!p || (p.visibility ?? 1) < 0.3) continue;
    const q = P(p);
    ctx.beginPath();
    ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = i <= 16 ? '#eafcff' : color;
    ctx.fill();
  }
  ctx.restore();
}

function drawBox(ctx, t, P) {
  if (!S.cfg.showBox) return;
  const p1 = P({ x: t.box.x, y: t.box.y });
  const p2 = P({ x: t.box.x + t.box.w, y: t.box.y + t.box.h });
  const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
  const meta = TYPE_META[t.type] || TYPE_META['正常作业'];
  const color = meta.color;

  ctx.save();
  ctx.lineWidth = t.level === 'high' ? 2.2 : 1.5;
  ctx.strokeStyle = color;
  if (t.level === 'high') { ctx.shadowColor = color; ctx.shadowBlur = 14; }
  if (S.selectedId === t.id) ctx.setLineDash([6, 3]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  // 四角强调
  const c = Math.min(14, w * 0.22, h * 0.22);
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
  ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
  ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h);
  ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c);
  ctx.stroke();

  // 标签
  const label = `ID:${t.id}  ${t.type}`;
  ctx.font = '600 11px ui-monospace, monospace';
  const tw = ctx.measureText(label).width;
  const padX = 7, bh = 18;
  const ly = y - bh - 4 < 2 ? y + 4 : y - bh - 4;
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(3,10,18,.82)';
  roundRect(ctx, x, ly, tw + padX * 2 + 4, bh, 5);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, x, ly, tw + padX * 2 + 4, bh, 5);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(label, x + padX, ly + 12.5);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ------------------------------ 区域交互 ------------------------------ */
function toRawPoint(clientX, clientY) {
  const r = S.wrap.getBoundingClientRect();
  const fr = frameRect();
  const dx = (clientX - r.left - fr.x) / (fr.w || 1);
  const dy = (clientY - r.top - fr.y) / (fr.h || 1);
  return {
    x: clamp(isMirror() ? 1 - dx : dx, 0, 1),
    y: clamp(dy, 0, 1),
  };
}

function toggleDrawZone() {
  if (!S.running && !S.drawing) {
    toast('请先启动画面，再绘制危险区');
    return;
  }
  S.drawing = !S.drawing;
  S.draft = [];
  S.wrap.classList.toggle('drawing', S.drawing);
  $('#btnZone').classList.toggle('primary', S.drawing);
  $('#btnZone').textContent = S.drawing ? '取消绘制' : '绘制危险区';
  $('#btnZoneDone').disabled = !S.drawing;
  if (S.drawing) toast('在画面中依次点击顶点（至少 3 个），然后点「完成区域」');
}

function finishZone() {
  if (S.draft.length < 3) {
    toast('至少需要 3 个顶点才能闭合区域');
    return;
  }
  S.zones.push({
    id: `Z${Date.now()}`,
    name: `危险区${S.zones.length + 1}`,
    points: S.draft.slice(),
    createdAt: Date.now(),
  });
  store.saveZones(S.zones);
  S.draft = [];
  S.drawing = false;
  S.wrap.classList.remove('drawing');
  $('#btnZone').classList.remove('primary');
  $('#btnZone').textContent = '绘制危险区';
  $('#btnZoneDone').disabled = true;
  renderZonesList();
  toast('危险区已保存');
}

/* ------------------------------ 面板刷新 ------------------------------ */
function setPill(sel, text, cls) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  el.className = `pill ${cls || ''}`.trim();
}

function refreshLivePanels() {
  const tracks = S.tracker.tracks;
  const danger = tracks.filter(t => t.level !== 'low').length;
  $('#kpi-detected').textContent = tracks.length;
  $('#kpi-ids').textContent = S.tracker.totalIds;
  $('#kpi-danger').textContent = danger;
  $('#kpi-violators').textContent = S.violators.size;
  $('#kpi-inzone').textContent = tracks.filter(t => t.zone).length;
  $('#kpi-today').textContent = S.todayCount;

  const ast = S.alerts.stats();
  $('#kpi-pending').textContent = ast.pending;
  $('#kpi-voiced').textContent = ast.voiced;
  const alarmKpi = $('.kpi.alarm');
  if (alarmKpi) alarmKpi.classList.toggle('active', ast.highPending > 0);

  const c = S.counts;
  $('#al-climb').textContent = c['攀爬作业'] || 0;
  $('#al-bend').textContent = c['弯腰作业'] || 0;
  $('#al-fall').textContent = c['跌倒'] || 0;
  $('#al-loiter').textContent = c['人员滞留'] || 0;
  $('#al-zone').textContent = c['进入危险区'] || 0;
  $$('#alertList li').forEach(li => {
    const n = c[li.dataset.type] || 0;
    li.classList.toggle('hot', n > 0);
  });

  if (S.running && S.mode === 'live') {
    $('#stageInfo').textContent = `${S.source === 'camera' ? '摄像头' : '视频'} ${S.video.videoWidth}×${S.video.videoHeight} · ${tracks.length} 人`;
  }
  renderTrackList(tracks);
  if (S.selectedId) {
    const t = tracks.find(x => x.id === S.selectedId);
    if (t) renderDetail(t);
  }
}

function renderTrackList(tracks) {
  const ul = $('#trackList');
  $('#trackCount').textContent = `${tracks.length} tracks`;
  if (!tracks.length) {
    ul.innerHTML = '<li class="detail-empty" style="cursor:default;background:none;border:0;padding:0">暂无追踪目标，启动摄像头或上传图片后自动出现。</li>';
    return;
  }
  ul.innerHTML = tracks.map(t => {
    const meta = TYPE_META[t.type] || TYPE_META['正常作业'];
    return `<li data-id="${t.id}" class="${S.selectedId === t.id ? 'sel' : ''}">
      <div class="row1"><i style="background:${t.color}"></i><b>ID ${t.id}</b>
      <span style="color:${meta.color}">${t.type}</span></div>
      <div class="bar"><i style="width:${Math.round(t.conf * 100)}%;background:${meta.color}"></i></div>
    </li>`;
  }).join('');
}

function renderDetail(t) {
  const meta = TYPE_META[t.type] || TYPE_META['正常作业'];
  const m = t.metrics || {};
  const rows = [
    ['躯干倾角', `${m.angle ?? 0}°`, Math.min((m.angle || 0) / 90, 1), '#22d3ee'],
    ['膝关节角', `${m.knee ?? 0}°`, Math.min((m.knee || 0) / 180, 1), '#a78bfa'],
    ['包围框比例', `${m.aspect ?? 0}`, Math.min((m.aspect || 0) / 2, 1), '#34d399'],
    ['髋部下落', `${m.drop ?? 0}`, clamp(Math.abs(m.drop || 0) / 0.2, 0, 1), '#fbbf24'],
    ['所处区域', t.zone || '安全区', null, '#7f95ad'],
    ['追踪时长', `${m.life ?? 0}s`, null, '#7f95ad'],
  ];
  $('#detailBox').className = '';
  $('#detailBox').innerHTML = `
    <div class="detail-head">
      <span class="id">ID ${t.id}</span>
      <span class="tagpill" style="color:${meta.color};background:${meta.color}1f;border:1px solid ${meta.color}55">${t.type}</span>
      <span class="mono" style="margin-left:auto;color:#7f95ad">置信度 ${t.conf.toFixed(2)}</span>
    </div>
    ${rows.map(([k, v, ratio, color]) => `
      <div class="metric"><span>${k}</span>
        ${ratio != null ? `<div class="bar"><i style="width:${Math.round(ratio * 100)}%;background:${color}"></i></div>` : ''}
        <b>${v}</b>
      </div>`).join('')}
    <p class="mini-note" style="margin:10px 0 0">
      ${m.still
        ? `单帧判定：躯干倾角 ≥ ${S.cfg.fallAngle}° 且包围框横置 → 跌倒；倾角 ${S.cfg.bendAngle}°~${S.cfg.fallAngle - 3}° 且膝关节伸直 → 弯腰；双手举过头顶 → 攀爬；髋部落在危险区多边形内 → 进入危险区。`
        : `判定依据：躯干倾角 ≥ ${S.cfg.fallAngle}° 且包围框横置 / 髋部骤降 → 跌倒；
      倾角 ${S.cfg.bendAngle}°~${S.cfg.fallAngle - 3}° 且膝关节伸直 → 弯腰；
      髋部位于危险区多边形内 → 进入危险区，停留 ≥ ${S.cfg.loiterSec}s → 滞留。`}
    </p>`;
}

function alertOf(e) {
  return e && e.alertId ? S.alerts.find(e.alertId) : null;
}

function ackBadge(status) {
  const map = {
    new: ['new', '待处理'],
    acked: ['acked', '已处理'],
    ignored: ['ignored', '已忽略'],
    none: ['none', '—'],
  };
  const [cls, text] = map[status] || map.none;
  return `<span class="st-badge ${cls}">${text}</span>`;
}

function renderEventTable() {
  const tbody = $('#eventBody');
  const list = S.events.filter(e => {
    if (S.filter === 'alert') return e.type !== '正常作业';
    if (S.filter === 'normal') return e.type === '正常作业';
    if (S.filter === 'pending') {
      const a = alertOf(e);
      return !!(a && a.status === 'new');
    }
    return true;
  }).slice(0, 60);

  if (!list.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">暂无事件记录</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(e => {
    const meta = TYPE_META[e.type] || TYPE_META['正常作业'];
    const a = alertOf(e);
    const status = e.type === '正常作业' ? 'none' : (a ? a.status : (e.ackStatus || 'new'));
    const voiceText = e.voiceText || (a && a.text) || '';
    const voiceCls = voiceText ? 'voice-cell' : 'voice-cell muted';
    return `<tr>
      <td class="mono">${store.fmtTime(e.ts)}</td>
      <td class="mono">${esc(String(e.id))}</td>
      <td><span class="tag" style="--c:${meta.color}">${esc(e.type)}</span></td>
      <td class="mono">${Number(e.conf).toFixed(2)}</td>
      <td>${esc(e.zone || '—')}</td>
      <td><span class="${voiceCls}" title="${esc(voiceText)}">${voiceText ? esc(voiceText) : '—'}</span></td>
      <td><div class="st-cell">${ackBadge(status)}${a && a.status === 'new' ? `<button data-ack-row="${a.id}">处理</button>` : ''}</div></td>
      <td>${e.thumb ? `<img class="thumb" src="${e.thumb}" alt="snapshot" />` : '—'}</td>
    </tr>`;
  }).join('');
}

function renderDonut() {
  const cv = $('#riskDonut');
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  if (r.width < 10) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = r.width, h = r.height;
  ctx.clearRect(0, 0, w, h);

  const counts = { high: 0, mid: 0, low: 0 };
  for (const e of S.events) {
    const lv = (TYPE_META[e.type] || TYPE_META['正常作业']).level;
    counts[lv]++;
  }
  const total = Math.max(1, counts.high + counts.mid + counts.low);
  const data = [
    { v: counts.high, c: '#f43f5e' },
    { v: counts.mid, c: '#fbbf24' },
    { v: counts.low, c: '#34d399' },
  ];
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6, ring = Math.max(9, R * 0.32);
  let start = -Math.PI / 2;
  ctx.lineWidth = ring;
  ctx.lineCap = 'butt';
  if (!S.events.length) {
    ctx.beginPath();
    ctx.arc(cx, cy, R - ring / 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(126,148,171,.18)';
    ctx.stroke();
  }
  for (const d of data) {
    if (!d.v) continue;
    const ang = (d.v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R - ring / 2, start, start + ang - 0.02);
    ctx.strokeStyle = d.c;
    ctx.stroke();
    start += ang;
  }
  ctx.fillStyle = '#eafcff';
  ctx.font = `700 ${Math.round(R * 0.42)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(S.events.length), cx, cy - 3);
  ctx.fillStyle = '#6f8aa2';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText('EVENTS', cx, cy + R * 0.34);

  const pct = v => `${Math.round((v / total) * 100)}%`;
  $('#risk-high').textContent = pct(counts.high);
  $('#risk-mid').textContent = pct(counts.mid);
  $('#risk-low').textContent = pct(counts.low);
}

function renderZonesList() {
  const ul = $('#zoneList');
  $('#zoneCount').textContent = `${S.zones.length} 个区域`;
  if (!S.zones.length) {
    ul.innerHTML = '<li class="detail-empty" style="background:none;border:0;padding:0">暂无区域。在实时监控中点击「绘制危险区」，在画面内依次点选顶点后点「完成区域」。</li>';
    return;
  }
  ul.innerHTML = S.zones.map(z => `<li><i class="swatch"></i>${z.name}<b>${z.points.length} 顶点</b>
    <button class="btn sm ghost" data-del-zone="${z.id}" style="padding:2px 8px">删除</button></li>`).join('');
}

/* ------------------------------ 统计 / 历史 ------------------------------ */
function allEvents() {
  const stored = store.loadSessions().filter(s => !S.session || s.id !== S.session.id);
  const list = [];
  for (const s of stored) if (Array.isArray(s.events)) list.push(...s.events);
  list.push(...S.events);
  return list;
}

function countToday() {
  return S.todayCount;
}

function computeToday() {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let n = 0;
  for (const s of store.loadSessions()) {
    for (const e of (s.events || [])) if (e.ts >= start) n++;
  }
  return n;
}

function renderHistory() {
  const ul = $('#histList');
  const stored = store.loadSessions();
  const live = (S.running && S.events.length)
    ? [{ ...snapshotSession(), live: true }]
    : [];
  const sessions = live.concat(stored.filter(s => !live.length || s.id !== live[0].id));
  $('#histCount').textContent = `${sessions.length} 条`;
  if (!sessions.length) {
    ul.innerHTML = '<li class="detail-empty" style="cursor:default;background:none;border:0">暂无历史会话。每次启动采集会自动建立一条会话记录（保存在本机浏览器）。</li>';
    return;
  }
  ul.innerHTML = sessions.map((s, i) => {
    const alerts = (s.events || []).filter(e => e.type !== '正常作业').length;
    const dur = store.fmtDuration((s.end || s.start) - s.start);
    return `<li data-sid="${s.id}" class="${i === 0 ? 'sel' : ''}">
      <div class="h-top">${store.fmtTime(s.start)}${s.live ? '<span style="color:#34d399">· 进行中</span>' : ''}<b>${alerts} 预警</b></div>
      <div class="h-sub"><span>时长 ${dur}</span><span>事件 ${(s.events || []).length}</span>
      <span>${s.source === 'video' ? '视频分析' : (s.source === 'image' ? '图片检测' : '摄像头')}</span></div>
    </li>`;
  }).join('');
  const first = sessions[0];
  if (first) renderHistoryDetail(first);
}

function renderHistoryDetail(s) {
  $('#histTitle').textContent = `${store.fmtTime(s.start)} 起`;
  const box = $('#histDetail');
  const events = s.events || [];
  const thumbs = events.filter(e => e.thumb).slice(0, 8);
  if (!events.length) {
    box.className = 'detail-empty';
    box.innerHTML = '该会话没有记录到事件。';
    return;
  }
  box.className = '';
  box.innerHTML = `
    <div class="stat-cards" style="margin-bottom:12px">
      <div class="stat-card"><div class="k">会话时长</div><div class="v">${store.fmtDuration((s.end || s.start) - s.start)}</div><div class="s">DURATION</div></div>
      <div class="stat-card"><div class="k">事件总数</div><div class="v">${events.length}</div><div class="s">EVENTS</div></div>
      <div class="stat-card"><div class="k">预警数</div><div class="v">${events.filter(e => e.type !== '正常作业').length}</div><div class="s">ALERTS</div></div>
      <div class="stat-card"><div class="k">涉及目标</div><div class="v">${new Set(events.map(e => e.id)).size}</div><div class="s">IDS</div></div>
    </div>
    ${thumbs.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${thumbs.map(e => `<figure style="margin:0;text-align:center">
        <img src="${e.thumb}" style="width:104px;height:59px;object-fit:cover;border-radius:6px;border:1px solid rgba(56,189,248,.25)" />
        <figcaption class="mono" style="font-size:9.5px;color:#7f95ad;margin-top:3px">${e.type} · ID ${e.id}</figcaption>
      </figure>`).join('')}
    </div>` : ''}
    <div class="table-wrap">
      <table><thead><tr><th>时间</th><th>人员 ID</th><th>事件类型</th><th>置信度</th><th>区域位置</th></tr></thead>
      <tbody>${events.slice(0, 120).map(e => {
        const meta = TYPE_META[e.type] || TYPE_META['正常作业'];
        return `<tr><td class="mono">${store.fmtTime(e.ts)}</td><td class="mono">${e.id}</td>
        <td><span class="tag" style="--c:${meta.color}">${e.type}</span></td>
        <td class="mono">${Number(e.conf).toFixed(2)}</td><td>${e.zone || '—'}</td></tr>`;
      }).join('')}</tbody></table>
    </div>
    <div style="margin-top:12px"><button class="btn sm" id="btnExportSession">导出该会话 CSV</button></div>`;

  $('#btnExportSession')?.addEventListener('click', () => downloadCsv(events, `session-${s.id}`));
}

function renderStats() {
  const events = allEvents();
  const sessions = store.loadSessions();
  const totalMs = sessions.reduce((acc, s) => acc + Math.max(0, (s.end || s.start) - s.start), 0)
    + (S.session && S.running ? Date.now() - S.session.start : 0);
  const alerts = events.filter(e => e.type !== '正常作业');
  const high = events.filter(e => (TYPE_META[e.type] || TYPE_META['正常作业']).level === 'high');

  const mins = totalMs / 60000;
  $('#st-duration').innerHTML = `${mins < 10 ? mins.toFixed(1) : Math.round(mins)}<small>min</small>`;
  $('#st-events').textContent = events.length;
  $('#st-alerts').textContent = alerts.length;
  $('#st-high').innerHTML = `${events.length ? Math.round((high.length / events.length) * 100) : 0}<small>%</small>`;
  $('#st-ids').textContent = new Set(events.map(e => e.id)).size;
  $('#st-conf').textContent = events.length
    ? (events.reduce((a, e) => a + Number(e.conf || 0), 0) / events.length).toFixed(2)
    : '0.00';

  drawHourChart(events);
  drawTypeChart(events);
}

function canvasSetup(cv) {
  const r = cv.getBoundingClientRect();
  if (r.width < 10) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

function drawHourChart(events) {
  const cv = $('#chartHour');
  const s = canvasSetup(cv);
  if (!s) return;
  const { ctx, w, h } = s;
  ctx.clearRect(0, 0, w, h);
  const bins = new Array(24).fill(0);
  for (const e of events) bins[new Date(e.ts).getHours()]++;
  const max = Math.max(1, ...bins);
  const pad = { l: 30, r: 10, t: 14, b: 24 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;

  ctx.strokeStyle = 'rgba(56,189,248,.12)';
  ctx.fillStyle = '#6f8aa2';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(max - (max * i) / 4)), pad.l - 6, y + 3);
  }

  const step = iw / 24;
  const bw = Math.max(3, step * 0.6);
  bins.forEach((v, i) => {
    const bh = (ih * v) / max;
    const x = pad.l + step * i + (step - bw) / 2;
    const y = pad.t + ih - bh;
    const g = ctx.createLinearGradient(0, y, 0, pad.t + ih);
    g.addColorStop(0, '#22d3ee');
    g.addColorStop(1, 'rgba(34,211,238,.12)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, bw, Math.max(bh, 1.5), 3) : ctx.rect(x, y, bw, Math.max(bh, 1.5));
    ctx.fill();
  });

  ctx.fillStyle = '#6f8aa2';
  ctx.textAlign = 'center';
  for (let i = 0; i < 24; i += 3) {
    ctx.fillText(`${String(i).padStart(2, '0')}:00`, pad.l + step * i + step / 2, h - 6);
  }
}

function drawTypeChart(events) {
  const cv = $('#chartType');
  const s = canvasSetup(cv);
  if (!s) return;
  const { ctx, w, h } = s;
  ctx.clearRect(0, 0, w, h);

  const map = new Map();
  for (const e of events) map.set(e.type, (map.get(e.type) || 0) + 1);
  const rows = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!rows.length) {
    ctx.fillStyle = '#5d7389';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', w / 2, h / 2);
    return;
  }
  const max = Math.max(...rows.map(r => r[1]));
  const pad = { l: 74, r: 42, t: 12, b: 10 };
  const rowH = (h - pad.t - pad.b) / rows.length;
  const barMax = w - pad.l - pad.r;

  rows.forEach(([type, v], i) => {
    const y = pad.t + rowH * i + rowH * 0.28;
    const bh = rowH * 0.44;
    const bw = Math.max(3, (v / max) * barMax);
    const color = (TYPE_META[type] || TYPE_META['正常作业']).color;

    ctx.fillStyle = 'rgba(126,148,171,.10)';
    ctx.beginPath();
    roundRect(ctx, pad.l, y, barMax, bh, bh / 2);
    ctx.fill();

    const g = ctx.createLinearGradient(pad.l, 0, pad.l + bw, 0);
    g.addColorStop(0, `${color}55`);
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.beginPath();
    roundRect(ctx, pad.l, y, bw, bh, bh / 2);
    ctx.fill();

    ctx.fillStyle = '#bcd2e4';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(type, pad.l - 8, y + bh * 0.78);

    ctx.fillStyle = color;
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(String(v), pad.l + bw + 7, y + bh * 0.78);
  });
}

/* ------------------------------ 设置 ------------------------------ */
function syncSettingsUI() {
  $$('[data-cfg]').forEach(el => {
    const key = el.dataset.cfg;
    const v = S.cfg[key];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
    const out = $(`[data-val="${key}"]`);
    if (out) out.textContent = fmtVal(key, v);
  });
  syncVoicePill();
}

function fmtVal(key, v) {
  if (['fallAngle', 'bendAngle', 'kneeStraight'].includes(key)) return `${v}°`;
  if (key === 'loiterSec' || key === 'voiceMinGap' || key === 'reAlertSec') return `${v}s`;
  if (key === 'climbHold') return `${Number(v).toFixed(1)}s`;
  if (key === 'eventCooldown') return `${v}s`;
  if (key === 'maxFps') return `${v}fps`;
  if (key === 'maxPersons') return `${v}人`;
  if (key === 'fallFrames' || key === 'bendFrames') return `${v}帧`;
  if (key === 'confGate') return Number(v).toFixed(2);
  if (key === 'voiceRate') return `${Number(v).toFixed(2)}×`;
  if (key === 'voiceVolume') return `${Math.round(Number(v) * 100)}%`;
  if (key === 'voiceRepeat') return `${v}次`;
  return String(v);
}

function bindSettings() {
  $$('[data-cfg]').forEach(el => {
    const key = el.dataset.cfg;
    el.addEventListener('input', () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'range') v = Number(el.value);
      else v = el.value;
      S.cfg[key] = v;
      const out = $(`[data-val="${key}"]`);
      if (out) out.textContent = fmtVal(key, v);
      if (key === 'mirror') S.video.style.transform = v ? 'scaleX(-1)' : 'none';
      if (key === 'voiceEnabled') {
        if (!v) S.voice?.stopAll();
        else S.voice?.unlock();
        renderVoiceEngine();
      }
      if ((key === 'maxPersons' || key === 'modelQuality') && S.running) {
        S.engineDirty = true;
        toast('已修改模型参数，重启采集后生效');
      }
      store.saveConfig(S.cfg);
    });
  });

  $('#voiceSelect')?.addEventListener('change', e => {
    S.voice.setVoice(e.target.value);
    store.saveConfig(S.cfg);
    renderVoiceEngine();
    toast('已切换播报音色');
  });

  $('#btnSaveCfg').addEventListener('click', () => {
    store.saveConfig(S.cfg);
    toast('设置已保存');
  });

  $('#btnResetCfg').addEventListener('click', () => {
    Object.assign(S.cfg, DEFAULT_CONFIG);
    store.saveConfig(S.cfg);
    syncSettingsUI();
    renderVoiceEngine();
    renderVoiceSelect();
    S.video.style.transform = S.cfg.mirror ? 'scaleX(-1)' : 'none';
    toast('已恢复默认设置');
  });

  $('#btnClearData').addEventListener('click', () => {
    if (!confirm('将清空本机保存的全部会话记录、事件与危险区，确定继续？')) return;
    store.clearAll();
    S.events = [];
    S.counts = {};
    S.violators.clear();
    S.zones = [];
    S.session = null;
    S.selectedId = null;
    S.alerts.clear();
    S.bcast = [];
    renderEventTable();
    renderZonesList();
    renderHistory();
    renderStats();
    refreshLivePanels();
    renderDonut();
    renderAlertQueue();
    updateAlertBanner();
    renderBcastLog();
    toast('本机数据已清空');
  });

  $('#zoneList').addEventListener('click', e => {
    const btn = e.target.closest('[data-del-zone]');
    if (!btn) return;
    S.zones = S.zones.filter(z => z.id !== btn.dataset.delZone);
    store.saveZones(S.zones);
    renderZonesList();
    toast('区域已删除');
  });
}

/* ------------------------------ 交互绑定 ------------------------------ */
function bindToolbar() {
  $('#btnStart').addEventListener('click', () => {
    if (S.source !== 'camera') {
      S.source = 'camera';
      S.video.pause();
      S.video.removeAttribute('src');
      S.video.load();
    }
    start();
  });
  $('#btnStop').addEventListener('click', stop);

  $('#btnMirror').addEventListener('click', () => {
    if (S.mode === 'image') {
      toast('图片按原图方向显示，镜像只对摄像头画面生效');
      return;
    }
    S.cfg.mirror = !S.cfg.mirror;
    S.video.style.transform = S.cfg.mirror ? 'scaleX(-1)' : 'none';
    $('#btnMirror').textContent = `镜像：${S.cfg.mirror ? '开' : '关'}`;
    store.saveConfig(S.cfg);
  });
  $('#btnMirror').textContent = `镜像：${S.cfg.mirror ? '开' : '关'}`;

  $('#btnZone').addEventListener('click', toggleDrawZone);
  $('#btnZoneDone').addEventListener('click', finishZone);
  $('#btnZoneClear').addEventListener('click', () => {
    if (!S.zones.length) return;
    if (!confirm('确定清除全部危险区？')) return;
    S.zones = [];
    store.saveZones(S.zones);
    renderZonesList();
    toast('已清除全部危险区');
  });

  $('#btnSnap').addEventListener('click', () => {
    if (!S.running) { toast('请先启动画面'); return; }
    const { w, h } = sourceSize();
    if (!w || !h) { toast('当前没有可用画面'); return; }
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(sourceEl(), 0, 0, w, h);
    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = `snapshot-${Date.now()}.png`;
    a.click();
    toast(S.mode === 'image' ? '已保存原图（需要骨骼标注请用「导出标注图」）' : '已保存画面截图');
  });

  // 「上传视频 / 上传图片」是 <label for="…">，由浏览器原生打开文件选择框，
  // 不再用脚本 click()，避免部分浏览器拦截隐藏 input 的程序化点击
  $('#fileInput').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (S.running) stop();
    if (S.mode === 'image') exitImageMode();
    S.source = 'video';
    S.video.style.display = 'block';
    S.stream = null;
    S.video.srcObject = null;
    S.video.src = URL.createObjectURL(file);
    S.video.loop = true;
    try { await S.video.play(); } catch (err) { /* ignore */ }
    await start();
    toast(`已载入视频：${file.name}`);
  });

  /* —— 图片上传：选择文件 / 拖拽到画面 / Ctrl+V 粘贴 —— */
  $('#imgInput').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';       // 允许连续选择同一张图
    if (!file) return;
    await pickImage(file);
  });

  $('#btnImgRerun')?.addEventListener('click', () => {
    if (S.mode !== 'image') { toast('请先上传图片'); return; }
    analyzeImage();
  });
  $('#btnImgSave')?.addEventListener('click', exportAnnotated);
  $('#btnImgClose')?.addEventListener('click', () => exitImageMode({ toastText: '已退出图片模式' }));

  $('#imgList')?.addEventListener('click', e => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    S.selectedId = Number(li.dataset.id);
    const t = S.tracker.tracks.find(x => x.id === S.selectedId);
    if (t) renderDetail(t);
    renderImgResult();
    renderTrackList(S.tracker.tracks);
    draw();
  });

  // 拖拽载入
  ['dragenter', 'dragover'].forEach(ev => S.wrap.addEventListener(ev, e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    S.wrap.classList.add('dragover');
  }));
  S.wrap.addEventListener('dragleave', e => {
    if (e.relatedTarget && S.wrap.contains(e.relatedTarget)) return;
    S.wrap.classList.remove('dragover');
  });
  S.wrap.addEventListener('drop', async e => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    S.wrap.classList.remove('dragover');
    try { await handleDroppedFile(file); }
    catch (err) { toast(err.message || '文件载入失败'); }
  });

  // 粘贴截图 / 复制的图片
  document.addEventListener('paste', e => {
    const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
    const file = item?.getAsFile?.();
    if (!file) return;
    e.preventDefault();
    loadImageFile(file).catch(err => { hideImgLoading(); toast(err.message || '粘贴图片失败'); });
  });

  $('#camSelect').addEventListener('change', async () => {
    if (!S.running || S.source !== 'camera') return;
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    S.stream = null;
    try { await openCamera(); } catch (e) { toast('切换摄像头失败'); }
  });

  $('#btnExport').addEventListener('click', () => {
    if (!S.events.length) { toast('暂无事件可导出'); return; }
    downloadCsv(S.events, 'events');
  });

  $$('.chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      S.filter = chip.dataset.filter;
      $$('.chip[data-filter]').forEach(c => c.classList.toggle('active', c === chip));
      renderEventTable();
    });
  });

  // 画面点击：绘制顶点 / 选中目标
  S.wrap.addEventListener('click', e => {
    if (S.drawing) {
      S.draft.push(toRawPoint(e.clientX, e.clientY));
      return;
    }
    if (!S.running) return;
    const p = toRawPoint(e.clientX, e.clientY);
    const hit = S.tracker.tracks.find(t =>
      p.x >= t.box.x && p.x <= t.box.x + t.box.w && p.y >= t.box.y && p.y <= t.box.y + t.box.h);
    S.selectedId = hit ? hit.id : null;
    if (hit) {
      renderDetail(hit);
    } else {
      const box = $('#detailBox');
      box.className = 'detail-empty';
      box.textContent = '在画面中点击某位作业人员，查看其骨骼角度与判定依据。';
    }
  });

  window.addEventListener('keydown', e => {
    if (e.code === 'Escape' && S.drawing) {
      S.drawing = false;
      S.draft = [];
      S.wrap.classList.remove('drawing');
      $('#btnZone').classList.remove('primary');
      $('#btnZone').textContent = '绘制危险区';
      $('#btnZoneDone').disabled = true;
    }
    if (e.code === 'Space' && S.running && S.mode === 'live' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      S.paused = !S.paused;
      if (S.source === 'video') { S.paused ? S.video.pause() : S.video.play(); }
      $('#stageInfo').textContent = S.paused ? '已暂停 · 按空格继续' : '实时分析中';
    }
  });

  $('#trackList').addEventListener('click', e => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    S.selectedId = Number(li.dataset.id);
    const t = S.tracker.tracks.find(x => x.id === S.selectedId);
    if (t) renderDetail(t);
    renderTrackList(S.tracker.tracks);
  });

  $('#histList').addEventListener('click', e => {
    const li = e.target.closest('[data-sid]');
    if (!li) return;
    $$('#histList li').forEach(x => x.classList.toggle('sel', x === li));
    const s = store.loadSessions().find(x => x.id === li.dataset.sid);
    if (s) renderHistoryDetail(s);
  });
}

function bindMisc() {
  $('#btnSources').addEventListener('click', () => $('#modalSources').classList.add('show'));
  $('#btnCloseSources').addEventListener('click', () => $('#modalSources').classList.remove('show'));
  $('#modalSources').addEventListener('click', e => {
    if (e.target.id === 'modalSources') e.target.classList.remove('show');
  });
  window.addEventListener('resize', () => { resizeOverlay(); renderDonut(); });
  navigator.mediaDevices?.addEventListener?.('devicechange', listCameras);
}

/* ------------------------------ 语音 UI ------------------------------ */
function bindVoiceUI() {
  S.alerts.onChange(() => {
    renderAlertQueue();
    updateAlertBanner();
  });

  S.voice.on('voices', () => {
    renderVoiceEngine();
    renderVoiceSelect();
  });

  S.voice.on('start', ({ job }) => {
    S.voiceJob = job;
    const level = job.priority >= 3 ? 'high' : (job.priority >= 2 ? 'mid' : 'low');
    showSpeechBar(job.text, level, job.kind === 'manual' ? 'HUMAN' : 'ALERT');

    const meter = $('#voiceMeter');
    meter?.classList.add('live');
    meter?.classList.toggle('hot', level === 'high');
    setVoiceStatus('播报中…', 'on');
    setPill('#voicePill', '语音播报中', 'voice-speak');

    const q = $('#voiceQuote');
    if (q) {
      q.textContent = job.text;
      q.className = `vs-quote live${level === 'high' ? ' hot' : ''}`;
    }

    if (job.tag) S.alerts.markVoice(job.tag, 'speaking');
    pushBcast({ text: job.text, level, source: job.kind || 'auto', alertId: job.tag });
  });

  S.voice.on('end', ({ job }) => {
    if (job?.tag) S.alerts.markVoice(job.tag, 'done');
    S.voiceJob = null;
    scheduleHideBar();
  });

  S.voice.on('idle', () => scheduleHideBar());

  // 首次交互解锁音频（部分浏览器要求手势后才能出声）
  document.addEventListener('pointerdown', () => S.voice?.unlock(), { once: true });

  $('#btnMute').addEventListener('click', toggleVoice);
  $('#btnVoiceTest').addEventListener('click', () => testVoice());
  $('#btnVoiceStop').addEventListener('click', () => {
    S.voice.stopAll();
    toast('已停止播报');
  });
  $('#btnVoiceTestCfg')?.addEventListener('click', () => testVoice());
  $('#btnVoiceStopCfg')?.addEventListener('click', () => {
    S.voice.stopAll();
    toast('已停止播报');
  });

  // 喊话台按钮
  $('#presetGrid').addEventListener('click', e => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const p = PRESETS.find(x => x.key === btn.dataset.preset);
    if (!p) return;
    btn.classList.remove('firing');
    void btn.offsetWidth;
    btn.classList.add('firing');
    sayNow(p.text, p.level, { label: p.label });
  });

  $('#btnSay').addEventListener('click', () => {
    const input = $('#sayInput');
    const text = input.value.trim();
    sayNow(text, $('#sayLevel').value, { label: '自定义喊话' });
    if (text) input.value = '';
  });

  $('#sayInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#btnSay').click();
    }
  });

  // 告警队列的 处理 / 忽略
  $('#alertQueue').addEventListener('click', e => {
    const ack = e.target.closest('[data-ack]');
    const ign = e.target.closest('[data-ign]');
    if (ack) { ackAlert(ack.dataset.ack); return; }
    if (ign) { ignoreAlert(ign.dataset.ign); return; }
  });

  // 事件表里的 处理 按钮
  $('#eventBody').addEventListener('click', e => {
    const btn = e.target.closest('[data-ack-row]');
    if (!btn) return;
    ackAlert(btn.dataset.ackRow);
  });

  // 顶部横幅
  $('#abAck').addEventListener('click', () => {
    const id = $('#alarmBanner').dataset.alert;
    if (id) ackAlert(id);
  });
  $('#abVoice').addEventListener('click', () => {
    const id = $('#alarmBanner').dataset.alert;
    const a = id ? S.alerts.find(id) : S.alerts.pending()[0];
    if (!a) return;
    const r = S.voice.speak(a.text, { priority: 3, repeat: 1, force: true, gap: 0, tag: a.id, kind: 'manual' });
    toast(r.ok ? '已再次播报' : '播报未发出（语音已关闭或不支持）');
  });

  renderVoiceEngine();
  renderVoiceSelect();
  setPill('#voicePill', voicePillText().text, voicePillText().cls);
}

function voicePillText() {
  if (!VOICE_SUPPORTED) return { text: '语音不支持', cls: 'err' };
  if (!S.cfg.voiceEnabled) return { text: '语音已静音', cls: '' };
  if (S.voice?.speaking) return { text: '语音播报中', cls: 'voice-speak' };
  return { text: '语音就绪', cls: 'voice-ok' };
}

function syncVoicePill() {
  const p = voicePillText();
  setPill('#voicePill', p.text, p.cls);

  const btn = $('#btnMute');
  if (btn) {
    const on = !!S.cfg.voiceEnabled;
    btn.textContent = on ? '语音：开' : '语音：关';
    btn.classList.toggle('off', !on);
  }
}

function toggleVoice() {
  S.cfg.voiceEnabled = !S.cfg.voiceEnabled;
  if (!S.cfg.voiceEnabled) S.voice.stopAll();
  else S.voice.unlock();
  store.saveConfig(S.cfg);
  syncSettingsUI();
  syncVoicePill();
  renderVoiceEngine();
  toast(S.cfg.voiceEnabled ? '语音播报已开启' : '语音播报已静音');
}

function testVoice() {
  if (!VOICE_SUPPORTED) { toast('当前浏览器不支持语音合成'); return; }
  S.voice.unlock();
  const r = S.voice.test('语音播报测试，请注意，工作区内有人摔倒');
  if (!r.ok) toast('试听失败：' + (r.reason || '未知原因'));
  else toast('正在试听当前音色');
}

function renderVoiceEngine() {
  const eng = $('#voiceEngine');
  const nm = $('#voiceName');
  if (eng) {
    eng.textContent = VOICE_SUPPORTED ? (S.cfg.voiceEnabled ? '就绪' : '已静音') : '不支持';
    eng.className = VOICE_SUPPORTED && S.cfg.voiceEnabled ? 'on' : 'off';
  }
  if (nm) {
    nm.textContent = S.voice?.voiceName || '系统默认';
    nm.title = `${S.voice?.voiceName || ''} ${S.voice?.langName || ''}`.trim();
  }
  syncVoicePill();
}

function renderVoiceSelect() {
  const sel = $('#voiceSelect');
  if (!sel) return;
  const voices = S.voice?.voices?.length ? S.voice.voices : [];
  if (!voices.length) {
    sel.innerHTML = '<option value="">系统默认音色</option>';
    sel.value = '';
    return;
  }
  sel.innerHTML = '<option value="">自动选择（推荐中文）</option>' +
    voices.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
  sel.value = S.cfg.voiceURI || '';
}

function scheduleHideBar() {
  clearTimeout(S._barTimer);
  S._barTimer = setTimeout(() => {
    if (S.voice?.speaking) return;
    hideSpeechBar();
    syncVoicePill();
  }, 1600);
}

/* ------------------------------ 工具 ------------------------------ */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPresets() {
  const grid = $('#presetGrid');
  if (!grid) return;
  grid.innerHTML = PRESETS.map(p =>
    `<button class="preset-btn" data-preset="${p.key}" data-level="${p.level}" title="${esc(p.text)}">
      <b>${esc(p.label)}</b><i>${esc(p.hint)}</i>
    </button>`).join('');
}

function downloadCsv(events, name) {
  const csv = store.eventsToCsv(events);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${store.fmtTime(Date.now()).replace(/[: ]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast(`已导出 ${events.length} 条记录`);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

let audioCtx = null;
function beep(level) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = level === 'high' ? 880 : 620;
    gain.gain.value = 0.035;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.11);
  } catch (e) { /* 音频不可用则忽略 */ }
}

boot();
