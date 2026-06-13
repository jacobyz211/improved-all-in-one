// Eclipse All-in-One Addon — v3.0.0
// Cloudflare Workers · Hono · Priority-first multi-source search with strict dedup
// Sources: Qobuz, Tidal (HiFi proxies), Deezer, SoundCloud, MusicBrainz, Internet Archive

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('*', cors());

// ─── Constants ────────────────────────────────────────────────────────────────
const VERSION        = '3.0.0';
const UA             = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS     = 10000;
const STREAM_TTL     = 200;       // seconds to cache stream URLs
const INSTANCE_TTL   = 300;
const MB_RATE_MS     = 1100;
const MB_BASE        = 'https://musicbrainz.org/ws/2';
const DEEZER_BASE    = 'https://api.deezer.com';
const IA_BASE        = 'https://archive.org';
const QOBUZ_BASE     = 'https://www.qobuz.com/api.json/0.2';

// Qobuz direct credentials (same as your working addon)
const QOBUZ_APP_ID   = '312369995';
const QOBUZ_TOKEN    = 'xDkvXFh-sRSrmN-s5rSdL4Dooppx4Q7G6VgnviHcxpBBv_RHxKmCKx1_XANKmz6IDVBtgBcwQHFWJgJObLpiJw';
const QOBUZ_SECRET   = 'e79f8b9be485692b0e5f9dd895826368';

// Qobuz proxy fallbacks
const QOBUZ_PROXIES = [
  'https://qobuz-api1.onrender.com',
  'https://trypt-hifi-dl-456461932686.us-west1.run.app',
  'https://qobuz-api.stremio123.duckdns.org',
  'https://qobuz.kennyy.com.br/api',
];

// Tidal HiFi proxy pool
const DEFAULT_HIFI_INSTANCES = [
  'https://hifi-api-bffw.onrender.com',
  'https://hifi-api-pj08.onrender.com',
  'https://mono.kennyy.com.br/hifi-api',
  'https://tidal-api.binimum.org',
  'https://triton.squid.wtf',
  'https://ohio-1.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://vogel.qqdl.site',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://monochrome-api.samidy.com',
  'https://hifi-two.spotisaver.net',
  'https://wolf.qqdl.site',
  'https://katze.qqdl.site',
  'https://hund.qqdl.site',
  'https://api.monochrome.tf',
];

// Source IDs — also the valid values for searchSources / streamSources
const S = {
  QOBUZ:    'qobuz',
  TIDAL:    'tidal',
  DEEZER:   'deezer',
  SOUNDCLOUD: 'soundcloud',
  MUSICBRAINZ: 'musicbrainz',
  INTERNETARCHIVE: 'internetarchive',
};

// Default search priority (user can override via token settings or manifest URL param)
const DEFAULT_SEARCH_ORDER  = [S.QOBUZ, S.TIDAL, S.DEEZER, S.SOUNDCLOUD, S.MUSICBRAINZ, S.INTERNETARCHIVE];
const DEFAULT_STREAM_ORDER  = [S.QOBUZ, S.TIDAL, S.DEEZER, S.SOUNDCLOUD, S.INTERNETARCHIVE];

// ─── In-memory token store ────────────────────────────────────────────────────
const TOKEN_STORE = new Map();
const memCache    = new Map();

// ─── In-memory working-instance cache ────────────────────────────────────────
let _hifiWorkingInst  = null;
let _hifiInstExpiry   = 0;

// ─── Rate limiting state ──────────────────────────────────────────────────────
const GLOBAL_DAILY_LIMIT = 85000;
let _globalDailyCount = 0;
let _globalDayStart   = Date.now();
const TOKEN_RATE_STATE = new Map();
const IP_GEN_RATE      = new Map();
const IP_CREATES       = new Map();

