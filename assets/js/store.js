/* ==========================================================================
 * store.js — 本地持久化（配置 / 危险区 / 会话事件）
 * 使用 localStorage，全部数据留在本机浏览器，不上传任何画面
 * ========================================================================== */
const K = {
  cfg: 'wsm.config.v1',
  zones: 'wsm.zones.v1',
  sess: 'wsm.sessions.v1',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function write(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (e) {
    return false;
  }
}

export const loadConfig = () => read(K.cfg, {});
export const saveConfig = (cfg) => write(K.cfg, cfg);

export const loadZones = () => read(K.zones, []);
export const saveZones = (zones) => write(K.zones, zones);

export const loadSessions = () => read(K.sess, []);

/** 保存或更新一条会话；容量不足时自动剥离快照后重试 */
export function upsertSession(session) {
  const arr = loadSessions().filter(s => s.id !== session.id);
  arr.unshift(session);
  arr.sort((a, b) => b.start - a.start);
  const trimmed = arr.slice(0, 24);
  if (write(K.sess, trimmed)) return true;
  const lean = trimmed.map(s => ({
    ...s,
    events: (s.events || []).map(e => ({ ...e, thumb: null })),
  }));
  if (write(K.sess, lean)) return true;
  return write(K.sess, lean.map(s => ({ ...s, events: (s.events || []).slice(0, 120) })));
}

export function clearSessions() {
  write(K.sess, []);
}

export function clearAll() {
  write(K.sess, []);
  write(K.cfg, {});
  write(K.zones, []);
}

/** 导出事件为 CSV（带 BOM，Excel 直接可读） */
export function eventsToCsv(events) {
  const head = ['时间', '人员ID', '事件类型', '置信度', '区域位置', '语音播报', '处理状态'];
  const statusText = { new: '待处理', acked: '已处理', ignored: '已忽略' };
  const rows = events.map(e => [
    fmtTime(e.ts),
    e.id,
    e.type,
    Number(e.conf || 0).toFixed(2),
    e.zone || '',
    e.voiceText || '',
    e.type === '正常作业' ? '' : (statusText[e.ackStatus] || (e.alertId ? '待处理' : '')),
  ]);
  const body = [head, ...rows]
    .map(cols => cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  return '\uFEFF' + body;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