// ─── MD5 (pure JS — needed for Qobuz signature) ──────────────────────────────
function md5(str) {
  function RL(v,n){return(v<<n)|(v>>>(32-n))}
  function AU(x,y){const x8=(x&0x80000000),y8=(y&0x80000000),x4=(x&0x40000000),y4=(y&0x40000000),r=(x&0x3FFFFFFF)+(y&0x3FFFFFFF);if(x4&y4)return(r^0x80000000^x8^y8);if(x4|y4){if(r&0x40000000)return(r^0xC0000000^x8^y8);return(r^0x40000000^x8^y8)}return(r^x8^y8)}
  function F(x,y,z){return(x&y)|((~x)&z)}function G(x,y,z){return(x&z)|(y&(~z))}function H(x,y,z){return x^y^z}function I(x,y,z){return y^(x|(~z))}
  function FF(a,b,c,d,x,s,ac){a=AU(a,AU(AU(F(b,c,d),x),ac));return AU(RL(a,s),b)}
  function GG(a,b,c,d,x,s,ac){a=AU(a,AU(AU(G(b,c,d),x),ac));return AU(RL(a,s),b)}
  function HH(a,b,c,d,x,s,ac){a=AU(a,AU(AU(H(b,c,d),x),ac));return AU(RL(a,s),b)}
  function II(a,b,c,d,x,s,ac){a=AU(a,AU(AU(I(b,c,d),x),ac));return AU(RL(a,s),b)}
  function CW(s){const ml=s.length,nw_t1=ml+8,nw_t2=(nw_t1-(nw_t1%64))/64,nw=(nw_t2+1)*16,wa=Array(nw-1);let bp=0,bc=0;while(bc<ml){const wc=(bc-(bc%4))/4,pos=(bc%4)*8;wa[wc]=(wa[wc]|(s.charCodeAt(bc)<<pos));bc++}const wc2=(bc-(bc%4))/4;wa[wc2]=(wa[wc2]|(0x80<<((bc%4)*8)));wa[nw-2]=ml<<3;wa[nw-1]=ml>>>29;return wa}
  function WH(v){let r='',t='',byte,c;for(c=0;c<=3;c++){byte=(v>>>(c*8))&255;t='0'+byte.toString(16);r+=t.substr(t.length-2,2)}return r}
  const x=CW(str);let k,a=0x67452301,b=0xEFCDAB89,c2=0x98BADCFE,d=0x10325476,AA,BB,CC,DD;
  const S11=7,S12=12,S13=17,S14=22,S21=5,S22=9,S23=14,S24=20,S31=4,S32=11,S33=16,S34=23,S41=6,S42=10,S43=15,S44=21;
  for(k=0;k<x.length;k+=16){AA=a;BB=b;CC=c2;DD=d;a=FF(a,b,c2,d,x[k],S11,0xD76AA478);d=FF(d,a,b,c2,x[k+1],S12,0xE8C7B756);c2=FF(c2,d,a,b,x[k+2],S13,0x242070DB);b=FF(b,c2,d,a,x[k+3],S14,0xC1BDCEEE);a=FF(a,b,c2,d,x[k+4],S11,0xF57C0FAF);d=FF(d,a,b,c2,x[k+5],S12,0x4787C62A);c2=FF(c2,d,a,b,x[k+6],S13,0xA8304613);b=FF(b,c2,d,a,x[k+7],S14,0xFD469501);a=FF(a,b,c2,d,x[k+8],S11,0x698098D8);d=FF(d,a,b,c2,x[k+9],S12,0x8B44F7AF);c2=FF(c2,d,a,b,x[k+10],S13,0xFFFF5BB1);b=FF(b,c2,d,a,x[k+11],S14,0x895CD7BE);a=FF(a,b,c2,d,x[k+12],S11,0x6B901122);d=FF(d,a,b,c2,x[k+13],S12,0xFD987193);c2=FF(c2,d,a,b,x[k+14],S13,0xA679438E);b=FF(b,c2,d,a,x[k+15],S14,0x49B40821);a=GG(a,b,c2,d,x[k+1],S21,0xF61E2562);d=GG(d,a,b,c2,x[k+6],S22,0xC040B340);c2=GG(c2,d,a,b,x[k+11],S23,0x265E5A51);b=GG(b,c2,d,a,x[k],S24,0xE9B6C7AA);a=GG(a,b,c2,d,x[k+5],S21,0xD62F105D);d=GG(d,a,b,c2,x[k+10],S22,0x02441453);c2=GG(c2,d,a,b,x[k+15],S23,0xD8A1E681);b=GG(b,c2,d,a,x[k+4],S24,0xE7D3FBC8);a=GG(a,b,c2,d,x[k+9],S21,0x21E1CDE6);d=GG(d,a,b,c2,x[k+14],S22,0xC33707D6);c2=GG(c2,d,a,b,x[k+3],S23,0xF4D50D87);b=GG(b,c2,d,a,x[k+8],S24,0x455A14ED);a=GG(a,b,c2,d,x[k+13],S21,0xA9E3E905);d=GG(d,a,b,c2,x[k+2],S22,0xFCEFA3F8);c2=GG(c2,d,a,b,x[k+7],S23,0x676F02D9);b=GG(b,c2,d,a,x[k+12],S24,0x8D2A4C8A);a=HH(a,b,c2,d,x[k+5],S31,0xFFFA3942);d=HH(d,a,b,c2,x[k+8],S32,0x8771F681);c2=HH(c2,d,a,b,x[k+11],S33,0x6D9D6122);b=HH(b,c2,d,a,x[k+14],S34,0xFDE5380C);a=HH(a,b,c2,d,x[k+1],S31,0xA4BEEA44);d=HH(d,a,b,c2,x[k+4],S32,0x4BDECFA9);c2=HH(c2,d,a,b,x[k+7],S33,0xF6BB4B60);b=HH(b,c2,d,a,x[k+10],S34,0xBEBFBC70);a=HH(a,b,c2,d,x[k+13],S31,0x289B7EC6);d=HH(d,a,b,c2,x[k],S32,0xEAA127FA);c2=HH(c2,d,a,b,x[k+3],S33,0xD4EF3085);b=HH(b,c2,d,a,x[k+6],S34,0x04881D05);a=HH(a,b,c2,d,x[k+9],S31,0xD9D4D039);d=HH(d,a,b,c2,x[k+12],S32,0xE6DB99E5);c2=HH(c2,d,a,b,x[k+15],S33,0x1FA27CF8);b=HH(b,c2,d,a,x[k+2],S34,0xC4AC5665);a=II(a,b,c2,d,x[k],S41,0xF4292244);d=II(d,a,b,c2,x[k+7],S42,0x432AFF97);c2=II(c2,d,a,b,x[k+14],S43,0xAB9423A7);b=II(b,c2,d,a,x[k+5],S44,0xFC93A039);a=II(a,b,c2,d,x[k+12],S41,0x655B59C3);d=II(d,a,b,c2,x[k+3],S42,0x8F0CCC92);c2=II(c2,d,a,b,x[k+10],S43,0xFFEFF47D);b=II(b,c2,d,a,x[k+1],S44,0x85845DD1);a=II(a,b,c2,d,x[k+8],S41,0x6FA87E4F);d=II(d,a,b,c2,x[k+15],S42,0xFE2CE6E0);c2=II(c2,d,a,b,x[k+6],S43,0xA3014314);b=II(b,c2,d,a,x[k+13],S44,0x4E0811A1);a=II(a,b,c2,d,x[k+4],S41,0xF7537E82);d=II(d,a,b,c2,x[k+11],S42,0xBD3AF235);c2=II(c2,d,a,b,x[k+2],S43,0x2AD7D2BB);b=II(b,c2,d,a,x[k+9],S44,0xEB86D391);a=AU(a,AA);b=AU(b,BB);c2=AU(c2,CC);d=AU(d,DD)}
  return (WH(a)+WH(b)+WH(c2)+WH(d)).toLowerCase();
}

// ─── String helpers ───────────────────────────────────────────────────────────
function normalizeStr(s) {
  if (!s) return '';
  return s.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''`´]/g, "'")
    .replace(/[\u2022\u00b7\u2027\u22c5]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .toLowerCase().trim();
}

function removeFeat(s) {
  if (!s) return '';
  s = s.replace(/\s*\([^)]*(feat|ft|featuring)[^)]*\)/gi, '');
  s = s.replace(/\s*\[[^\]]*(feat|ft|featuring)[^\]]*\]/gi, '');
  const m = s.match(/\b(feat\.?|ft\.?|featuring)\b/i);
  if (m && m.index > 0) s = s.substring(0, m.index);
  return s.trim();
}

function cleanTitle(t) { return t ? removeFeat(t) : 'Unknown'; }

function formatQuery(q) {
  q = q.replace(/[''`´]/g, "'").replace(/[""«»]/g, '"');
  return removeFeat(q);
}

// ─── Deduplication ────────────────────────────────────────────────────────────
// Each bucket (tracks / albums / artists) dedupes independently.
// Key strategy:
//   tracks  → ISRC preferred; fallback to normalized(title)|normalized(artist)|durationBucket
//   albums  → normalized(title)|normalized(artist)
//   artists → normalized(name)
function durationBucket(sec) { return sec ? Math.round(Number(sec) / 4) : 0; }

function trackKey(isrc, title, artist, durSec) {
  if (isrc) {
    const c = String(isrc).toUpperCase().replace(/\W/g, '');
    if (c.length >= 12) return 'isrc:' + c;
  }
  const t = normalizeStr(title);
  const a = normalizeStr(artist);
  const d = durationBucket(durSec);
  return `t:${t}|${a}|${d}`;
}

function albumKey(title, artist) {
  return `al:${normalizeStr(title)}|${normalizeStr(artist)}`;
}

function artistKey(name) {
  return `ar:${normalizeStr(name)}`;
}

/**
 * Priority-first merge:
 * Source 1 fills ALL its results first.
 * Source 2 only adds results not already seen from source 1.
 * Source 3 fills in whatever source 1+2 didn't cover, etc.
 *
 * orderedResults: array of { source, tracks[], albums[], artists[] }
 *   already sorted by user's chosen priority (index 0 = highest priority)
 */
function mergeResults(orderedResults) {
  const trackSeen  = new Set();
  const albumSeen  = new Set();
  const artistSeen = new Set();

  const tracks  = [];
  const albums  = [];
  const artists = [];

  for (const { source, results } of orderedResults) {
    if (!results) continue;

    // ── Tracks ──────────────────────────────────────────────────────────────
    // Sort newest-first within each source before merging
    const srcTracks = [...(results.tracks || [])].sort((a, b) => {
      const ya = String(a.year || a.releaseDate || '0000').slice(0, 4);
      const yb = String(b.year || b.releaseDate || '0000').slice(0, 4);
      return yb.localeCompare(ya);
    });
    for (const t of srcTracks) {
      const key = trackKey(t.isrc, t.title, t.artist, t.duration);
      if (!key || trackSeen.has(key)) continue;
      trackSeen.add(key);
      tracks.push({ ...t, _source: source });
    }

    // ── Albums ───────────────────────────────────────────────────────────────
    const srcAlbums = [...(results.albums || [])].sort((a, b) => {
      const ya = String(a.year || a.releaseDate || '0000').slice(0, 4);
      const yb = String(b.year || b.releaseDate || '0000').slice(0, 4);
      return yb.localeCompare(ya);
    });
    for (const a of srcAlbums) {
      const key = albumKey(a.title, a.artist);
      if (!key || albumSeen.has(key)) continue;
      albumSeen.add(key);
      albums.push({ ...a, _source: source });
    }

    // ── Artists ──────────────────────────────────────────────────────────────
    for (const a of (results.artists || [])) {
      const key = artistKey(a.name);
      if (!key || artistSeen.has(key)) continue;
      artistSeen.add(key);
      artists.push({ ...a, _source: source });
    }
  }

  return { tracks, albums, artists };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function httpGet(url, params, timeoutMs) {
  const u = new URL(url);
  if (params) Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(u.toString(), {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) { try { await r.arrayBuffer(); } catch {} throw new Error('HTTP ' + r.status); }
    return r.json();
  } catch (e) { clearTimeout(timer); throw e; }
}

// ─── Mem cache helpers ────────────────────────────────────────────────────────
function mGet(key) {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { memCache.delete(key); return null; }
  return e.val;
}
function mSet(key, val, ttlSec) {
  memCache.set(key, { val, exp: Date.now() + ttlSec * 1000 });
  if (memCache.size > 800) memCache.delete(memCache.keys().next().value);
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
function consumeGlobalBudget() {
  const now = Date.now();
  if (now - _globalDayStart > 86400000) { _globalDailyCount = 0; _globalDayStart = now; }
  if (_globalDailyCount >= GLOBAL_DAILY_LIMIT) return false;
  _globalDailyCount++;
  return true;
}
function getTokenRateState(token) {
  if (!TOKEN_RATE_STATE.has(token)) TOKEN_RATE_STATE.set(token, { general: [], stream: [], search: [] });
  return TOKEN_RATE_STATE.get(token);
}
function checkTokenRate(token, type) {
  const now = Date.now();
  const st  = getTokenRateState(token);
  const cfg = { stream: [60000, 20], search: [60000, 30], general: [60000, 100] };
  const [windowMs, maxReqs] = cfg[type] || cfg.general;
  st[type] = (st[type] || []).filter(t => now - t < windowMs);
  if (st[type].length >= maxReqs) return false;
  st[type].push(now);
  return true;
}
function checkIpGenerateRate(ip) {
  const now = Date.now();
  const b = IP_GEN_RATE.get(ip) || { count: 0, resetAt: now + 3600000 };
  if (now > b.resetAt) { b.count = 0; b.resetAt = now + 3600000; }
  if (b.count >= 5) return false;
  b.count++; IP_GEN_RATE.set(ip, b); return true;
}
function rateLimitResp(msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
  });
}

// ─── Token helpers ────────────────────────────────────────────────────────────
function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(28);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => chars[b % chars.length]).join('');
}
function b64uEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function parseTokenParam(raw) {
  const parts = raw.split('~');
  const token = parts[0];
  let name = null;
  if (parts[1]) { try { name = decodeURIComponent(b64uDecode(parts[1])); } catch {} }
  return { token, embeddedName: name };
}
function buildTokenSegment(token, name) {
  return name ? token + '~' + b64uEncode(encodeURIComponent(name)) : token;
}
function saveToken(token, data) {
  TOKEN_STORE.set(token, data);
}
function loadToken(token) {
  return TOKEN_STORE.get(token) || null;
}

// ─── HiFi (Tidal proxy) helpers ───────────────────────────────────────────────
async function getWorkingHiFiInstance() {
  const now = Date.now();
  if (_hifiWorkingInst && now < _hifiInstExpiry) return _hifiWorkingInst;
  for (const inst of DEFAULT_HIFI_INSTANCES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const r = await fetch(inst + '/search/?s=test&limit=1', { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      clearTimeout(timer);
      try { await r.arrayBuffer(); } catch {}
      if (r.ok) { _hifiWorkingInst = inst; _hifiInstExpiry = now + INSTANCE_TTL * 1000; return inst; }
    } catch { clearTimeout(timer); }
  }
  // Fallback to a known stable instance
  _hifiWorkingInst = DEFAULT_HIFI_INSTANCES[4];
  _hifiInstExpiry  = now + 60000;
  return _hifiWorkingInst;
}

async function hifiGet(path) {
  const inst = await getWorkingHiFiInstance();
  return httpGet(inst + path, null, TIMEOUT_MS);
}

async function hifiGetAny(path) {
  for (const inst of DEFAULT_HIFI_INSTANCES) {
    try { return await httpGet(inst + path, null, 6000); } catch {}
  }
  throw new Error('All HiFi instances failed: ' + path);
}

// ─── Qobuz API (direct → proxy fallback) ─────────────────────────────────────
async function qobuzApi(endpoint, params) {
  const appId = QOBUZ_APP_ID;
  const token = QOBUZ_TOKEN;
  const base  = QOBUZ_BASE + endpoint + '?app_id=' + appId + '&user_auth_token=' + token;
  const qs    = params ? '&' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString() : '';
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(base + qs, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    clearTimeout(timer);
    if (!r.ok) throw new Error('Qobuz direct HTTP ' + r.status);
    return r.json();
  } catch (e) {
    clearTimeout(timer);
    // Try proxies
    for (const proxy of QOBUZ_PROXIES) {
      const ctrl2 = new AbortController();
      const t2    = setTimeout(() => ctrl2.abort(), 7000);
      try {
        const u = new URL(proxy + endpoint);
        if (params) Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
        const r2 = await fetch(u.toString(), { headers: { 'User-Agent': UA }, signal: ctrl2.signal });
        clearTimeout(t2);
        if (!r2.ok) { try { await r2.arrayBuffer(); } catch {} throw new Error('HTTP ' + r2.status); }
        return r2.json();
      } catch { clearTimeout(t2); }
    }
    throw new Error('All Qobuz endpoints failed for ' + endpoint);
  }
}

// ─── MusicBrainz ─────────────────────────────────────────────────────────────
let _mbLastCall = 0;
async function mbFetch(path, params) {
  const now  = Date.now();
  const wait = MB_RATE_MS - (now - _mbLastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _mbLastCall = Date.now();
  const u = new URL(MB_BASE + path);
  u.searchParams.set('fmt', 'json');
  if (params) Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(u.toString(), {
      headers: { 'User-Agent': 'eclipse-all-in-one/3.0', 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error('MB HTTP ' + r.status);
    return r.json();
  } catch (e) { clearTimeout(timer); throw e; }
}

// ─── Source adapters: search ──────────────────────────────────────────────────

// Returns { tracks[], albums[], artists[] }
async function searchQobuz(query, limit) {
  try {
    const d = await qobuzApi('/catalog/search', { query, limit, offset: 0 });
    const tracks = (d?.tracks?.items || []).map(t => ({
      id:       'qobuz:' + t.id,
      sourceId: String(t.id),
      isrc:     t.isrc || null,
      title:    cleanTitle(t.title),
      artist:   t.performer?.name || t.album?.artist?.name || '',
      album:    t.album?.title || '',
      duration: t.duration || null,
      cover:    t.album?.image?.large || t.album?.image?.small || null,
      year:     t.album?.released_at ? new Date(t.album.released_at * 1000).getFullYear() : null,
      quality:  t.maximum_sampling_rate ? `${t.maximum_sampling_rate}kHz/${t.maximum_bit_depth}bit FLAC` : 'FLAC',
      explicit: t.parental_advisory === true,
    }));
    const albums = (d?.albums?.items || []).map(a => ({
      id:      'qobuz:' + a.id,
      sourceId: String(a.id),
      title:   a.title,
      artist:  a.artist?.name || '',
      year:    a.released_at ? new Date(a.released_at * 1000).getFullYear() : null,
      cover:   a.image?.large || a.image?.small || null,
    }));
    const artists = (d?.artists?.items || []).map(a => ({
      id:      'qobuz:' + a.id,
      sourceId: String(a.id),
      name:    a.name,
      cover:   a.picture || null,
    }));
    return { tracks, albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function searchTidal(query, limit) {
  try {
    const d = await hifiGet('/search/?s=' + encodeURIComponent(query) + '&limit=' + limit);
    const raw = d?.data?.tracks?.items || d?.tracks?.items || d?.data?.items || (Array.isArray(d) ? d : []);
    const tracks = raw.map(t => {
      const arts = (t.artists || (t.artist ? [t.artist] : [])).map(a => a.name).join(', ');
      const cvr  = t.album?.cover;
      const imgUrl = cvr
        ? 'https://resources.tidal.com/images/' + cvr.replace(/-/g, '/') + '/640x640.jpg'
        : null;
      return {
        id:       'tidal:' + t.id,
        sourceId: String(t.id),
        isrc:     t.isrc || null,
        title:    cleanTitle(t.title),
        artist:   arts,
        album:    t.album?.title || '',
        duration: t.duration || null,
        cover:    imgUrl,
        year:     t.album?.releaseDate ? String(t.album.releaseDate).slice(0, 4) : null,
        quality:  'AAC 320',
        explicit: t.explicit === true,
      };
    });
    const rawAlb = d?.data?.albums?.items || d?.albums?.items || [];
    const albums = rawAlb.map(a => {
      const cvr = a.cover || a.image;
      const img = cvr ? 'https://resources.tidal.com/images/' + cvr.replace(/-/g, '/') + '/640x640.jpg' : null;
      return {
        id:      'tidal:' + a.id,
        sourceId: String(a.id),
        title:   a.title,
        artist:  a.artist?.name || '',
        year:    a.releaseDate ? String(a.releaseDate).slice(0, 4) : null,
        cover:   img,
      };
    });
    const rawArt = d?.data?.artists?.items || d?.artists?.items || [];
    const artists = rawArt.map(a => ({
      id:      'tidal:' + a.id,
      sourceId: String(a.id),
      name:    a.name,
      cover:   a.picture ? 'https://resources.tidal.com/images/' + a.picture.replace(/-/g, '/') + '/480x480.jpg' : null,
    }));
    return { tracks, albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function searchDeezer(query, limit) {
  try {
    const [td, ald, ard] = await Promise.all([
      httpGet(DEEZER_BASE + '/search', { q: query, limit }, 8000).catch(() => ({ data: [] })),
      httpGet(DEEZER_BASE + '/search/album', { q: query, limit: Math.ceil(limit / 2) }, 8000).catch(() => ({ data: [] })),
      httpGet(DEEZER_BASE + '/search/artist', { q: query, limit: Math.ceil(limit / 2) }, 8000).catch(() => ({ data: [] })),
    ]);
    const tracks = (td.data || []).map(t => ({
      id:       'deezer:' + t.id,
      sourceId: String(t.id),
      isrc:     t.isrc || null,
      title:    cleanTitle(t.title),
      artist:   t.artist?.name || '',
      album:    t.album?.title || '',
      duration: t.duration || null,
      cover:    t.album?.cover_xl || t.album?.cover_medium || null,
      explicit: t.explicit_lyrics === true,
    }));
    const albums = (ald.data || []).map(a => ({
      id:      'deezer:' + a.id,
      sourceId: String(a.id),
      title:   a.title,
      artist:  a.artist?.name || '',
      cover:   a.cover_xl || a.cover_medium || null,
    }));
    const artists = (ard.data || []).map(a => ({
      id:      'deezer:' + a.id,
      sourceId: String(a.id),
      name:    a.name,
      cover:   a.picture_xl || a.picture_medium || null,
    }));
    return { tracks, albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function searchSoundCloud(query, limit, clientId) {
  if (!clientId) return { tracks: [], albums: [], artists: [] };
  try {
    const d = await httpGet('https://api-v2.soundcloud.com/search', { q: query, client_id: clientId, limit }, 8000);
    const tracks = [], albums = [], artists = [];
    for (const item of (d.collection || [])) {
      if (item.kind === 'track') {
        tracks.push({
          id:       'sc:' + item.id,
          sourceId: String(item.id),
          isrc:     null,
          title:    cleanTitle(item.title),
          artist:   item.user?.username || '',
          album:    '',
          duration: item.duration ? Math.round(item.duration / 1000) : null,
          cover:    item.artwork_url?.replace('-large', '-t500x500') || null,
          streamUrl: item.stream_url || null,
        });
      } else if (item.kind === 'playlist' || item.kind === 'album') {
        albums.push({
          id:      'sc:' + item.id,
          sourceId: String(item.id),
          title:   item.title,
          artist:  item.user?.username || '',
          cover:   item.artwork_url?.replace('-large', '-t500x500') || null,
        });
      } else if (item.kind === 'user') {
        artists.push({
          id:      'sc:' + item.id,
          sourceId: String(item.id),
          name:    item.username || item.full_name || '',
          cover:   item.avatar_url?.replace('-large', '-t500x500') || null,
        });
      }
    }
    return { tracks, albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function searchMusicBrainz(query, limit) {
  try {
    const [tr, al, ar] = await Promise.allSettled([
      mbFetch('/recording', { query: query.replace(/"/g, ''), limit }).then(d =>
        (d.recordings || []).map(r => ({
          id:       'mb:' + r.id,
          sourceId: r.id,
          isrc:     r.isrcs?.[0] || null,
          title:    r.title,
          artist:   r['artist-credit']?.[0]?.name || '',
          album:    r.releases?.[0]?.title || '',
          duration: r.length ? Math.round(r.length / 1000) : null,
          cover:    null,
          streamable: false,
        }))
      ).catch(() => []),
      mbFetch('/release', { query: query.replace(/"/g, ''), limit: Math.ceil(limit / 2) }).then(d =>
        (d.releases || []).map(a => ({
          id:      'mb:' + a.id,
          sourceId: a.id,
          title:   a.title,
          artist:  a['artist-credit']?.[0]?.name || '',
          year:    a.date?.slice(0, 4) || null,
          cover:   null,
        }))
      ).catch(() => []),
      mbFetch('/artist', { query: query.replace(/"/g, ''), limit: Math.ceil(limit / 2) }).then(d =>
        (d.artists || []).map(a => ({
          id:      'mb:' + a.id,
          sourceId: a.id,
          name:    a.name,
          cover:   null,
        }))
      ).catch(() => []),
    ]);
    return {
      tracks:  tr.status === 'fulfilled' ? tr.value : [],
      albums:  al.status === 'fulfilled' ? al.value : [],
      artists: ar.status === 'fulfilled' ? ar.value : [],
    };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function searchInternetArchive(query, limit) {
  try {
    const q = encodeURIComponent(query + ' AND mediatype:audio');
    const url = IA_BASE + `/advancedsearch.php?q=${q}&fl=identifier,title,creator,year,mediatype&rows=${limit}&output=json`;
    const d = await httpGet(url, null, 8000);
    const tracks = [], albums = [];
    for (const doc of (d.response?.docs || [])) {
      const title  = Array.isArray(doc.title)   ? doc.title[0]   : doc.title;
      const artist = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator;
      const isAlbum = doc.description?.toLowerCase().includes('album') || !artist;
      if (isAlbum) {
        albums.push({ id: 'ia:' + doc.identifier, sourceId: doc.identifier, title, artist: artist || '', cover: IA_BASE + '/services/img/' + doc.identifier });
      } else {
        tracks.push({ id: 'ia:' + doc.identifier, sourceId: doc.identifier, isrc: null, title, artist: artist || '', album: '', duration: null, cover: IA_BASE + '/services/img/' + doc.identifier });
      }
    }
    return { tracks, albums, artists: [] };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

// ─── Unified search orchestrator ──────────────────────────────────────────────
async function unifiedSearch(query, searchOrder, env, limit) {
  const fmtQuery = formatQuery(query);

  // Fire ALL source searches concurrently for speed
  const sourcePromises = searchOrder.map(async src => {
    let results = { tracks: [], albums: [], artists: [] };
    try {
      switch (src) {
        case S.QOBUZ:    results = await searchQobuz(fmtQuery, limit); break;
        case S.TIDAL:    results = await searchTidal(fmtQuery, limit); break;
        case S.DEEZER:   results = await searchDeezer(fmtQuery, limit); break;
        case S.SOUNDCLOUD: results = await searchSoundCloud(fmtQuery, limit, env?.SOUNDCLOUD_CLIENT_ID); break;
        case S.MUSICBRAINZ: results = await searchMusicBrainz(fmtQuery, Math.min(limit, 10)); break;
        case S.INTERNETARCHIVE: results = await searchInternetArchive(fmtQuery, limit); break;
      }
    } catch {}
    return { source: src, results };
  });

  // Wait for all, then re-order by user's priority before merging
  const settled = await Promise.all(sourcePromises);

  // Build ordered list: source 0 first, then 1, then 2, etc.
  const ordered = searchOrder.map(sid => settled.find(r => r.source === sid)).filter(Boolean);

  return mergeResults(ordered);
}

// ─── Stream resolvers ─────────────────────────────────────────────────────────
async function streamQobuz(trackId, quality) {
  const formatId = ({ hires: 27, lossless: 6, high: 5, mp3: 5 })[quality] || 27;
  const cacheKey = 'stream:qobuz:' + trackId + ':' + formatId;
  const cached   = mGet(cacheKey);
  if (cached) return cached;
  const ts  = Math.floor(Date.now() / 1000);
  const sig = md5('trackgetFileUrlformat_id' + formatId + 'intentstreamtrack_id' + trackId + ts + QOBUZ_SECRET);
  const url = `${QOBUZ_BASE}/track/getFileUrl?app_id=${QOBUZ_APP_ID}&user_auth_token=${QOBUZ_TOKEN}&track_id=${trackId}&format_id=${formatId}&intent=stream&request_ts=${ts}&request_sig=${sig}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error('Qobuz stream HTTP ' + r.status);
  const d = await r.json();
  if (!d?.url) throw new Error('No stream URL from Qobuz for ' + trackId);
  const result = { url: d.url, source: S.QOBUZ, quality: formatId === 27 ? 'Hi-Res FLAC' : formatId === 6 ? 'FLAC' : 'MP3 320' };
  mSet(cacheKey, result, STREAM_TTL);
  return result;
}

async function streamTidal(trackId, quality) {
  const tidalQ = quality === 'hires' ? 'HIRESLOSSLESS' : quality === 'lossless' ? 'LOSSLESS' : 'HIGH';
  const inst   = await getWorkingHiFiInstance();
  const ctrl   = new AbortController();
  const timer  = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${inst}/track/?id=${encodeURIComponent(trackId)}&quality=${tidalQ}`, {
      headers: { 'User-Agent': UA }, signal: ctrl.signal,
    });
    clearTimeout(timer);
    const d = await r.json();
    const b64 = d?.data?.manifest || d?.manifest;
    if (!b64) throw new Error('No manifest');
    const manifest = JSON.parse(atob(b64));
    const streamUrl = manifest?.urls?.[0];
    if (!streamUrl) throw new Error('No URL in manifest');
    return { url: streamUrl, source: S.TIDAL, quality: tidalQ };
  } catch (e) { clearTimeout(timer); throw e; }
}

async function streamDeezer(trackId, arl) {
  if (!arl) throw new Error('Deezer ARL required');
  // Get user data
  const cookieHdr = 'arl=' + arl;
  const step1 = await fetch('https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=null&input=3', {
    method: 'POST', headers: { Cookie: cookieHdr, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!step1.ok) throw new Error('Deezer getUserData failed');
  const userData  = await step1.json();
  const apiToken  = userData.results?.checkForm;
  if (!apiToken) throw new Error('Deezer no token');
  // Get track token
  const step2 = await fetch('https://www.deezer.com/ajax/gw-light.php?method=song.getListData&api_version=1.0&api_token=' + apiToken + '&input=3', {
    method: 'POST', headers: { Cookie: cookieHdr, 'Content-Type': 'application/json' },
    body: JSON.stringify({ song_ids: [parseInt(trackId)] }),
  });
  if (!step2.ok) throw new Error('Deezer getListData failed');
  const td = await step2.json();
  const ti = td.results?.data?.[0];
  if (!ti?.TRACK_TOKEN) throw new Error('Deezer no track token');
  return { url: 'deezer-token://' + ti.TRACK_TOKEN, source: S.DEEZER, quality: 'FLAC', _trackToken: ti.TRACK_TOKEN };
}

async function streamSoundCloud(trackId, clientId) {
  if (!clientId) throw new Error('SoundCloud client ID required');
  const d = await httpGet('https://api-v2.soundcloud.com/tracks/' + trackId, { client_id: clientId }, TIMEOUT_MS);
  const progressive = d.media?.transcodings?.find(t => t.format?.protocol === 'progressive');
  const hls         = d.media?.transcodings?.find(t => t.format?.protocol === 'hls');
  const chosen      = progressive || hls;
  if (!chosen) throw new Error('No transcodings for ' + trackId);
  const sd = await httpGet(chosen.url + '?client_id=' + clientId, null, TIMEOUT_MS);
  return { url: sd.url, source: S.SOUNDCLOUD, quality: 'MP3' };
}

async function streamIA(identifier) {
  const d = await httpGet(IA_BASE + '/metadata/' + identifier, null, TIMEOUT_MS);
  const audio = (d.files || []).find(f => f.name?.match(/\.(flac|mp3|ogg|m4a|wav|aif)$/i));
  if (!audio) throw new Error('No audio file in IA item ' + identifier);
  return { url: IA_BASE + '/download/' + identifier + '/' + audio.name, source: S.INTERNETARCHIVE, quality: 'MP3' };
}

// Try stream from a specific source; returns { url, source, quality } or throws
async function resolveStream(source, trackId, env, quality) {
  const q = quality || 'lossless';
  switch (source) {
    case S.QOBUZ:    return streamQobuz(trackId, q);
    case S.TIDAL:    return streamTidal(trackId, q);
    case S.DEEZER:   return streamDeezer(trackId, env?.DEEZER_ARL);
    case S.SOUNDCLOUD: return streamSoundCloud(trackId, env?.SOUNDCLOUD_CLIENT_ID);
    case S.INTERNETARCHIVE: return streamIA(trackId);
    default: throw new Error('Unknown source: ' + source);
  }
}

// Resolve stream with fallback down the stream priority order
async function resolveStreamWithFallback(source, trackId, streamOrder, env, quality) {
  // Always try the requested source first
  const order = [source, ...streamOrder.filter(s => s !== source)];
  for (const src of order) {
    try {
      const result = await resolveStream(src, trackId, env, quality);
      if (result?.url) return result;
    } catch {}
  }
  return null;
}

// ─── Catalog response builder ─────────────────────────────────────────────────
function buildCatalogMetas(merged) {
  const metas = [];

  // Artists first
  for (const a of merged.artists) {
    metas.push({
      id:          a.id,
      type:        'artist',
      name:        a.name,
      poster:      a.cover || null,
      background:  a.cover || null,
      description: 'Artist · ' + a._source,
    });
  }

  // Albums
  for (const a of merged.albums) {
    metas.push({
      id:          a.id,
      type:        'album',
      name:        a.title,
      poster:      a.cover || null,
      description: [a.artist, a.year].filter(Boolean).join(' · ') + ' · ' + a._source,
    });
  }

  // Tracks
  for (const t of merged.tracks) {
    metas.push({
      id:          t.id,
      type:        'music',
      name:        t.title,
      poster:      t.cover || null,
      description: [t.artist, t.album, t.quality].filter(Boolean).join(' · ') + ' · ' + t._source,
      runtime:     t.duration,
      isrc:        t.isrc || undefined,
    });
  }

  return metas;
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Eclipse All-in-One</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0a0b;color:#e2e2e4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 72px;-webkit-font-smoothing:antialiased}
    .wrap{max-width:580px;width:100%}
    .logo{width:48px;height:48px;background:#1a1a1f;border:1px solid #2a2a32;border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:20px}
    h1{font-size:20px;font-weight:700;color:#fff;letter-spacing:-.02em;margin-bottom:6px}
    .sub{font-size:13px;color:#52525e;line-height:1.65;margin-bottom:28px}
    .card{background:#111115;border:1px solid #1e1e26;border-radius:16px;padding:28px;margin-bottom:16px}
    .card-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#3f3f50;margin-bottom:16px;display:flex;align-items:center;gap:6px}
    .card-title::before{content:'';width:6px;height:6px;border-radius:50%;background:#5b5bf6;flex-shrink:0}
    .lbl{font-size:11px;font-weight:600;color:#3f3f50;margin-bottom:6px;margin-top:14px;text-transform:uppercase;letter-spacing:.06em}
    .lbl:first-child{margin-top:0}
    .hint{font-size:12px;color:#2e2e3a;line-height:1.65;margin-top:4px}
    input,select{width:100%;background:#0d0d11;border:1px solid #1e1e26;border-radius:10px;color:#e2e2e4;font-size:14px;padding:11px 13px;outline:none;appearance:none;transition:border-color .15s;font-family:inherit}
    input:focus,select:focus{border-color:#5b5bf6}
    input::placeholder{color:#2a2a35}
    .source-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px}
    .src-pill{display:flex;align-items:center;gap:8px;background:#0d0d11;border:1px solid #1e1e26;border-radius:10px;padding:9px 12px;cursor:pointer;transition:border-color .15s,background .15s;user-select:none}
    .src-pill.on{background:#0e0e1c;border-color:#5b5bf6}
    .src-pill input[type=checkbox]{display:none}
    .src-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
    .src-name{font-size:13px;font-weight:500;flex:1}
    .src-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 6px;background:#1a1a22;border-radius:999px;color:#3f3f55}
    .ql-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .ql-btn{background:#0d0d11;border:1px solid #1e1e26;border-radius:10px;padding:10px 8px;text-align:center;cursor:pointer;font-size:12px;font-weight:700;color:#42425a;letter-spacing:.04em;transition:all .15s}
    .ql-btn:hover{border-color:#3a3a55;color:#aaa}
    .ql-btn.sel{background:#0e0e1c;border-color:#5b5bf6;color:#a5a5f5}
    .ql-sub{font-size:10px;font-weight:400;opacity:.7;display:block;margin-top:2px}
    button.gen{width:100%;background:#5b5bf6;border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:700;padding:14px;cursor:pointer;margin-top:6px;transition:background .15s,opacity .15s;letter-spacing:-.01em}
    button.gen:hover{background:#4a4ae0}
    button.gen:disabled{opacity:.45;cursor:not-allowed}
    .result{margin-top:14px;display:none;flex-direction:column;gap:8px}
    .result.show{display:flex}
    .url-wrap{background:#0d0d11;border:1px solid #1e1e26;border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px}
    .url-text{flex:1;font-size:12px;color:#52527a;font-family:"SF Mono","Fira Code",monospace;word-break:break-all;line-height:1.5}
    .copy-btn{flex-shrink:0;background:#1a1a22;border:1px solid #2a2a35;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;color:#e2e2e4;cursor:pointer;transition:all .15s}
    .copy-btn:hover{background:#5b5bf6;border-color:#5b5bf6}
    .copy-btn.done{background:#22c55e;border-color:#22c55e;color:#fff}
    .step-note{font-size:12px;color:#2e2e3a;text-align:center}
    footer{margin-top:36px;font-size:11px;color:#1e1e26;text-align:center}
    @media(max-width:440px){.source-grid,.ql-row{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="wrap">
  <div class="logo">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b5bf6" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
      <line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>
      <line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
    </svg>
  </div>
  <h1>Eclipse All-in-One</h1>
  <p class="sub">Priority-ordered multi-source search with strict deduplication. Drag to reorder — Source 1 shows all results first, lower sources only fill in the gaps.</p>

  <div class="card">
    <div class="card-title">Addon Name</div>
    <input type="text" id="addonName" placeholder="My All-in-One" maxlength="40"/>
    <div class="hint">Shown in Eclipse's connection list.</div>
  </div>

  <div class="card">
    <div class="card-title">Search Priority</div>
    <p style="font-size:12px;color:#2e2e3a;margin-bottom:14px;line-height:1.6">Select and order sources. Source 1 fills all results first — the rest only add what's missing (no repeats).</p>
    <div class="source-grid" id="searchSources">
      <label class="src-pill on" data-src="qobuz"><input type="checkbox" checked/><span class="src-dot" style="background:#007cba"></span><span class="src-name">Qobuz</span><span class="src-badge">Hi-Res</span></label>
      <label class="src-pill on" data-src="tidal"><input type="checkbox" checked/><span class="src-dot" style="background:#00ffff"></span><span class="src-name">Tidal</span><span class="src-badge">HiFi</span></label>
      <label class="src-pill on" data-src="deezer"><input type="checkbox" checked/><span class="src-dot" style="background:#ef5466"></span><span class="src-name">Deezer</span><span class="src-badge">HQ</span></label>
      <label class="src-pill" data-src="soundcloud"><input type="checkbox"/><span class="src-dot" style="background:#ff5500"></span><span class="src-name">SoundCloud</span><span class="src-badge">MP3</span></label>
      <label class="src-pill" data-src="musicbrainz"><input type="checkbox"/><span class="src-dot" style="background:#ba478f"></span><span class="src-name">MusicBrainz</span><span class="src-badge">Meta</span></label>
      <label class="src-pill" data-src="internetarchive"><input type="checkbox"/><span class="src-dot" style="background:#428bca"></span><span class="src-name">Internet Archive</span><span class="src-badge">Free</span></label>
    </div>
    <div class="hint" style="margin-top:6px">Order reflects priority 1→6 left-to-right, top-to-bottom.</div>
  </div>

  <div class="card">
    <div class="card-title">Stream Priority</div>
    <div class="source-grid" id="streamSources">
      <label class="src-pill on" data-src="qobuz"><input type="checkbox" checked/><span class="src-dot" style="background:#007cba"></span><span class="src-name">Qobuz</span><span class="src-badge">Hi-Res</span></label>
      <label class="src-pill on" data-src="tidal"><input type="checkbox" checked/><span class="src-dot" style="background:#00ffff"></span><span class="src-name">Tidal</span><span class="src-badge">HiFi</span></label>
      <label class="src-pill on" data-src="deezer"><input type="checkbox" checked/><span class="src-dot" style="background:#ef5466"></span><span class="src-name">Deezer</span><span class="src-badge">HQ</span></label>
      <label class="src-pill" data-src="soundcloud"><input type="checkbox"/><span class="src-dot" style="background:#ff5500"></span><span class="src-name">SoundCloud</span><span class="src-badge">MP3</span></label>
      <label class="src-pill" data-src="internetarchive"><input type="checkbox"/><span class="src-dot" style="background:#428bca"></span><span class="src-name">Internet Archive</span><span class="src-badge">Free</span></label>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Playback Quality</div>
    <div class="ql-row">
      <div class="ql-btn" id="q-hires" onclick="selQ('hires')">Hi-Res FLAC<span class="ql-sub">24-bit/192kHz</span></div>
      <div class="ql-btn sel" id="q-lossless" onclick="selQ('lossless')">Lossless FLAC<span class="ql-sub">16-bit/44.1kHz</span></div>
      <div class="ql-btn" id="q-high" onclick="selQ('high')">High<span class="ql-sub">AAC 320 / MP3</span></div>
      <div class="ql-btn" id="q-mp3" onclick="selQ('mp3')">MP3<span class="ql-sub">320kbps</span></div>
    </div>
  </div>

  <button class="gen" id="genBtn" onclick="generate()">Generate Addon URL</button>

  <div class="result" id="resultBox">
    <div class="url-wrap">
      <span class="url-text" id="urlText"></span>
      <button class="copy-btn" id="copyBtn" onclick="copyUrl()">Copy</button>
    </div>
    <p class="step-note">Eclipse → Settings → Connections → Add Connection → Addon → Paste URL</p>
  </div>
</div>

<footer>Eclipse All-in-One v${VERSION}</footer>

<script>
  var _q='lossless', _genUrl=null;
  function selQ(q){_q=q;['hires','lossless','high','mp3'].forEach(function(k){document.getElementById('q-'+k).classList.toggle('sel',k===q)});}
  function getSources(containerId){var pills=document.querySelectorAll('#'+containerId+' .src-pill');var out=[];pills.forEach(function(p){if(p.querySelector('input').checked)out.push(p.dataset.src)});return out;}
  function generate(){
    var btn=document.getElementById('genBtn');btn.disabled=true;btn.textContent='Generating…';
    var name=document.getElementById('addonName').value.trim();
    var ss=getSources('searchSources');var st=getSources('streamSources');
    if(!ss.length){alert('Select at least one search source.');btn.disabled=false;btn.textContent='Generate Addon URL';return;}
    fetch('/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({addonName:name||null,quality:_q,searchSources:ss,streamSources:st})})
      .then(function(r){return r.json()}).then(function(d){
        if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Generate Addon URL';return;}
        _genUrl=d.manifestUrl;
        document.getElementById('urlText').textContent=_genUrl;
        document.getElementById('resultBox').classList.add('show');
        document.getElementById('copyBtn').textContent='Copy';
        btn.disabled=false;btn.textContent='Generate Another URL';
      }).catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Generate Addon URL';});
  }
  function copyUrl(){
    if(!_genUrl)return;
    try{navigator.clipboard.writeText(_genUrl)}catch(_){var ta=document.createElement('textarea');ta.value=_genUrl;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}
    var b=document.getElementById('copyBtn');b.textContent='Copied!';b.classList.add('done');setTimeout(function(){b.textContent='Copy';b.classList.remove('done');},2000);
  }
  // Toggle pill style on click
  document.querySelectorAll('.src-pill').forEach(function(p){
    p.addEventListener('click',function(){
      var cb=p.querySelector('input');cb.checked=!cb.checked;p.classList.toggle('on',cb.checked);
    });
  });
</script>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', c => new Response(buildConfigPage(
  (c.req.header('x-forwarded-proto') || 'https') + '://' + c.req.header('host')
), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));

// Generate token
app.post('/generate', async c => {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  if (!checkIpGenerateRate(ip)) return rateLimitResp('Too many requests. Try again in an hour.');
  let body = {};
  try { body = await c.req.json(); } catch {}
  const quality       = body?.quality        || 'lossless';
  const addonName     = body?.addonName ? String(body.addonName).trim().slice(0, 40) : null;
  const searchSources = Array.isArray(body?.searchSources) ? body.searchSources.filter(s => Object.values(S).includes(s)) : DEFAULT_SEARCH_ORDER;
  const streamSources = Array.isArray(body?.streamSources) ? body.streamSources.filter(s => Object.values(S).includes(s)) : DEFAULT_STREAM_ORDER;
  const token = generateToken();
  saveToken(token, { quality, addonName, searchSources, streamSources, createdAt: Date.now() });
  const base = (c.req.header('x-forwarded-proto') || 'https') + '://' + c.req.header('host');
  const seg  = buildTokenSegment(token, addonName);
  return c.json({ token, manifestUrl: base + '/u/' + seg + '/manifest.json' });
});

// Manifest
app.get('/u/:token/manifest.json', c => {
  const { token, embeddedName } = parseTokenParam(c.req.param('token'));
  let stored = loadToken(token);
  if (!stored) { stored = { quality: 'lossless', searchSources: DEFAULT_SEARCH_ORDER, streamSources: DEFAULT_STREAM_ORDER }; saveToken(token, stored); }
  const displayName = embeddedName || stored.addonName || 'Eclipse All-in-One';
  const sourceDesc  = (stored.searchSources || DEFAULT_SEARCH_ORDER).join(', ');
  return c.json({
    id:          'com.eclipse.allinone.' + token.slice(0, 8),
    name:        displayName,
    version:     VERSION,
    description: 'Priority-ordered multi-source search · Sources: ' + sourceDesc,
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist'],
    catalogs: [
      { id: 'aio-music', type: 'music', name: displayName, extra: [{ name: 'search', isRequired: true }] },
    ],
    behaviorHints: { configurable: false },
  });
});

// Catalog search (Eclipse calls: /catalog/music/aio-music/search=QUERY.json)
app.get('/u/:token/catalog/:type/:catalogId/:extra.json', async c => {
  const { token }  = parseTokenParam(c.req.param('token'));
  const extra      = c.req.param('extra') || '';
  const queryMatch = extra.match(/^search=(.+)$/);
  const query      = queryMatch ? decodeURIComponent(queryMatch[1]) : (c.req.query('search') || '').trim();

  if (!query) return c.json({ metas: [] });
  if (!consumeGlobalBudget())          return rateLimitResp('Daily request limit reached.');
  if (!checkTokenRate(token, 'search')) return rateLimitResp('Search rate limit exceeded.');

  const stored = loadToken(token) || { quality: 'lossless', searchSources: DEFAULT_SEARCH_ORDER, streamSources: DEFAULT_STREAM_ORDER };
  const limit  = 20;

  const merged = await unifiedSearch(query, stored.searchSources || DEFAULT_SEARCH_ORDER, c.env, limit);
  return c.json({ metas: buildCatalogMetas(merged) });
});

// Also handle simpler /catalog/ shape that some clients use
app.get('/u/:token/catalog/:type/:catalogId.json', async c => {
  const { token }  = parseTokenParam(c.req.param('token'));
  const query      = (c.req.query('search') || c.req.query('q') || '').trim();
  if (!query) return c.json({ metas: [] });
  if (!consumeGlobalBudget())          return rateLimitResp('Daily request limit reached.');
  if (!checkTokenRate(token, 'search')) return rateLimitResp('Search rate limit exceeded.');
  const stored = loadToken(token) || { quality: 'lossless', searchSources: DEFAULT_SEARCH_ORDER, streamSources: DEFAULT_STREAM_ORDER };
  const merged = await unifiedSearch(query, stored.searchSources || DEFAULT_SEARCH_ORDER, c.env, 20);
  return c.json({ metas: buildCatalogMetas(merged) });
});

// Stream
app.get('/u/:token/stream/:type/:id.json', async c => {
  const { token }  = parseTokenParam(c.req.param('token'));
  const id         = c.req.param('id');
  if (!consumeGlobalBudget())           return rateLimitResp('Daily request limit reached.');
  if (!checkTokenRate(token, 'stream')) return rateLimitResp('Stream rate limit exceeded.');
  const stored = loadToken(token) || { quality: 'lossless', streamSources: DEFAULT_STREAM_ORDER };

  // Parse source and trackId from prefixed id (e.g. "qobuz:12345", "tidal:67890")
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) return c.json({ streams: [] });
  const source  = id.slice(0, colonIdx);
  const trackId = id.slice(colonIdx + 1);

  const result = await resolveStreamWithFallback(source, trackId, stored.streamSources || DEFAULT_STREAM_ORDER, c.env, stored.quality);
  if (!result?.url) return c.json({ streams: [] });

  return c.json({
    streams: [{
      url:   result.url,
      title: result.quality + ' · ' + result.source,
      behaviorHints: { notWebReady: false },
    }],
  });
});

// Meta (minimal — Eclipse uses this to get track/album detail)
app.get('/u/:token/meta/:type/:id.json', async c => {
  return c.json({ meta: {} });
});

// Health
app.get('/health', async c => {
  const inst = await getWorkingHiFiInstance().catch(() => null);
  return c.json({ status: inst ? 'ok' : 'degraded', hifi: inst, version: VERSION });
});

// Legacy flat manifest (no token)
app.get('/manifest.json', c => c.json({
  id: 'com.eclipse.allinone', name: 'Eclipse All-in-One', version: VERSION,
  description: 'Multi-source music search with priority dedup',
  resources: ['catalog', 'stream', 'search'], types: ['track', 'album', 'artist'],
  catalogs: [{ id: 'aio-music', type: 'music', name: 'Eclipse All-in-One', extra: [{ name: 'search', isRequired: true }] }],
}));

export default app;
