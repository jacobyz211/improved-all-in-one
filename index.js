/**
 * Eclipse Universal Addon
 * Sources (in priority order):
 *   MUSIC:    HiFi instances → SoundCloud → Internet Archive
 *   PODCASTS: Podcast Index → Taddy → Apple Podcasts
 *   AUDIOBOOKS: LibriVox → Internet Archive
 *   RADIO:    Radio Browser
 *
 * All API keys are optional and passed via query string when installing:
 *   https://your-addon.vercel.app/{token}/manifest.json
 *
 * Token format (base64url of JSON):
 *   { hifi, sc, pi_key, pi_secret, taddy_key, taddy_uid }
 */

import { Hono } from 'hono';

// ─── safeYear: always returns Int for Android JSON parser ─────────────────────
function safeYear(val) {
  if (val === null || val === undefined || val === '' || val === 0) return 0;
  const n = parseInt(String(val).replace(/[^0-9]/g, '').slice(0, 4), 10);
  return (isNaN(n) || n < 1000 || n > 2100) ? 0 : n;
}



const app = new Hono();

const memCache = new Map();
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const textHeaders = { 'content-type': 'text/html; charset=utf-8' };


async function cacheGet(key) {
  const v = memCache.get(key);
  if (!v) return null;
  if (v.exp && v.exp < Date.now()) { memCache.delete(key); return null; }
  return v.value;
}

async function cacheSet(key, value, ttl = 300) {
  memCache.set(key, { value, exp: Date.now() + ttl * 1000 });
}

// ─── Inflight deduplication ───────────────────────────────────────────────────
// Two simultaneous requests for the same stream share ONE outbound call.
const _inflight = new Map();
async function dedupeCall(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}


// ─── Axios-compatible fetch shim (Workers-safe) ──────────────────────────────
function buildUrl(url, params) {
  if (!params || Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

const axios = {
  get: async (url, config = {}) => {
    const fullUrl = buildUrl(url, config.params);
    const ctrl = new AbortController();
    const timer = config.timeout ? setTimeout(() => ctrl.abort(), config.timeout) : null;
    try {
      const res = await fetch(fullUrl, {
        method: 'GET',
        headers: config.headers || {},
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      const ct = res.headers.get('content-type') || '';
      let data = text;
      if (ct.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        const err = new Error(`Request failed with status ${res.status}`);
        err.response = { status: res.status, data, headers: res.headers };
        throw err;
      }
      return { status: res.status, data, headers: res.headers };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  post: async (url, body, config = {}) => {
    const ctrl = new AbortController();
    const timer = config.timeout ? setTimeout(() => ctrl.abort(), config.timeout) : null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.headers || {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { data = text; }
      if (!res.ok) {
        const err = new Error(`Request failed with status ${res.status}`);
        err.response = { status: res.status, data, headers: res.headers };
        throw err;
      }
      return { status: res.status, data, headers: res.headers };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};

// ─── Token / Config Parsing ──────────────────────────────────────────────────
function parseToken(tokenStr) {
  if (!tokenStr || tokenStr === 'noop') return {};
  try {
    const json = decodeBase64Url(tokenStr);
    return JSON.parse(json);
  } catch {
    try {
      const json = decodeBase64(tokenStr);
      return JSON.parse(json);
    } catch { return {}; }
  }
}


function decodeBase64Url(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4 || 4)) % 4);
  return atob(padded);
}

function decodeBase64(str) {
  return atob(String(str || ''));
}

function encodeBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function upstashCmd(env, ...args) {
  if (!env?.UPSTASH_REDIS_REST_URL || !env?.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const cmd = args[0]?.toUpperCase();
    if (cmd === 'MSET') {
      const pairs = args.slice(1);
      const pipeline = [];
      for (let i = 0; i < pairs.length; i += 2) {
        pipeline.push(['SET', pairs[i], pairs[i + 1], 'EX', '3600']);
      }
      const r = await fetch(env.UPSTASH_REDIS_REST_URL + '/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(pipeline),
      });
      return r.ok ? 'OK' : null;
    }
    const r = await fetch(env.UPSTASH_REDIS_REST_URL + '/' + args.map(encodeURIComponent).join('/'), {
      headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ?? null;
  } catch { return null; }
}

function getConfig(c) {
  const token = c.req.param('token') || '';
  const cfg = parseToken(token);
  const VALID_QUALITIES = ['LOSSLESS', 'HIGH', 'LOW'];
  return {
    hifiInstances: cfg.hifi
      ? cfg.hifi.split(',').map(u => u.trim()).filter(Boolean)
      : (c.env.HIFI_INSTANCES
          ? c.env.HIFI_INSTANCES.split(',').map(u => u.trim()).filter(Boolean)
          : []),
    scClientId: cfg.sc || c.env.SC_CLIENT_ID || null,
    piKey: cfg.pi_key || c.env.PI_KEY || null,
    piSecret: cfg.pi_secret || c.env.PI_SECRET || null,
    taddyKey: cfg.taddy_key || c.env.TADDY_KEY || null,
    taddyUid: cfg.taddy_uid || c.env.TADDY_UID || null,
    preferredQuality: VALID_QUALITIES.includes(cfg.q) ? cfg.q : null,
    // Source flags — undefined/missing means "enabled" (backward-compatible)
    noHifi:      !!(cfg.no_hifi      === true || cfg.no_hifi      === 1 || cfg.no_hifi      === "true"),
    noSc:        !!(cfg.no_sc        === true || cfg.no_sc        === 1 || cfg.no_sc        === "true"),
    noIa:        !!(cfg.no_ia        === true || cfg.no_ia        === 1 || cfg.no_ia        === "true"),
    noQobuz:     !!(cfg.no_qobuz     === true || cfg.no_qobuz     === 1 || cfg.no_qobuz     === "true"),
    noPodcast:   !!(cfg.no_podcast   === true || cfg.no_podcast   === 1 || cfg.no_podcast   === "true"),
    noAudiobook: !!(cfg.no_audiobook === true || cfg.no_audiobook === 1 || cfg.no_audiobook === "true"),
    noRadio:     !!(cfg.no_radio     === true || cfg.no_radio     === 1 || cfg.no_radio     === "true"),
    noDeezer:    !!(cfg.no_deezer    === true || cfg.no_deezer    === 1 || cfg.no_deezer    === "true"),
    // Ordered priority arrays for search/stream (empty = all enabled, default order)
    searchOrder: Array.isArray(cfg.search_order) ? cfg.search_order : [],
    streamOrder: Array.isArray(cfg.stream_order) ? cfg.stream_order : [],
  };
}

// ─── SoundCloud Client ID Auto-Discovery ─────────────────────────────────────
let _scClientIdCache = null;
let _scClientIdExpiry = 0;

async function getSCClientId(providedId) {
  if (providedId) return providedId;
  if (_scClientIdCache && Date.now() < _scClientIdExpiry) return _scClientIdCache;
  const cached = await cacheGet('sc:client_id');
  if (cached) {
    _scClientIdCache = cached;
    _scClientIdExpiry = Date.now() + 3600000;
    return cached;
  }
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' };
    const page = await axios.get('https://soundcloud.com', { headers, timeout: 8000 });
    const scriptUrls = [...new Set((page.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g) || []))];
    for (const url of scriptUrls.slice(-5).reverse()) {
      try {
        const js = await axios.get(url, { headers, timeout: 5000 });
        const m = js.data.match(/client_id[:"'\s=]+([a-zA-Z0-9]{32})/);
        if (m) {
          _scClientIdCache = m[1];
          _scClientIdExpiry = Date.now() + 3600000;
          await cacheSet('sc:client_id', m[1], 3600);
          console.log('[SC] Auto-discovered client_id:', m[1].slice(0, 8) + '...');
          return m[1];
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[SC] client_id discovery failed:', e.message);
  }
  return null;
}

// ─── HiFi Instance Helpers ───────────────────────────────────────────────────
const DEFAULT_HIFI_INSTANCES = [
  'https://hifi-api-workers.anothermoumen4.workers.dev',
  'https://hifi-api-bffw.onrender.com',
  'https://hifi-api-pj08.onrender.com',
  'https://hifi-api.kennyy.com.br',
  'https://hifi-api6.spotisaver.net',
  'https://tidal-api.binimum.org',
  'https://triton.squid.wtf',
  'https://ohio-1.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://vogel.qqdl.site',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://hifi.geeked.wtf',
  'https://monochrome-api.samidy.com',
  'https://hifi-two.spotisaver.net',
  'https://wolf.qqdl.site',
  'https://katze.qqdl.site',
  'https://hund.qqdl.site',
  'https://api.monochrome.tf',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

const QOBUZ_INSTANCES = [
  'https://qobuz-api1.onrender.com',
  'https://trypt-hifi-dl-456461932686.us-west1.run.app',
  'https://qobuz-api.stremio123.duckdns.org',
  'https://qobuz.kennyy.com.br/api',
];

// ─── Qobuz Native Stream Credentials ────────────────────────────────────────
const QOBUZ_APP_ID     = '312369995';
const QOBUZ_USER_TOKEN = 'XX7seyZt4OaHGPgksFUldL2Ig0cH6jqcKSAfOAiAGBzw1HosDl9vfQTGRQEo2zkkcwP9ADc3L20nYNaI0l7E4g';
const QOBUZ_SECRET     = 'e79f8b9be485692b0e5f9dd895826368';

// ─── Compact MD5 (Qobuz request signature) ───────────────────────────────────
function md5(str) {
  function RL(v,n){return(v<<n)|(v>>>(32-n));}
  function AU(x,y){const x8=(x&0x80000000),y8=(y&0x80000000),x4=(x&0x40000000),y4=(y&0x40000000),r=(x&0x3FFFFFFF)+(y&0x3FFFFFFF);if(x4&y4)return(r^0x80000000^x8^y8);if(x4|y4){if(r&0x40000000)return(r^0xC0000000^x8^y8);return(r^0x40000000^x8^y8);}return(r^x8^y8);}
  function F(x,y,z){return(x&y)|((~x)&z);}function G(x,y,z){return(x&z)|(y&(~z));}function H(x,y,z){return x^y^z;}function I(x,y,z){return y^(x|(~z));}
  function FF(a,b,c,d,x,s,ac){a=AU(a,AU(AU(F(b,c,d),x),ac));return AU(RL(a,s),b);}
  function GG(a,b,c,d,x,s,ac){a=AU(a,AU(AU(G(b,c,d),x),ac));return AU(RL(a,s),b);}
  function HH(a,b,c,d,x,s,ac){a=AU(a,AU(AU(H(b,c,d),x),ac));return AU(RL(a,s),b);}
  function II(a,b,c,d,x,s,ac){a=AU(a,AU(AU(I(b,c,d),x),ac));return AU(RL(a,s),b);}
  function CW(s){const ml=s.length,nw_t1=ml+8,nw_t2=(nw_t1-(nw_t1%64))/64,nw=(nw_t2+1)*16,wa=Array(nw-1);let bp=0,bc=0;while(bc<ml){const wc=(bc-(bc%4))/4,pos=(bc%4)*8;wa[wc]=(wa[wc]|(s.charCodeAt(bc)<<pos));bc++;}const wc2=(bc-(bc%4))/4;wa[wc2]=(wa[wc2]|(0x80<<((bc%4)*8)));wa[nw-2]=ml<<3;wa[nw-1]=ml>>>29;return wa;}
  function WH(v){let r='',t='',byte,c;for(c=0;c<=3;c++){byte=(v>>>(c*8))&255;t='0'+byte.toString(16);r+=t.substr(t.length-2,2);}return r;}
  const x=CW(str);let k,a=0x67452301,b=0xEFCDAB89,c2=0x98BADCFE,d=0x10325476,AA,BB,CC,DD;
  const S11=7,S12=12,S13=17,S14=22,S21=5,S22=9,S23=14,S24=20,S31=4,S32=11,S33=16,S34=23,S41=6,S42=10,S43=15,S44=21;
  for(k=0;k<x.length;k+=16){AA=a;BB=b;CC=c2;DD=d;a=FF(a,b,c2,d,x[k],S11,0xD76AA478);d=FF(d,a,b,c2,x[k+1],S12,0xE8C7B756);c2=FF(c2,d,a,b,x[k+2],S13,0x242070DB);b=FF(b,c2,d,a,x[k+3],S14,0xC1BDCEEE);a=FF(a,b,c2,d,x[k+4],S11,0xF57C0FAF);d=FF(d,a,b,c2,x[k+5],S12,0x4787C62A);c2=FF(c2,d,a,b,x[k+6],S13,0xA8304613);b=FF(b,c2,d,a,x[k+7],S14,0xFD469501);a=FF(a,b,c2,d,x[k+8],S11,0x698098D8);d=FF(d,a,b,c2,x[k+9],S12,0x8B44F7AF);c2=FF(c2,d,a,b,x[k+10],S13,0xFFFF5BB1);b=FF(b,c2,d,a,x[k+11],S14,0x895CD7BE);a=FF(a,b,c2,d,x[k+12],S11,0x6B901122);d=FF(d,a,b,c2,x[k+13],S12,0xFD987193);c2=FF(c2,d,a,b,x[k+14],S13,0xA679438E);b=FF(b,c2,d,a,x[k+15],S14,0x49B40821);a=GG(a,b,c2,d,x[k+1],S21,0xF61E2562);d=GG(d,a,b,c2,x[k+6],S22,0xC040B340);c2=GG(c2,d,a,b,x[k+11],S23,0x265E5A51);b=GG(b,c2,d,a,x[k],S24,0xE9B6C7AA);a=GG(a,b,c2,d,x[k+5],S21,0xD62F105D);d=GG(d,a,b,c2,x[k+10],S22,0x02441453);c2=GG(c2,d,a,b,x[k+15],S23,0xD8A1E681);b=GG(b,c2,d,a,x[k+4],S24,0xE7D3FBC8);a=GG(a,b,c2,d,x[k+9],S21,0x21E1CDE6);d=GG(d,a,b,c2,x[k+14],S22,0xC33707D6);c2=GG(c2,d,a,b,x[k+3],S23,0xF4D50D87);b=GG(b,c2,d,a,x[k+8],S24,0x455A14ED);a=GG(a,b,c2,d,x[k+13],S21,0xA9E3E905);d=GG(d,a,b,c2,x[k+2],S22,0xFCEFA3F8);c2=GG(c2,d,a,b,x[k+7],S23,0x676F02D9);b=GG(b,c2,d,a,x[k+12],S24,0x8D2A4C8A);a=HH(a,b,c2,d,x[k+5],S31,0xFFFA3942);d=HH(d,a,b,c2,x[k+8],S32,0x8771F681);c2=HH(c2,d,a,b,x[k+11],S33,0x6D9D6122);b=HH(b,c2,d,a,x[k+14],S34,0xFDE5380C);a=HH(a,b,c2,d,x[k+1],S31,0xA4BEEA44);d=HH(d,a,b,c2,x[k+4],S32,0x4BDECFA9);c2=HH(c2,d,a,b,x[k+7],S33,0xF6BB4B60);b=HH(b,c2,d,a,x[k+10],S34,0xBEBFBC70);a=HH(a,b,c2,d,x[k+13],S31,0x289B7EC6);d=HH(d,a,b,c2,x[k],S32,0xEAA127FA);c2=HH(c2,d,a,b,x[k+3],S33,0xD4EF3085);b=HH(b,c2,d,a,x[k+6],S34,0x04881D05);a=HH(a,b,c2,d,x[k+9],S31,0xD9D4D039);d=HH(d,a,b,c2,x[k+12],S32,0xE6DB99E5);c2=HH(c2,d,a,b,x[k+15],S33,0x1FA27CF8);b=HH(b,c2,d,a,x[k+2],S34,0xC4AC5665);a=II(a,b,c2,d,x[k],S41,0xF4292244);d=II(d,a,b,c2,x[k+7],S42,0x432AFF97);c2=II(c2,d,a,b,x[k+14],S43,0xAB9423A7);b=II(b,c2,d,a,x[k+5],S44,0xFC93A039);a=II(a,b,c2,d,x[k+12],S41,0x655B59C3);d=II(d,a,b,c2,x[k+3],S42,0x8F0CCC92);c2=II(c2,d,a,b,x[k+10],S43,0xFFEFF47D);b=II(b,c2,d,a,x[k+1],S44,0x85845DD1);a=II(a,b,c2,d,x[k+8],S41,0x6FA87E4F);d=II(d,a,b,c2,x[k+15],S42,0xFE2CE6E0);c2=II(c2,d,a,b,x[k+6],S43,0xA3014314);b=II(b,c2,d,a,x[k+13],S44,0x4E0811A1);a=II(a,b,c2,d,x[k+4],S41,0xF7537E82);d=II(d,a,b,c2,x[k+11],S42,0xBD3AF235);c2=II(c2,d,a,b,x[k+2],S43,0x2AD7D2BB);b=II(b,c2,d,a,x[k+9],S44,0xEB86D391);a=AU(a,AA);b=AU(b,BB);c2=AU(c2,CC);d=AU(d,DD);}
  return (WH(a)+WH(b)+WH(c2)+WH(d)).toLowerCase();
}

// ─── ISRC Scoring Engine (ported from qobuz-tidal-eclipse) ───────────────────
function normalizeStr(s) {
  return String(s||'').toLowerCase()
    .replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e').replace(/[ìíîï]/g,'i')
    .replace(/[òóôõö]/g,'o').replace(/[ùúûü]/g,'u').replace(/[ý]/g,'y')
    .replace(/[ñ]/g,'n').replace(/[ç]/g,'c')
    .replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}
const FEAT_RE_ISRC = /\s*(\(|\[)?\s*(feat\.?|ft\.?|featuring)\s+[^\)\]]*\s*(\)|\])?/gi;
function removeFeat(s) { return String(s||'').replace(FEAT_RE_ISRC,'').trim(); }
function isrcCleanTitle(t) { return t ? removeFeat(t) : 'Unknown'; }
function isrcFormatQuery(q) {
  q = q.replace(/['\u2018\u2019\u0060\u00B4]/g,"'").replace(/[\u201C\u201D\u00AB\u00BB]/g,'"');
  q = removeFeat(q);
  if (/ - /.test(q)) { return q.split(' - ').map(p=>removeFeat(p.trim())).join(' - '); }
  return removeFeat(q);
}
function isrcFindBestMatch(items, query, expectedDuration) {
  let bestItem=null, bestScore=-1;
  const qNorm=normalizeStr(query);
  const hasHyphen=/ - /.test(qNorm);
  const qWords=qNorm.replace(/[^a-z0-9\s]/gi,' ').split(/\s+/).filter(w=>w.length>1);
  let qLeft=qNorm, qRight='';
  if (hasHyphen){const parts=qNorm.split(' - ').map(p=>p.trim());qLeft=parts[0];qRight=parts[1]||'';}
  for(let i=0;i<Math.min(items.length,50);i++){
    const t=items[i];
    const tTitle=normalizeStr(isrcCleanTitle(t.title||''));
    const tArtist=normalizeStr(t.performer?.name||t.artist?.name||t.artists?.[0]?.name||'');
    let score=0;
    const thits=qWords.filter(w=>tTitle.includes(w)).length;
    const ahits=qWords.filter(w=>tArtist.includes(w)).length;
    score+=thits*15+ahits*8;
    const cov=qWords.filter(w=>tTitle.includes(w)||tArtist.includes(w)).length;
    if(cov===qWords.length&&qWords.length>0)score+=50;
    let tm=false,am=false;
    if(hasHyphen){
      if(qLeft&&(tTitle===qLeft||tTitle.includes(qLeft)||qLeft.includes(tTitle)))tm=true;
      if(qRight&&(tTitle===qRight||tTitle.includes(qRight)||qRight.includes(tTitle)))tm=true;
      if(qLeft&&(tArtist===qLeft||tArtist.includes(qLeft)||qLeft.includes(tArtist)))am=true;
      if(qRight&&(tArtist===qRight||tArtist.includes(qRight)||qRight.includes(tArtist)))am=true;
    }else{
      if(tTitle&&thits>0&&(qNorm===tTitle||tTitle.includes(qNorm)||qNorm.includes(tTitle)))tm=true;
      if(tTitle&&tTitle===qNorm)tm=true;
      if(tArtist&&(qNorm===tArtist||tArtist.includes(qNorm)||qNorm.includes(tArtist)))am=true;
    }
    if(tm)score+=35;if(am)score+=25;if(tm&&am)score+=80;
    if(tTitle===qNorm||(hasHyphen&&(tTitle===qLeft||tTitle===qRight)))score+=60;
    if(!hasHyphen&&thits===0&&ahits>0)score-=90;
    if(!hasHyphen&&thits===0&&qWords.length>=2)score-=40;
    if(!hasHyphen&&thits===0&&qWords.length>=1)score=-9999; // FIX: zero title-word hits = hard reject (prevents wrong-track like Embers)
    if(!/\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(qNorm)&&
       /\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(t.title||''))score-=500;
    if(!/\b(live|remix|version|edit|mix)\b/i.test(qNorm)&&
       /\b(live|remix|version|edit|mix)\b/i.test(t.title||''))score-=50;
    if (expectedDuration && expectedDuration > 10) {
      const tDur = t.duration || 0;
      if (tDur > 10) {
        const diff = Math.abs(tDur - expectedDuration);
        if (diff > 45) score -= 300;
        else if (diff > 20) score -= 80;
      }
    }
    if(score>bestScore){bestScore=score;bestItem=t;}
  }
  return {item:bestItem,score:bestScore};
}

// ─── Native Qobuz Stream ──────────────────────────────────────────────────────
// Calls qobuz.com directly with a signed MD5 request. No proxy needed.
// Falls back to proxy instances in qobuzStream() if this throws.
async function qobuzNativeStream(trackId, formatId, env) {
  const appId     = (env&&env.QOBUZ_APP_ID)     || QOBUZ_APP_ID;
  const userToken = (env&&env.QOBUZ_USER_TOKEN)  || QOBUZ_USER_TOKEN;
  const secret    = (env&&env.QOBUZ_SECRET)      || QOBUZ_SECRET;
  const cacheKey  = 'qnative:' + trackId + ':' + formatId;
  const cached    = await cacheGet(cacheKey);
  if (cached) return cached;
  const ts  = Math.floor(Date.now()/1000);
  const sig = md5('trackgetFileUrlformat_id'+formatId+'intentstreamtrack_id'+trackId+ts+secret);
  const url = 'https://www.qobuz.com/api.json/0.2/track/getFileUrl' +
    '?app_id='+appId+'&user_auth_token='+userToken+
    '&track_id='+trackId+'&format_id='+formatId+
    '&intent=stream&request_ts='+ts+'&request_sig='+sig;
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),10000);
  try {
    const r=await fetch(url,{headers:{'User-Agent':UA},signal:ctrl.signal});
    clearTimeout(timer);
    if(!r.ok){try{await r.arrayBuffer();}catch{}throw new Error('Qobuz native HTTP '+r.status);}
    const data=await r.json();
    if(!data?.url)throw new Error('No URL in native Qobuz response for '+trackId);
    const fmt=formatId===5?'mp3':'flac';
    const qual=formatId===5?'320kbps':formatId===6?'lossless':formatId===7?'hires-96':'hires-192';
    const result={url:data.url,format:fmt,quality:qual,source:'qobuz-native',expiresAt:Math.floor(Date.now()/1000)+1680};
    await cacheSet(cacheKey,result,1680);
    return result;
  } catch(e){clearTimeout(timer);throw e;}
}


async function getWorkingHiFiInstance(instances) {
  const list = (instances && instances.length) ? instances : DEFAULT_HIFI_INSTANCES;
  const cacheKey = 'hifi:working:' + list[0];
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const results = await Promise.allSettled(list.map(async inst => {
    const r = await axios.get(`${inst}/search/`, {
      params: { s: 'test', limit: 1 },
      headers: { 'User-Agent': UA },
      timeout: 4000,
    });
    const isJson = typeof r.data === 'object' && r.data !== null;
    if (r.status === 200 && isJson) return inst;
    return null;
  }));
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      await cacheSet(cacheKey, r.value, 300); // cache 300s — prevent repeated health blasts
      return r.value;
    }
  }
  return null;
}


// ─── Qobuz client (via proxy — multi-instance, parallel, cached) ──────────────
// QOBUZ_INSTANCES: tries both proxies in parallel, picks best quality winner.
// qobuzStream:         stream URLs cached 28 min (proxies expire them at 30 min).
// qobuzFindBestTrack:  search results cached 1 h; negative results cached 30 min.

async function qobuzStream(trackId, env) {
  const cacheKey = 'qstream:' + trackId;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  if (env) {
    try {
      const _ur = await upstashCmd(env, 'GET', cacheKey);
      if (_ur) { const _up = JSON.parse(_ur); cacheSet(cacheKey, _up, 700); return _up; }
    } catch(e) {}
  }

  const fmtOrder   = [27, 7, 6, 5];
  const fmtQuality = { 27: 'hires-192', 7: 'hires-96', 6: 'lossless', 5: '320kbps' };
  const fmtLabel   = { 27: 'flac', 7: 'flac', 6: 'flac', 5: 'mp3' };

  // ── Path 1: Native Qobuz direct stream (signed MD5, no proxy) ────────────
  for (const fmt of fmtOrder) {
    try {
      const native = await qobuzNativeStream(trackId, fmt, env);
      if (native && native.url) {
        await cacheSet(cacheKey, native, 1680);
        if (env) upstashCmd(env, 'SET', cacheKey, JSON.stringify(native), 'EX', 720).catch(()=>{});
        return native;
      }
    } catch(e) {
      // 401/403 = token expired — stop trying native, fall through to proxy
      if (e.message && (e.message.includes('401') || e.message.includes('403'))) break;
    }
  }

  // ── Path 2: Proxy instance fallback (all instances × all formats in parallel) ─
  const _instOrder = [...QOBUZ_INSTANCES].sort((a, b) => {
    const ta = cacheGet('qinst:' + a) || 9999;
    const tb = cacheGet('qinst:' + b) || 9999;
    return ta - tb;
  });
  const combos = [];
  for (const inst of _instOrder)
    for (const fmt of fmtOrder)
      combos.push({ inst, fmt });

  const results = await Promise.allSettled(combos.map(({ inst, fmt }) =>
    qobuzGet(inst + '/stream/' + trackId, { format_id: fmt }).then(r => {
      if (r.data && r.data.url) {
        cacheSet('qinst:' + inst, Date.now(), 600);
        return { url: r.data.url, fmt, inst };
      }
      throw new Error('no url');
    })
  ));

  for (const fmt of fmtOrder) {
    const hit = results.find(r => r.status === 'fulfilled' && r.value.fmt === fmt);
    if (hit) {
      const { url } = hit.value;
      const result = { url, format: fmtLabel[fmt], quality: fmtQuality[fmt], source: 'qobuz-proxy', expiresAt: Math.floor(Date.now()/1000)+1680 };
      await cacheSet(cacheKey, result, 1680);
      if (env) upstashCmd(env, 'SET', cacheKey, JSON.stringify(result), 'EX', 720).catch(()=>{});
      return result;
    }
  }
  return null;
}


// qobuzFindByIsrc: looks up a Qobuz track by ISRC code.
// ONLY returns a result if the Qobuz item's own .isrc field matches exactly —
// if the proxy doesn't support ISRC search syntax the result is silently discarded.
// Confirmed hits cached 24h; misses cached 30 min.
async function qobuzFindByIsrc(isrc) {
  if (!isrc) return null;
  const normIsrc = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const wantIsrc = normIsrc(isrc);
  if (!wantIsrc) return null;

  const cacheKey = 'qisrc:' + wantIsrc;
  const cached = await cacheGet(cacheKey);
  if (cached === 'MISS') return null;
  if (cached) return cached;

  for (const inst of QOBUZ_INSTANCES) {
    try {
      const r = await qobuzGet(inst + '/search', { q: isrc, limit: 5 }, 8000);
      const items = (r.data && r.data.tracks && r.data.tracks.items) ? r.data.tracks.items : [];
      // STRICT: only accept a result if Qobuz confirms the ISRC matches exactly
      const match = items.find(t => t.isrc && normIsrc(t.isrc) === wantIsrc);
      if (match && match.id) {
        await cacheSet(cacheKey, match, 86400); // confirmed ISRC match — cache 24h
        console.log(`[Qobuz ISRC] HIT ${isrc} -> id=${match.id} "${match.title}"`);
        return match;
      }
    } catch(e) { continue; } // instance down — circuit breaker handles it via qobuzStream
  }
  await cacheSet(cacheKey, 'MISS', 1800); // miss cached 30 min
  return null;
}

async function qobuzFindBestTrack(title, artist, isrc, _env, expectedDuration) {
  // 1. ISRC fast path
  if (isrc) {
    const byIsrc = await qobuzFindByIsrc(isrc);
    if (byIsrc) return byIsrc;
    console.log(`[Qobuz ISRC] no confirmed match for ${isrc} — falling back to title search`);
  }
  if (!title) return null;
  // FIX: MusicBrainz ISRC enrichment — try to fetch ISRC if we don't have one
  if (!isrc && title && artist) {
    try {
      const _mbRes = await axios.get(
        `https://musicbrainz.org/ws/2/recording/?query=recording:${encodeURIComponent(title)}+AND+artist:${encodeURIComponent(artist)}&fmt=json&limit=3`,
        { headers: { 'User-Agent': 'EclipseAllInOne/1.0 (eclipse-addon)' }, timeout: 4000 }
      );
      const _mbRec = (_mbRes.data?.recordings || [])[0];
      const _mbIsrc = _mbRec?.isrcs?.[0];
      if (_mbIsrc) {
        console.log(`[MusicBrainz] enriched ISRC for "${title}" -> ${_mbIsrc}`);
        const byMbIsrc = await qobuzFindByIsrc(_mbIsrc);
        if (byMbIsrc) return byMbIsrc;
        isrc = _mbIsrc; // carry ISRC forward for cache key enrichment
      }
    } catch(e) { /* non-fatal */ }
  }
  // TheAudioDB ISRC enrichment fallback
  if (!isrc && title && artist) {
    try {
      const _tadbRes = await axios.get(
        `https://www.theaudiodb.com/api/v1/json/2/searchtrack.php?s=${encodeURIComponent(artist)}&t=${encodeURIComponent(title)}`,
        { timeout: 4000 }
      );
      const _tadbTrack = (_tadbRes.data?.track || [])[0];
      const _tadbIsrc = _tadbTrack?.strMusicBrainzID;
      if (_tadbIsrc) {
        console.log(`[TheAudioDB] enriched ISRC for "${title}" -> ${_tadbIsrc}`);
        const byTadbIsrc = await qobuzFindByIsrc(_tadbIsrc);
        if (byTadbIsrc) return byTadbIsrc;
      }
    } catch(e) { /* non-fatal */ }
  }
  const cacheKey = 'qmatch:' + title.toLowerCase() + ':' + (artist||'').toLowerCase();
  const cached = await cacheGet(cacheKey);
  if (cached === 'MISS') return null;
  if (cached) return cached;
  if (_env) {
    try {
      const _ur = await upstashCmd(_env, 'GET', cacheKey);
      if (_ur === 'MISS') { cacheSet(cacheKey, 'MISS', 1800); return null; }
      if (_ur) { const _up = JSON.parse(_ur); cacheSet(cacheKey, _up, 3600); return _up; }
    } catch(e) {}
  }

  // Use ISRC scoring engine for accurate matching
  const query = artist ? (artist + ' - ' + title) : isrcFormatQuery(title);
  for (const inst of QOBUZ_INSTANCES) {
    try {
      const r = await qobuzGet(inst + '/search', { q: query, limit: 20 }, 10000);
      const data = r.data || null;
      if (!data) continue;
      const items = (data.tracks && data.tracks.items) ? data.tracks.items : [];
      if (!items.length) continue;
      const match = isrcFindBestMatch(items, query, expectedDuration);
      if (match.item && match.score >= 50) {
        await cacheSet(cacheKey, match.item, 3600);
        if (_env) upstashCmd(_env, 'SET', cacheKey, JSON.stringify(match.item), 'EX', 3600).catch(()=>{});
        return match.item;
      }
    } catch(e) { continue; }
  }
  await cacheSet(cacheKey, 'MISS', 1800);
  if (_env) upstashCmd(_env, 'SET', cacheKey, 'MISS', 'EX', 1800).catch(()=>{});
  return null;
}

// ─── Qobuz Direct Search ─────────────────────────────────────────────────────
async function qobuzSearch(query) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  const cacheKey = `qsearch:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  for (const inst of QOBUZ_INSTANCES) {
    try {
      const r = await axios.get(`${inst}/search`, {
        params: { q: query, limit: 20 },
        headers: { 'User-Agent': UA },
        timeout: 9000,
      });
      const data = r.data || {};

      // ── Tracks ────────────────────────────────────────────────────────────
      const rawTracks = data.tracks?.items || data.tracks || data.items || [];
      const tracks = rawTracks.slice(0, 20).map(t => {
        const artistName = t.performer?.name || t.artist?.name || t.artists?.[0]?.name || 'Unknown';
        const cover = t.album?.image?.large || t.album?.cover_url || null;
        return {
          id: `qobuz_${t.id}`,
          title: t.title || 'Unknown',
          artist: artistName,
          album: t.album?.title || '',
          duration: t.duration || undefined,
          artworkURL: cover,
          format: 'flac',
          source: 'qobuz',
        };
      });

      // ── Albums ────────────────────────────────────────────────────────────
      const rawAlbums = data.albums?.items || data.albums || [];
      const albums = rawAlbums.slice(0, 8).map(a => ({
        id:         `qobuzalbum_${a.id}`,
        title:      a.title || 'Unknown Album',
        artist:     a.artist?.name || 'Unknown',
        artworkURL: a.image?.large || null,
        year:       safeYear(a.release_date_original),
        source:     'qobuz',
      }));

      // ── Artists ───────────────────────────────────────────────────────────
      const rawArtists = data.artists?.items || data.artists || [];
      const artists = rawArtists.slice(0, 6).map(a => ({
        id:         `qobuz_artist_${a.id}`,
        name:       a.name || 'Unknown Artist',
        // Qobuz search: artist.image.large  or artist.picture (300x300 jpg path)
        artworkURL: a.image?.large || (a.picture ? `https://static.qobuz.com/images/artists/covers/${a.picture}_300.jpg` : null),
        source:     'qobuz',
      }));

      // ── Playlists ─────────────────────────────────────────────────────────
      const rawPlaylists = data.playlists?.items || data.playlists || [];
      const playlists = rawPlaylists.slice(0, 5).map(p => ({
        id:         `qobuzplaylist_${p.id}`,
        title:      p.name || p.title || 'Unknown Playlist',
        artist:     p.owner?.name || 'Qobuz',
        // Qobuz playlist images is an array in search results
        artworkURL: (Array.isArray(p.images) && p.images[0]) || p.image_url || null,
        trackCount: p.tracks_count || undefined,
        source:     'qobuz',
      }));

      // Re-rank tracks using ISRC scoring engine so best match is always first
      if (tracks.length > 1) {
        const scored = tracks.map(t => {
          const qNorm   = normalizeStr(query);
          const tTitle  = normalizeStr(t.title || '');
          const tArtist = normalizeStr(t.artist || '');
          const qWords  = qNorm.replace(/[^a-z0-9\s]/gi,' ').split(/\s+/).filter(w=>w.length>1);
          const hasHyphen = / - /.test(qNorm);
          const thits = qWords.filter(w=>tTitle.includes(w)).length;
          const ahits = qWords.filter(w=>tArtist.includes(w)).length;
          let s = thits*15 + ahits*8;
          const cov = qWords.filter(w=>tTitle.includes(w)||tArtist.includes(w)).length;
          if (cov===qWords.length && qWords.length>0) s+=50;
          if (!hasHyphen && thits>0 && (qNorm===tTitle||tTitle.includes(qNorm)||qNorm.includes(tTitle))) s+=35;
          if (!hasHyphen && tArtist && (qNorm===tArtist||tArtist.includes(qNorm)||qNorm.includes(tArtist))) s+=25;
          if (thits>0 && ahits>0) s+=80;
          if (tTitle===qNorm) s+=60;
          // KEY FIX: penalise heavily when title has ZERO word hits but artist matches
          // This is what caused "embers dead butterflies" to surface wrong track
          if (!hasHyphen && thits===0 && ahits>0) s-=90;
          if (!hasHyphen && thits===0 && qWords.length>=2) s-=40;
          if (!/\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(qNorm) &&
              /\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(t.title||'')) s-=500;
          if (!/\b(live|remix|version|edit|mix)\b/i.test(qNorm) &&
              /\b(live|remix|version|edit|mix)\b/i.test(t.title||'')) s-=50;
          return { t, s };
        });
        scored.sort((a,b) => b.s - a.s);
        tracks.length = 0;
        scored.forEach(x => tracks.push(x.t));
      }

      const result = { tracks, albums, artists, playlists };
      await cacheSet(cacheKey, result, 300);
      return result;
    } catch (e) { continue; }
  }
  return { tracks: [], albums: [], artists: [], playlists: [] };
}

async function hifiSearch(query, instances) {
  const list = (instances && instances.length) ? instances : DEFAULT_HIFI_INSTANCES;
  const cacheKey = `hifi:search:all:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  // Race all instances — first to respond wins for main search
  // Artist searches run in parallel and we collect ALL results
  const HIFI_TIMEOUT = 5000;
  const mainSearches = list.map(inst =>
    axios.get(`${inst}/search/`, { params: { s: query, limit: 50 }, headers: { 'User-Agent': UA }, timeout: HIFI_TIMEOUT })
      .then(r => { if (!r?.data) throw new Error('empty'); return { r, inst }; })
  );
  const artistSearches = list.map(inst =>
    axios.get(`${inst}/search/`, { params: { s: query, type: 'ARTISTS', limit: 10 }, headers: { 'User-Agent': UA }, timeout: HIFI_TIMEOUT })
      .then(r => ({ r, inst, type: 'artists' })).catch(() => null)
  );

  // Get fastest main result + all artist results simultaneously
  let mainHit = null;
  try {
    mainHit = await Promise.any(mainSearches);
  } catch { /* all failed */ }

  const artistSettled = await Promise.allSettled(artistSearches);
  const inst = mainHit?.inst || list[0];
  const artistHits = artistSettled
    .filter(x => x.status === 'fulfilled' && x.value?.r?.data)
    .map(x => x.value);

  if (!mainHit) return { tracks: [], albums: [], artists: [] };
  try {
    const mainRes  = { status: 'fulfilled', value: mainHit.r };
    // Merge all artist responses into one synthetic result
    const mergedArtistData = artistHits.flatMap(x => {
      const d = x.r.data;
      return d?.data?.artists?.items || d?.data?.artists || d?.artists?.items || d?.artists || d?.data?.items || d?.items || [];
    });
    const artistRes = {
      status: 'fulfilled',
      value: { data: { data: { artists: { items: mergedArtistData } } } },
    };

    const items = mainRes.status === 'fulfilled'
      ? (mainRes.value.data?.data?.items || mainRes.value.data?.items || mainRes.value.data?.tracks || [])
      : [];
    const instB64 = encodeBase64Url(inst);
    const tracks = [], albumMap = {}, artistMap = {};

    for (const t of items) {
      if (!t?.id) continue;

      // Build artist map from ALL items (not just streamable) so geo-restricted
      // artists like Travis Scott still appear in search results
      for (const a of (t.artists || (t.artist ? [t.artist] : []))) {
        if (a?.id && !artistMap[String(a.id)]) {
          artistMap[String(a.id)] = {
            id: `hifi_artist_${instB64}_${a.id}`,
            name: a.name || 'Unknown',
            artworkURL: a.picture
              ? `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg`
              : undefined,
            _source: 'hifi',
            _hits: 0,
          };
        }
        if (a?.id) artistMap[String(a.id)]._hits = (artistMap[String(a.id)]._hits || 0) + 1;
      }

      // Only streamable tracks go into track/album results
      if (t.streamReady === false) continue;

      const origId = String(t.id);
      const artworkURL = t.album?.cover
        ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, '/')}/1280x1280.jpg`
        : undefined;
      // Artist resolution: MAIN/FEATURED first, then strip known label/distributor names
      const _LABEL_RE = /\b(octobersveryown|ovo|republic|island|atlantic|columbia|interscope|universal|sony|warner|capitol|def jam|rca|epic|polydor|parlophone|elektra|geffen|virgin|motown|label|records|music group|entertainment|distribution|publishing|llc|inc\.?)\b/i;
      const mainArtists = (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED');
      const nonLabelArtists = (t.artists || []).filter(a => a.name && !_LABEL_RE.test(a.name));
      const artistNames = mainArtists.length
        ? mainArtists.map(a => a.name).join(', ')
        : nonLabelArtists.length
          ? nonLabelArtists.map(a => a.name).join(', ')
          : (t.artist?.name || (t.artists || []).map(a => a.name).join(', ') || 'Unknown');
      tracks.push({
        id: `hifi_${instB64}_${origId}`,
        title: t.title || 'Unknown',
        artist: artistNames,
        album: t.album?.title || '',
        duration: t.duration ? Math.floor(t.duration) : undefined,
        artworkURL,
        format: 'flac',
        _source: 'hifi',
        _inst: inst,
        _instB64: instB64,
        _origId: origId,
      });
      // Cache track metadata so stream handler can fall back to SC if HiFi fails
      cacheSet(`hifi:track:meta:${instB64}_${origId}`, { title: t.title || 'Unknown', artist: artistNames, isrc: t.isrc ? t.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null, duration: t.duration ? Math.floor(t.duration) : undefined }, 3600);
      if (t.album?.id) {
        const aid = String(t.album.id);
        if (!albumMap[aid]) albumMap[aid] = {
          id: `hifi_album_${instB64}_${aid}`,
          title: t.album.title || 'Unknown Album',
          artist: artistNames,
          artworkURL,
          // FIX: releaseDate is often null on track.album objects; fall back to streamStartDate
          year: safeYear(t.album.releaseDate || t.album.streamStartDate || t.releaseDate),
          _source: 'hifi',
        };
      }
    }

    // Merge dedicated artist search results — these return artists even when
    // their tracks are geo-restricted (fixes Travis Scott / Drake / etc.)
    if (artistRes.status === 'fulfilled') {
      const arData = artistRes.value.data;
      const arItems = arData?.data?.artists?.items || arData?.data?.artists
        || arData?.artists?.items || arData?.artists
        || arData?.data?.items || arData?.items || [];
      for (const a of arItems) {
        if (!a?.id || !a?.name) continue;
        const key = String(a.id);
        if (!artistMap[key]) {
          artistMap[key] = {
            id: `hifi_artist_${instB64}_${a.id}`,
            name: a.name,
            artworkURL: a.picture
              ? `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg`
              : undefined,
            _source: 'hifi',
            _hits: 10, // boost dedicated artist results to top
          };
        } else {
          artistMap[key]._hits = (artistMap[key]._hits || 0) + 10;
          if (!artistMap[key].artworkURL && a.picture) {
            artistMap[key].artworkURL = `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg`;
          }
        }
      }
    }

    // Sort artists: most hits first (dedicated results float to top)
    const artistList = Object.values(artistMap)
      .sort((a, b) => (b._hits || 0) - (a._hits || 0))
      .slice(0, 5)
      .map(({ _hits, ...a }) => a);

    // Re-rank HiFi tracks using ISRC scoring engine (same "embers" fix)
    if (tracks.length > 1) {
      const scored = tracks.map(t => {
        const qNorm   = normalizeStr(query);
        const tTitle  = normalizeStr(t.title || '');
        const tArtist = normalizeStr(t.artist || '');
        const qWords  = qNorm.replace(/[^a-z0-9\s]/gi,' ').split(/\s+/).filter(w=>w.length>1);
        const hasHyphen = / - /.test(qNorm);
        const thits = qWords.filter(w=>tTitle.includes(w)).length;
        const ahits = qWords.filter(w=>tArtist.includes(w)).length;
        let s = thits*15 + ahits*8;
        const cov = qWords.filter(w=>tTitle.includes(w)||tArtist.includes(w)).length;
        if (cov===qWords.length && qWords.length>0) s+=50;
        if (!hasHyphen && thits>0 && (qNorm===tTitle||tTitle.includes(qNorm)||qNorm.includes(tTitle))) s+=35;
        if (!hasHyphen && tArtist && (qNorm===tArtist||tArtist.includes(qNorm)||qNorm.includes(tArtist))) s+=25;
        if (thits>0 && ahits>0) s+=80;
        if (tTitle===qNorm) s+=60;
        if (!hasHyphen && thits===0 && ahits>0) s-=90;
        if (!hasHyphen && thits===0 && qWords.length>=2) s-=40;
        if (!/\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(qNorm) &&
            /\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(t.title||'')) s-=500;
        if (!/\b(live|remix|version|edit|mix)\b/i.test(qNorm) &&
            /\b(live|remix|version|edit|mix)\b/i.test(t.title||'')) s-=50;
        return { t, s };
      });
      scored.sort((a,b) => b.s - a.s);
      tracks.length = 0;
      scored.forEach(x => tracks.push(x.t));
    }

    const result = {
      tracks,
      // FIX: sort albums newest-first before slicing (was unsorted)
      albums: Object.values(albumMap)
        .sort((a, b) => {
          if (!a.year && !b.year) return 0;
          if (!a.year) return 1;
          if (!b.year) return -1;
          return b.year - a.year;
        })
        .slice(0, 8),
      artists: artistList,
    };
    await cacheSet(cacheKey, result, 300);
    return result;
  } catch (e) {
    console.warn('[HiFi] search error:', e.message);
    return { tracks: [], albums: [], artists: [] };
  }
}

async function hifiStream(id, extraInstances, preferredQuality) {
  const withoutPrefix = id.slice(5);
  const firstUnderscore = withoutPrefix.indexOf('_');
  const instB64   = withoutPrefix.slice(0, firstUnderscore);
  const origId    = withoutPrefix.slice(firstUnderscore + 1);
  const preferred = decodeBase64Url(instB64);

  // Preferred instance first, then any user-configured instances, then all defaults
  const allInstances = [...new Set([preferred, ...(extraInstances || []), ...DEFAULT_HIFI_INSTANCES])];
  const instanceOrder = allInstances;

  function parseTrackResponse(data) {
    const payload = data?.data || data;
    if (payload?.manifest) {
      try {
        const decoded = JSON.parse(atob(payload.manifest));
        const url = decoded.urls?.[0];
        if (url) {
          const codec = (decoded.codecs || decoded.mimeType || '').toLowerCase();
          const isFlac = codec.includes('flac') || codec.includes('audio/flac');
          return { url, format: isFlac ? 'flac' : 'aac' };
        }
        // manifest decoded but no url — log the structure
        console.warn('[HiFi stream] manifest decoded but no url, keys:', Object.keys(decoded));
      } catch (e) {
        console.warn('[HiFi stream] manifest decode error:', e.message);
      }
    }
    if (payload?.url) return { url: payload.url, format: 'aac' };
    // Log what we actually got back
    if (payload) console.warn('[HiFi stream] no manifest/url in payload, keys:', Object.keys(payload).slice(0,10).join(','));
    return null;
  }

  // Try quality tiers in preferred order — race ALL instances per tier in parallel.
  // Each tier is tried fully before falling to the next, so LOSSLESS is always
  // attempted before HIGH or LOW (fixes the bug where LOW won the race).
  async function tryInstance(inst, ql) {
    // FIX: 2s per-instance timeout — slow instances drop out fast in Promise.any race
    try {
      const r = await axios.get(`${inst}/track/`, {
        params: { id: origId, quality: ql },
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 2000,
      });
      const parsed = parseTrackResponse(r.data);
      if (parsed) return { ...parsed, quality: ql };
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data?.userMessage || e.response?.data?.error || e.message;
      if (status !== 403 && status !== 404 && status !== 401)
        console.warn(`[HiFi stream] ${inst}/track/ ql=${ql} -> ${status || 'ERR'}: ${msg}`);
    }
    return null;
  }

  // Build quality order: preferred first, then remaining tiers highest→lowest
  const ALL_QUALITIES = ['LOSSLESS', 'HIGH', 'LOW'];
  const pref = preferredQuality && ALL_QUALITIES.includes(preferredQuality) ? preferredQuality : 'LOSSLESS';
  const qualityOrder = [pref, ...ALL_QUALITIES.filter(q => q !== pref)];

  // FIX: Two-phase race strategy to minimize latency:
  // Phase 1 — race preferred quality across ALL instances simultaneously (2s window).
  // Phase 2 — if phase 1 yields nothing, race ALL remaining qualities × ALL instances at once.
  // This caps worst-case at ~4s (was up to 9s with sequential per-tier loops).
  try {
    const winner = await Promise.any(
      instanceOrder.map(inst =>
        tryInstance(inst, qualityOrder[0]).then(r => {
          if (!r) throw new Error('no result');
          return r;
        })
      )
    );
    console.log(`[HiFi stream] phase1 winner quality=${qualityOrder[0]} trackId=${origId}`);
    return winner;
  } catch { /* phase 1 failed — all instances timed out or errored on preferred quality */ }

  // Phase 2: race ALL remaining quality tiers × ALL instances simultaneously
  const phase2Promises = [];
  for (const ql of qualityOrder.slice(1)) {
    for (const inst of instanceOrder) {
      phase2Promises.push(
        tryInstance(inst, ql).then(r => {
          if (!r) throw new Error('no result');
          return r;
        })
      );
    }
  }
  if (phase2Promises.length) {
    try {
      const winner2 = await Promise.any(phase2Promises);
      console.log(`[HiFi stream] phase2 winner trackId=${origId}`);
      return winner2;
    } catch { /* all tiers/instances failed */ }
  }

  // Legacy /stream/ path fallback — parallel across all instances
  const legacyResults = await Promise.all(instanceOrder.map(async inst => {
    for (let _la = 1; _la <= 2; _la++) {
      try {
        const r = await axios.get(`${inst}/stream/${origId}`, {
          headers: { 'User-Agent': UA },
          timeout: 5000,
        });
        if (r.data?.url) {
          console.log(`[HiFi stream] legacy /stream/ success: ${inst} trackId=${origId}`);
          return { url: r.data.url, format: r.data.format || 'aac', quality: r.data.quality || 'unknown' };
        }
      } catch (e) {
        const _ls = e.response?.status;
        if (_ls === 403 || _ls === 404 || _ls === 401) break;
        if (_la < 2) { await new Promise(r => setTimeout(r, 500)); continue; }
        if (_ls !== 403 && _ls !== 404 && _ls !== 401)
          console.warn(`[HiFi stream] legacy ${inst}/stream/${origId} -> ${_ls || 'ERR'}: ${e.message}`);
      }
    }
    return null;
  }));
  const legacyWinner = legacyResults.find(r => r !== null);
  if (legacyWinner) return legacyWinner;

  console.error(`[HiFi stream] ALL instances failed for trackId=${origId}`);
  return null;
}

async function hifiAlbum(id) {
  const withoutPrefix = id.slice(11);
  const firstUnderscore = withoutPrefix.indexOf('_');
  const instB64 = withoutPrefix.slice(0, firstUnderscore);
  const albumId = withoutPrefix.slice(firstUnderscore + 1);
  const inst = decodeBase64Url(instB64);
  const cacheKey = `hifi:album:${instB64}:${albumId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const r = await axios.get(`${inst}/album/`, {
      params: { id: albumId, limit: 100 },
      headers: { 'User-Agent': UA },
      timeout: 10000,
    });
    const album = r.data?.data || r.data;
    const rawItems = album?.items || [];
    const _mainAlbumArtists = (album?.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED');
    const artistName = _mainAlbumArtists.length
      ? _mainAlbumArtists.map(a => a.name).join(', ')
      : (album?.artist?.name || (album?.artists || []).map(a => a.name).join(', ') || 'Unknown');
    const cover = album?.cover
      ? `https://resources.tidal.com/images/${album.cover.replace(/-/g, '/')}/1280x1280.jpg`
      : undefined;
    const tracks = rawItems
      .map(i => i.item || i)
      .filter(t => t?.id && t.streamReady !== false)
      .map(t => ({
        id: `hifi_${instB64}_${t.id}`,
        title: t.title || 'Unknown',
        artist: ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length
              ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED')
              : (t.artists?.length ? t.artists : (t.artist ? [t.artist] : []))).map(a => a.name).join(', ') || artistName,
        duration: t.duration ? Math.floor(t.duration) : undefined,
        trackNumber: t.trackNumber,
        artworkURL: cover,
        format: 'flac',
      }));
    // FIX: cache track meta so stream handler applies correct streamOrder priority (Qobuz-first etc.)
    for (const _rawT of rawItems.map(i => i.item || i).filter(t => t?.id)) {
      const _rawArtist = (((_rawT.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED').length
        ? (_rawT.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED')
        : (_rawT.artists?.length ? _rawT.artists : (_rawT.artist ? [_rawT.artist] : []))
      ).map(a=>a.name).join(', ')) || artistName;
      cacheSet(`hifi:track:meta:${instB64}_${_rawT.id}`, {
        title: _rawT.title || 'Unknown',
        artist: _rawArtist,
        isrc: _rawT.isrc ? _rawT.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null,
        duration: _rawT.duration ? Math.floor(_rawT.duration) : undefined,
      }, 3600);
    }
    const result = {
      id,
      title: album?.title || 'Unknown Album',
      artist: artistName,
      artworkURL: cover,
      year: safeYear(album?.releaseDate),
      trackCount: tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) {
    console.warn('[HiFi] album error:', e.message);
    return null;
  }
}


async function scSearch(query, clientId) {
  const cid = await getSCClientId(clientId);
  if (!cid) return { tracks: [], playlists: [] };
  const cacheKey = `sc:search:${cid.slice(0,8)}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const [tracksRes, plRes] = await Promise.allSettled([
      axios.get('https://api-v2.soundcloud.com/search/tracks', {
        params: { q: query, client_id: cid, limit: 20 },
        timeout: 8000,
      }),
      axios.get('https://api-v2.soundcloud.com/search/playlists', {
        params: { q: query, client_id: cid, limit: 5 },
        timeout: 8000,
      }),
    ]);
    const tracks = (tracksRes.status === 'fulfilled' ? tracksRes.value.data?.collection || [] : [])
      .filter(t => {
        // Drop snipped/blocked tracks from search results
        const _p = (t.policy || '').toUpperCase();
        if (_p === 'BLOCK') return false;
        // Only drop SNIP if the track is also very short (< 60s) — a real snip preview.
        // Long tracks (GY!BE, ambient, etc.) may have policy=SNIP but still be full uploads.
        if (_p === 'SNIP' && (t.full_duration || t.duration || 0) < 60000) return false;
        return true;
      })
      .map(t => ({
      id: `sc_${t.id}`,
      title: t.publisher_metadata?.title || t.title,
      artist: t.publisher_metadata?.artist || t.user?.name || t.user?.username || 'Unknown',
      album: '',
      duration: Math.floor((t.full_duration || t.duration || 0) / 1000),
      artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
      isrc: t.publisher_metadata?.isrc || undefined,
      format: 'mp3',
      _source: 'sc',
      _origId: String(t.id),
      _streamUrl: t.media?.transcodings?.find(x => x.format?.mime_type?.includes('mpeg'))?.url || null,
    }));
    // Cache individual track transcoding URLs + policy so fallback can detect snips/previews
    for (const t of (tracksRes.status === 'fulfilled' ? tracksRes.value.data?.collection || [] : [])) {
      const turl = t.media?.transcodings?.find(x => x.format?.protocol === 'progressive' && x.format?.mime_type?.includes('mpeg'))?.url
                || t.media?.transcodings?.find(x => x.format?.protocol === 'progressive')?.url
                || t.media?.transcodings?.[0]?.url;
      if (turl) await cacheSet(`sc:transcodings:${t.id}`, turl, 3600);
      // Cache title/artist for fallback lookup when track turns out to be snipped
      if (t.title) {
        const _scMetaVal = { title: t.publisher_metadata?.title || t.title, artist: t.publisher_metadata?.artist || t.user?.name || t.user?.username || '', isrc: t.publisher_metadata?.isrc ? t.publisher_metadata.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null, duration: Math.floor((t.full_duration || t.duration || 0) / 1000) || undefined };
        await cacheSet(`sc:meta:${t.id}`, _scMetaVal, 3600);
        // Also persist to Upstash so stream handler can find it across isolates
        // Upstash persist done in handleSearch (which has c.env access)
      }
      // Cache policy so stream handler can detect snipped/blocked tracks
      if (t.policy || t.monetization_model) {
        await cacheSet(`sc:policy:${t.id}`, {
          policy: t.policy || '',
          monetization: t.monetization_model || '',
          snipped: !!(t.policy && ['SNIP', 'BLOCK'].includes(t.policy.toUpperCase())),
        }, 3600);
      }
    }
    const playlists = (plRes.status === 'fulfilled' ? plRes.value.data?.collection || [] : []).map(p => ({
      id: `sc_pl_${p.id}`,
      title: p.title,
      creator: p.user?.username || 'Unknown',
      artworkURL: (p.artwork_url || '').replace('-large', '-t500x500'),
      trackCount: p.track_count || 0,
      _source: 'sc',
      _origId: String(p.id),
    }));
    const result = { tracks, playlists };
    await cacheSet(cacheKey, result, 300);
    return result;
  } catch (e) {
    console.warn('[SC] search error:', e.message);
    return { tracks: [], playlists: [] };
  }
}


async function scStream(origId, clientId) {
  const cid = await getSCClientId(clientId);
  // Even without a client_id, try using a cached transcoding URL from search
  const cachedTranscodingUrl = await cacheGet(`sc:transcodings:${origId}`);
  if (!cid && !cachedTranscodingUrl) return null;
  if (!cid && cachedTranscodingUrl) {
    // Can't resolve the transcoding URL without client_id, nothing we can do
    console.warn('[SC] no client_id, cannot resolve transcoding URL for', origId);
    return null;
  }
  try {
    const res = await axios.get(`https://api-v2.soundcloud.com/tracks/${origId}`, {
      params: { client_id: cid },
      timeout: 8000,
    });
    const transcodings = res.data?.media?.transcodings || [];
    const transcoding =
      transcodings.find(t => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('mpeg')) ||
      transcodings.find(t => t.format?.protocol === 'progressive') ||
      transcodings.find(t => t.format?.mime_type?.includes('mpeg')) ||
      transcodings[0];
    if (!transcoding?.url) return null;
    const streamRes = await axios.get(transcoding.url, {
      params: { client_id: cid },
      timeout: 8000,
    });
    const url = streamRes.data?.url;
    if (!url) return null;
    const isHls = transcoding.format?.protocol === 'hls' || url.includes('.m3u8');
    // Detect snipped/preview tracks: SC returns short URLs or policy says SNIP/BLOCK
    const trackData = res.data;
    const policy = (trackData?.policy || '').toUpperCase();
    const isSnipped = policy === 'SNIP' || policy === 'BLOCK'
      || trackData?.monetization_model === 'SUB_HIGH_TIER'
      || (trackData?.full_duration && trackData?.duration && trackData.full_duration > trackData.duration + 5000);
    // Never serve a snippet — return null so caller gets a 404 or tries HiFi
    if (isSnipped) {
      console.warn(`[SC stream] ${origId} is snipped/sub-only, refusing to serve preview`);
      return null;
    }
    return { url, format: isHls ? 'hls' : 'mp3', quality: '128kbps', _scSnipped: false };
  } catch (e) {
    console.warn('[SC] stream error:', e.message);
    // Fallback: try cached transcoding URL directly
    if (cachedTranscodingUrl) {
      try {
        const fallbackRes = await axios.get(cachedTranscodingUrl, { params: { client_id: cid }, timeout: 6000 });
        const fallbackUrl = fallbackRes.data?.url;
        if (fallbackUrl) return { url: fallbackUrl, format: 'mp3', quality: '128kbps' };
      } catch {}
    }
    return null;
  }
}

// ─── Internet Archive Search (Music) ─────────────────────────────────────────
async function iaSearchMusic(query) {
  const cacheKey = `ia:music:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://archive.org/advancedsearch.php', {
      params: {
        q: `${query} AND mediatype:audio AND -mediatype:collection`,
        fl: 'identifier,title,creator,date,description',
        rows: 10,
        page: 1,
        output: 'json',
        'sort[]': 'downloads desc',
      },
      timeout: 8000,
    });
    const docs = res.data?.response?.docs || [];
    const tracks = docs.map(d => ({
      id: `ia_music_${d.identifier}`,
      title: d.title || d.identifier,
      artist: Array.isArray(d.creator) ? d.creator[0] : (d.creator || 'Unknown'),
      album: '',
      duration: 0,
      artworkURL: `https://archive.org/services/img/${d.identifier}`,
      format: 'mp3',
      _source: 'ia_music',
      _identifier: d.identifier,
    }));
    await cacheSet(cacheKey, tracks, 600);
    return tracks;
  } catch (e) {
    console.warn('[IA Music] search error:', e.message);
    return [];
  }
}

async function iaGetBestAudioFile(identifier) {
  const cacheKey = `ia:files:${identifier}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get(`https://archive.org/metadata/${identifier}`, { timeout: 6000 });
    const files = res.data?.files || [];
    // Prefer mp3, then ogg, then flac
    const ranked = ['mp3', 'ogg', 'flac', 'wav'];
    for (const ext of ranked) {
      const f = files.find(f => f.name?.toLowerCase().endsWith(`.${ext}`) && f.source !== 'metadata');
      if (f) {
        const url = `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`;
        await cacheSet(cacheKey, url, 3600);
        return url;
      }
    }
    return null;
  } catch { return null; }
}

// ─── Internet Archive Audiobooks ──────────────────────────────────────────────
async function iaSearchAudiobooks(query) {
  const cacheKey = `ia:audiobooks:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://archive.org/advancedsearch.php', {
      params: {
        q: `${query} AND (collection:librivoxaudio OR subject:audiobook OR subject:"audio book") AND mediatype:audio`,
        fl: 'identifier,title,creator,date,description,subject',
        rows: 8,
        page: 1,
        output: 'json',
        'sort[]': 'downloads desc',
      },
      timeout: 8000,
    });
    const docs = res.data?.response?.docs || [];
    const albums = docs.map(d => ({
      id: `ia_book_${d.identifier}`,
      title: d.title || d.identifier,
      artist: Array.isArray(d.creator) ? d.creator[0] : (d.creator || 'Unknown Author'),
      artworkURL: `https://archive.org/services/img/${d.identifier}`,
      trackCount: 0,
      year: safeYear(d.date),
      _source: 'ia_book',
      _identifier: d.identifier,
    }));
    await cacheSet(cacheKey, albums, 600);
    return albums;
  } catch (e) {
    console.warn('[IA Audiobooks] search error:', e.message);
    return [];
  }
}

// ─── LibriVox Audiobooks ──────────────────────────────────────────────────────
async function librivoxSearch(query) {
  const cacheKey = `librivox:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // LibriVox API: title search with caret prefix for broader matches
    const res = await axios.get('https://librivox.org/api/feed/audiobooks', {
      params: { title: `%5E${query}`, format: 'json', extended: 1, limit: 6 },
      timeout: 5000,
    }).catch(async () =>
      axios.get('https://librivox.org/api/feed/audiobooks', {
        params: { title: query, format: 'json', extended: 1, limit: 6 },
        timeout: 5000,
      })
    );
    const books = Array.isArray(res.data?.books) ? res.data.books : [];
    const albums = books.map(b => ({
      id: `lvox_${b.id}`,
      title: b.title || 'Unknown',
      artist: (b.authors || []).map(a => `${a.first_name} ${a.last_name}`).join(', ') || 'Unknown Author',
      artworkURL: b.url_zip_file ? '' : '',
      trackCount: parseInt(b.num_sections) || 0,
      year: safeYear(b.copyright_year),
      _source: 'librivox',
      _bookId: b.id,
      _rssUrl: b.url_rss,
    }));
    await cacheSet(cacheKey, albums, 600);
    return albums;
  } catch (e) {
    console.warn('[LibriVox] search error:', e.message);
    return [];
  }
}

async function librivoxGetChapters(bookId, rssUrl) {
  const cacheKey = `lvox:chapters:${bookId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const feedUrl = rssUrl || `https://librivox.org/rss/${bookId}`;
    const res = await axios.get(feedUrl, { timeout: 8000, responseType: 'text' });
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    let i = 0;
    while ((m = itemRe.exec(res.data)) !== null) {
      const item = m[1];
      const title = (item.match(/<title><!\[CDATA\[([^\]]+)\]\]>/) || item.match(/<title>([^<]+)/))?.[1]?.trim() || `Chapter ${++i}`;
      const url = item.match(/url="([^"]+\.mp3)"/)?.[1] || item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] || '';
      const duration = item.match(/<itunes:duration>([^<]+)/)?.[1] || '';
      const durSecs = duration.split(':').reduce((acc, t) => acc * 60 + parseInt(t || 0), 0);
      if (url) items.push({ title, url, duration: durSecs });
    }
    await cacheSet(cacheKey, items, 3600);
    return items;
  } catch (e) {
    console.warn('[LibriVox] chapter fetch error:', e.message);
    return [];
  }
}

// ─── Podcast Index ────────────────────────────────────────────────────────────
async function podcastIndexHeaders(key, secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const msgBuffer = new TextEncoder().encode(key + secret + ts);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    'X-Auth-Key': key,
    'X-Auth-Date': ts,
    Authorization: hash,
    'User-Agent': 'EclipseUniversalAddon/1.0',
  };
}

async function piSearchEpisodes(query, key, secret) {
  if (!key || !secret) return { playlists: [], albums: [], episodes: [] };
  const cacheKey = `pi:episodes:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // Run both PI calls in parallel to cut search latency in half
    const [feedsRes, epRes] = await Promise.allSettled([
      axios.get('https://api.podcastindex.org/api/1.0/search/byterm', {
        params: { q: query, max: 10, fulltext: true },
        headers: podcastIndexHeaders(key, secret),
        timeout: 5000,
      }),
      axios.get('https://api.podcastindex.org/api/1.0/search/byterm', {
        params: { q: query, max: 10, fulltext: true, type: 'episode' },
        headers: podcastIndexHeaders(key, secret),
        timeout: 5000,
      }),
    ]);
    const feeds = feedsRes.status === 'fulfilled' ? (feedsRes.value.data?.feeds || []) : [];
    // Return as playlists (podcast series)
    const playlists = feeds.slice(0, 5).map(f => ({
      id: `pi_feed_${f.id}`,
      title: f.title || 'Unknown Podcast',
      description: f.description || '',
      artworkURL: f.artwork || f.image || '',
      creator: f.author || '',
      trackCount: f.episodeCount || 0,
      _source: 'pi',
      _feedId: f.id,
      _feedUrl: f.url,
    }));
    const episodes = (epRes.status === 'fulfilled' ? (epRes.value.data?.items || epRes.value.data?.episodes || []) : []).map(e => ({
      id: `pi_ep_${e.id}`,
      title: e.title || 'Unknown Episode',
      artist: e.feedTitle || e.author || 'Unknown Podcast',
      album: e.feedTitle || '',
      duration: e.duration || 0,
      artworkURL: e.image || e.feedImage || '',
      format: 'mp3',
      streamURL: e.enclosureUrl || e.enclosure?.url || '',
      _source: 'pi',
    }));
    for (const f of feeds) {
      await cacheSet(`pi:series_info:${f.id}`, {
        title: f.title || 'Unknown Podcast',
        artworkURL: f.artwork || f.image || '',
        creator: f.author || '',
        description: f.description || '',
      }, 3600);
    }
    const albums = feeds.slice(0, 5).map(f => ({
      id: `pi_feed_${f.id}`,
      title: f.title || 'Unknown Podcast',
      artist: f.author || '',
      artworkURL: f.artwork || f.image || '',
      trackCount: f.episodeCount || 0,
      year: 0,
      _source: 'pi',
      _isPodcast: true,
    }));
    const result = { playlists, albums, episodes };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[PI] search error:', e.message);
    return { playlists: [], albums: [], episodes: [] };
  }
}

async function piGetEpisodes(feedId, key, secret) {
  if (!key || !secret) return [];
  const cacheKey = `pi:feed:${feedId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://api.podcastindex.org/api/1.0/episodes/byfeedid', {
      params: { id: feedId, max: 50 },
      headers: podcastIndexHeaders(key, secret),
      timeout: 8000,
    });
    const items = (res.data?.items || []).map(e => ({
      id: `pi_ep_${e.id}`,
      title: e.title || 'Episode',
      artist: e.feedTitle || '',
      duration: e.duration || 0,
      artworkURL: e.image || e.feedImage || '',
      streamURL: e.enclosureUrl || '',
      format: 'mp3',
    }));
    await cacheSet(cacheKey, items, 600);
    return items;
  } catch { return []; }
}

// ─── Taddy GraphQL ────────────────────────────────────────────────────────────
async function taddySearch(query, apiKey, userId) {
  if (!apiKey || !userId) return { playlists: [], episodes: [] };
  const cacheKey = `taddy:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const gql = `query { search(term: "${query.replace(/[\\'"\`\n\r{}[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)}", filterForTypes: [PODCASTSERIES, PODCASTEPISODE], limitPerPage: 8) { searchId podcastSeries { uuid name imageUrl rssUrl episodes(limitPerPage: 5) { uuid name audioUrl duration imageUrl } } podcastEpisodes { uuid name audioUrl duration imageUrl podcastSeries { uuid name imageUrl } } } }`;
  try {
    const res = await axios.post('https://api.taddy.org', { query: gql }, {
      headers: {
        'Content-Type': 'application/json',
        'X-USER-ID': userId,
        'X-API-KEY': apiKey,
      },
      timeout: 5000,
    });
    const data = res.data?.data?.search;
    const playlists = (data?.podcastSeries || []).map(s => ({
      id: `taddy_series_${s.uuid}`,
      title: s.name || 'Unknown',
      description: s.description || '',
      artworkURL: s.imageUrl || '',
      creator: '',
      trackCount: 0,
      _source: 'taddy',
      _uuid: s.uuid,
      _episodes: s.episodes || [],
    }));
    const episodes = (data?.podcastEpisodes || []).map(e => ({
      id: `taddy_ep_${e.uuid}`,
      title: e.name || 'Unknown Episode',
      artist: e.podcastSeries?.name || 'Unknown Podcast',
      album: e.podcastSeries?.name || '',
      duration: e.duration || 0,
      artworkURL: e.imageUrl || e.podcastSeries?.imageUrl || '',
      format: 'mp3',
      streamURL: e.audioUrl || '',
      _source: 'taddy',
    }));
    for (const s of (data?.podcastSeries || [])) {
      await cacheSet(`taddy:series_info:${s.uuid}`, {
        title: s.name || 'Unknown Podcast',
        artworkURL: s.imageUrl || '',
        creator: '',
      }, 3600);
    }
    const albums = playlists.map(p => ({
      id: p.id,
      title: p.title,
      artist: p.creator || '',
      artworkURL: p.artworkURL || '',
      trackCount: p.trackCount || 0,
      year: 0,
      _source: 'taddy',
      _isPodcast: true,
    }));
    const result = { playlists, albums, episodes };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Taddy] search error:', e.message);
    return { playlists: [], albums: [], episodes: [] };
  }
}

async function taddyGetEpisodes(seriesUuid, apiKey, userId) {
  if (!apiKey || !userId) return [];
  const cacheKey = `taddy:series:${seriesUuid}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const gql = `query {
    getPodcastSeries(uuid: "${seriesUuid}") {
      uuid name imageUrl
      episodes(limitPerPage: 50) {
        uuid name description audioUrl duration imageUrl datePublished
      }
    }
  }`;
  try {
    const res = await axios.post('https://api.taddy.org', { query: gql }, {
      headers: { 'Content-Type': 'application/json', 'X-USER-ID': userId, 'X-API-KEY': apiKey },
      timeout: 8000,
    });
    const series = res.data?.data?.getPodcastSeries;
    const items = (series?.episodes || []).map(e => ({
      id: `taddy_ep_${e.uuid}`,
      title: e.name || 'Episode',
      artist: series?.name || '',
      duration: e.duration || 0,
      artworkURL: e.imageUrl || series?.imageUrl || '',
      streamURL: e.audioUrl || '',
      format: 'mp3',
    }));
    await cacheSet(cacheKey, items, 600);
    return items;
  } catch { return []; }
}

// ─── Apple Podcasts — RSS Feed Parser ─────────────────────────────────────────
async function appleGetFeed(feedUrl, collectionId) {
  const cacheKey = `apple:feed:${collectionId || feedUrl}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get(feedUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      timeout: 10000,
      responseType: 'text',
    });
    const xml = res.data;
    const chanTitle  = (xml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || '';
    const chanArtM   = xml.match(/<itunes:image\s+href="([^"]+)"/) || xml.match(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>/);
    const chanArt    = chanArtM ? chanArtM[1].trim() : '';
    const chanAuthor = (xml.match(/<itunes:author>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/itunes:author>/) || [])[1]?.trim() || '';
    const chanDesc   = (xml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1]?.trim().slice(0, 500) || '';
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    const episodes = [];
    let m, idx = 0;
    while ((m = itemRe.exec(xml)) !== null) {
      const item    = m[1];
      const title   = (item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || `Episode ${idx + 1}`;
      const encM    = item.match(/<enclosure[^>]+url="([^"]+)"/) || item.match(/<enclosure[^>]+url='([^']+)'/);
      const audioUrl = encM ? encM[1].trim() : null;
      const durStr  = (item.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/) || [])[1]?.trim() || '';
      const durSecs = durStr.includes(':')
        ? durStr.split(':').reduce((acc, t) => acc * 60 + parseInt(t, 10), 0)
        : (parseInt(durStr, 10) || 0);
      const artM  = item.match(/<itunes:image\s+href="([^"]+)"/);
      const epArt = artM ? artM[1].trim() : chanArt;
      const epId  = `apple_ep_rss_${collectionId || 'feed'}_${idx}`;
      if (audioUrl) await cacheSet(`apple:ep:stream:${epId}`, audioUrl, 3600);
      episodes.push({
        id: epId, title,
        artist: chanAuthor || chanTitle, album: chanTitle,
        duration: durSecs, artworkURL: epArt,
        format: audioUrl && audioUrl.includes('.m4a') ? 'aac' : 'mp3',
        streamURL: audioUrl, source: 'apple',
      });
      idx++;
    }
    const result = {
      id: `apple_feed_${collectionId || 'rss'}`,
      title: chanTitle || 'Podcast', artist: chanAuthor,
      artworkURL: chanArt, description: chanDesc,
      trackCount: episodes.length, tracks: episodes,
    };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Apple] RSS feed parse error:', e.message);
    return null;
  }
}

// ─── Apple Podcasts Search (iTunes API — completely free, no key) ─────────────
async function appleSearch(query) {
  const cacheKey = `apple:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // iTunes API doesn't support entity=podcastAndEpisode — run two parallel calls
    const [showsRes, epsRes] = await Promise.allSettled([
      axios.get('https://itunes.apple.com/search', {
        params: { term: query, media: 'podcast', entity: 'podcast', limit: 10 },
        timeout: 8000,
      }),
      axios.get('https://itunes.apple.com/search', {
        params: { term: query, media: 'podcast', entity: 'podcastEpisode', limit: 10 },
        timeout: 8000,
      }),
    ]);
    const results = [
      ...(showsRes.status === 'fulfilled' ? showsRes.value.data?.results || [] : []),
      ...(epsRes.status === 'fulfilled' ? epsRes.value.data?.results || [] : []),
    ];
    const playlists = [], episodes = [];
    const seenFeed = new Set();
    for (const r of results) {
      if (r.kind === 'podcast' || (r.wrapperType === 'track' && r.collectionType === 'Podcast')) {
        if (!seenFeed.has(r.collectionId)) {
          seenFeed.add(r.collectionId);
          if (r.feedUrl) await cacheSet(`apple:feed_url:${r.collectionId}`, r.feedUrl, 86400);
          playlists.push({
            id: `apple_feed_${r.collectionId}`,
            title: r.collectionName || r.trackName || 'Unknown Podcast',
            description: r.description || '',
            artworkURL: (r.artworkUrl600 || r.artworkUrl100 || '').replace('100x100', '600x600'),
            creator: r.artistName || '', trackCount: r.trackCount || 0,
            source: 'apple', _feedUrl: r.feedUrl || null,
          });
        }
      } else if (r.kind === 'podcast-episode') {
        const epId = `apple_ep_${r.trackId}`;
        if (r.episodeUrl) await cacheSet(`apple:ep:stream:${epId}`, r.episodeUrl, 3600);
        if (r.feedUrl && r.collectionId) await cacheSet(`apple:feed_url:${r.collectionId}`, r.feedUrl, 86400);
        episodes.push({
          id: epId, title: r.trackName || 'Unknown Episode',
          artist: r.artistName || r.collectionName || 'Unknown Podcast',
          album: r.collectionName || '',
          duration: r.trackTimeMillis ? Math.floor(r.trackTimeMillis / 1000) : 0,
          artworkURL: (r.artworkUrl600 || r.artworkUrl100 || '').replace('100x100', '600x600'),
          format: 'mp3', streamURL: r.episodeUrl || null, source: 'apple',
        });
      }
    }
    const albums = playlists.map(p => ({
      id: p.id, title: p.title, artist: p.creator,
      artworkURL: p.artworkURL, trackCount: p.trackCount,
      year: 0, source: 'apple', _isPodcast: true,
    }));
    const result = { playlists, albums, episodes };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Apple] search error:', e.message);
    return { playlists: [], albums: [], episodes: [] };
  }
}



// ─── Deezer (via your Cloudflare Worker proxy) ───────────────────────────────
// ─── Deezer (via dawn-art-79bc.cyrusna29.workers.dev addon) ─────────────────
const DEEZER_ADDON  = 'https://dawn-art-79bc.cyrusna29.workers.dev/u/e91b254bb5e8a17a97420339188c';
const DEEZER_API    = 'https://api.deezer.com'; // for albums/artists/playlists metadata

async function deezerSearch(query) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  const cacheKey = `dz:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // All from public Deezer API — no addon needed for search metadata
    const [trackRes, albumRes, artistRes, playlistRes] = await Promise.allSettled([
      axios.get(`${DEEZER_API}/search`,          { params: { q: query, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/search/album`,    { params: { q: query, limit: 8  }, headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/search/artist`,   { params: { q: query, limit: 6  }, headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/search/playlist`, { params: { q: query, limit: 4  }, headers: { 'User-Agent': UA }, timeout: 8000 }),
    ]);

    const rawTracks   = trackRes.status    === 'fulfilled' ? (trackRes.value.data?.data    || []) : [];
    const rawAlbums   = albumRes.status    === 'fulfilled' ? (albumRes.value.data?.data    || []) : [];
    const rawArtists  = artistRes.status   === 'fulfilled' ? (artistRes.value.data?.data   || []) : [];
    const rawPlaylists = playlistRes.status === 'fulfilled' ? (playlistRes.value.data?.data || []) : [];

    const tracks = rawTracks.slice(0, 20).map(t => ({
      id:         `deezer:${t.id}`,
      title:      t.title || 'Unknown',
      artist:     t.artist?.name || 'Unknown',
      album:      t.album?.title || '',
      duration:   t.duration || undefined,
      artworkURL: t.album?.cover_xl || t.album?.cover_big || t.album?.cover || null,
      format:     'mp3',
      source:     'deezer',
    }));
    const albums = rawAlbums.slice(0, 8).map(a => ({
      id:         `deezer:album:${a.id}`,
      title:      a.title || 'Unknown Album',
      artist:     a.artist?.name || 'Unknown',
      artworkURL: a.cover_xl || a.cover_big || a.cover || null,
      year:       safeYear(a.release_date),
      source:     'deezer',
    }));
    const artists = rawArtists.slice(0, 6).map(a => ({
      id:         `deezer:artist:${a.id}`,
      name:       a.name || 'Unknown Artist',
      artworkURL: a.picture_xl || a.picture_big || a.picture || null,
      source:     'deezer',
    }));
    const playlists = rawPlaylists.slice(0, 4).map(p => ({
      id:         `deezer:playlist:${p.id}`,
      title:      p.title || 'Unknown Playlist',
      artist:     p.user?.name || 'Deezer',
      artworkURL: p.picture_xl || p.picture_big || p.picture || null,
      trackCount: p.nb_tracks || undefined,
      source:     'deezer',
    }));
    const result = { tracks, albums, artists, playlists };
    await cacheSet(cacheKey, result, 300);
    return result;
  } catch (e) {
    console.warn('Deezer search error:', e.message);
    return { tracks: [], albums: [], artists: [], playlists: [] };
  }
}

async function deezerStream(trackId) {
  // trackId is the numeric Deezer ID (strip "deezer:" prefix if present)
  const numericId = String(trackId).replace(/^deezer:/, '');
  const cacheKey = `dz:stream:${numericId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const r = await axios.get(`${DEEZER_ADDON}/stream/${numericId}`, {
      headers: { 'User-Agent': UA },
      timeout: 10000,
    });
    const data = r.data || {};
    if (data.url) {
      const result = { url: data.url, format: data.format || 'mp3', quality: data.quality || '320kbps', source: 'deezer' };
      // FIX: use expiresAt from addon response for cache TTL (was hardcoded 1800s)
      const ttlSec = data.expiresAt ? Math.max(60, Math.floor((data.expiresAt - Date.now()) / 1000) - 30) : 1200;
      await cacheSet(cacheKey, result, ttlSec);
      return result;
    }
    return null;
  } catch (e) {
    console.warn('Deezer stream error:', e.message);
    return null;
  }
}

async function deezerAlbum(albumId) {
  const cacheKey = `dz:album:${albumId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const [metaRes, tracksRes] = await Promise.allSettled([
      axios.get(`${DEEZER_API}/album/${albumId}`, { headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/album/${albumId}/tracks`, { params: { limit: 100 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
    ]);
    const meta = metaRes.status === 'fulfilled' ? (metaRes.value.data || {}) : {};
    const rawTracks = tracksRes.status === 'fulfilled' ? (tracksRes.value.data?.data || []) : [];
    const artworkURL = meta.cover_xl || meta.cover_big || meta.cover || null;
    const artistName = meta.artist?.name || 'Unknown';
    const tracks = rawTracks.map((t, i) => ({
      id: `deezer:${t.id}`, title: t.title || 'Unknown',
      artist: t.artist?.name || artistName, album: meta.title || '',
      duration: t.duration || undefined, artworkURL,
      format: 'mp3', source: 'deezer', trackNumber: t.track_position || (i + 1),
    }));
    const result = {
      id: `deezer:album:${albumId}`, title: meta.title || 'Unknown Album',
      artist: artistName, artworkURL, year: safeYear(meta.release_date), tracks,
    };
    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) {
    console.warn('Deezer album error:', e.message);
    return null;
  }
}

async function deezerArtist(artistId) {
  const cacheKey = `dz:artist:${artistId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const [infoRes, topRes, albumsRes] = await Promise.allSettled([
      axios.get(`${DEEZER_API}/artist/${artistId}`, { headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/artist/${artistId}/top`, { params: { limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/artist/${artistId}/albums`, { params: { limit: 50 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
    ]);
    const info = infoRes.status === 'fulfilled' ? (infoRes.value.data || {}) : {};
    const rawTop = topRes.status === 'fulfilled' ? (topRes.value.data?.data || []) : [];
    const rawAlbums = albumsRes.status === 'fulfilled' ? (albumsRes.value.data?.data || []) : [];
    const artworkURL = info.picture_xl || info.picture_big || info.picture || null;
    const artistName = info.name || 'Unknown Artist';
    const topTracks = rawTop.map(t => ({
      id: `deezer:${t.id}`, title: t.title || 'Unknown', artist: artistName,
      album: t.album?.title || '', duration: t.duration || undefined,
      artworkURL: t.album?.cover_xl || t.album?.cover_big || artworkURL, format: 'mp3', source: 'deezer',
    }));
    const albums = rawAlbums.map(a => ({
      id: `deezer:album:${a.id}`, title: a.title || 'Unknown Album', artist: artistName,
      artworkURL: a.cover_xl || a.cover_big || a.cover || null,
      year: safeYear(a.release_date), source: 'deezer',
    }));
    const result = {
      id: `deezer:artist:${artistId}`, name: artistName, artworkURL, topTracks, albums,
    };
    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) {
    console.warn('Deezer artist error:', e.message);
    return null;
  }
}

async function deezerPlaylist(playlistId) {
  const cacheKey = `dz:playlist:${playlistId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // Single call: api.deezer.com/playlist/{id} already includes up to 25 embedded tracks
    const metaRes = await axios.get(`${DEEZER_API}/playlist/${playlistId}`, {
      headers: { 'User-Agent': UA }, timeout: 8000,
    });
    const meta = metaRes.data || {};
    if (!meta.id) return null;

    // Use embedded tracks from meta; if more exist, fetch the /tracks endpoint too
    const embeddedTracks = meta.tracks?.data || [];
    const totalTracks    = meta.tracks?.total || embeddedTracks.length;
    let allRawTracks     = embeddedTracks;

    if (totalTracks > embeddedTracks.length) {
      // Fetch remaining tracks (up to 100 total)
      try {
        const tracksRes = await axios.get(`${DEEZER_API}/playlist/${playlistId}/tracks`, {
          params: { limit: 100, index: 0 }, headers: { 'User-Agent': UA }, timeout: 8000,
        });
        const fetched = tracksRes.data?.data || [];
        if (fetched.length > embeddedTracks.length) allRawTracks = fetched;
      } catch(e2) { /* use embedded tracks */ }
    }

    const mapTrack = t => ({
      id:         `deezer:${t.id}`,
      title:      t.title || t.title_short || 'Unknown',
      artist:     t.artist?.name || 'Unknown',
      album:      t.album?.title || meta.title || '',
      duration:   t.duration || undefined,
      artworkURL: t.album?.cover_xl || t.album?.cover_big || meta.picture_xl || meta.picture_big || null,
      isrc:       t.isrc  || undefined,
      format:     'mp3',
      source:     'deezer',
    });

    const tracks = allRawTracks.map(mapTrack);
    const result = {
      id:         `deezer:playlist:${playlistId}`,
      type:       'playlist',
      title:      meta.title || 'Unknown Playlist',
      artist:     meta.creator?.name || 'Deezer',
      artworkURL: meta.picture_xl || meta.picture_big || null,
      trackCount: totalTracks,
      tracks,
    };    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) {
    console.warn('Deezer playlist error:', e.message);
    return null;
  }
}



// ─── YouTube Music (ported from standalone youtube addon) ─────────────────────
// ─── YouTube Music — Eclipse Addon (Cloudflare Workers) ─────────────────────
// author: ricky | version: 1.4.8

function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
function isValidToken(t) { return typeof t === 'string' && /^[a-f0-9]{28}$/.test(t); }
function parseTokenPath(p) {
  const m = p.match(new RegExp("^/u/([a-f0-9]{28})(/.*)?$"));
  return m ? { token: m[1], rest: m[2] || '/' } : null;
}
function lastSegment(rest) { return rest.split('/').filter(Boolean).pop() || ''; }


// ─── Radio Browser ────────────────────────────────────────────────────────────
const RADIO_BROWSER_HOSTS = [
  'https://de1.api.radio-browser.info',
  'https://fr1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
];

async function getRadioBrowserHost() {
  const cached = await cacheGet('radio:host');
  if (cached) return cached;
  for (const h of RADIO_BROWSER_HOSTS) {
    try {
      await axios.get(`${h}/json/stats`, { timeout: 2000 });
      await cacheSet('radio:host', h, 300);
      return h;
    } catch {}
  }
  return RADIO_BROWSER_HOSTS[0];
}

async function radioSearch(query) {
  const cacheKey = `radio:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const host = await getRadioBrowserHost();
  try {
    const res = await axios.get(`${host}/json/stations/search`, {
      params: { name: query, limit: 10, hidebroken: true, order: 'votes', reverse: true },
      headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' },
      timeout: 5000,
    });
    const stations = (res.data || []).map(s => ({
      id: `radio_${s.stationuuid}`,
      title: s.name || 'Unknown Station',
      artist: `${s.country || ''} ${s.tags ? '· ' + s.tags.split(',').slice(0,2).join(', ') : ''}`.trim(),
      album: 'Live Radio',
      duration: 0,
      artworkURL: s.favicon || '',
      format: s.codec?.toLowerCase() || 'mp3',
      streamURL: s.url_resolved || s.url,
      _source: 'radio',
      _stationuuid: s.stationuuid,
    }));
    // Also search by tag (genre)
    const tagRes = await axios.get(`${host}/json/stations/bytag/${encodeURIComponent(query)}`, {
      params: { limit: 5, hidebroken: true, order: 'votes', reverse: true },
      headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' },
      timeout: 5000,
    }).catch(() => ({ data: [] }));
    const tagStations = (tagRes.data || []).map(s => ({
      id: `radio_${s.stationuuid}`,
      title: s.name || 'Unknown Station',
      artist: `${s.country || ''} ${s.tags ? '· ' + s.tags.split(',').slice(0,2).join(', ') : ''}`.trim(),
      album: 'Live Radio',
      duration: 0,
      artworkURL: s.favicon || '',
      format: s.codec?.toLowerCase() || 'mp3',
      streamURL: s.url_resolved || s.url,
      _source: 'radio',
      _stationuuid: s.stationuuid,
    }));
    const combined = [...stations, ...tagStations].reduce((acc, s) => {
      if (!acc.find(x => x._stationuuid === s._stationuuid)) acc.push(s);
      return acc;
    }, []).slice(0, 12);
    await cacheSet(cacheKey, combined, 300);
    return combined;
  } catch (e) {
    console.warn('[Radio] search error:', e.message);
    return [];
  }
}


// ─── Routes ──────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════

// ── SomaFM — free, no-key internet radio ──────────────────────────────────────
async function somaFmSearch(query) {
  const cacheKey = `somafm:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://api.somafm.com/channels.json', {
      headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' },
      timeout: 5000,
    });
    const channels = res.data?.channels || [];
    const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const scored = channels.map(ch => {
      const name  = (ch.title || '').toLowerCase();
      const genre = (ch.genre || '').toLowerCase();
      const desc  = (ch.description || '').toLowerCase();
      let score = 1;
      if (name === q)            score = 500;
      else if (name.includes(q)) score = 300;
      else if (genre.includes(q)) score = 200;
      else if (desc.includes(q)) score = 100;
      return { ch, score };
    }).sort((a, b) => b.score - a.score).slice(0, 15);

    const stations = scored.map(({ ch }) => {
      const stream =
        ch.playlists?.find(p => p.format === 'mp3' && p.quality === 'highest')?.url ||
        ch.playlists?.find(p => p.format === 'aac')?.url ||
        ch.playlists?.[0]?.url || null;
      if (!stream) return null;
      return {
        id: `somafm:${ch.id}`,
        title: ch.title || 'SomaFM Station',
        artist: ch.genre || 'SomaFM',
        album: 'Live Radio \u00b7 SomaFM',
        duration: 0,
        artworkURL: ch.xlimage || ch.image || null,
        format: stream.includes('.m3u') ? 'hls' : 'mp3',
        streamURL: stream,
        source: 'somafm',
      };
    }).filter(Boolean);

    await cacheSet(cacheKey, stations, 300);
    return stations;
  } catch (e) {
    console.warn('SomaFM search error:', e.message);
    return [];
  }
}

// PATCH: Replace the existing buildManifest function + manifest routes block.
//
// FIND this in your index.js (search for "// Manifest (with and without token)"):
//
//   // Manifest (with and without token)
//   function buildManifest(token) { ... }
//   app.get('/manifest.json', ...);
//   app.get('/:token/manifest.json', ...);
//
// REPLACE the entire block above with everything below this line:
// ═══════════════════════════════════════════════════════════════════════════

// ── Manifest routes ─────────────────────────────────────────────────────────
// Eclipse uses contentType in the manifest to decide which player UI to show.
// One manifest can only have one contentType, so we expose three manifest routes:
//   /{token}/manifest.json           → music player  (main addon)
//   /{token}/podcast/manifest.json   → podcast player
//   /{token}/audiobook/manifest.json → audiobook player
// All three routes hit the exact same search/stream/catalog endpoints.

function buildManifest(token, type) {
  const prefix = `com.eclipse.universal${token ? '.' + token.slice(0, 8) : ''}`;

  if (type === 'podcast') {
    return {
      id: prefix + '.podcast',
      name: 'Podcasts',
      version: '1.4.0',
      description: 'Podcast episodes and series from Podcast Index, Taddy, and Apple Podcasts',
      icon: 'https://www.jermelpresident.com/wp-content/uploads/2020/10/ApplePodcastHP.jpg',
      resources: ['search', 'stream', 'catalog'],
      types: ['track', 'album', 'artist', 'playlist'],
      contentType: 'podcast',
    };
  }

  if (type === 'audiobook') {
    return {
      id: prefix + '.audiobook',
      name: 'Audiobooks',
      version: '1.4.0',
      description: 'Public domain audiobooks from LibriVox and Internet Archive',
      icon: 'https://play-lh.googleusercontent.com/-x0uIYaNWONIRefvL7u4pi75rh4fi5441J0EelEpoOaGRZbAPdhRqKxBu-cvvCV5dw',
      resources: ['search', 'stream', 'catalog'],
      types: ['track', 'album', 'artist', 'playlist'],
      contentType: 'audiobook',
    };
  }

  if (type === 'radio') {
    return {
      id: prefix + '.radio',
      name: 'Radio',
      version: '1.4.0',
      description: 'Live internet radio from Radio Browser (250 k+ stations) and SomaFM',
      icon: 'https://img.freepik.com/premium-vector/radio-icon-vector-logo-template_917138-1337.jpg',
      resources: ['search', 'stream', 'catalog'],
      types: ['track', 'album', 'artist', 'playlist'],
      contentType: 'music',
    };
  }

  // Default: music
  return {
    id: prefix,
    name: 'All In One',
    version: '1.4.0',
    description: 'All-in-one: HiFi music, SoundCloud, Internet Archive, Podcasts, Audiobooks, and Live Radio',
    icon: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTueIUOQATc6lrir4FpwhFl9P656MBFPkvOV03N5P3zlA&s=10',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
  };
}

// ── Main manifest (music player) ─────────────────────────────────────────────

app.get('/:config/stats', async (c) => {
  return c.json({
    uptime: Math.floor(process.uptime?.() || 0),
    stats: _stats,
    instances: {
      qobuz: QOBUZ_INSTANCES,
      hifi_defaults: DEFAULT_HIFI_INSTANCES,
      keepalive_targets: KEEPALIVE_TARGETS,
    },
  });
});


app.get('/manifest.json', c => c.json(buildManifest(null, 'music')));
app.get('/:token/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'music')));

// ── Podcast sub-manifest → podcast player UI ─────────────────────────────────
// Install URL: https://your-addon.vercel.app/{token}/podcast/manifest.json
app.get('/podcast/manifest.json', c => c.json(buildManifest(null, 'podcast')));
app.get('/:token/podcast/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'podcast')));

// ── Audiobook sub-manifest → audiobook player UI ─────────────────────────────
// Install URL: https://your-addon.vercel.app/{token}/audiobook/manifest.json
app.get('/audiobook/manifest.json', c => c.json(buildManifest(null, 'audiobook')));
app.get('/:token/audiobook/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'audiobook')));

// ── Radio sub-manifest → music player UI (Radio Browser + SomaFM only) ────────
// Install URL: https://your-addon.vercel.app/{token}/radio/manifest.json
app.get('/radio/manifest.json', c => c.json(buildManifest(null, 'radio')));
app.get('/:token/radio/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'radio')));

// Search (with and without token)


// ─── Stats tracking ──────────────────────────────────────────────────────────
const _stats = { hits: {}, misses: {}, errors: {} };
function statHit(src)   { _stats.hits[src]   = (_stats.hits[src]   || 0) + 1; }
function statMiss(src)  { _stats.misses[src]  = (_stats.misses[src]  || 0) + 1; }
function statErr(src)   { _stats.errors[src]  = (_stats.errors[src]  || 0) + 1; }


// ─── Qobuz Instance Retry Helper ─────────────────────────────────────────────
// Retries each instance up to 3 times before moving on.
// Permanent errors (403/404/401) are not retried.
async function qobuzGet(url, params, timeout = 7000) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await axios.get(url, { params, headers: { 'User-Agent': UA }, timeout });
      return r;
    } catch(e) {
      const status = e.response?.status;
      if (status === 403 || status === 404 || status === 401) throw e; // permanent, don't retry
      if (attempt < MAX_RETRIES) {
        await new Promise(res => setTimeout(res, 500));
        continue;
      }
      throw e; // gave up after MAX_RETRIES
    }
  }
}

// ─── Rate Limiting (two-tier sliding window) ──────────────────────────────────
// Tier 1: 300 req/min  — kills burst attacks (legit peak is ~50/min)
// Tier 2: 2000 req/10min — kills sustained scrapers
async function checkRateLimit(env, ip) {
  if (!env?.UPSTASH_REDIS_REST_URL || !env?.UPSTASH_REDIS_REST_TOKEN) return true;
  const now10 = Math.floor(Date.now() / 600000); // 10-min bucket
  const now1  = Math.floor(Date.now() / 60000);  // 1-min bucket
  const k1  = `rl1:${ip}:${now1}`;
  const k10 = `rl10:${ip}:${now10}`;
  try {
    const [r1, r10] = await Promise.all([
      upstashCmd(env, 'INCR', k1).then(async n => {
        if (n === 1) upstashCmd(env, 'EXPIRE', k1, 90).catch(()=>{}); // 90s TTL
        return n;
      }),
      upstashCmd(env, 'INCR', k10).then(async n => {
        if (n === 1) upstashCmd(env, 'EXPIRE', k10, 660).catch(()=>{}); // 11min TTL
        return n;
      }),
    ]);
    if (r1 > 300)  return false; // burst: >300 in 1 min
    if (r10 > 2000) return false; // sustained: >2000 in 10 min
  } catch(e) {}
  return true;
}

async function handleSearch(c) {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'unknown';
  if (!(await checkRateLimit(c.env, ip))) return c.json({ error: 'Too many requests.' }, 429);
  const query = c.req.query('q') || '';
  if (!query || query.trim().length < 2) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const TOTAL_MS = 7000;
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);
  }

  // Fire all sources — source flags gate whether results are used, not whether calls fire
  const [
    hifiRes, scRes, iaMusicRes,
    piRes, taddyRes, appleRes,
    lvoxRes, iaBookRes, radioRes,
    qobuzRes, deezerRes,
  ] = await Promise.all([
    withTimeout(hifiSearch(query, cfg.hifiInstances),            7000),
    withTimeout(scSearch(query, cfg.scClientId),                 7000),
    withTimeout(iaSearchMusic(query),                            4000),
    cfg.noPodcast   ? Promise.resolve(null) : withTimeout(piSearchEpisodes(query, cfg.piKey, cfg.piSecret), TOTAL_MS),
    cfg.noPodcast   ? Promise.resolve(null) : withTimeout(taddySearch(query, cfg.taddyKey, cfg.taddyUid),  TOTAL_MS),
    cfg.noPodcast   ? Promise.resolve(null) : withTimeout(appleSearch(query),                              TOTAL_MS),
    cfg.noAudiobook ? Promise.resolve(null) : cfg.noLibrivox ? Promise.resolve(null) : withTimeout(librivoxSearch(query),                           TOTAL_MS),
    cfg.noAudiobook ? Promise.resolve(null) : withTimeout(iaSearchAudiobooks(query),                       TOTAL_MS),
    cfg.noRadio     ? Promise.resolve(null) : cfg.noRadio ? Promise.resolve(null) : withTimeout(radioSearch(query),                              4000),
    withTimeout(qobuzSearch(query),                              7000),
    (cfg.noDeezer && !cfg.searchOrder.includes('deezer')) ? Promise.resolve(null) : withTimeout(deezerSearch(query), 7000),
  ]);

  const scResult    = scRes    || {};
  const scRaw       = Array.isArray(scResult) ? scResult : (scResult.tracks    || []);
  // Persist sc:meta to Upstash now that we have c.env (parallel, non-blocking)
  // MSET: write all 20 sc:meta in ONE Upstash command instead of 20
  const _msetArgs = [];
  for (const _t of scRaw) {
    if (_t._origId && _t.title) {
      const _mv = { title: _t.title, artist: _t.artist || '', isrc: _t.isrc || null };
      cacheSet(`sc:meta:${_t._origId}`, _mv, 3600);
      _msetArgs.push(`sc:meta:${_t._origId}`, JSON.stringify(_mv));
    }
  }
  if (_msetArgs.length) upstashCmd(c.env, 'MSET', ..._msetArgs).catch(()=>{});
  const sc          = cfg.noSc   ? [] : scRaw;
  const scPlaylists = cfg.noSc   ? [] : (Array.isArray(scResult) ? [] : (scResult.playlists || []));
  const iaMusicRaw  = iaMusicRes || [];
  const iaMusic     = cfg.noIa   ? [] : iaMusicRaw;

  const piResult    = piRes    || { playlists: [], episodes: [], albums: [] };
  const taddyResult = taddyRes || { playlists: [], episodes: [], albums: [] };
  const appleResult = appleRes || { playlists: [], episodes: [], albums: [] };
  const lvox        = (cfg.noAudiobook ? [] : lvoxRes)    || [];
  const iaBooks     = (cfg.noAudiobook ? [] : iaBookRes)  || [];
  const radio       = (cfg.noRadio     ? [] : radioRes)   || [];
  const piAlbums    = piResult.albums    || [];
  const taddyAlbums = taddyResult.albums || [];
  const appleAlbums = appleResult.albums || [];

  // Qobuz search results
  const qobuzResult    = qobuzRes || { tracks: [], albums: [], artists: [], playlists: [] };
  const qobuzTracks    = cfg.noQobuz ? [] : (qobuzResult.tracks    || []);
  const qobuzAlbums    = cfg.noQobuz ? [] : (qobuzResult.albums    || []);
  const qobuzArtists   = cfg.noQobuz ? [] : (qobuzResult.artists   || []);
  const qobuzPlaylists = cfg.noQobuz ? [] : (qobuzResult.playlists || []);

  // Merge podcast episodes: PI first, then Taddy (dedupe by title)
  const episodeTitles = new Set();
  const allEpisodes = [];
  if (!cfg.noPodcast) {
    for (const ep of [...(piResult.episodes || []), ...(taddyResult.episodes || []), ...(appleResult.episodes || [])]) {
      const key = ep.title?.toLowerCase().slice(0, 40);
      if (!episodeTitles.has(key)) { episodeTitles.add(key); allEpisodes.push(ep); }
    }
  }

  // Merge podcast series: PI first, then Taddy
  const seriesTitles = new Set();
  const deezerPlaylists = cfg.noDeezer ? [] : (deezerRes?.playlists || []);
  const allSeries = [];
  {
    const _podLists = cfg.noPodcast ? [] : [
      ...(piResult.playlists   || []),
      ...(taddyResult.playlists || []),
      ...(appleResult.playlists || []),
    ];
    for (const s of [...scPlaylists, ...deezerPlaylists, ..._podLists]) {
      const key = s.title?.toLowerCase().slice(0, 40);
      if (!seriesTitles.has(key)) { seriesTitles.add(key); allSeries.push(s); }
    }
  }

  // Merge audiobook albums: LibriVox first, then IA
  const bookTitles = new Set();
  const allBooks = [];
  if (!cfg.noAudiobook) {
    for (const b of [...lvox, ...iaBooks]) {
      const key = b.title?.toLowerCase().slice(0, 40);
      if (!bookTitles.has(key)) { bookTitles.add(key); allBooks.push(b); }
    }
  }

  // Normalize HiFi result (now returns object)
  const hifiResult     = (cfg.noHifi ? {} : hifiRes) || {};
  const hifiTrackList  = Array.isArray(hifiResult) ? hifiResult : (hifiResult.tracks  || []);
  const hifiAlbumList  = Array.isArray(hifiResult) ? []         : (hifiResult.albums  || []);
  const hifiArtistList = Array.isArray(hifiResult) ? []         : (hifiResult.artists || []);

  // Re-encode instB64 for tracks that came back with raw inst
  const hifiTracksNorm = hifiTrackList.map(t => {
    if (t.id && t.id.startsWith('hifi_')) return t;
    const instB64 = encodeBase64Url(t._inst || '');
    return { ...t, id: `hifi_${instB64}_${t._origId || t.id}` };
  });

  // Dedupe podcast albums
  const podcastAlbumSet = new Set();
  const podcastAlbums = [];
  for (const a of [...piAlbums, ...taddyAlbums, ...appleAlbums]) {
    if (!podcastAlbumSet.has(a.id)) { podcastAlbumSet.add(a.id); podcastAlbums.push(a); }
  }

  // Smart query-type detection
  const qLow = query.toLowerCase();
  const isPodcastQuery = /podcast|episode|rogan|lex fridman|serial|npr|radiolab|conan|armchair|smartless|call her daddy|pardon my take|crime junkie|huberman|theo von|apple podcast/i.test(qLow)
    || (allEpisodes.length > 0 && hifiTrackList.length === 0);
  const isRadioQuery    = /\bfm\b|radio|station|lofi|lo-fi|chillhop|chillout|ambient|bbc|rnz/i.test(qLow);
  const isAudiobookQuery = /audiobook|librivox|sherlock|austen|dickens|tolkien|public domain/i.test(qLow);

  // Build ordered music track pool respecting user-selected search priority.
  // searchOrder contains ONLY the sources the user wants — treat it as the allow-list.
  // The no_ flags are for completely disabling a source; if a source appears in searchOrder
  // it means the user explicitly wants it, so honour that over the no_ flag.
  const defaultMusicOrder = ['hifi', 'qobuz', 'deezer', 'sc', 'ia'];
  const effectiveMusicOrder = cfg.searchOrder.length > 0
    ? cfg.searchOrder.filter(k => defaultMusicOrder.includes(k))
    : defaultMusicOrder.filter(k => {
        if (k === 'hifi'   && cfg.noHifi)   return false;
        if (k === 'qobuz'  && cfg.noQobuz)  return false;
        if (k === 'sc'     && cfg.noSc)     return false;
        if (k === 'ia'     && cfg.noIa)     return false;
        if (k === 'deezer' && cfg.noDeezer && !cfg.searchOrder.includes('deezer')) return false;
        return true;
      });

  // Source results — a source is included if it appears in effectiveMusicOrder.
  // effectiveMusicOrder is built from searchOrder (user's explicit pick) or defaults minus disabled.
  const deezerTracks = (deezerRes?.tracks || []).map(t => ({
    ...t, id: t.id, title: t.title, artist: t.artist, album: t.album || '',
    artworkURL: t.artworkURL, duration: t.duration, format: t.format || 'mp3',
  }));
  // Cache deezer track metadata so stream handler can cross-source fallback without query params
  for (const dt of deezerTracks) {
    const rawId = String(dt.id).replace(/^deezer:/, '');
    cacheSet(`dz:track:meta:${rawId}`, { title: dt.title, artist: dt.artist, isrc: dt.isrc ? dt.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null }, 3600);
  }
  const musicSourceMap = {
    hifi:   effectiveMusicOrder.includes('hifi')   ? hifiTracksNorm : [],
    qobuz:  effectiveMusicOrder.includes('qobuz')  ? qobuzTracks    : [],
    sc:     effectiveMusicOrder.includes('sc')     ? sc             : [],
    ia:     effectiveMusicOrder.includes('ia')     ? iaMusic        : [],
    deezer: effectiveMusicOrder.includes('deezer') ? deezerTracks   : [],
  };
  const musicAlbumMap = {
    hifi:   effectiveMusicOrder.includes('hifi')   ? hifiAlbumList       : [],
    qobuz:  effectiveMusicOrder.includes('qobuz')  ? qobuzAlbums         : [],
    sc:     [],
    ia:     [],
    deezer: effectiveMusicOrder.includes('deezer') ? (deezerRes?.albums || []) : [],
  };

  // ── Canonical dedup ─────────────────────────────────────────────────────────
  // Key priority: ISRC (exact) → title+artist+year+duration-bucket (fuzzy, ±2 s)
  const _normStr = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);

  const _canonKey = item => {
    if (item.isrc) return 'isrc:' + item.isrc.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const t  = _normStr(item.title  || '');
    const a  = _normStr((item.artist || '').split(/[,&]/)[0]);
    const y  = item.year ? String(item.year).slice(0, 4) : '';
    // 10-second buckets; interleave() adds a hard 15-second cross-check on top
    const dur = (item.duration && item.duration > 5) ? item.duration : 0;
    const db  = dur ? '|d' + (Math.round(dur / 10) * 10) : '';
    if (!t && !a) return null; // don't dedup unknown tracks against each other
    return 'ta:' + t + '|' + a + '|' + y + db;
  };

  const _canonAlbKey = item => {
    const t = _normStr(item.title  || '');
    const a = _normStr((item.artist || '').split(/[,&]/)[0]);
    const y = item.year ? String(item.year).slice(0, 4) : '';
    return 'alb:' + t + '|' + a + '|' + y;
  };

  const interleave = (sourceLists) => {
    const result = [], seenIds = new Set(), seenKeys = new Set();
    // seenKeyDur: first-seen duration per canon key.
    // Same title+artist but duration >15s apart = genuinely different track.
    const seenKeyDur = new Map();
    const maxLen = Math.max(0, ...sourceLists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
      for (const list of sourceLists) {
        if (i >= list.length) continue;
        const item = list[i];
        if (!item) continue;
        const ik = item.id, ck = _canonKey(item);
        if (ik && seenIds.has(ik)) continue;
        if (ck && seenKeys.has(ck)) {
          const prevDur = seenKeyDur.get(ck) || 0;
          const curDur  = (item.duration && item.duration > 5) ? item.duration : 0;
          if (prevDur > 10 && curDur > 10 && Math.abs(prevDur - curDur) > 15) {
            if (ik) seenIds.add(ik);
            result.push(item);
          }
          continue;
        }
        if (ik) seenIds.add(ik);
        if (ck) {
          seenKeys.add(ck);
          if (item.duration && item.duration > 5) seenKeyDur.set(ck, item.duration);
        }
        result.push(item);
      }
    }
    return result;
  };

  const interleaveAlbums = (sourceLists) => {
    const result = [], seenIds = new Set(), seenKeys = new Set();
    const maxLen = Math.max(0, ...sourceLists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
      for (const list of sourceLists) {
        if (i >= list.length) continue;
        const item = list[i];
        if (!item) continue;
        const ik = item.id, ck = _canonAlbKey(item);
        if (ik && seenIds.has(ik))   continue;
        if (ck && seenKeys.has(ck))  continue;
        if (ik) seenIds.add(ik);
        if (ck) seenKeys.add(ck);
        result.push(item);
      }
    }
    return result;
  };

  const orderedTrackLists = effectiveMusicOrder.map(k => musicSourceMap[k] || []);
  const orderedAlbumLists = effectiveMusicOrder.map(k => musicAlbumMap[k] || []);
  const orderedMusicTracks = interleave(orderedTrackLists);
  const orderedMusicAlbums = interleaveAlbums(orderedAlbumLists);

  // Merge qobuz playlists into the playlists (allSeries) pool — dedupe by title
  for (const p of qobuzPlaylists) {
    const key = p.title?.toLowerCase().slice(0, 40);
    if (!seriesTitles.has(key)) { seriesTitles.add(key); allSeries.push(p); }
  }

  const _seenArtistNames = new Set();
  const _dedupeArtists = list => list.filter(a => {
    const k = _normStr(a.name || '');
    if (!k) return true;
    if (_seenArtistNames.has(k)) return false;
    _seenArtistNames.add(k); return true;
  });
  const _seenAlbumKeys = new Set();
  const _dedupeAlbums = list => list.filter(a => {
    const y = a.year ? String(a.year).slice(0, 4) : '';
    const k = _normStr(a.title || '') + '|' + _normStr((a.artist || '').split(/[,&]/)[0]) + '|' + y;
    if (!k || k === '||') return true;
    if (_seenAlbumKeys.has(k)) return false;
    _seenAlbumKeys.add(k); return true;
  });

  let allTracks, allAlbums, allArtists;
  if (isPodcastQuery) {
    allTracks  = [...allEpisodes, ...orderedMusicTracks, ...radio];
    allAlbums  = [...podcastAlbums, ...allBooks, ...orderedMusicAlbums];
    allArtists = [...hifiArtistList, ...qobuzArtists, ...(deezerRes?.artists || [])];
  } else if (isRadioQuery) {
    allTracks  = [...radio, ...orderedMusicTracks, ...allEpisodes];
    allAlbums  = [...orderedMusicAlbums, ...allBooks, ...podcastAlbums];
    allArtists = [...hifiArtistList, ...qobuzArtists, ...(deezerRes?.artists || [])];
  } else if (isAudiobookQuery) {
    allTracks  = [...orderedMusicTracks, ...allEpisodes, ...radio];
    allAlbums  = [...allBooks, ...orderedMusicAlbums, ...podcastAlbums];
    allArtists = [...qobuzArtists];
  } else {
    allTracks  = [...orderedMusicTracks, ...radio, ...allEpisodes];
    allAlbums  = [...orderedMusicAlbums, ...allBooks, ...podcastAlbums];
    allArtists = [...hifiArtistList, ...qobuzArtists, ...(deezerRes?.artists || [])];
  }

  allArtists = _dedupeArtists(allArtists);
  allAlbums  = _dedupeAlbums(allAlbums);

  const result = {
    tracks:    allTracks.slice(0, 60),
    albums:    allAlbums.slice(0, 16),
    artists:   allArtists.slice(0, 10),
    playlists: allSeries.slice(0, 20),
  };

  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

app.get('/search', handleSearch);
app.get('/:token/search', handleSearch);

// ─── Podcast-only search (/podcast/search) ───────────────────────────────────
async function handlePodcastSearch(c) {
  const query = c.req.query('q') || '';
  if (!query || query.trim().length < 2) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:podcast:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const [podcastData, taddyData, appleData] = await Promise.allSettled([
    piSearchEpisodes(query, cfg.piKey, cfg.piSecret),
    taddySearch(query, cfg.taddyKey, cfg.taddyUid),
    appleSearch(query),
  ]);

  const get = r => (r.status === 'fulfilled' ? r.value : null) || {};

  const piResult    = get(podcastData);
  const taddyResult = get(taddyData);
  const appleResult = get(appleData);

  // Merge episodes (dedupe by title)
  const episodeTitles = new Set();
  const allEpisodes = [];
  for (const ep of [...(piResult.episodes||[]), ...(taddyResult.episodes||[]), ...(appleResult.episodes||[])]) {
    const key = ep.title?.toLowerCase().slice(0, 40);
    if (!episodeTitles.has(key)) { episodeTitles.add(key); allEpisodes.push(ep); }
  }

  // Merge series/playlists (dedupe by title)
  const seriesTitles = new Set();
  const allSeries = [];
  for (const s of [...(piResult.playlists||[]), ...(taddyResult.playlists||[]), ...(appleResult.playlists||[])]) {
    const key = s.title?.toLowerCase().slice(0, 40);
    if (!seriesTitles.has(key)) { seriesTitles.add(key); allSeries.push(s); }
  }

  // Merge podcast show albums (dedupe by id)
  const podcastAlbumSet = new Set();
  const podcastAlbums = [];
  for (const a of [...(piResult.albums||[]), ...(taddyResult.albums||[]), ...(appleResult.albums||[])]) {
    if (!podcastAlbumSet.has(a.id)) { podcastAlbumSet.add(a.id); podcastAlbums.push(a); }
  }

  // Build artist entries from podcast series (show as artist, episodes as their "tracks")
  const podArtists = allSeries.slice(0, 8).map(s => ({
    id:         s.id,
    name:       s.title,
    artworkURL: s.artworkURL || null,
    source:     s.source || 'pi',
  }));

  const result = {
    tracks:    allEpisodes.slice(0, 40),
    albums:    podcastAlbums.slice(0, 12),
    artists:   podArtists,
    playlists: allSeries.slice(0, 20),
  };
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

// ─── Audiobook-only search (/audiobook/search) ───────────────────────────────
async function handleAudiobookSearch(c) {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:audiobook:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const [lvoxAlbums, iaBookAlbums] = await Promise.allSettled([
    librivoxSearch(query),
    iaSearchAudiobooks(query),
  ]);

  const get = r => (r.status === 'fulfilled' ? r.value : null) || [];

  const lvox    = get(lvoxAlbums);
  const iaBooks = get(iaBookAlbums);

  // Merge audiobook albums (dedupe by title)
  const bookTitles = new Set();
  const allBooks = [];
  for (const b of [...lvox, ...iaBooks]) {
    const key = b.title?.toLowerCase().slice(0, 40);
    if (!bookTitles.has(key)) { bookTitles.add(key); allBooks.push(b); }
  }

  // Build flat track list from book albums so Eclipse shows them as playable items
  const bookTracks = allBooks.map(b => ({
    id:         b.id,
    title:      b.title,
    artist:     b.artist || b.creator || 'Unknown Author',
    album:      b.title,
    duration:   b.duration || null,
    artworkURL: b.artworkURL || null,
  }));

  // Build artist entries from unique authors
  const authorSeen = new Set();
  const bookAuthors = [];
  for (const b of allBooks) {
    const name = b.artist || b.creator || 'Unknown Author';
    if (!authorSeen.has(name)) {
      authorSeen.add(name);
      bookAuthors.push({
        id:         `author:${encodeURIComponent(name)}`,
        name,
        artworkURL: b.artworkURL || null,
        source:     b.source || 'librivox',
      });
    }
  }

  // Build playlist entries from source collections
  const bookPlaylists = [
    lvox.length > 0 ? {
      id: 'audiobook:collection:librivox',
      title: 'LibriVox — Free Public Domain Audiobooks',
      creator: 'LibriVox',
      trackCount: lvox.length,
      artworkURL: null,
      source: 'librivox',
    } : null,
    iaBooks.length > 0 ? {
      id: 'audiobook:collection:ia',
      title: 'Internet Archive Audiobooks',
      creator: 'Internet Archive',
      trackCount: iaBooks.length,
      artworkURL: null,
      source: 'iabook',
    } : null,
  ].filter(Boolean);

  const result = {
    tracks:    bookTracks.slice(0, 20),
    albums:    allBooks.slice(0, 20),
    artists:   bookAuthors.slice(0, 10),
    playlists: bookPlaylists,
  };
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

// ─── Sub-routes for podcast manifest base URL ────────────────────────────────
app.get('/podcast/search',              handlePodcastSearch);
app.get('/:token/podcast/search',       handlePodcastSearch);
app.get('/podcast/stream/:id',          handleStream);
app.get('/:token/podcast/stream/:id',   handleStream);
app.get('/podcast/album/:id',           handleAlbumWithHifi);
app.get('/:token/podcast/album/:id',    handleAlbumWithHifi);
app.get('/podcast/playlist/:id',        handlePlaylist);
app.get('/:token/podcast/playlist/:id', handlePlaylist);
app.get('/podcast/artist/:id',          handleArtist);
app.get('/:token/podcast/artist/:id',   handleArtist);

// ─── Sub-routes for audiobook manifest base URL ──────────────────────────────
app.get('/audiobook/search',               handleAudiobookSearch);
app.get('/:token/audiobook/search',        handleAudiobookSearch);
app.get('/audiobook/stream/:id',           handleStream);
app.get('/:token/audiobook/stream/:id',    handleStream);
app.get('/audiobook/album/:id',            handleAlbumWithHifi);
app.get('/:token/audiobook/album/:id',     handleAlbumWithHifi);
app.get('/audiobook/playlist/:id',         handlePlaylist);
app.get('/:token/audiobook/playlist/:id',  handlePlaylist);
app.get('/audiobook/artist/:id',           handleArtist);
app.get('/:token/audiobook/artist/:id',    handleArtist);


// ─── Radio-only search handler (Radio Browser + SomaFM) ──────────────────────
async function handleRadioSearch(c) {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const cacheKey = `search:radio:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const [rbRes, somaRes] = await Promise.allSettled([
    radioSearch(query),
    somaFmSearch(query),
  ]);
  const rb   = rbRes.status   === 'fulfilled' ? (rbRes.value   || []) : [];
  const soma = somaRes.status === 'fulfilled' ? (somaRes.value || []) : [];

  // Merge & dedupe by title
  const seen = new Set();
  const combined = [];
  for (const s of [...rb, ...soma]) {
    const key = (s.title || '').toLowerCase().slice(0, 40);
    if (!seen.has(key)) { seen.add(key); combined.push(s); }
  }

  // Build artist entries from unique genres/tags
  const genreMap = new Map();
  for (const s of combined) {
    const tags = (s.artist || '').split(',').map(t => t.trim()).filter(Boolean);
    for (const tag of tags.slice(0, 2)) {
      if (tag && !genreMap.has(tag)) {
        genreMap.set(tag, {
          id:         `radiogenre:${encodeURIComponent(tag)}`,
          name:       tag,
          artworkURL: s.artworkURL || null,
          source:     s.source || 'radio',
        });
      }
    }
  }
  const radioArtists = [...genreMap.values()].slice(0, 10);

  // Build album entries — one per source (Radio Browser / SomaFM)
  const radioAlbums = [
    rb.length > 0 ? {
      id:         'radio:source:radiobrowser',
      title:      'Radio Browser',
      artist:     'Radio Browser',
      artworkURL: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png',
      trackCount: rb.length,
      year:       0,
      source:     'radio',
    } : null,
    soma.length > 0 ? {
      id:         'radio:source:somafm',
      title:      'SomaFM',
      artist:     'SomaFM',
      artworkURL: 'https://somafm.com/img3/facebook-logo.png',
      trackCount: soma.length,
      year:       0,
      source:     'somafm',
    } : null,
  ].filter(Boolean);

  // Build playlist entries from popular genre buckets
  const GENRE_BUCKETS = ['jazz', 'classical', 'rock', 'pop', 'electronic', 'ambient', 'news', 'talk', 'hip-hop', 'country'];
  const radioPlaylists = GENRE_BUCKETS.map(g => {
    const matches = combined.filter(s => (s.artist || '').toLowerCase().includes(g));
    if (!matches.length) return null;
    return {
      id:         `radioplaylist:${g}`,
      title:      g.charAt(0).toUpperCase() + g.slice(1) + ' Radio',
      creator:    'Radio Browser',
      trackCount: matches.length,
      artworkURL: matches[0]?.artworkURL || null,
      source:     'radio',
    };
  }).filter(Boolean).slice(0, 8);

  const result = {
    tracks:    combined.slice(0, 30),
    albums:    radioAlbums,
    artists:   radioArtists,
    playlists: radioPlaylists,
  };
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

// ─── Sub-routes for radio manifest base URL ───────────────────────────────────
app.get('/radio/search',              handleRadioSearch);
app.get('/:token/radio/search',       handleRadioSearch);
app.get('/radio/album/:id',           handleAlbumWithHifi);
app.get('/:token/radio/album/:id',    handleAlbumWithHifi);
app.get('/radio/playlist/:id',        handlePlaylist);
app.get('/:token/radio/playlist/:id', handlePlaylist);
app.get('/radio/artist/:id',          handleArtist);
app.get('/:token/radio/artist/:id',   handleArtist);
app.get('/radio/stream/:id',          handleStream);
app.get('/:token/radio/stream/:id',   handleStream);

// Lightweight resolve for playlist import — HiFi only, skips podcast/radio/IA overhead
// Use this endpoint for per-track lookups during CSV/link playlist imports
async function handleResolve(c) {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [] });
  const cfg = getConfig(c);
  const cacheKey = `resolve:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);
  try {
    // HiFi first — fastest and highest quality
    const hifiResult = await hifiSearch(query, cfg.hifiInstances);
    let tracks = (Array.isArray(hifiResult) ? hifiResult : (hifiResult.tracks || [])).slice(0, 5);
    // SC fallback only if HiFi came back empty
    if (!tracks.length) {
      const scResult = await scSearch(query, cfg.scClientId);
      tracks = (Array.isArray(scResult) ? scResult : (scResult.tracks || [])).slice(0, 5);
    }
    const result = { tracks };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  } catch (e) {
    console.warn('[resolve] error:', e.message);
    return c.json({ tracks: [] });
  }
}

app.get('/resolve', handleResolve);
app.get('/:token/resolve', handleResolve);

// Stream resolution
async function handleStream(c) {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'unknown';
  if (!(await checkRateLimit(c.env, ip))) return c.json({ error: 'Too many requests.' }, 429);
  const id = c.req.param('id');
  const cfg = getConfig(c);

  if (id.startsWith('hifi_album_')) {
    const data = await hifiAlbum(id);
    if (data) return c.json(data);
    return c.json({ error: 'HiFi album not found' });
  }

  if (id.startsWith('hifi_')) {
    // Check stream URL cache first — makes repeat plays instant
    const streamCacheKey = `stream:url:${id}`;
    const cachedStream = await cacheGet(streamCacheKey);
    if (cachedStream) return c.json(cachedStream);

    // ── Qobuz Hi-Res FIRST (unless hifi is ranked higher in streamOrder) ─────
    const trackKey = id.slice(5); // strip 'hifi_' -> instB64_origId
    const _hifiStreamOrder = cfg.streamOrder && cfg.streamOrder.length ? cfg.streamOrder : [];
    const _hifiQIdx2 = _hifiStreamOrder.indexOf('qobuz');
    const _hifiHIdx2 = _hifiStreamOrder.indexOf('hifi');
    const _skipQobuz = _hifiQIdx2 !== -1 && _hifiHIdx2 !== -1 && _hifiHIdx2 < _hifiQIdx2;
    let qMeta = await cacheGet(`hifi:track:meta:${trackKey}`);
    // FIX: if meta not cached yet (e.g. artist/album page before our patch kicks in for old cache),
    // do a live HiFi track info fetch to populate it so Qobuz-first logic can run
    if (!qMeta && !_skipQobuz) {
      try {
        const _tkParts = trackKey.split('_');
        const _tkInstB64 = _tkParts[0];
        const _tkOrigId = _tkParts.slice(1).join('_');
        const _tkInst = decodeBase64Url(_tkInstB64);
        // FIX: 2s timeout (was 5s) — don't block Qobuz lookup waiting for slow Tidal instances
        const _tkRes = await axios.get(`${_tkInst}/track/`, {
          params: { id: _tkOrigId }, headers: { 'User-Agent': UA }, timeout: 2000,
        });
        const _tkD = _tkRes.data?.data || _tkRes.data || {};
        const _tkT = _tkD.item || _tkD;
        if (_tkT?.title) {
          const _tkArtists = ((_tkT.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED').length
            ? (_tkT.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED')
            : (_tkT.artists||[])).map(a=>a.name).join(', ');
          qMeta = {
            title: _tkT.title,
            artist: _tkArtists || '',
            isrc: _tkT.isrc ? _tkT.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null,
            duration: _tkT.duration ? Math.floor(_tkT.duration) : undefined,
          };
          cacheSet(`hifi:track:meta:${trackKey}`, qMeta, 3600);
        }
      } catch(e) { /* non-fatal — will fall through to native HiFi */ }
    }
    if (!_skipQobuz && (qMeta?.title || qMeta?.isrc)) {
      try {
        const qTrack = await qobuzFindBestTrack(qMeta.title, qMeta.artist, qMeta.isrc || null, c.env, qMeta.duration);
        if (qTrack && qTrack.id) {
          const qStream = await qobuzStream(qTrack.id, c.env);
          if (qStream) {
            const matchInfo = qMeta.isrc ? `ISRC:${qMeta.isrc}` : `"${qMeta.title}" by "${qMeta.artist}"`;
            console.log(`[Qobuz] HIT ${matchInfo} -> id=${qTrack.id} quality=${qStream.quality}`);
            await cacheSet(streamCacheKey, qStream, 280);
            return c.json(qStream);
          }
        }
        console.log(`[Qobuz] no match for "${qMeta.title}" by "${qMeta.artist}"${qMeta.isrc ? ` (ISRC:${qMeta.isrc})` : ''} — falling back to HiFi`);
      } catch(e) {
        console.warn('[Qobuz] error:', e.message);
      }
    }
    // ── HiFi fallback ─────────────────────────────────────────────────────────

    const data = await hifiStream(id, cfg.hifiInstances, cfg.preferredQuality);
    if (data) {
      // Cache stream URLs for 5 minutes (short TTL — they expire)
      await cacheSet(streamCacheKey, data, 280);
      return c.json(data);
    }

    // HiFi failed — walk full streamOrder fallback chain
    const meta = await cacheGet(`hifi:track:meta:${trackKey}`);
    if (meta?.title && meta?.artist) {
      const _fbOrder = (_hifiStreamOrder.length
        ? _hifiStreamOrder.filter(s => s !== 'hifi')
        : ['qobuz', 'deezer', 'sc'] // FIX: explicit default when no streamOrder configured
      );
      console.log(`[stream fallback] HiFi failed for "${meta.title}", trying: ${_fbOrder.join(',')}`);
      for (const _fb of _fbOrder) {
        // ── Qobuz ────────────────────────────────────────────────────────
        // FIX: _fbOrder already filtered by streamOrder, so these checks are safeguards only
        if (_fb === 'qobuz' && !cfg.noQobuz && !_skipQobuz) continue; // already tried above
        if (_fb === 'qobuz' && !cfg.noQobuz && _skipQobuz) {
          try {
            const qTrack = await qobuzFindBestTrack(meta.title, meta.artist, meta.isrc || null, c.env, meta.duration);
            if (qTrack?.id) {
              const _qd = (meta.duration && qTrack.duration) ? Math.abs(meta.duration - qTrack.duration) : 0;
              if (_qd <= 20) {
                const qs = await qobuzStream(qTrack.id, c.env);
                if (qs) { await cacheSet(streamCacheKey, { ...qs, fallback: 'qobuz' }, 280); return c.json({ ...qs, fallback: 'qobuz' }); }
              }
            }
          } catch(e) { console.warn('[fb-qobuz]', e.message); }
        }
        // ── Deezer ───────────────────────────────────────────────────────
        if (_fb === 'deezer' && !cfg.noDeezer) {
          try {
            const dRes = await deezerSearch(`${meta.artist} ${meta.title}`, 5);
            for (const dt of (dRes?.tracks || [])) {
              const _dd = (meta.duration && dt.duration) ? Math.abs(meta.duration - dt.duration) : 0;
              if (_dd > 20) continue;
              const ds = await deezerStream(String(dt.id), c.env);
              if (ds) { await cacheSet(streamCacheKey, { ...ds, fallback: 'deezer' }, 280); return c.json({ ...ds, fallback: 'deezer' }); }
            }
          } catch(e) { console.warn('[fb-deezer]', e.message); }
        }
        // ── SoundCloud ───────────────────────────────────────────────────
        if (_fb === 'sc' && !cfg.noSc) {
          try {
            const cid = await getSCClientId(cfg.scClientId);
            if (cid) {
              const scRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
                params: { q: `${meta.artist} ${meta.title}`, client_id: cid, limit: 8 },
                timeout: 5000,
              });
              const scTracks = scRes.data?.collection || [];
              const scResults = await Promise.all(
                scTracks.map(st => scStream(String(st.id), cid).then(r => ({ r, st })).catch(() => ({ r: null, st })))
              );
              for (const { r: scr, st } of scResults) {
                if (!scr || scr._scSnipped) continue;
                const _sd = (meta.duration && st.full_duration)
                  ? Math.abs(meta.duration - st.full_duration / 1000) : 0;
                if (_sd > 20) { console.log(`[fb-sc] dur mismatch ${_sd}s — skip`); continue; }
                console.log(`[fb-sc] found: "${st.title}" by "${st.user?.username}"`);
                const { _scSnipped, ...clean } = scr;
                const fbr = { ...clean, fallback: 'sc' };
                await cacheSet(streamCacheKey, fbr, 280);
                return c.json(fbr);
              }
            }
          } catch(e) { console.warn('[fb-sc]', e.message); }
        }
      }
    }
    return c.json({ error: 'Stream not found — all fallbacks exhausted' });
  }

  if (id.startsWith('sc_')) {
    const origId = id.slice(3);
    const scStreamCacheKey = `stream:url:${id}`;
    const cachedScStream = await cacheGet(scStreamCacheKey);
    if (cachedScStream) return c.json(cachedScStream);

    // Respect streamOrder — if user put qobuz/hifi before sc, try those first
    let scMeta0 = await cacheGet(`sc:meta:${origId}`);
    if (!scMeta0) {
      try {
        const _raw = await upstashCmd(c.env, 'GET', `sc:meta:${origId}`);
        if (_raw) { scMeta0 = JSON.parse(_raw); await cacheSet(`sc:meta:${origId}`, scMeta0, 3600); }
      } catch(e) {}
    }
    const _scStreamOrder = cfg.streamOrder && cfg.streamOrder.length ? cfg.streamOrder : [];
    const _scIdx = _scStreamOrder.indexOf('sc');
    const _qIdx  = _scStreamOrder.indexOf('qobuz');
    const _hIdx  = _scStreamOrder.indexOf('hifi');

    // Try Qobuz before SC if qobuz is ranked higher (lower index) than sc
    // FIX: ISRC-gate — only upgrade SC tracks that have a confirmed ISRC.
    // Without ISRC, qobuzFindBestTrack does fuzzy title/artist search which matches wrong tracks
    // on SC-exclusive / indie content. If no ISRC, always play natively on SC.
    if (scMeta0?.title && scMeta0?.isrc && _qIdx !== -1 && (_scIdx === -1 || _qIdx < _scIdx) && !cfg.noQobuz) {
      try {
        const qTrack = await qobuzFindBestTrack(scMeta0.title, scMeta0.artist, scMeta0.isrc, c.env, scMeta0.duration);
        if (qTrack?.id) {
          const _qDurDiff = (scMeta0.duration && qTrack.duration)
            ? Math.abs(scMeta0.duration - qTrack.duration) : 999;
          // FIX: tighter 5s guard (was 15s) — prevents wrong-track substitution on close matches
          if (_qDurDiff > 5) {
            console.log(`[SC→Qobuz] dur mismatch ${_qDurDiff}s — playing SC natively`);
          } else {
            const qStream = await qobuzStream(qTrack.id, c.env);
            if (qStream) {
              console.log(`[SC→Qobuz priority] ISRC:${scMeta0.isrc} → qobuz:${qTrack.id}`);
              await cacheSet(scStreamCacheKey, qStream, 280);
              return c.json(qStream);
            }
          }
        }
      } catch(e) { console.warn('[SC→Qobuz priority]', e.message); }
    }

    // Try HiFi/Tidal before SC if hifi is ranked higher than sc — also ISRC-gated
    if (scMeta0?.title && scMeta0?.isrc && _hIdx !== -1 && (_scIdx === -1 || _hIdx < _scIdx) && !cfg.noHifi) {
      try {
        const hifiRes = await hifiSearch(`${scMeta0.artist} ${scMeta0.title}`, cfg.hifiInstances);
        const hifiTracks = Array.isArray(hifiRes) ? hifiRes : (hifiRes?.tracks || []);
        for (const ht of hifiTracks.slice(0, 3)) {
          const _hDurDiff = (scMeta0.duration && ht.duration)
            ? Math.abs(scMeta0.duration - ht.duration) : 999;
          if (_hDurDiff > 5) { console.log(`[SC→HiFi] dur mismatch ${_hDurDiff}s — skip`); continue; }
          const hs = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
          if (hs) {
            console.log(`[SC→HiFi priority] ISRC:${scMeta0.isrc} → ${ht.id}`);
            await cacheSet(scStreamCacheKey, hs, 280);
            return c.json(hs);
          }
        }
      } catch(e) { console.warn('[SC→HiFi priority]', e.message); }
    }

    const data = await scStream(origId, cfg.scClientId);
    if (data) {
      const { _scSnipped, ...cleanData } = data;
      await cacheSet(scStreamCacheKey, cleanData, 280);
      return c.json(cleanData);
    }
    // SC returned null (snipped/blocked) — try HiFi then DAB as fallback
    let scMeta = scMeta0; // reuse already-fetched meta (includes Upstash lookup)
    if (!scMeta) {
      try {
        const _raw2 = await upstashCmd(c.env, 'GET', `sc:meta:${origId}`);
        if (_raw2) scMeta = JSON.parse(_raw2);
      } catch(e) {}
    }
    // If still no meta, try a live SC track lookup (first-time play before search persisted)
    if (!scMeta?.title) {
      try {
        const cid2 = await getSCClientId(cfg.scClientId);
        if (cid2) {
          const _liveRes = await axios.get(`https://api-v2.soundcloud.com/tracks/${origId}`, {
            params: { client_id: cid2 }, timeout: 5000,
          });
          const _lt = _liveRes.data;
          if (_lt?.title) {
            scMeta = {
              title: _lt.publisher_metadata?.title || _lt.title,
              artist: _lt.publisher_metadata?.artist || _lt.user?.name || _lt.user?.username || '',
              isrc: _lt.publisher_metadata?.isrc || null,
              duration: _lt.duration ? Math.floor(_lt.duration / 1000) : undefined, // FIX: was missing, caused fallback dur checks to always use 0
            };
            cacheSet(`sc:meta:${origId}`, scMeta, 3600);
            upstashCmd(c.env, 'SET', `sc:meta:${origId}`, JSON.stringify(scMeta), 'EX', 86400).catch(()=>{});
          }
        }
      } catch(e) { console.warn('[SC meta live lookup]', e.message); }
    }
    if (scMeta?.title && scMeta?.artist) {
      // Walk streamOrder — only try sources the user has enabled
      const _fbOrder = cfg.streamOrder && cfg.streamOrder.length
        ? cfg.streamOrder.filter(s => s !== 'sc') // SC already failed, skip it
        : []; // no streamOrder set = user didn't restrict streams, use defaults below
      const _tryQobuz = _fbOrder.length ? _fbOrder.includes('qobuz') : !cfg.noQobuz;
      const _tryHifi  = _fbOrder.length ? _fbOrder.includes('hifi')  : !cfg.noHifi;
      const _tryDeezer= _fbOrder.length ? _fbOrder.includes('deezer'): !cfg.noDeezer;
      // Sort fallback sources by streamOrder position
      const _fbSources = [];
      if (_fbOrder.length) {
        for (const s of _fbOrder) {
          if (s === 'qobuz' && _tryQobuz) _fbSources.push('qobuz');
          if (s === 'hifi'  && _tryHifi)  _fbSources.push('hifi');
          if (s === 'deezer'&& _tryDeezer)_fbSources.push('deezer');
        }
      } else {
        if (_tryQobuz) _fbSources.push('qobuz');
        if (_tryHifi)  _fbSources.push('hifi');
        if (_tryDeezer)_fbSources.push('deezer');
        // FIX: if all three flags were false (misconfigured cfg), force a default order so fallback always runs
        if (!_fbSources.length) { _fbSources.push('qobuz', 'hifi', 'deezer'); }
      }
      console.log(`[SC fallback] ${origId} snipped — trying [${_fbSources.join(',')}] for ${scMeta.title}`);
      for (const _fbSrc of _fbSources) {
        if (_fbSrc === 'qobuz') {
          try {
            const qTrack = await qobuzFindBestTrack(scMeta.title, scMeta.artist, scMeta.isrc || null, c.env, scMeta.duration);
            if (qTrack?.id) {
              const _sqd = (scMeta.duration && qTrack.duration)
                ? Math.abs(scMeta.duration - qTrack.duration) : 0;
              if (_sqd > 15) {
                console.log(`[SC snipped→Qobuz] dur mismatch ${_sqd}s — skip`);
              } else {
                const qStream = await qobuzStream(qTrack.id, c.env);
                if (qStream) { console.log(`[SC→Qobuz] ${scMeta.isrc || scMeta.title} → ${qTrack.id}`); statHit('qobuz'); return c.json({ ...qStream, fallback: 'qobuz' }); }
              }
            }
          } catch(e) { console.warn('[SC→Qobuz]', e.message); }
        }
        if (_fbSrc === 'hifi') {
          try {
            const hifiRes = await hifiSearch(`${scMeta.artist} ${scMeta.title}`, cfg.hifiInstances);
            const hifiTracks = Array.isArray(hifiRes) ? hifiRes : (hifiRes?.tracks || []);
            for (const ht of hifiTracks.slice(0, 3)) {
              const hifiStreamResult = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
              if (hifiStreamResult) { console.log(`[SC→HiFi] ${scMeta.title} → ${ht.id}`); return c.json({ ...hifiStreamResult, fallback: 'hifi' }); }
            }
          } catch (e) { console.warn('[SC→HiFi]', e.message); }
        }
        if (_fbSrc === 'deezer') {
          try {
            const dzRes = await deezerSearch(`${scMeta.artist} ${scMeta.title}`);
            const dzTrack = dzRes?.tracks?.[0];
            if (dzTrack?.id) {
              const dzId = dzTrack.id.replace('deezer:', '');
              const dzStream = await deezerStream(dzId);
              if (dzStream) { console.log(`[SC→Deezer] ${scMeta.title} → ${dzId}`); statHit('deezer'); return c.json({ ...dzStream, fallback: 'deezer' }); }
            }
          } catch(e) { console.warn('[SC→Deezer]', e.message); }
        }
      }
    }
    return c.json({ error: 'SoundCloud stream not found or restricted' });
  }

  if (id.startsWith('ia_music_')) {
    const identifier = id.slice(9);
    const url = await iaGetBestAudioFile(identifier);
    if (url) return c.json({ url, format: 'mp3', quality: 'variable' });
    return c.json({ error: 'IA stream not found' });
  }

  if (id.startsWith('ia_book_')) {
    const identifier = id.slice(8);
    const url = await iaGetBestAudioFile(identifier);
    if (url) return c.json({ url, format: 'mp3', quality: 'variable' });
    return c.json({ error: 'IA audiobook stream not found' });
  }

  if (id.startsWith('qobuz_')) {
    const qobuzId = id.slice(6);
    const sCacheKey = `stream:url:${id}`;
    const cachedQStream = await cacheGet(sCacheKey);
    if (cachedQStream) return c.json(cachedQStream);
    try {
      const result = await qobuzStream(qobuzId, c.env);
      if (result) {
        await cacheSet(sCacheKey, result, 280);
        return c.json(result);
      }
    } catch(e) { console.warn('[qobuz direct stream]', e.message); }
    // Qobuz failed — try HiFi then SC as ordered fallback
    const _qMeta = await cacheGet(`qobuz:track:meta:${qobuzId}`);
    if (_qMeta?.title) {
      // FIX: only fall back to sources in streamOrder when it's explicitly set
    const _qFbOrder = (cfg.streamOrder?.length
        ? cfg.streamOrder.filter(s => s !== 'qobuz')
        : ['hifi', 'deezer', 'sc']
      );
      for (const _qfb of _qFbOrder) {
        if (_qfb === 'hifi' && !cfg.noHifi && cfg.hifiInstances?.length) {
          try {
            const _hRes = await hifiSearch(`${_qMeta.artist} ${_qMeta.title}`, cfg.hifiInstances);
            const _hTracks = Array.isArray(_hRes) ? _hRes : (_hRes?.tracks || []);
            for (const _ht of _hTracks.slice(0, 3)) {
              const _hd = (_qMeta.duration && _ht.duration) ? Math.abs(_qMeta.duration - _ht.duration) : 0;
              if (_hd > 20) continue;
              const _hs = await hifiStream(_ht.id, cfg.hifiInstances, cfg.preferredQuality);
              if (_hs) { await cacheSet(sCacheKey, { ..._hs, fallback: 'hifi' }, 280); return c.json({ ..._hs, fallback: 'hifi' }); }
            }
          } catch(e) { console.warn('[qobuz fb-hifi]', e.message); }
        }
        if (_qfb === 'deezer' && !cfg.noDeezer) {
          try {
            const _dRes = await deezerSearch(`${_qMeta.artist} ${_qMeta.title}`, 5);
            for (const _dt of (_dRes?.tracks || [])) {
              const _dd = (_qMeta.duration && _dt.duration) ? Math.abs(_qMeta.duration - _dt.duration) : 0;
              if (_dd > 20) continue;
              const _ds = await deezerStream(String(_dt.id), c.env);
              if (_ds) { await cacheSet(sCacheKey, { ..._ds, fallback: 'deezer' }, 280); return c.json({ ..._ds, fallback: 'deezer' }); }
            }
          } catch(e) { console.warn('[qobuz fb-deezer]', e.message); }
        }
        if (_qfb === 'sc' && !cfg.noSc) {
          try {
            const _cid = await getSCClientId(cfg.scClientId);
            if (_cid) {
              const _scR = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
                params: { q: `${_qMeta.artist} ${_qMeta.title}`, client_id: _cid, limit: 6 },
                timeout: 5000,
              });
              for (const _st of (_scR.data?.collection || [])) {
                const _sd = (_qMeta.duration && _st.full_duration)
                  ? Math.abs(_qMeta.duration - _st.full_duration / 1000) : 0;
                if (_sd > 20) continue;
                const _ss = await scStream(String(_st.id), _cid);
                if (_ss && !_ss._scSnipped) {
                  const { _scSnipped, ...clean } = _ss;
                  await cacheSet(sCacheKey, { ...clean, fallback: 'sc' }, 280);
                  return c.json({ ...clean, fallback: 'sc' });
                }
              }
            }
          } catch(e) { console.warn('[qobuz fb-sc]', e.message); }
        }
      }
    }
    return c.json({ error: 'Stream not found — all fallbacks exhausted' });
  }

  if (id.startsWith('radio_')) {
    // Radio stream URLs are stored directly in search results as streamURL
    // If we get here, try to find from cache
    return c.json({ error: 'Radio stream: use streamURL from search result' });
  }

  // Podcast episodes (pi_ep_, taddy_ep_) have streamURL in search results
  if (id.startsWith('pi_ep_') || id.startsWith('taddy_ep_')) {
    return c.json({ error: 'Podcast stream: use streamURL from search result' });
  }

  // ── Apple Podcast episode stream ────────────────────────────────────────────
  if (id.startsWith('apple_ep_')) {
    const cachedUrl = await cacheGet(`apple:ep:stream:${id}`);
    if (cachedUrl) {
      return c.json({ url: cachedUrl, format: cachedUrl.includes('.m4a') ? 'aac' : 'mp3', quality: 'variable' });
    }
    const trackId = id.startsWith('apple_ep_rss_') ? null : id.slice('apple_ep_'.length);
    if (trackId && /^[0-9]+$/.test(trackId)) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: trackId, media: 'podcast', entity: 'podcastEpisode', limit: 1 },
          timeout: 5000,
        });
        const ep = (lu.data?.results || []).find(r => r.kind === 'podcast-episode' || r.wrapperType === 'track');
        const url = ep?.episodeUrl;
        if (url) {
          await cacheSet(`apple:ep:stream:${id}`, url, 3600);
          return c.json({ url, format: 'mp3', quality: 'variable' });
        }
      } catch (e) {
        console.warn('[Apple] episode stream lookup error:', e.message);
      }
    }
    return c.json({ error: 'Apple Podcast episode stream URL not found' });
  }

  if (id.startsWith('lvox_')) {
    return c.json({ error: 'LibriVox: use /album/{id} and browse chapters' });
  }

  // ── Deezer stream (early return — BEFORE social fallback) ──────────────────
  if (id.startsWith('deezer:')) {
    const dzId = id.replace(/^deezer:/, '');

    // Respect streamOrder — try qobuz/hifi before deezer if ranked higher
    const _dzStreamOrder = cfg.streamOrder && cfg.streamOrder.length ? cfg.streamOrder : [];
    const _dzIdx  = _dzStreamOrder.indexOf('deezer');
    const _dzQIdx = _dzStreamOrder.indexOf('qobuz');
    const _dzHIdx = _dzStreamOrder.indexOf('hifi');
    const dzIsrc0 = c.req.query('isrc') ? String(c.req.query('isrc')).trim().toUpperCase() : null;
    const dzTitle = c.req.query('title')  ? decodeURIComponent(c.req.query('title')).trim()  : '';
    const dzArtist= c.req.query('artist') ? decodeURIComponent(c.req.query('artist')).trim() : '';

    // Load cached track metadata so we can cross-source even without query params
    const _dzCachedMeta = await cacheGet(`dz:track:meta:${dzId}`);
    const dzTitle2  = dzTitle  || _dzCachedMeta?.title  || '';
    const dzArtist2 = dzArtist || _dzCachedMeta?.artist || '';
    const dzIsrc    = dzIsrc0  || _dzCachedMeta?.isrc   || null;

    // FIX: when streamOrder is set and non-empty, treat any source NOT in it as disabled.
    // e.g. streamOrder=['deezer'] → qobuz/hifi/sc are all implicitly excluded,
    // even if cfg.noQobuz etc. aren't explicitly true.
    const _dzHasExplicitOrder = _dzStreamOrder.length > 0;
    const _dzEffNoQobuz = _dzHasExplicitOrder ? !_dzStreamOrder.includes('qobuz') : (cfg.noQobuz || false);
    const _dzEffNoHifi  = _dzHasExplicitOrder ? !_dzStreamOrder.includes('hifi')  : (cfg.noHifi  || false);
    const _dzEffNoSc    = _dzHasExplicitOrder ? !_dzStreamOrder.includes('sc')    : (cfg.noSc    || false);

    // If deezer is NOT in streamOrder, skip deezerStream() entirely and cross-source immediately
    const dzSkipDeezer = _dzIdx === -1 && !cfg.noDeezer; // not in stream list — skip addon

    // Qobuz priority (or fallback when deezer skipped)
    if ((dzSkipDeezer || (_dzQIdx !== -1 && _dzQIdx < _dzIdx)) && !_dzEffNoQobuz) {
      try {
        if (dzIsrc) {
          const qTrack = await qobuzFindByIsrc(dzIsrc);
          if (qTrack?.id) {
            const qStream = await qobuzStream(qTrack.id, c.env);
            if (qStream) { console.log(`[Deezer→Qobuz ISRC] ${dzIsrc}`); return c.json(qStream); }
          }
        }
        if (dzTitle2) {
          const qTrack = await qobuzFindBestTrack(dzTitle2, dzArtist2, dzIsrc, c.env);
          if (qTrack?.id) {
            const qStream = await qobuzStream(qTrack.id, c.env);
            if (qStream) { console.log(`[Deezer→Qobuz] ${dzTitle2}`); return c.json(qStream); }
          }
        }
      } catch(e) { console.warn('[Deezer→Qobuz]', e.message); }
    }

    // HiFi/Tidal priority (or fallback when deezer skipped)
    if ((dzSkipDeezer || (_dzHIdx !== -1 && _dzHIdx < _dzIdx)) && !_dzEffNoHifi && dzTitle2) {
      try {
        const hifiRes = await hifiSearch(`${dzArtist2} ${dzTitle2}`, cfg.hifiInstances);
        const hifiTracks = Array.isArray(hifiRes) ? hifiRes : (hifiRes?.tracks || []);
        for (const ht of hifiTracks.slice(0, 3)) {
          const hs = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
          if (hs) { console.log(`[Deezer→HiFi] ${dzTitle2}`); return c.json(hs); }
        }
      } catch(e) { console.warn('[Deezer→HiFi]', e.message); }
    }

    // SoundCloud fallback when deezer skipped
    if (dzSkipDeezer && !_dzEffNoSc && dzTitle2) {
      try {
        const cid = await getSCClientId(cfg.scClientId);
        if (cid) {
          const scRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
            params: { q: `${dzArtist2} ${dzTitle2}`, client_id: cid, limit: 5 }, timeout: 5000,
          });
          const scTrack = (scRes.data?.collection || []).find(t => t.streamable);
          if (scTrack) {
            const _dzScResult = await scStream(String(scTrack.id), cid);
            if (_dzScResult) { console.log(`[Deezer→SC] ${dzTitle2}`); return c.json({ ..._dzScResult, fallback: 'sc' }); }
          }
        }
      } catch(e) { console.warn('[Deezer→SC]', e.message); }
    }

    // Only attempt deezer addon if deezer IS in streamOrder
    if (!dzSkipDeezer) {
      const s = await deezerStream(dzId);
      if (s) return c.json(s);
      // Deezer failed — walk full streamOrder for best available source
      const _dzFbOrder = cfg.streamOrder && cfg.streamOrder.length
        ? cfg.streamOrder.filter(x => x !== 'deezer')
        : ['qobuz', 'hifi', 'sc'];
      for (const _fbSrc of _dzFbOrder) {
        if (_fbSrc === 'qobuz' && !_dzEffNoQobuz) {
          try {
            const qTrack = dzIsrc
              ? await qobuzFindByIsrc(dzIsrc)
              : (dzTitle2 ? await qobuzFindBestTrack(dzTitle2, dzArtist2, null, c.env) : null);
            if (qTrack?.id) {
              const qStream = await qobuzStream(qTrack.id, c.env);
              if (qStream) { console.log(`[Deezer→Qobuz fallback] ${dzIsrc || dzTitle2}`); return c.json({ ...qStream, fallback: 'qobuz' }); }
            }
          } catch(e) { console.warn('[Deezer→Qobuz fallback]', e.message); }
        }
        if (_fbSrc === 'hifi' && !_dzEffNoHifi && dzTitle2) {
          try {
            const hifiRes = await hifiSearch(`${dzArtist2} ${dzTitle2}`, cfg.hifiInstances);
            const hifiTracks = Array.isArray(hifiRes) ? hifiRes : (hifiRes?.tracks || []);
            for (const ht of hifiTracks.slice(0, 3)) {
              const hs = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
              if (hs) { console.log(`[Deezer→HiFi fallback] ${dzTitle2}`); return c.json({ ...hs, fallback: 'hifi' }); }
            }
          } catch(e) { console.warn('[Deezer→HiFi fallback]', e.message); }
        }
        if (_fbSrc === 'sc' && !cfg.noSc && dzTitle2) {
          try {
            const cid = await getSCClientId(cfg.scClientId);
            if (cid) {
              const scRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
                params: { q: `${dzArtist2} ${dzTitle2}`, client_id: cid, limit: 5 }, timeout: 5000,
              });
              const scTrack = (scRes.data?.collection || []).find(t => t.streamable);
              if (scTrack) {
                const _dzScResult2 = await scStream(String(scTrack.id), cid);
                if (_dzScResult2) { console.log(`[Deezer→SC fallback] ${dzTitle2}`); return c.json({ ..._dzScResult2, fallback: 'sc' }); }
              }
            }
          } catch(e) { console.warn('[Deezer→SC fallback]', e.message); }
        }
      }
    }

    return c.json({ error: 'Deezer stream not found' }, 404);
  }

  // ── Social/Community Tab & Cross-Addon Track Fallback ───────────────────────
  // Tracks from Social/Community tab or other addons (Apple Music, Tidal, Deezer,
  // Spotify, etc.) arrive with foreign ID prefixes this addon doesn't own.
  // Eclipse passes ?title=&artist= query params alongside the foreign ID —
  // we use those to search our own sources for the best match.
  //
  // Strategy:
  //   0. Extract search query: prefer ?title+artist params, fall back to raw ID.
  //   1. Bare numeric ID → try HiFi directly (likely a Tidal track ID).
  //   2. HiFi search using title+artist — best quality.
  //   3. SC search using title+artist — broad availability.
  //   4. Last resort: HiFi search using raw ID string.
  {
    const rawId = id;
    const decodedId = (() => { try { return decodeURIComponent(rawId); } catch (e) { return rawId; } })();

    // Eclipse passes title/artist as query params for cross-addon tracks
    const qTitle  = c.req.query('title')  ? decodeURIComponent(c.req.query('title')).trim()  : '';
    const qArtist = c.req.query('artist') ? decodeURIComponent(c.req.query('artist')).trim() : '';
    const searchQuery = (qTitle && qArtist)
      ? `${qArtist} ${qTitle}`
      : (qTitle || qArtist || decodedId);

    const qIsrc = c.req.query('isrc') ? String(c.req.query('isrc')).trim().toUpperCase() : '';
    console.log(`[Social fallback] id="${decodedId}" title="${qTitle}" artist="${qArtist}" isrc="${qIsrc}" → query="${searchQuery}"`);

    // 0. ISRC fast path — try Qobuz exact match before any search
    if (qIsrc && !cfg.noQobuz) {
      try {
        const qTrack = await qobuzFindByIsrc(qIsrc);
        if (qTrack?.id) {
          const qStream = await qobuzStream(qTrack.id, c.env);
          if (qStream) { console.log(`[Social→Qobuz ISRC] ${qIsrc} → ${qTrack.id}`); statHit('qobuz'); return c.json({ ...qStream, fallback: 'qobuz_isrc' }); }
        }
      } catch(e) { console.warn('[Social→Qobuz ISRC]', e.message); }
    }

    const cid = await getSCClientId(cfg.scClientId);
    const _socialInstances = (cfg.hifiInstances && cfg.hifiInstances.length) ? cfg.hifiInstances : DEFAULT_HIFI_INSTANCES;

    // 1. Bare numeric ID → try HiFi directly as a Tidal track ID
    if (/^\d+$/.test(decodedId)) {
      let hifiDirectResult = null;
      for (const _inst of _socialInstances) {
        const instB64 = encodeBase64Url(_inst);
        const syntheticHifiId = `hifi_${instB64}_${decodedId}`;
        hifiDirectResult = await hifiStream(syntheticHifiId, cfg.hifiInstances, cfg.preferredQuality);
        if (hifiDirectResult) break;
      }
      if (hifiDirectResult) {
        console.log(`[Social fallback] HiFi direct stream success for numeric ID ${decodedId}`);
        return c.json({ ...hifiDirectResult, fallback: 'social_hifi_direct' });
      }
    }

    // 2. HiFi search using title+artist (or raw ID as fallback query)
    if (searchQuery.length > 1) {
      try {
        console.log(`[Social fallback] HiFi search: "${searchQuery}"`);
        const hifiSearchResult = await hifiSearch(searchQuery, cfg.hifiInstances);
        const hifiTracks = Array.isArray(hifiSearchResult) ? hifiSearchResult : (hifiSearchResult?.tracks || []);
        for (const ht of hifiTracks.slice(0, 5)) {
          const hifiStreamResult = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
          if (hifiStreamResult) {
            console.log(`[Social fallback] HiFi matched: "${ht.title}" by "${ht.artist}"`);
            return c.json({ ...hifiStreamResult, fallback: 'social_hifi_search' });
          }
        }
      } catch (e) {
        console.warn('[Social fallback] HiFi search failed:', e.message);
      }

      // 3. SoundCloud search using title+artist
      if (cid) {
        try {
          console.log(`[Social fallback] SC search: "${searchQuery}"`);
          const scSearchRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
            params: { q: searchQuery, client_id: cid, limit: 5 },
            timeout: 8000,
          });
          const candidates = scSearchRes.data?.collection || [];
          const streamAttempts = await Promise.all(
            candidates.map(t => scStream(String(t.id), cid).then(r => ({ r, t })).catch(() => ({ r: null, t })))
          );
          for (const { r, t } of streamAttempts) {
            if (r && !r._scSnipped) {
              console.log(`[Social fallback] SC matched: "${t.title}" by "${t.user?.username}"`);
              const { _scSnipped, ...clean } = r;
              return c.json({ ...clean, fallback: 'social_sc' });
            }
          }
        } catch (e) {
          console.warn('[Social fallback] SC search failed:', e.message);
        }
      }

      // 4. Last resort: if no title/artist params, try HiFi with raw ID as query
      if (!qTitle && !qArtist) {
        try {
          console.log(`[Social fallback] last resort HiFi for raw id: "${decodedId}"`);
          const hifiSearchResult2 = await hifiSearch(decodedId, cfg.hifiInstances);
          const hifiTracks2 = Array.isArray(hifiSearchResult2) ? hifiSearchResult2 : (hifiSearchResult2?.tracks || []);
          for (const ht of hifiTracks2.slice(0, 3)) {
            const hifiStreamResult = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
            if (hifiStreamResult) {
              console.log(`[Social fallback] last resort HiFi matched: "${ht.title}"`);
              return c.json({ ...hifiStreamResult, fallback: 'social_hifi_lastresort' });
            }
          }
        } catch (e) {
          console.warn('[Social fallback] last resort HiFi failed:', e.message);
        }
      }
    }
  }

  // ── Deezer stream ───────────────────────────────────────────────────────
    c.json({ error: 'Unknown stream ID — could not resolve via any source' }, 404);
}

app.get('/stream/:id', handleStream);
app.get('/:token/stream/:id', handleStream);

// Album detail (audiobooks)
async function handleAlbum(c) {
  const id = c.req.param('id');

  if (id.startsWith('lvox_')) {
    const bookId = id.slice(5);
    const cacheKey = `album:lvox:${bookId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    // Look up book info
    try {
      const infoRes = await axios.get('https://librivox.org/api/feed/audiobooks', {
        params: { id: bookId, format: 'json', extended: 1 },
        timeout: 5000,
      });
      const book = infoRes.data?.books?.[0] || {};
      const rssUrl = book.url_rss || `https://librivox.org/rss/${bookId}`;
      const author = (book.authors || []).map(a => `${a.first_name} ${a.last_name}`).join(', ') || 'Unknown Author';
      const chapters = await librivoxGetChapters(bookId, rssUrl);
      const albumData = {
        id,
        title: book.title || `LibriVox Book ${bookId}`,
        artist: author,
        artworkURL: '',
        year: safeYear(book.copyright_year),
        description: book.description || '',
        trackCount: chapters.length,
        tracks: chapters.map((c, i) => ({
          id: `lvox_ch_${bookId}_${i}`,
          title: c.title,
          artist: author,
          duration: c.duration,
          streamURL: c.url,
          format: 'mp3',
        })),
      };
      await cacheSet(cacheKey, albumData, 3600);
      return c.json(albumData);
    } catch (e) {
      return c.json({ error: 'LibriVox album fetch failed' });
    }
  }

  if (id.startsWith('ia_book_')) {
    const identifier = id.slice(8);
    const cacheKey = `album:ia_book:${identifier}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const meta = await axios.get(`https://archive.org/metadata/${identifier}`, { timeout: 6000 });
      const m = meta.data?.metadata || {};
      const files = (meta.data?.files || [])
        .filter(f => ['mp3','ogg','flac'].some(ext => f.name?.toLowerCase().endsWith(`.${ext}`)) && f.source !== 'metadata')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const albumData = {
        id,
        title: Array.isArray(m.title) ? m.title[0] : (m.title || identifier),
        artist: Array.isArray(m.creator) ? m.creator[0] : (m.creator || 'Unknown'),
        artworkURL: `https://archive.org/services/img/${identifier}`,
        year: safeYear(m.date),
        description: Array.isArray(m.description) ? m.description[0] : (m.description || ''),
        trackCount: files.length,
        tracks: files.map((f, i) => ({
          id: `ia_book_file_${identifier}_${i}`,
          title: f.title || f.name?.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || `Track ${i + 1}`,
          artist: Array.isArray(m.creator) ? m.creator[0] : (m.creator || 'Unknown'),
          duration: f.length ? parseInt(f.length) : 0,
          streamURL: `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`,
          format: f.name?.split('.').pop()?.toLowerCase() || 'mp3',
        })),
      };
      await cacheSet(cacheKey, albumData, 3600);
      return c.json(albumData);
    } catch {
      return c.json({ error: 'IA audiobook album fetch failed' });
    }
  }

  // ── Deezer album/artist/playlist ────────────────────────────────────────
  if (id.startsWith('deezer:album:')) {
    const data = await deezerAlbum(id.replace('deezer:album:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer album not found' }, 404);
  }
  if (id.startsWith('deezer:artist:')) {
    const data = await deezerArtist(id.replace('deezer:artist:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer artist not found' }, 404);
  }
  if (id.startsWith('deezer:playlist:')) {
    const data = await deezerPlaylist(id.replace('deezer:playlist:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer playlist not found' }, 404);
  }
  if (id.startsWith('deezer:')) {
    // bare deezer track id — return single-track album shell
    const trackId = id.replace('deezer:', '');
    const data = await deezerAlbum(trackId).catch(() => null);
    if (data) return c.json(data);
    return c.json({ error: 'Deezer item not found' }, 404);
  }
    c.json({ error: 'Album not found' }, 404);
}

async function handleAlbumWithHifi(c) {
  const id = c.req.param('id');
  const cfg = getConfig(c);

  // ── HiFi album ──────────────────────────────────────────────────────────
  if (id.startsWith('hifi_album_')) {
    const data = await hifiAlbum(id);
    if (data) return c.json(data);
    return c.json({ error: 'HiFi album not found' });
  }

  if (id.startsWith('qobuzalbum_')) {
    const qobuzAlbumId = id.slice(11);
    const aCacheKey = `qobuz:album:${qobuzAlbumId}`;
    const cachedAlbum = await cacheGet(aCacheKey);
    if (cachedAlbum) return c.json(cachedAlbum);
    for (const inst of QOBUZ_INSTANCES) {
      try {
        // qobuz-api1: GET /album/:album_id  (path param)
        // Qobuz returns album object directly: { id, title, artist:{name}, image:{large}, release_date_original, tracks:{items:[...]} }
        const r = await axios.get(`${inst}/album/${qobuzAlbumId}`, {
          headers: { 'User-Agent': UA },
          timeout: 9000,
        });
        const album = r.data || {};
        if (!album?.id) continue;
        const cover      = album.image?.large || null;
        const artistName = album.artist?.name || 'Unknown';
        const rawTracks  = album.tracks?.items || [];
        const tracks = rawTracks.map((t, i) => ({
          id:          `qobuz_${t.id}`,
          title:       t.title || `Track ${i + 1}`,
          artist:      t.performer?.name || t.performers?.split(',')?.[0]?.trim() || artistName,
          album:       album.title || '',
          duration:    t.duration  || undefined,
          artworkURL:  cover,
          format:      'flac',
          source:      'qobuz',
          trackNumber: t.track_number || (i + 1),
        }));
        const result = {
          id,
          title:      album.title || 'Unknown Album',
          artist:     artistName,
          artworkURL: cover,
          year:       safeYear(album.release_date_original),
          trackCount: tracks.length,
          tracks,
        };
        await cacheSet(aCacheKey, result, 600);
        return c.json(result);
      } catch(e) { continue; }
    }
    return c.json({ error: 'Qobuz album not found' });
  }

  // ── Podcast Index feed album ─────────────────────────────────────────────
  if (id.startsWith('pi_feed_')) {
    const feedId   = id.slice(8);
    const cacheKey = `album:pi_feed:${feedId}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [feedRes, epRes] = await Promise.allSettled([
      cfg.piKey && cfg.piSecret
        ? axios.get('https://api.podcastindex.org/api/1.0/podcasts/byfeedid', {
            params: { id: feedId },
            headers: podcastIndexHeaders(cfg.piKey, cfg.piSecret),
            timeout: 8000,
          })
        : Promise.resolve(null),
      cfg.piKey && cfg.piSecret
        ? axios.get('https://api.podcastindex.org/api/1.0/episodes/byfeedid', {
            params: { id: feedId, max: 200, fulltext: true },
            headers: podcastIndexHeaders(cfg.piKey, cfg.piSecret),
            timeout: 10000,
          })
        : Promise.resolve(null),
    ]);

    const feed = feedRes.status === 'fulfilled' && feedRes.value
      ? (feedRes.value.data?.feed || {})
      : {};
    const episodes = epRes.status === 'fulfilled' && epRes.value
      ? (epRes.value.data?.items || [])
      : [];

    // Fallback: use cached series info if feed API call failed
    if (!feed.title) {
      const cached_info = await cacheGet(`pi:series_info:${feedId}`);
      if (cached_info) { feed.title = cached_info.title; feed.image = cached_info.artworkURL; feed.author = cached_info.creator; }
    }

    const tracks = episodes.map(ep => ({
      id: `pi_ep_${ep.id}`,
      title: ep.title || 'Episode',
      artist: ep.feedAuthor || ep.feedTitle || feed.title || '',
      album:  ep.feedTitle  || feed.title  || '',
      duration:   typeof ep.duration === 'number' ? ep.duration : null,
      artworkURL: ep.image || ep.feedImage || feed.image || feed.artwork || null,
      streamURL:  ep.enclosureUrl || null,
      format: 'mp3',
    }));

    const albumData = {
      id,
      title:       feed.title       || 'Podcast',
      artist:      feed.author      || feed.ownerName || '',
      artworkURL:  feed.image       || feed.artwork   || null,
      year:        feed.newestItemPublishTime ? safeYear(new Date(feed.newestItemPublishTime * 1000).getFullYear()) : 0,
      description: (feed.description || '').slice(0, 500),
      trackCount:  tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, albumData, 600);
    return c.json(albumData);
  }

  // ── Taddy series album ───────────────────────────────────────────────────
  if (id.startsWith('taddy_series_')) {
    const uuid     = id.slice(13);
    const cacheKey = `album:taddy_series:${uuid}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    if (!cfg.taddyKey || !cfg.taddyUid) {
      return c.json({ error: 'No Taddy credentials configured.' });
    }

    let pod = {};
    try {
      const gql = `query {
        getPodcastSeries(uuid: "${uuid}") {
          uuid name description imageUrl authorName
          episodes(limitPerPage: 200) {
            uuid name audioUrl duration imageUrl
          }
        }
      }`;
      const r = await axios.post('https://api.taddy.org', { query: gql }, {
        headers: {
          'Content-Type': 'application/json',
          'X-USER-ID': cfg.taddyUid,
          'X-API-KEY': cfg.taddyKey,
        },
        timeout: 10000,
      });
      pod = r.data?.data?.getPodcastSeries || {};
    } catch (e) {
      console.warn('[Taddy] album fetch error:', e.message);
    }

    // Fallback: use cached series info if Taddy call failed
    if (!pod.name) {
      const cached_info = await cacheGet(`taddy:series_info:${uuid}`);
      if (cached_info) { pod.name = cached_info.title; pod.imageUrl = cached_info.artworkURL; }
    }

    const tracks = (pod.episodes || []).map(ep => ({
      id: `taddy_ep_${ep.uuid}`,
      title:      ep.name    || 'Episode',
      artist:     pod.authorName || pod.name || '',
      album:      pod.name   || '',
      duration:   ep.duration || null,
      artworkURL: ep.imageUrl || pod.imageUrl || null,
      streamURL:  ep.audioUrl || null,
      format: 'mp3',
    }));

    const albumData = {
      id,
      title:       pod.name        || 'Podcast',
      artist:      pod.authorName  || '',
      artworkURL:  pod.imageUrl    || null,
      year:        0,
      description: (pod.description || '').slice(0, 500),
      trackCount:  tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, albumData, 600);
    return c.json(albumData);
  }


  // ── Apple Podcast feed album ──────────────────────────────────────────────
  if (id.startsWith('apple_feed_')) {
    const collectionId = id.slice('apple_feed_'.length);
    const cacheKey = `album:apple_feed:${collectionId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    let feedUrl = await cacheGet(`apple:feed_url:${collectionId}`);
    if (!feedUrl) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: collectionId, media: 'podcast', entity: 'podcast' },
          timeout: 5000,
        });
        feedUrl = lu.data?.results?.[0]?.feedUrl || null;
        if (feedUrl) await cacheSet(`apple:feed_url:${collectionId}`, feedUrl, 86400);
      } catch (e) { console.warn('[Apple] album feedUrl lookup error:', e.message); }
    }
    if (feedUrl) {
      const feedData = await appleGetFeed(feedUrl, collectionId);
      if (feedData) { await cacheSet(cacheKey, feedData, 600); return c.json(feedData); }
    }
    try {
      const lu = await axios.get('https://itunes.apple.com/lookup', {
        params: { id: collectionId, media: 'podcast', entity: 'podcastEpisode', limit: 200 },
        timeout: 10000,
      });
      const results = lu.data?.results || [];
      const show = results.find(r => r.wrapperType === 'collection' || r.collectionType === 'Podcast');
      const eps  = results.filter(r => r.kind === 'podcast-episode');
      const tracks = eps.map((r, i) => {
        const epId = `apple_ep_${r.trackId}`;
        if (r.episodeUrl) cacheSet(`apple:ep:stream:${epId}`, r.episodeUrl, 3600);
        return {
          id: epId, title: r.trackName || `Episode ${i + 1}`,
          artist: r.artistName || show?.collectionName || '',
          album: r.collectionName || show?.collectionName || '',
          duration: r.trackTimeMillis ? Math.floor(r.trackTimeMillis / 1000) : 0,
          artworkURL: (r.artworkUrl600 || r.artworkUrl100 || show?.artworkUrl600 || '').replace('100x100', '600x600'),
          format: 'mp3', streamURL: r.episodeUrl || null, source: 'apple',
        };
      });
      const albumData = {
        id, title: show?.collectionName || 'Apple Podcast',
        artist: show?.artistName || '',
        artworkURL: (show?.artworkUrl600 || '').replace('100x100', '600x600'),
        year: 0, description: show?.description || '',
        trackCount: tracks.length, tracks,
      };
      await cacheSet(cacheKey, albumData, 600);
      return c.json(albumData);
    } catch (e) { console.warn('[Apple] album fallback lookup error:', e.message); }
    return c.json({ error: 'Apple Podcast feed not found' });
  }

  // ── Social/Cross-Addon Album Fallback ───────────────────────────────────────
  // Album IDs from other addons (Apple Music, Tidal, Deezer, Spotify, etc.)
  // won't match any known prefix. Eclipse passes ?title=&artist= params.
  // Use those to search HiFi for the best matching album.
  {
    const qTitle  = c.req.query('title')  ? decodeURIComponent(c.req.query('title')).trim()  : '';
    const qArtist = c.req.query('artist') ? decodeURIComponent(c.req.query('artist')).trim() : '';
    const decodedAlbumId = (() => { try { return decodeURIComponent(id); } catch (e) { return id; } })();
    const searchQuery = (qTitle && qArtist)
      ? `${qArtist} ${qTitle}`
      : (qTitle || qArtist || '');

    if (searchQuery.length > 1) {
      console.log(`[Album social fallback] id="${decodedAlbumId}" query="${searchQuery}" — searching HiFi`);
      try {
        const hifiResult = await hifiSearch(searchQuery, cfg.hifiInstances);
        const albums = Array.isArray(hifiResult) ? [] : (hifiResult?.albums || []);
        if (albums.length) {
          const albumData = await hifiAlbum(albums[0].id);
          if (albumData) {
            console.log(`[Album social fallback] HiFi album matched: "${albumData.title}"`);
            return c.json(albumData);
          }
        }
        // No album objects — build a synthetic album from track results
        const tracks = Array.isArray(hifiResult) ? hifiResult : (hifiResult?.tracks || []);
        if (tracks.length) {
          console.log(`[Album social fallback] building synthetic album from tracks for "${searchQuery}"`);
          const syntheticAlbum = {
            id,
            title: qTitle || tracks[0]?.album || searchQuery,
            artist: qArtist || tracks[0]?.artist || '',
            artworkURL: tracks[0]?.artworkURL || null,
            trackCount: tracks.length,
            tracks: tracks.slice(0, 50),
          };
          return c.json(syntheticAlbum);
        }
      } catch (e) {
        console.warn('[Album social fallback] HiFi search error:', e.message);
      }
    }
  }

  // ── Radio Browser source album ────────────────────────────────────────────
  if (id === 'radio:source:radiobrowser') {
    const cacheKey = 'radio:album:radiobrowser';
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    const stations = await radioSearch('station') || [];
    const result = {
      id, title: 'Radio Browser', artist: 'Radio Browser',
      artworkURL: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png',
      trackCount: stations.length, tracks: stations,
    };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  }

  // ── SomaFM source album ──────────────────────────────────────────────────
  if (id === 'radio:source:somafm') {
    const cacheKey = 'radio:album:somafm';
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    let allStations = [];
    try {
      const res = await axios.get('https://api.somafm.com/channels.json', {
        headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' }, timeout: 5000,
      });
      allStations = (res.data?.channels || []).map(ch => {
        const stream =
          ch.playlists?.find(p => p.format === 'mp3' && p.quality === 'highest')?.url ||
          ch.playlists?.find(p => p.format === 'aac')?.url ||
          ch.playlists?.[0]?.url || null;
        if (!stream) return null;
        return {
          id: `somafm:${ch.id}`, title: ch.title || 'SomaFM Station',
          artist: ch.genre || 'SomaFM', album: 'Live Radio · SomaFM', duration: 0,
          artworkURL: ch.xlimage || ch.image || null,
          format: stream.includes('.m3u') ? 'hls' : 'mp3', streamURL: stream, source: 'somafm',
        };
      }).filter(Boolean);
    } catch (e) { console.warn('[SomaFM] album fetch error:', e.message); }
    const result = {
      id, title: 'SomaFM', artist: 'SomaFM',
      artworkURL: 'https://somafm.com/img3/facebook-logo.png',
      trackCount: allStations.length, tracks: allStations,
    };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  }

  return handleAlbum(c);
}
app.get('/album/:id', handleAlbumWithHifi);
app.get('/:token/album/:id', handleAlbumWithHifi);

// ─── Artist detail ────────────────────────────────────────────────────────────
async function handleArtist(c) {
  const id = c.req.param('id');
  const cfg = getConfig(c);

  if (id.startsWith('hifi_artist_')) {
    const withoutPrefix = id.slice(12);
    const firstUnderscore = withoutPrefix.indexOf('_');
    const instB64  = withoutPrefix.slice(0, firstUnderscore);
    const artistId = withoutPrefix.slice(firstUnderscore + 1);
    const inst     = decodeBase64Url(instB64);
    const cacheKey = `hifi:artist:${instB64}:${artistId}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const coverUrl = (uuid, size = 1280) => uuid
        ? `https://resources.tidal.com/images/${String(uuid).replace(/-/g, '/')}/${size}x${size}.jpg`
        : undefined;

      // Fire ALL endpoints in parallel across multiple param variations
      // Covers all known HiFi API v2.x instance response shapes
      // FIX: 3s timeouts (was 8s) — Promise.allSettled waits for ALL; slow instances
      // were blocking the entire artist page for up to 8 seconds.
      const [infoRes, discRes, albumsRes, topTracksRes, albumsRes2, discRes2] = await Promise.allSettled([
        axios.get(`${inst}/artist/`, { params: { id: artistId }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/`, { params: { f: artistId, skip_tracks: false }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/albums/`, { params: { id: artistId, limit: 50, offset: 0 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/toptracks/`, { params: { id: artistId, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/albums/`, { params: { artistId, limit: 50 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/discography/`, { params: { id: artistId, limit: 50 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
      ]);

      // ── Artist info ──────────────────────────────────────────────────────────
      let artistInfo = {};
      if (infoRes.status === 'fulfilled') {
        const d = infoRes.value.data?.data || infoRes.value.data || {};
        if      (d.artist?.id)   artistInfo = d.artist;
        else if (d.id && d.name) artistInfo = d;
      }
      // Fallback: discography response often embeds artist info too
      if (!artistInfo.name && discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        if      (dd.artist?.id)   artistInfo = dd.artist;
        else if (dd.id && dd.name) artistInfo = dd;
      }

      // ── Albums — merge all sources, dedupe by album id ───────────────────────
      const albumMap = {};
      const albumTitleSeen = new Set(); // FIX: dedup albums by title+year to catch int/string id mismatches
      const addAlbums = (arr) => {
        for (const a of (Array.isArray(arr) ? arr : [])) {
          if (!a?.id) continue;
          const _ak = String(a.id);
          if (albumMap[_ak]) continue;
          const _aNorm = `${(a.title||'').toLowerCase().replace(/[^a-z0-9]/g,'')}:${(a.releaseDate||'').slice(0,4)}`;
          if (_aNorm.length > 1 && albumTitleSeen.has(_aNorm)) continue;
          if (_aNorm.length > 1) albumTitleSeen.add(_aNorm);
          albumMap[_ak] = a;
        }
      };
      // Helper to extract array from any known response shape
      const extractList = (res, keys = ['items', 'tracks', 'albums']) => {
        if (res.status !== 'fulfilled' || !res.value) return [];
        const d = res.value.data?.data || res.value.data || {};
        for (const k of keys) {
          if (Array.isArray(d[k])) return d[k];
          if (Array.isArray(d[k]?.items)) return d[k].items;
        }
        if (Array.isArray(d)) return d;
        return [];
      };
      if (discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        addAlbums(Array.isArray(dd.albums) ? dd.albums : (dd.albums?.items || []));
      }
      if (discRes2.status === 'fulfilled') {
        const dd2 = discRes2.value.data?.data || discRes2.value.data || {};
        addAlbums(Array.isArray(dd2.albums) ? dd2.albums : (dd2.albums?.items || []));
        addAlbums(Array.isArray(dd2.items) ? dd2.items : []);
      }
      for (const aRes of [albumsRes, albumsRes2]) {
        if (aRes.status === 'fulfilled') {
          const ad = aRes.value.data?.data || aRes.value.data;
          addAlbums(Array.isArray(ad) ? ad : (ad?.items || []));
        }
      }
      // Also extract albums from info response (some instances nest them there)
      if (infoRes.status === 'fulfilled') {
        const id2 = infoRes.value.data?.data || infoRes.value.data || {};
        addAlbums(Array.isArray(id2.albums) ? id2.albums : (id2.albums?.items || []));
      }

      // ── Tracks — merge discography + toptracks ───────────────────────────────
      const trackMap = {};
      const trackTitleArtistSeen = new Set(); // FIX: secondary dedup by title+artist
      const addTracks = (arr) => {
        for (const t of (Array.isArray(arr) ? arr : [])) {
          if (!t?.id) continue;
          const _tk = String(t.id);
          if (trackMap[_tk]) continue;
          const _tNorm = `${(t.title||'').toLowerCase().replace(/[^a-z0-9]/g,'')}:${((t.artists||[]).map(a=>a.name).join('').toLowerCase().replace(/[^a-z0-9]/g,''))}`;
          if (trackTitleArtistSeen.has(_tNorm)) continue;
          trackTitleArtistSeen.add(_tNorm);
          trackMap[_tk] = t;
        }
      };
      if (discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        addTracks(Array.isArray(dd.tracks) ? dd.tracks : (dd.tracks?.items || []));
      }
      if (discRes2.status === 'fulfilled') {
        const dd2 = discRes2.value.data?.data || discRes2.value.data || {};
        addTracks(Array.isArray(dd2.tracks) ? dd2.tracks : (dd2.tracks?.items || []));
      }
      if (topTracksRes.status === 'fulfilled') {
        const td = topTracksRes.value.data?.data || topTracksRes.value.data || {};
        addTracks(td.items || td.tracks || (Array.isArray(td) ? td : []));
      }

      // ── Search fallback if both album sources came back empty ─────────────────
      if (!Object.keys(albumMap).length && artistInfo.name) {
        try {
          const sData = await axios.get(`${inst}/search/`, { params: { s: artistInfo.name, limit: 30 }, headers: { 'User-Agent': UA }, timeout: 8000 });
          const sItems = sData.data?.data?.items || sData.data?.items || [];
          const wantName = artistInfo.name.toLowerCase();
          for (const t of sItems) {
            if (!t?.album?.id) continue;
            const tArtist = ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED') : (t.artists || [])).map(a => a.name).join(', ').toLowerCase();
            if (!tArtist.includes(wantName) && !wantName.includes(tArtist)) continue;
            const alId = String(t.album.id);
            if (!albumMap[alId]) albumMap[alId] = {
              id: t.album.id, title: t.album.title, cover: t.album.cover,
              // FIX: t.album.releaseDate is often null on track objects; fall back to
              // streamStartDate (ISO string) or track-level releaseDate
              releaseDate: t.album.releaseDate || t.album.streamStartDate || t.releaseDate || null,
              source: 'hifi',
            };
            if (!trackMap[String(t.id)] && t.streamReady !== false) trackMap[String(t.id)] = t;
          }
        } catch (e6) { console.log('[HiFi] search fallback failed:', e6.message); }
      }

      const artistName = artistInfo.name || 'Unknown Artist';
      const artworkURL = artistInfo.picture ? coverUrl(artistInfo.picture, 480) : undefined;

      const topTracks = Object.values(trackMap)
        .filter(t => t.streamReady !== false)
        .slice(0, 20)
        .map(t => ({
          id:         `hifi_${instB64}_${t.id}`,
          title:      t.title || 'Unknown',
          artist:     ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length
              ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED')
              : (t.artists?.length ? t.artists : (t.artist ? [t.artist] : []))).map(a => a.name).join(', ') || artistName,
          album:      t.album?.title || '',
          duration:   t.duration ? Math.floor(t.duration) : undefined,
          artworkURL: t.album?.cover ? coverUrl(t.album.cover, 320) : artworkURL,
          format:     'flac',
        }));

      const albums = Object.values(albumMap)
        // FIX: sort by numeric year descending; null/0 years go to the end
        .sort((a, b) => {
          const ya = safeYear(a.releaseDate || a.streamStartDate);
          const yb = safeYear(b.releaseDate || b.streamStartDate);
          if (!ya && !yb) return 0;
          if (!ya) return 1;  // a has no year → push to end
          if (!yb) return -1; // b has no year → push to end
          return yb - ya;     // newest first
        })
        .slice(0, 60)
        .map(a => ({
          id:         `hifi_album_${instB64}_${a.id}`,
          title:      a.title || 'Unknown Album',
          artist:     artistName,
          artworkURL: a.cover ? coverUrl(a.cover, 320) : undefined,
          year:       safeYear(a.releaseDate || a.streamStartDate),
          source:     'hifi',
        }));

      // FIX: cache track meta for ALL tracks so stream handler can apply correct streamOrder priority
      for (const [_atid, _atv] of Object.entries(trackMap)) {
        if (_atv.streamReady === false) continue;
        const _atArtist = (((_atv.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED').length
          ? (_atv.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED')
          : (_atv.artists?.length ? _atv.artists : (_atv.artist ? [_atv.artist] : []))
        ).map(a=>a.name).join(', ')) || artistName;
        cacheSet(`hifi:track:meta:${instB64}_${_atid}`, {
          title: _atv.title || 'Unknown',
          artist: _atArtist,
          isrc: _atv.isrc ? _atv.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null,
          duration: _atv.duration ? Math.floor(_atv.duration) : undefined,
        }, 3600);
      }
      const result = { id, name: artistName, artworkURL, topTracks, albums };
      await cacheSet(cacheKey, result, 3600);
      return c.json(result);
    } catch (e) {
      console.warn('[HiFi] artist error:', e.message);
      return c.json({ error: 'Artist fetch failed: ' + e.message });
    }
  }

  if (id.startsWith('sc_artist_')) {
    const artistName = decodeURIComponent(id.slice(10));
    const cid = await getSCClientId(cfg.scClientId);
    if (!cid) return c.json({ error: 'SC client ID unavailable' });
    try {
      const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
        params: { q: artistName, client_id: cid, limit: 20 }, timeout: 8000,
      });
      const topTracks = (r.data?.collection || []).map(t => ({
        id:        `sc_${t.id}`,
        title:     t.title || 'Unknown',
        artist:    t.user?.username || 'Unknown',
        duration:  Math.floor((t.duration || 0) / 1000),
        artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
        format: 'mp3',
        _origId: String(t.id),
      }));
      return c.json({ id, name: artistName, topTracks, albums: [] });
    } catch (e) {
      return c.json({ error: 'SC artist fetch failed' });
    }
  }

  // ── Podcast show as artist (pi_feed_, taddy_series_, apple_feed_) ─────────
  if (id.startsWith('pi_feed_') || id.startsWith('taddy_series_') || id.startsWith('apple_feed_')) {
    const cacheKey = `artist:podcast:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    let episodes = [];
    let info = { title: 'Podcast', artworkURL: null, creator: '' };

    if (id.startsWith('pi_feed_')) {
      const feedId = id.slice(8);
      episodes = await piGetEpisodes(feedId, cfg.piKey, cfg.piSecret) || [];
      const si = await cacheGet(`pi:series_info:${feedId}`);
      if (si) info = si;
      else if (!cfg.piKey) {
        // try to get info from PI without auth
        try {
          const infoRes = await axios.get('https://api.podcastindex.org/api/1.0/podcasts/byfeedid', {
            params: { id: feedId }, headers: podcastIndexHeaders(cfg.piKey, cfg.piSecret), timeout: 5000,
          });
          const f = infoRes.data?.feed;
          if (f) info = { title: f.title, artworkURL: f.artwork || f.image, creator: f.author };
        } catch {}
      }
    } else if (id.startsWith('taddy_series_')) {
      const uuid = id.slice(13);
      episodes = await taddyGetEpisodes(uuid, cfg.taddyKey, cfg.taddyUid) || [];
      const si = await cacheGet(`taddy:series_info:${uuid}`);
      if (si) info = { title: si.title, artworkURL: si.artworkURL, creator: si.creator || '' };
      else if (episodes[0]) info = { title: episodes[0].artist || 'Podcast', artworkURL: episodes[0].artworkURL, creator: '' };
    } else if (id.startsWith('apple_feed_')) {
      const collectionId = id.slice('apple_feed_'.length);
      let feedUrl = await cacheGet(`apple:feed_url:${collectionId}`);
      if (!feedUrl) {
        try {
          const lu = await axios.get('https://itunes.apple.com/lookup', {
            params: { id: collectionId, media: 'podcast', entity: 'podcast' }, timeout: 5000,
          });
          feedUrl = lu.data?.results?.[0]?.feedUrl || null;
          if (feedUrl) await cacheSet(`apple:feed_url:${collectionId}`, feedUrl, 86400);
        } catch {}
      }
      if (feedUrl) {
        const feedData = await appleGetFeed(feedUrl, collectionId);
        if (feedData) {
          episodes = feedData.tracks || [];
          info = { title: feedData.title, artworkURL: feedData.artworkURL, creator: feedData.artist };
        }
      }
    }

    const result = {
      id,
      name:       info.title || 'Podcast',
      artworkURL: info.artworkURL || null,
      topTracks:  episodes.slice(0, 20),
      albums:     episodes.length ? [{
        id, title: info.title || 'Podcast', artist: info.creator || '',
        artworkURL: info.artworkURL || null, trackCount: episodes.length, source: 'pi',
      }] : [],
    };
    await cacheSet(cacheKey, result, 3600);
    return c.json(result);
  }

  // ── Audiobook author as artist ────────────────────────────────────────────
  if (id.startsWith('author:')) {
    const authorName = decodeURIComponent(id.slice(7));
    const cacheKey = `artist:author:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [lvoxRes, iaRes] = await Promise.allSettled([
      librivoxSearch(authorName),
      iaSearchAudiobooks(authorName),
    ]);
    const lvox = lvoxRes.status === 'fulfilled' ? (lvoxRes.value || []) : [];
    const ia   = iaRes.status   === 'fulfilled' ? (iaRes.value   || []) : [];
    const seen = new Set();
    const allBooks = [];
    for (const b of [...lvox, ...ia]) {
      const key = b.title?.toLowerCase().slice(0, 40);
      if (!seen.has(key)) { seen.add(key); allBooks.push(b); }
    }

    const result = {
      id,
      name:       authorName,
      artworkURL: allBooks[0]?.artworkURL || null,
      topTracks:  allBooks.slice(0, 20).map(b => ({
        id: b.id, title: b.title, artist: authorName, album: b.title,
        duration: b.duration || null, artworkURL: b.artworkURL || null, format: 'mp3', source: b.source,
      })),
      albums: allBooks.slice(0, 20).map(b => ({
        id: b.id, title: b.title, artist: authorName,
        artworkURL: b.artworkURL || null, year: b.year || 0, source: b.source,
      })),
    };
    await cacheSet(cacheKey, result, 3600);
    return c.json(result);
  }

  // ── Radio genre as artist ─────────────────────────────────────────────────
  if (id.startsWith('radiogenre:')) {
    const genre = decodeURIComponent(id.slice(11));
    const cacheKey = `artist:radiogenre:${genre}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [rbRes, somaRes] = await Promise.allSettled([
      radioSearch(genre),
      somaFmSearch(genre),
    ]);
    const rb   = rbRes.status   === 'fulfilled' ? (rbRes.value   || []) : [];
    const soma = somaRes.status === 'fulfilled' ? (somaRes.value || []) : [];
    const seen = new Set();
    const stations = [];
    for (const s of [...rb, ...soma]) {
      const key = (s.title || '').toLowerCase().slice(0, 40);
      if (!seen.has(key)) { seen.add(key); stations.push(s); }
    }

    const result = {
      id,
      name:       genre.charAt(0).toUpperCase() + genre.slice(1) + ' Radio',
      artworkURL: stations[0]?.artworkURL || null,
      topTracks:  stations.slice(0, 20),
      albums:     [],
    };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  }

  if (id.startsWith('qobuz_artist_')) {
    const qobuzArtistId = id.slice(13);
    const arCacheKey = `qobuz:artist:${qobuzArtistId}`;
    const cachedAr = await cacheGet(arCacheKey);
    if (cachedAr) return c.json(cachedAr);
    for (const inst of QOBUZ_INSTANCES) {
      try {
        // The proxy /artist/:id only returns basic info — no albums, no tracks.
        // Fetch artist info + 4 parallel search queries to cover all release types.
        const arRes = await axios.get(`${inst}/artist/${qobuzArtistId}`, {
          params: { limit: 25 },
          headers: { 'User-Agent': UA },
          timeout: 8000,
        });
        const arData = arRes.data || {};
        if (!arData?.id && !arData?.name) continue;
        const artistName = arData.name || '';
        const cover = arData.image?.large || arData.image?.extralarge || null;

        // Run search queries in parallel: general, EP/Single, compilation, live
        // to maximise album type coverage since proxy has no dedicated albums endpoint
        const [s1, s2, s3, s4] = await Promise.allSettled([
          axios.get(`${inst}/search`, { params: { q: artistName, limit: 50 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
          axios.get(`${inst}/search`, { params: { q: `${artistName} EP`, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
          axios.get(`${inst}/search`, { params: { q: `${artistName} compilation`, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
          axios.get(`${inst}/search`, { params: { q: `${artistName} live`, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
        ]);

        // Collect tracks + albums from all search results, filter to this artist
        const albumMap = {};
        const topTracks = [];
        const seenTrackIds = new Set(); // FIX: dedup tracks across all parallel search results
        const wantId = String(arData.id);
        const wantNameLow = artistName.toLowerCase();

        const isThisArtist = (a) => {
          if (!a) return false;
          const aId = String(a.artist?.id || a.artists?.[0]?.id || '');
          if (aId && aId === wantId) return true;
          const aName = (a.artist?.name || a.artists?.[0]?.name || a.performer?.name || '').toLowerCase();
          return aName === wantNameLow || aName.includes(wantNameLow) || wantNameLow.includes(aName);
        };

        for (const res of [s1, s2, s3, s4]) {
          if (res.status !== 'fulfilled') continue;
          const data = res.value.data || {};

          // Albums
          const rawAlbums = data.albums?.items || data.albums || [];
          for (const a of rawAlbums) {
            if (!a?.id) continue;
            const key = String(a.id);
            if (albumMap[key]) continue;
            // Accept if artist id matches OR artist name matches
            const aArtistId = String(a.artist?.id || '');
            const aArtistName = (a.artist?.name || '').toLowerCase();
            if (aArtistId !== wantId && aArtistName !== wantNameLow) continue;
            albumMap[key] = a;
          }

          // Tracks — collect from all searches, dedup by track id
          const rawTracks = data.tracks?.items || data.tracks || [];
          for (const t of rawTracks) {
            if (!isThisArtist(t)) continue;
            if (topTracks.length >= 20) break;
            const _tkey = String(t.id);
            if (seenTrackIds.has(_tkey)) continue; // FIX: skip already-seen track ids
            seenTrackIds.add(_tkey);
            topTracks.push({
              id:         `qobuz_${t.id}`,
              title:      t.title || 'Unknown',
              artist:     t.performer?.name || t.artist?.name || artistName,
              album:      t.album?.title || '',
              duration:   t.duration || undefined,
              artworkURL: t.album?.image?.large || cover,
              format:     'flac',
              source:     'qobuz',
            });
          }
        }

        const albums = Object.values(albumMap)
          // FIX: numeric year sort descending, nulls/0s at end (consistent with hifi)
          .sort((a, b) => {
            const ya = safeYear(a.release_date_original);
            const yb = safeYear(b.release_date_original);
            if (!ya && !yb) return 0;
            if (!ya) return 1;
            if (!yb) return -1;
            return yb - ya;
          })
          .slice(0, 80)
          .map(a => ({
            id:         `qobuzalbum_${a.id}`,
            title:      a.title || 'Unknown Album',
            artist:     artistName,
            artworkURL: a.image?.large || null,
            year:       safeYear(a.release_date_original),
            source:     'qobuz',
          }));

        const result = { id, name: artistName || 'Unknown Artist', artworkURL: cover, topTracks, albums };
        await cacheSet(arCacheKey, result, 600);
        return c.json(result);
      } catch(e) { continue; }
    }
    return c.json({ error: 'Qobuz artist not found' });
  }

    if (id.startsWith('deezer:artist:')) {
    const data = await deezerArtist(id.replace('deezer:artist:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer artist not found' }, 404);
  }
    return c.json({ error: 'Artist not found' });
}
app.get('/artist/:id', handleArtist);
app.get('/:token/artist/:id', handleArtist);

// Playlist detail (podcast series)
async function handlePlaylist(c) {
  const id = c.req.param('id');
  const cfg = getConfig(c);

  // SoundCloud playlist
  if (id.startsWith('sc_pl_')) {
    const origId = id.slice(6);
    const cid = await getSCClientId(cfg.scClientId);
    if (!cid) return c.json({ error: 'SC client ID unavailable' });
    const cacheKey = `sc:playlist:${origId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const r = await axios.get(`https://api-v2.soundcloud.com/playlists/${origId}`, {
        params: { client_id: cid },
        timeout: 10000,
      });
      const pl = r.data;
      const tracks = (pl.tracks || []).map(t => ({
        id: `sc_${t.id}`,
        title: t.title || 'Unknown',
        artist: t.publisher_metadata?.artist || t.user?.name || t.user?.username || 'Unknown',
        duration: Math.floor((t.duration || 0) / 1000),
        artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
        format: 'mp3',
        _source: 'sc',
        _origId: String(t.id),
      }));
      const result = {
        id,
        title: pl.title || 'SoundCloud Playlist',
        creator: pl.user?.username || 'Unknown',
        artworkURL: (pl.artwork_url || '').replace('-large', '-t500x500'),
        trackCount: tracks.length,
        tracks,
      };
      await cacheSet(cacheKey, result, 600);
      return c.json(result);
    } catch (e) {
      return c.json({ error: 'SC playlist fetch failed: ' + e.message });
    }
  }

  if (id.startsWith('pi_feed_')) {
    const feedId = id.slice(8);
    const cacheKey = `playlist:pi_feed:${feedId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    const episodes = await piGetEpisodes(feedId, cfg.piKey, cfg.piSecret);
    // Get series info from cache; re-fetch from PI if cache has expired
    let seriesInfo = await cacheGet(`pi:series_info:${feedId}`);
    if (!seriesInfo && cfg.piKey && cfg.piSecret) {
      try {
        const infoRes = await axios.get('https://api.podcastindex.org/api/1.0/podcasts/byfeedid', {
          params: { id: feedId },
          headers: podcastIndexHeaders(cfg.piKey, cfg.piSecret),
          timeout: 5000,
        });
        const f = infoRes.data?.feed;
        if (f) {
          seriesInfo = {
            title: f.title || 'Podcast',
            artworkURL: f.artwork || f.image || '',
            creator: f.author || '',
            description: f.description || '',
          };
          await cacheSet(`pi:series_info:${feedId}`, seriesInfo, 3600);
        }
      } catch {}
    }
    if (!seriesInfo) seriesInfo = { title: 'Podcast', artworkURL: '', creator: '', description: '' };
    const playlistData = {
      id,
      title: seriesInfo.title,
      description: seriesInfo.description || '',
      artworkURL: seriesInfo.artworkURL || '',
      creator: seriesInfo.creator || '',
      tracks: episodes,
    };
    await cacheSet(cacheKey, playlistData, 600);
    return c.json(playlistData);
  }

  if (id.startsWith('taddy_series_')) {
    const uuid = id.slice(13);
    const cacheKey = `playlist:taddy:${uuid}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    const [episodes, seriesInfo] = await Promise.all([
      taddyGetEpisodes(uuid, cfg.taddyKey, cfg.taddyUid),
      cacheGet(`taddy:series_info:${uuid}`),
    ]);
    const info = seriesInfo
      || (episodes && episodes[0]
        ? { title: episodes[0].artist || 'Podcast', artworkURL: episodes[0].artworkURL || '', creator: episodes[0].artist || '' }
        : { title: 'Podcast', artworkURL: '', creator: '' });
    const playlistData = {
      id,
      title: info.title || 'Podcast',
      description: '',
      artworkURL: info.artworkURL || '',
      creator: info.creator || '',
      tracks: episodes || [],
    };
    await cacheSet(cacheKey, playlistData, 600);
    return c.json(playlistData);
  }


  // ── Apple Podcast feed playlist ───────────────────────────────────────────
  if (id.startsWith('apple_feed_')) {
    const collectionId = id.slice('apple_feed_'.length);
    const cacheKey = `playlist:apple_feed:${collectionId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    let feedUrl = await cacheGet(`apple:feed_url:${collectionId}`);
    if (!feedUrl) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: collectionId, media: 'podcast', entity: 'podcast' },
          timeout: 5000,
        });
        feedUrl = lu.data?.results?.[0]?.feedUrl || null;
        if (feedUrl) await cacheSet(`apple:feed_url:${collectionId}`, feedUrl, 86400);
      } catch (e) { console.warn('[Apple] playlist feedUrl lookup error:', e.message); }
    }
    if (feedUrl) {
      const feedData = await appleGetFeed(feedUrl, collectionId);
      if (feedData) {
        const playlistData = {
          id, title: feedData.title, description: feedData.description || '',
          artworkURL: feedData.artworkURL || '', creator: feedData.artist || '',
          tracks: feedData.tracks,
        };
        await cacheSet(cacheKey, playlistData, 600);
        return c.json(playlistData);
      }
    }
    return c.json({ error: 'Apple Podcast feed not found — no RSS feed URL available' });
  }

  // ── Radio genre playlist ────────────────────────────────────────────────
  if (id.startsWith('radioplaylist:')) {
    const genre = decodeURIComponent(id.slice(14));
    const cacheKey = `radioplaylist:${genre}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [rbRes, somaRes] = await Promise.allSettled([
      radioSearch(genre),
      somaFmSearch(genre),
    ]);
    const rb   = rbRes.status   === 'fulfilled' ? (rbRes.value   || []) : [];
    const soma = somaRes.status === 'fulfilled' ? (somaRes.value || []) : [];
    const seen = new Set();
    const tracks = [];
    for (const s of [...rb, ...soma]) {
      const key = (s.title || '').toLowerCase().slice(0, 40);
      if (!seen.has(key)) { seen.add(key); tracks.push(s); }
    }
    const result = {
      id,
      title:      genre.charAt(0).toUpperCase() + genre.slice(1) + ' Radio',
      creator:    'Radio Browser',
      artworkURL: tracks[0]?.artworkURL || null,
      trackCount: tracks.length,
      tracks:     tracks.slice(0, 30),
    };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  }

  // ── Audiobook collection playlist ─────────────────────────────────────────
  if (id === 'audiobook:collection:librivox' || id === 'audiobook:collection:ia') {
    const isLvox = id === 'audiobook:collection:librivox';
    const cacheKey = id;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const books = isLvox
      ? (await librivoxSearch('popular') || [])
      : (await iaSearchAudiobooks('audiobook') || []);

    const tracks = books.map(b => ({
      id: b.id, title: b.title, artist: b.artist || b.creator || 'Unknown Author',
      album: b.title, duration: b.duration || null, artworkURL: b.artworkURL || null,
      format: 'mp3', source: b.source,
    }));
    const result = {
      id,
      title:      isLvox ? 'LibriVox — Free Public Domain Audiobooks' : 'Internet Archive Audiobooks',
      creator:    isLvox ? 'LibriVox' : 'Internet Archive',
      artworkURL: null,
      trackCount: tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, result, 600);
    return c.json(result);
  }

  if (id.startsWith('qobuzplaylist_')) {
    const qobuzPlaylistId = id.slice(14);
    const plCacheKey = `qobuz:playlist:${qobuzPlaylistId}`;
    const cachedPl = await cacheGet(plCacheKey);
    if (cachedPl) return c.json(cachedPl);
    for (const inst of QOBUZ_INSTANCES) {
      try {
        // The proxy /playlist/:id returns metadata but tracks is always empty.
        // Strategy: get playlist metadata, then use name/genres to search for tracks.
        const r = await axios.get(`${inst}/playlist/${qobuzPlaylistId}`, {
          headers: { 'User-Agent': UA },
          timeout: 9000,
        });
        const pl = r.data || {};
        if (!pl?.id) continue;

        const cover = (Array.isArray(pl.images300) && pl.images300[0])
          || (Array.isArray(pl.image_rectangle) && pl.image_rectangle[0])
          || (Array.isArray(pl.images) && pl.images[0])
          || null;
        const plName = pl.name || pl.title || '';
        const genre = pl.genres?.[0]?.name || '';

        // Build search queries from playlist name keywords + genre
        // Strip common filler words to get better search terms
        const nameWords = plName.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 4);
        const searchQ1 = nameWords.slice(0, 3).join(' ') || genre || 'music';
        const searchQ2 = genre || nameWords.slice(0, 2).join(' ') || 'popular';

        const [sr1, sr2] = await Promise.allSettled([
          axios.get(`${inst}/search`, { params: { q: searchQ1, limit: 30 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
          searchQ2 !== searchQ1
            ? axios.get(`${inst}/search`, { params: { q: searchQ2, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 })
            : Promise.resolve(null),
        ]);

        const trackMap = {};
        for (const res of [sr1, sr2]) {
          if (res.status !== 'fulfilled' || !res.value) continue;
          const data = res.value.data || {};
          const rawTracks = data.tracks?.items || data.tracks || [];
          for (const t of rawTracks) {
            if (!t?.id || trackMap[t.id]) continue;
            trackMap[t.id] = {
              id:         `qobuz_${t.id}`,
              title:      t.title || 'Unknown',
              artist:     t.performer?.name || t.album?.artist?.name || 'Unknown',
              album:      t.album?.title || '',
              duration:   t.duration || undefined,
              artworkURL: t.album?.image?.large || cover,
              format:     'flac',
              source:     'qobuz',
            };
          }
        }

        const tracks = Object.values(trackMap).slice(0, 50);
        const result = {
          id,
          title:      plName || 'Unknown Playlist',
          artist:     pl.owner?.name || 'Qobuz',
          artworkURL: cover,
          trackCount: pl.tracks_count || tracks.length,
          tracks,
        };
        await cacheSet(plCacheKey, result, 600);
        return c.json(result);
      } catch(e) { continue; }
    }
    return c.json({ error: 'Qobuz playlist not found' });
  }

  if (id.startsWith('deezer:playlist:')) {
    const data = await deezerPlaylist(id.replace('deezer:playlist:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer playlist not found' }, 404);
  }
      c.json({ error: 'Playlist not found' }, 404);
}

app.get('/playlist/:id', handlePlaylist);
app.get('/:token/playlist/:id', handlePlaylist);


// ─── HiFi Instance Health Check ──────────────────────────────────────────────
app.get('/instances', async (c) => {
  const list = DEFAULT_HIFI_INSTANCES;
  const results = await Promise.allSettled(list.map(async inst => {
    const start = Date.now();
    try {
      const r = await axios.get(`${inst}/search/`, {
        params: { s: 'test', limit: 1 },
        headers: { 'User-Agent': UA },
        timeout: 5000,
      });
      const ok = r.status === 200 && typeof r.data === 'object' && r.data !== null;
      return { inst, online: ok, latency: Date.now() - start };
    } catch (e) {
      return { inst, online: false, latency: Date.now() - start, error: e.message };
    }
  }));
  const instances = results.map(r => r.status === 'fulfilled' ? r.value : { inst: '?', online: false });
  return c.json({
    instances,
    checked: instances.length,
    online: instances.filter(i => i.online).length,
  });
});

// Health check
app.get('/health', async (c) => {
  const hifiInst = await getWorkingHiFiInstance([]);
  const scId = await getSCClientId(null);
  return c.json({
    status: 'ok',
    cache: null ? 'redis' : 'memory',
    hifi_instance: hifiInst || 'none found',
    sc_client_id: scId ? scId.slice(0, 8) + '...' : 'not discovered',
    timestamp: new Date().toISOString(),
  });
});

// ─── Config / Generator Page ─────────────────────────────────────────────────

function buildConfigPage(baseUrl) {
  var S = [];
  function w(s) { S.push(s); }

  w('<!DOCTYPE html>');
  w('<html lang="en">');
  w('<head>');
  w('<meta charset="UTF-8">');
  w('<meta name="viewport" content="width=device-width,initial-scale=1">');
  w('<title>Eclipse Universal Addon</title>');
  w('<link href="https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,600,700&display=swap" rel="stylesheet">');
  w('<style>');
  w('*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}');
  w(':root{');
  w('  --bg:#0a0a0d;--surf:#111115;--surf2:#17171d;--surf3:#1e1e26;');
  w('  --bdr:#242430;--bdrh:#343448;');
  w('  --txt:#dddde8;--muted:#6e6e88;--faint:#2e2e3e;');
  w('  --pri:#7c6af5;--prih:#9083f8;--glow:rgba(124,106,245,.15);');
  w('  --ok:#3dba7a;--err:#e05555;');
  w('  --r:10px;--rsm:6px;--rlg:16px;--tr:160ms cubic-bezier(0.16,1,0.3,1);');
  w('}');
  w('html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;scroll-behavior:smooth}');
  w('body{font-family:"Satoshi",system-ui,sans-serif;background:var(--bg);color:var(--txt);min-height:100dvh;line-height:1.55}');
  w('.page{max-width:600px;margin:0 auto;padding:48px 20px 80px}');
  w('.hdr{display:flex;align-items:center;gap:14px;margin-bottom:36px}');
  w('.hdr-logo{width:44px;height:44px;border-radius:12px;background:var(--glow);border:1px solid rgba(124,106,245,.3);display:flex;align-items:center;justify-content:center;flex-shrink:0}');
  w('.hdr-text h1{font-size:1.2rem;font-weight:700;letter-spacing:-.025em;color:#fff}');
  w('.hdr-text p{font-size:.78rem;color:var(--muted);margin-top:2px}');
  w('.card{background:var(--surf);border:1px solid var(--bdr);border-radius:var(--rlg);padding:22px;margin-bottom:12px}');
  w('.ctitle{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:8px}');
  w('.otag{font-size:.62rem;font-weight:500;text-transform:none;color:var(--muted);opacity:.7;background:var(--surf3);padding:1px 7px;border-radius:99px;border:1px solid var(--bdr)}');
  w('.tip{background:var(--surf2);border:1px solid var(--bdr);border-radius:var(--rsm);padding:10px 13px;font-size:.78rem;color:var(--muted);line-height:1.65;margin-bottom:12px}');
  w('.tip b{color:var(--txt)}');
  w('label.lbl{display:block;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:5px;margin-top:12px}');
  w('label.lbl:first-child{margin-top:0}');
  w('input[type=text],input[type=password]{width:100%;background:var(--surf2);border:1px solid var(--bdr);border-radius:var(--rsm);color:var(--txt);padding:9px 12px;font-size:.875rem;font-family:"Satoshi",system-ui,sans-serif;transition:border-color var(--tr),box-shadow var(--tr);outline:none}');
  w('input:focus{border-color:var(--pri);box-shadow:0 0 0 3px var(--glow)}');
  w('input::placeholder{color:var(--faint)}');
  w('.hint{font-size:.72rem;color:var(--faint);line-height:1.6;margin-top:5px}');
  w('.hint a{color:var(--pri);text-decoration:none}.hint a:hover{text-decoration:underline}');
  w('.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}');
  w('@media(max-width:460px){.row2{grid-template-columns:1fr}}');
  w('.ct-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}');
  w('.ct-btn{display:flex;align-items:center;gap:8px;background:var(--surf2);border:1px solid var(--bdr);border-radius:var(--r);padding:10px 14px;cursor:pointer;transition:all var(--tr);user-select:none;min-width:130px}');
  w('.ct-btn:hover{border-color:var(--bdrh);background:var(--surf3)}');
  w('.ct-btn.on{background:rgba(124,106,245,.12);border-color:rgba(124,106,245,.45)}');
  w('.ct-btn.on .ct-dot{background:var(--pri);box-shadow:0 0 6px rgba(124,106,245,.5)}');
  w('.ct-dot{width:8px;height:8px;border-radius:50%;background:var(--faint);transition:all var(--tr);flex-shrink:0}');
  w('.ct-label{font-size:.8rem;font-weight:600;color:var(--muted);transition:color var(--tr)}');
  w('.ct-btn.on .ct-label{color:#c0b8ff}');
  w('.ct-sub{font-size:.67rem;color:var(--faint);margin-top:1px}');
  w('.ct-info{display:flex;flex-direction:column}');
  w('.stitle{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:7px;margin-top:16px}');
  w('.srow{display:flex;flex-wrap:wrap;gap:7px}');
  w('.sbtn{display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--surf2);border:1px solid var(--bdr);border-radius:var(--r);padding:9px 13px;cursor:pointer;color:var(--muted);transition:all var(--tr);min-width:86px;position:relative;user-select:none}');
  w('.sbtn:hover{background:var(--surf3);color:var(--txt);border-color:var(--bdrh)}');
  w('.sbtn.on{background:rgba(124,106,245,.12);border-color:rgba(124,106,245,.5);color:#c0b8ff}');
  w('.sbtn .sn{font-size:.78rem;font-weight:700;line-height:1.3}');
  w('.sbtn .st{font-size:.67rem;opacity:.5;margin-top:2px}');
  w('.sbadge{position:absolute;top:-8px;left:50%;transform:translateX(-50%);background:var(--pri);color:#fff;font-size:.58rem;font-weight:800;padding:1px 6px;border-radius:99px;white-space:nowrap}');
  w('.shint{font-size:.72rem;color:var(--faint);margin-top:6px;line-height:1.6}');
  w('.brow{display:flex;gap:10px;flex-wrap:wrap}');
  w('.btn{padding:11px 24px;border-radius:var(--rsm);font-size:.875rem;font-weight:700;font-family:"Satoshi",system-ui,sans-serif;cursor:pointer;transition:all var(--tr);border:none;outline:none}');
  w('.bprimary{background:var(--pri);color:#fff;box-shadow:0 2px 12px rgba(124,106,245,.3)}');
  w('.bprimary:hover{background:var(--prih);box-shadow:0 4px 20px rgba(124,106,245,.4);transform:translateY(-1px)}');
  w('.bprimary:active{transform:none;box-shadow:none}');
  w('.bprimary:disabled{background:var(--surf3);color:var(--muted);box-shadow:none;cursor:not-allowed;transform:none}');
  w('.bsec{background:var(--surf2);border:1px solid var(--bdr);color:var(--muted)}');
  w('.bsec:hover{border-color:var(--bdrh);color:var(--txt)}');
  w('.status{padding:10px 14px;border-radius:var(--rsm);font-size:.8rem;margin-top:10px;display:none;line-height:1.5}');
  w('.s-ok{background:rgba(61,186,122,.1);border:1px solid rgba(61,186,122,.25);color:var(--ok)}');
  w('.s-err{background:rgba(224,85,85,.1);border:1px solid rgba(224,85,85,.25);color:var(--err)}');
  w('.outbox{display:none;margin-top:16px}');
  w('.out-item{margin-bottom:14px}');
  w('.out-item:last-child{margin-bottom:0}');
  w('.olbl{font-size:.67rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:5px}');
  w('.orow{display:flex;gap:8px;align-items:stretch}');
  w('.ourl{flex:1;background:var(--surf2);border:1px solid var(--bdr);border-radius:var(--rsm);padding:9px 12px;font-size:.72rem;font-family:"SF Mono",ui-monospace,monospace;color:#a09aff;word-break:break-all;line-height:1.5;min-height:38px;display:flex;align-items:center}');
  w('.cbtn{background:var(--surf2);border:1px solid var(--bdr);color:var(--muted);padding:8px 14px;border-radius:var(--rsm);cursor:pointer;font-size:.78rem;font-family:"Satoshi",system-ui,sans-serif;white-space:nowrap;transition:all var(--tr);flex-shrink:0}');
  w('.cbtn:hover{border-color:rgba(124,106,245,.4);color:var(--pri)}');
  w('.cbtn.cp{border-color:rgba(61,186,122,.4);color:var(--ok);background:rgba(61,186,122,.08)}');
  w('.steps{display:flex;flex-direction:column;gap:10px}');
  w('.step{display:flex;gap:12px;align-items:flex-start}');
  w('.stepn{width:24px;height:24px;border-radius:50%;background:var(--glow);border:1px solid rgba(124,106,245,.3);color:var(--pri);font-size:.75rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}');
  w('.stept{font-size:.8rem;color:var(--muted);line-height:1.55}');
  w('.stept b{color:var(--txt)}');
  w('footer{margin-top:32px;text-align:center;font-size:.7rem;color:var(--faint);line-height:1.8}');
  w('</style>');
  w('</head>');
  w('<body>');
  w('<div class="page">');

  w('<div class="hdr">');
  w('  <div class="hdr-logo">');
  w('    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(124,106,245,.9)" stroke-width="2" stroke-linecap="round">');
  w('      <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>');
  w('      <line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/>');
  w('      <line x1="3" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21" y2="12"/>');
  w('    </svg>');
  w('  </div>');
  w('  <div class="hdr-text">');
  w('    <h1>Eclipse Universal Addon</h1>');
  w('    <p>HiFi &middot; Qobuz &middot; SoundCloud &middot; Deezer &middot; Podcasts &middot; Audiobooks &middot; Radio</p>');
  w('  </div>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">Deployment URL <span class="otag">pre-filled</span></div>');
  w('  <input type="text" id="vercelUrl" value="' + String(baseUrl).replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '" placeholder="https://your-addon.vercel.app">');
  w('  <p class="hint">Only change this if you host on a different URL.</p>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">HiFi / Tidal Instance URLs <span class="otag">optional</span></div>');
  w('  <input type="text" id="hifiInst" placeholder="https://hifi.yourdomain.com (comma-separated)">');
  w('  <p class="hint">Leave blank to use the built-in public instance pool.</p>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">SoundCloud Client ID <span class="otag">optional</span></div>');
  w('  <input type="text" id="scId" placeholder="Leave blank for auto-discovery">');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">Podcast Index <span class="otag">optional &mdash; <a href="https://podcastindex.org/login" target="_blank" rel="noopener">podcastindex.org/login</a></span></div>');
  w('  <div class="row2">');
  w('    <div><label class="lbl">API Key</label><input type="text" id="piKey" placeholder="API Key"></div>');
  w('    <div><label class="lbl">API Secret</label><input type="password" id="piSecret" placeholder="API Secret"></div>');
  w('  </div>');
  w('  <p class="hint">Without these, podcast search uses Taddy + Apple Podcasts only.</p>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">Taddy <span class="otag">optional &mdash; <a href="https://taddy.org/developers" target="_blank" rel="noopener">taddy.org/developers</a></span></div>');
  w('  <div class="row2">');
  w('    <div><label class="lbl">API Key</label><input type="text" id="taddyKey" placeholder="API Key"></div>');
  w('    <div><label class="lbl">User ID</label><input type="text" id="taddyUid" placeholder="User ID"></div>');
  w('  </div>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">Content Types</div>');
  w('  <div class="tip"><b>Enabled types get their own install URL.</b> Disable any you don\'t want &mdash; they\'ll be excluded from search and no URL shown.</div>');
  w('  <div class="ct-row">');
  w('    <div class="ct-btn on" id="ct-podcast" onclick="toggleCT(\'podcast\')">');
  w('      <div class="ct-dot"></div>');
  w('      <div class="ct-info"><div class="ct-label">Podcasts</div><div class="ct-sub">PI &middot; Taddy &middot; Apple</div></div>');
  w('    </div>');
  w('    <div class="ct-btn on" id="ct-audiobook" onclick="toggleCT(\'audiobook\')">');
  w('      <div class="ct-dot"></div>');
  w('      <div class="ct-info"><div class="ct-label">Audiobooks</div><div class="ct-sub">LibriVox &middot; Archive</div></div>');
  w('    </div>');
  w('    <div class="ct-btn on" id="ct-radio" onclick="toggleCT(\'radio\')">');
  w('      <div class="ct-dot"></div>');
  w('      <div class="ct-info"><div class="ct-label">Radio</div><div class="ct-sub">Radio Browser &middot; SomaFM</div></div>');
  w('    </div>');
  w('  </div>');
  w('  <p class="hint" style="margin-top:10px">Music is always included and cannot be disabled.</p>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">Music Source Priority <span class="otag">optional</span></div>');
  w('  <div class="tip"><b>Click to set priority order.</b> First clicked = highest priority. Defaults are pre-selected. Click an active source to remove it.</div>');
  w('  <div class="stitle">Search Sources</div>');
  w('  <div class="srow" id="searchRow">');
  w('    <div class="sbtn" id="ss-hifi"   onclick="toggleSearch(\'hifi\')">  <span class="sn">Tidal HiFi</span><span class="st">Hi-Res FLAC</span></div>');
  w('    <div class="sbtn" id="ss-qobuz"  onclick="toggleSearch(\'qobuz\')"> <span class="sn">Qobuz</span>     <span class="st">Hi-Res FLAC</span></div>');
  w('    <div class="sbtn" id="ss-sc"     onclick="toggleSearch(\'sc\')">    <span class="sn">SoundCloud</span><span class="st">MP3 Free</span></div>');
  w('    <div class="sbtn" id="ss-ia"     onclick="toggleSearch(\'ia\')">    <span class="sn">Archive</span>   <span class="st">Various</span></div>');
  w('    <div class="sbtn" id="ss-deezer" onclick="toggleSearch(\'deezer\')"><span class="sn">Deezer</span>    <span class="st">MP3 Free</span></div>');
  w('  </div>');
  w('  <div class="shint" id="searchHint">Loading...</div>');
  w('  <div class="stitle">Stream Sources</div>');
  w('  <div class="srow" id="streamRow">');
  w('    <div class="sbtn" id="st-hifi"   onclick="toggleStream(\'hifi\')">  <span class="sn">Tidal HiFi</span><span class="st">Hi-Res FLAC</span></div>');
  w('    <div class="sbtn" id="st-qobuz"  onclick="toggleStream(\'qobuz\')"> <span class="sn">Qobuz</span>     <span class="st">Hi-Res FLAC</span></div>');
  w('    <div class="sbtn" id="st-sc"     onclick="toggleStream(\'sc\')">    <span class="sn">SoundCloud</span><span class="st">MP3 Free</span></div>');
  w('    <div class="sbtn" id="st-ia"     onclick="toggleStream(\'ia\')">    <span class="sn">Archive</span>   <span class="st">Various</span></div>');
  w('    <div class="sbtn" id="st-deezer" onclick="toggleStream(\'deezer\')"><span class="sn">Deezer</span>    <span class="st">MP3 Free</span></div>');
  w('  </div>');
  w('  <div class="shint" id="streamHint">Loading...</div>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">Generate URLs</div>');
  w('  <div class="brow">');
  w('    <button class="btn bprimary" id="genBtn" onclick="doGenerate()">Generate My Addon URLs</button>');
  w('  </div>');
  w('  <div class="status" id="genStatus"></div>');
  w('  <div class="outbox" id="genBox">');
  w('    <div class="out-item" id="out-music">');
  w('      <div class="olbl">&#9834; Music</div>');
  w('      <div class="orow"><div class="ourl" id="urlMusic"></div><button class="cbtn" id="cpMusic" onclick="copyIt(\'urlMusic\',\'cpMusic\')">Copy</button></div>');
  w('    </div>');
  w('    <div class="out-item" id="out-podcast">');
  w('      <div class="olbl">&#127897; Podcasts</div>');
  w('      <div class="orow"><div class="ourl" id="urlPodcast"></div><button class="cbtn" id="cpPodcast" onclick="copyIt(\'urlPodcast\',\'cpPodcast\')">Copy</button></div>');
  w('    </div>');
  w('    <div class="out-item" id="out-audiobook">');
  w('      <div class="olbl">&#128214; Audiobooks</div>');
  w('      <div class="orow"><div class="ourl" id="urlAudiobook"></div><button class="cbtn" id="cpAudiobook" onclick="copyIt(\'urlAudiobook\',\'cpAudiobook\')">Copy</button></div>');
  w('    </div>');
  w('    <div class="out-item" id="out-radio">');
  w('      <div class="olbl">&#128251; Radio</div>');
  w('      <div class="orow"><div class="ourl" id="urlRadio"></div><button class="cbtn" id="cpRadio" onclick="copyIt(\'urlRadio\',\'cpRadio\')">Copy</button></div>');
  w('    </div>');
  w('  </div>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">Refresh Existing URL <span class="otag">optional</span></div>');
  w('  <input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">');
  w('  <div class="brow" style="margin-top:10px">');
  w('    <button class="btn bsec" onclick="doRefresh()">Refresh URL</button>');
  w('  </div>');
  w('  <div class="status" id="refStatus"></div>');
  w('  <div class="outbox" id="refBox">');
  w('    <div class="olbl">Refreshed URL</div>');
  w('    <div class="orow"><div class="ourl" id="urlRef"></div><button class="cbtn" id="cpRef" onclick="copyIt(\'urlRef\',\'cpRef\')">Copy</button></div>');
  w('  </div>');
  w('</div>');

  w('<div class="card">');
  w('  <div class="ctitle">How to Install</div>');
  w('  <div class="steps">');
  w('    <div class="step"><div class="stepn">1</div><div class="stept">Fill in any optional API keys, then click <b>Generate My Addon URLs</b></div></div>');
  w('    <div class="step"><div class="stepn">2</div><div class="stept">Open <b>Eclipse</b> &rarr; Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</div></div>');
  w('    <div class="step"><div class="stepn">3</div><div class="stept">Paste a Manifest URL and tap <b>Install</b>. Install each content type separately for its dedicated player.</div></div>');
  w('  </div>');
  w('</div>');

  w('<footer>Eclipse Universal Addon &bull; Keys encoded in URL &bull; Never stored server-side</footer>');
  w('</div>');

  w('<script>');
  w('var searchOrder = ["hifi","qobuz","deezer","sc","ia"];');
  w('var streamOrder = ["qobuz","hifi","deezer","sc","ia"];');
  w('var ctEnabled = { podcast: true, audiobook: true, radio: true };');
  w('var SRCLABELS = { hifi:"Tidal HiFi", qobuz:"Qobuz", sc:"SoundCloud", ia:"Internet Archive", deezer:"Deezer" };');
  w('var ALL_SRCS = ["hifi","qobuz","sc","ia","deezer"];');
  w('');
  w('function toggleCT(type) {');
  w('  ctEnabled[type] = !ctEnabled[type];');
  w('  var btn = document.getElementById("ct-" + type);');
  w('  if (ctEnabled[type]) btn.classList.add("on"); else btn.classList.remove("on");');
  w('}');
  w('');
  w('function toggleSearch(src) {');
  w('  var idx = searchOrder.indexOf(src);');
  w('  if (idx === -1) searchOrder.push(src); else searchOrder.splice(idx, 1);');
  w('  renderSRow("ss-", searchOrder);');
  w('  updateHint("searchHint", searchOrder);');
  w('}');
  w('');
  w('function toggleStream(src) {');
  w('  var idx = streamOrder.indexOf(src);');
  w('  if (idx === -1) streamOrder.push(src); else streamOrder.splice(idx, 1);');
  w('  renderSRow("st-", streamOrder);');
  w('  updateHint("streamHint", streamOrder);');
  w('}');
  w('');
  w('function renderSRow(pfx, order) {');
  w('  ALL_SRCS.forEach(function(src) {');
  w('    var el = document.getElementById(pfx + src);');
  w('    if (!el) return;');
  w('    var pos = order.indexOf(src);');
  w('    var badge = el.querySelector(".sbadge");');
  w('    if (pos === -1) {');
  w('      el.classList.remove("on");');
  w('      if (badge) badge.remove();');
  w('    } else {');
  w('      el.classList.add("on");');
  w('      if (!badge) { badge = document.createElement("span"); badge.className = "sbadge"; el.appendChild(badge); }');
  w('      badge.textContent = pos + 1;');
  w('    }');
  w('  });');
  w('}');
  w('');
  w('function updateHint(hintId, order) {');
  w('  var el = document.getElementById(hintId);');
  w('  if (!el) return;');
  w('  if (!order.length) { el.textContent = "Nothing selected — all sources used with default priority."; return; }');
  w('  var names = order.map(function(s) { return SRCLABELS[s]; });');
  w('  var unsel = ALL_SRCS.filter(function(s) { return order.indexOf(s) === -1; });');
  w('  var msg = "Priority: " + names.join(" > ");');
  w('  if (unsel.length) msg += "  |  disabled: " + unsel.map(function(s) { return SRCLABELS[s]; }).join(", ");');
  w('  el.textContent = msg;');
  w('}');
  w('');
  w('function showStatus(id, msg, type) {');
  w('  var el = document.getElementById(id);');
  w('  el.textContent = msg;');
  w('  el.className = "status " + (type === "ok" ? "s-ok" : "s-err");');
  w('  el.style.display = "block";');
  w('}');
  w('');
  w('function copyIt(urlId, btnId) {');
  w('  var text = document.getElementById(urlId).textContent.trim();');
  w('  if (!text) return;');
  w('  navigator.clipboard.writeText(text).then(function() {');
  w('    var btn = document.getElementById(btnId);');
  w('    btn.textContent = "Copied!"; btn.classList.add("cp");');
  w('    setTimeout(function() { btn.textContent = "Copy"; btn.classList.remove("cp"); }, 2000);');
  w('  });');
  w('}');
  w('');
  w('function doGenerate() {');
  w('  var btn = document.getElementById("genBtn");');
  w('  var vercel = (document.getElementById("vercelUrl").value || "").trim().replace(/[/]+$/, "");');
  w('  if (!vercel) vercel = window.location.origin;');
  w('  if (vercel.indexOf("http") !== 0) vercel = "https://" + vercel;');
  w('  btn.disabled = true; btn.textContent = "Generating...";');
  w('  document.getElementById("genStatus").style.display = "none";');
  w('  var body = { vercelUrl: vercel };');
  w('  var v = function(id) { return (document.getElementById(id).value || "").trim(); };');
  w('  if (v("hifiInst"))  body.hifi       = v("hifiInst");');
  w('  if (v("scId"))      body.sc         = v("scId");');
  w('  if (v("piKey"))     body.pi_key     = v("piKey");');
  w('  if (v("piSecret"))  body.pi_secret  = v("piSecret");');
  w('  if (v("taddyKey"))  body.taddy_key  = v("taddyKey");');
  w('  if (v("taddyUid"))  body.taddy_uid  = v("taddyUid");');
  w('  if (!ctEnabled.podcast)   body.no_podcast   = true;');
  w('  if (!ctEnabled.audiobook) body.no_audiobook = true;');
  w('  if (!ctEnabled.radio)     body.no_radio     = true;');
  w('  if (searchOrder.length) {');
  w('    body.search_order = searchOrder;');
  w('    ALL_SRCS.forEach(function(s) { if (searchOrder.indexOf(s) === -1) body["no_" + s] = true; });');
  w('  }');
  w('  if (streamOrder.length) body.stream_order = streamOrder;');
  w('  fetch("/generate", {');
  w('    method: "POST",');
  w('    headers: { "Content-Type": "application/json" },');
  w('    body: JSON.stringify(body)');
  w('  })');
  w('  .then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })');
  w('  .then(function(data) {');
  w('    if (data.error) throw new Error(data.error);');
  w('    document.getElementById("urlMusic").textContent = data.manifestUrl || "";');
  w('    var sp = data.podcastManifestUrl, sa = data.audiobookManifestUrl, sr = data.radioManifestUrl;');
  w('    document.getElementById("out-podcast").style.display   = (ctEnabled.podcast   && sp) ? "" : "none";');
  w('    document.getElementById("out-audiobook").style.display = (ctEnabled.audiobook && sa) ? "" : "none";');
  w('    document.getElementById("out-radio").style.display     = (ctEnabled.radio     && sr) ? "" : "none";');
  w('    if (sp) document.getElementById("urlPodcast").textContent   = sp;');
  w('    if (sa) document.getElementById("urlAudiobook").textContent = sa;');
  w('    if (sr) document.getElementById("urlRadio").textContent     = sr;');
  w('    document.getElementById("genBox").style.display = "block";');
  w('    showStatus("genStatus", "Done! Copy your install URLs above.", "ok");');
  w('  })');
  w('  .catch(function(e) { showStatus("genStatus", "Error: " + e.message, "err"); })');
  w('  .finally(function() { btn.disabled = false; btn.textContent = "Generate My Addon URLs"; });');
  w('}');
  w('');
  w('function doRefresh() {');
  w('  var raw = (document.getElementById("existingUrl").value || "").trim();');
  w('  if (!raw) { showStatus("refStatus", "Paste your existing URL first.", "err"); return; }');
  w('  fetch("/refresh", {');
  w('    method: "POST",');
  w('    headers: { "Content-Type": "application/json" },');
  w('    body: JSON.stringify({ existingUrl: raw })');
  w('  })');
  w('  .then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })');
  w('  .then(function(data) {');
  w('    if (data.error) throw new Error(data.error);');
  w('    document.getElementById("urlRef").textContent = data.manifestUrl || "";');
  w('    document.getElementById("refBox").style.display = "block";');
  w('    showStatus("refStatus", "Refreshed!", "ok");');
  w('  })');
  w('  .catch(function(e) { showStatus("refStatus", "Error: " + e.message, "err"); });');
  w('}');
  w('');
  w('renderSRow("ss-", searchOrder);');
  w('updateHint("searchHint", searchOrder);');
  w('renderSRow("st-", streamOrder);');
  w('updateHint("streamHint", streamOrder);');
  w('</script>');
  w('</body>');
  w('</html>');

  return S.join('\n');
}

function getBaseUrl(c) {
  return (c.req.header('x-forwarded-proto') || 'https') + '://' + c.req.header('host');
}

// ─── POST /generate — server-side token builder ───────────────────────────────
app.post('/generate', async function(c) {
  var b = await c.req.json().catch(() => ({}));
  var vercel = (b.vercelUrl || '').trim().replace(/\/+$/, '');
  if (!vercel) {
    var proto = c.req.header('x-forwarded-proto') || 'https';
    vercel = proto + '://' + c.req.header('host');
  }
  if (!/^https?:\/\/.+/.test(vercel))
    return c.json({ error: 'Vercel URL must start with http:// or https://' });

  var VALID_QUALITIES = ['LOSSLESS', 'HIGH', 'LOW'];
  var cfg = {};
  if (b.hifi)      cfg.hifi      = b.hifi;
  if (b.sc)        cfg.sc        = b.sc;
  if (b.pi_key)    cfg.pi_key    = b.pi_key;
  if (b.pi_secret) cfg.pi_secret = b.pi_secret;
  if (b.taddy_key) cfg.taddy_key = b.taddy_key;
  if (b.taddy_uid) cfg.taddy_uid = b.taddy_uid;
  if (b.q && VALID_QUALITIES.includes(b.q)) cfg.q = b.q;
  // Source disable flags
  if (b.no_hifi)      cfg.no_hifi      = true;
  if (b.no_sc)        cfg.no_sc        = true;
  if (b.no_ia)        cfg.no_ia        = true;
  if (b.no_qobuz)     cfg.no_qobuz     = true;
  if (b.no_podcast)   cfg.no_podcast   = true;
  if (b.no_audiobook) cfg.no_audiobook = true;
  if (b.no_radio)     cfg.no_radio     = true;
  // Ordered search/stream priority arrays
  if (Array.isArray(b.search_order) && b.search_order.length) cfg.search_order = b.search_order;
  if (Array.isArray(b.stream_order) && b.stream_order.length) cfg.stream_order = b.stream_order;

  // Always generate a tokenized URL, even when no optional keys are set.
  // This keeps podcast/audiobook installs on the token-prefixed route shape:
  //   /{token}/podcast/manifest.json
  //   /{token}/audiobook/manifest.json
  // and avoids the bare /podcast/manifest.json path the user reported as unreliable.
  var token = encodeBase64Url(JSON.stringify(cfg));
  if (!token) token = 'e30';

  return c.json({
    manifestUrl:          vercel + '/' + token + '/manifest.json',
    podcastManifestUrl:   vercel + '/' + token + '/podcast/manifest.json',
    audiobookManifestUrl: vercel + '/' + token + '/audiobook/manifest.json',
    radioManifestUrl:     vercel + '/' + token + '/radio/manifest.json',
    baseUrl:              vercel + '/' + token,
  });
});

// ─── POST /refresh ────────────────────────────────────────────────────────────
app.post('/refresh', async function(c) {
  var rb = await c.req.json().catch(() => ({}));
  var raw = (rb && rb.existingUrl) ? String(rb.existingUrl).trim() : '';
  if (!raw) return c.json({ error: 'Paste your full addon URL.' });
  // Extract base (strip /manifest.json or /{token}/manifest.json)
  var clean = raw.replace(/\/manifest\.json$/, '');
  // Validate it looks like a URL
  if (!/^https?:\/\/.+/.test(clean)) return c.json({ error: 'Invalid URL.' });
  return c.json({ manifestUrl: clean + '/manifest.json', refreshed: true });
});

// ─── GET / and /generator — serve config page ─────────────────────────────────
app.get('/', async function(c) {
  return c.html(buildConfigPage(getBaseUrl(c)));
});

app.get('/generator', async function(c) {
  return c.html(buildConfigPage(getBaseUrl(c)));
});

// ─── 8SPINE Module Endpoints ──────────────────────────────────────────────────
const SPINE_MODULE_CODE = "var BASE_URL = 'https://all-in-one-seven-psi.vercel.app';\nvar RB_BASE = 'https://de1.api.radio-browser.info';\n\n// ─── Helpers ──────────────────────────────────────────────────────────────────\n\nfunction eclipseFetch(path, params) {\n  var qs = '';\n  if (params) {\n    var keys = Object.keys(params);\n    if (keys.length) {\n      qs = '?' + keys.map(function(k) {\n        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);\n      }).join('&');\n    }\n  }\n  return fetch(BASE_URL + path + qs, { headers: { 'Accept': 'application/json' } })\n    .then(function(r) {\n      if (!r.ok) throw new Error('HTTP ' + r.status);\n      return r.json();\n    });\n}\n\nfunction rbFetch(path, params) {\n  var qs = '';\n  if (params) {\n    var keys = Object.keys(params);\n    if (keys.length) {\n      qs = '?' + keys.map(function(k) {\n        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);\n      }).join('&');\n    }\n  }\n  return fetch(RB_BASE + path + qs, {\n    headers: { 'Accept': 'application/json', 'User-Agent': 'EclipseAllInOne/1.0' }\n  }).then(function(r) {\n    if (!r.ok) throw new Error('HTTP ' + r.status);\n    return r.json();\n  });\n}\n\nfunction fetchDirect(url, timeoutMs) {\n  var ms = timeoutMs || 2000;\n  var ctrl = new AbortController();\n  var timer = setTimeout(function() { ctrl.abort(); }, ms);\n  return fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Monochrome/1.0' }, signal: ctrl.signal })\n    .then(function(r) {\n      clearTimeout(timer);\n      if (!r.ok) throw new Error('HTTP ' + r.status);\n      return r.json();\n    }).catch(function(e) { clearTimeout(timer); throw e; });\n}\n\nfunction base64Decode(str) {\n  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');\n  while (s.length % 4) { s += '='; }\n  return atob(s);\n}\n\nfunction extractManifestUrl(manifest) {\n  if (!manifest) return null;\n  try {\n    if (typeof manifest === 'string' && manifest.indexOf('http') === 0) return manifest;\n    var decoded = atob(manifest);\n    var parsed = JSON.parse(decoded);\n    if (parsed.urls && parsed.urls.length > 0) return parsed.urls[0];\n  } catch (e) {}\n  return null;\n}\n\nfunction cleanText(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }\nfunction safeUrl(u) { return /^https?:\\/\\//i.test(String(u || '')) ? String(u) : null; }\nfunction normalizeQ(s) { return cleanText(s).toLowerCase().replace(/[^a-z0-9 ]/g, ''); }\n\nfunction parseHifiId(id) {\n  if (String(id).indexOf('hifi_') !== 0) return null;\n  var rest = String(id).slice(5);\n  var idx = rest.indexOf('_');\n  if (idx === -1) return null;\n  return { instB64: rest.slice(0, idx), origId: rest.slice(idx + 1) };\n}\n\nfunction qualityFallbacks(q) {\n  if (q === 'LOSSLESS') return ['HIGH', 'LOW'];\n  if (q === 'HIGH') return ['LOSSLESS', 'LOW'];\n  return ['HIGH', 'LOSSLESS'];\n}\n\n// ─── Radio Browser helpers ────────────────────────────────────────────────────\n\nfunction stationArtwork(station) {\n  return safeUrl(station.favicon) || 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png';\n}\n\nfunction stationSubtitle(station) {\n  var bits = [];\n  if (station.country) bits.push(cleanText(station.country));\n  if (station.language) bits.push(cleanText(station.language));\n  if (station.codec) bits.push(cleanText(station.codec));\n  if (station.bitrate) bits.push(station.bitrate + 'k');\n  return bits.join(' \\u2022 ');\n}\n\nfunction detectFormat(url, hls) {\n  var u = String(url || '').toLowerCase().split('?')[0];\n  if (hls === 1 || u.indexOf('.m3u8') >= 0) return 'hls';\n  if (u.indexOf('.aac') >= 0 || u.indexOf('.aacp') >= 0) return 'aac';\n  if (u.indexOf('.ogg') >= 0 || u.indexOf('.opus') >= 0) return 'ogg';\n  if (u.indexOf('.flac') >= 0) return 'flac';\n  return 'mp3';\n}\n\nfunction mapStation(station) {\n  var stream = safeUrl(station.url_resolved || station.urlresolved || station.url);\n  return {\n    id: 'rbst_' + station.stationuuid,\n    title: cleanText(station.name) || 'Radio Station',\n    artist: stationSubtitle(station) || 'Radio Browser',\n    album: cleanText(station.tags || station.country || 'Live Radio'),\n    albumCover: stationArtwork(station),\n    duration: 0,\n    audioQuality: 'HIGH',\n    streamUrl: stream\n  };\n}\n\nfunction isRadioId(id) { return String(id).indexOf('rbst_') === 0; }\n\n// ─── Improved radio scoring ───────────────────────────────────────────────────\n\nfunction scoreStation(station, q) {\n  var needle = normalizeQ(q);\n  var name = normalizeQ(station.name);\n  var tags = normalizeQ(station.tags || '');\n  var country = normalizeQ(station.country || '');\n  var language = normalizeQ(station.language || '');\n  var score = 0;\n\n  if (name === needle) score += 500;\n  else if (name.indexOf(needle) === 0) score += 350;\n  else if (new RegExp('\\\\b' + needle.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&') + '\\\\b').test(name)) score += 250;\n  else if (name.indexOf(needle) >= 0) score += 150;\n\n  if (tags.indexOf(needle) >= 0) score += 60;\n  if (country.indexOf(needle) >= 0) score += 40;\n  if (language.indexOf(needle) >= 0) score += 20;\n\n  if (station.lastcheckok === 1) score += 80;\n  score += Math.min(parseInt(station.clickcount || 0, 10), 60);\n  score += Math.min(parseInt(station.votes || 0, 10), 40);\n  if (parseInt(station.bitrate || 0, 10) >= 128) score += 20;\n\n  if (!safeUrl(station.url_resolved || station.urlresolved || station.url)) score -= 500;\n\n  return score;\n}\n\nfunction dedupeStations(list) {\n  var seen = {};\n  var out = [];\n  for (var i = 0; i < list.length; i++) {\n    var uuid = list[i].stationuuid;\n    if (!seen[uuid]) { seen[uuid] = true; out.push(list[i]); }\n  }\n  return out;\n}\n\n// ─── Eclipse track normaliser ─────────────────────────────────────────────────\n\nfunction normaliseTrack(t) {\n  var rawId = String(t.id || t._origId || '');\n  var directUrl = t.streamURL || t.stream_url || t.url || '';\n  var isDirectOnly = (\n    rawId.indexOf('radio_') === 0 ||\n    rawId.indexOf('pi_ep_') === 0 ||\n    rawId.indexOf('taddy_ep_') === 0 ||\n    rawId.indexOf('apple_ep_') === 0 ||\n    rawId.indexOf('lvox_ch_') === 0 ||\n    rawId.indexOf('ia_book_file_') === 0\n  );\n  var id = (isDirectOnly && directUrl) ? ('direct__' + encodeURIComponent(directUrl)) : rawId;\n  return {\n    id: id,\n    title: t.title || t.name || 'Unknown Title',\n    artist: t.artist || t.creator || (t.user && t.user.username) || 'Unknown Artist',\n    album: t.album || t.albumTitle || '',\n    albumCover: t.artworkURL || t.artwork_url || t.cover || '',\n    duration: typeof t.duration === 'number' ? t.duration : 0,\n    audioQuality: (rawId.indexOf('hifi_') === 0) ? 'LOSSLESS' : 'HIGH',\n    availableQualities: ['LOSSLESS', 'HIGH', 'LOW']\n  };\n}\n\nfunction resolveHifiDirect(trackId, quality) {\n  var parsed = parseHifiId(trackId);\n  if (!parsed) return Promise.reject(new Error('Invalid HiFi ID'));\n  var inst = base64Decode(parsed.instB64);\n  var url = inst + '/track/?id=' + encodeURIComponent(parsed.origId) + '&quality=' + encodeURIComponent(quality);\n  return fetchDirect(url).then(function(data) {\n    var payload = data.data || data || {};\n    var streamUrl = extractManifestUrl(payload.manifest) || payload.url || null;\n    if (!streamUrl) throw new Error('No stream URL from HiFi');\n    return {\n      streamUrl: streamUrl,\n      track: {\n        id: payload.trackId || trackId,\n        audioQuality: payload.audioQuality || quality,\n        bitDepth: payload.bitDepth,\n        sampleRate: payload.sampleRate\n      }\n    };\n  });\n}\n\n// ─── searchTracks ─────────────────────────────────────────────────────────────\n// FIX: use /resolve for single-track lookups (playlist import context) —\n// /resolve skips podcast/radio/audiobook sources and is 5-8x faster.\n// Use /search only for open-ended user searches (no context or context.type !== 'resolve').\n\nfunction searchTracks(query, limit, context) {\n  var lim = limit || 25;\n  var isResolve = context && (context.type === 'resolve' || context.playlistImport === true);\n\n  // Playlist import / resolve context: use the lightweight /resolve endpoint\n  var eclipsePromise = eclipseFetch(isResolve ? '/resolve' : '/search', { q: query })\n    .then(function(data) {\n      return (data.tracks || []).slice(0, lim).map(normaliseTrack);\n    }).catch(function() { return []; });\n\n  // Skip radio search entirely for playlist import — not useful there\n  if (isResolve) {\n    return eclipsePromise.then(function(tracks) {\n      return { tracks: tracks, total: tracks.length };\n    });\n  }\n\n  // Full search: radio + eclipse in parallel\n  var p1 = rbFetch('/json/stations/search', {\n    name: query, limit: 40, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var p2 = rbFetch('/json/stations/byname/' + encodeURIComponent(query), {\n    limit: 20, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var p3 = rbFetch('/json/stations/bytag/' + encodeURIComponent(query), {\n    limit: 20, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var radioPromise = Promise.all([p1, p2, p3]).then(function(results) {\n    var raw = (Array.isArray(results[0]) ? results[0] : [])\n      .concat(Array.isArray(results[1]) ? results[1] : [])\n      .concat(Array.isArray(results[2]) ? results[2] : []);\n\n    return dedupeStations(raw)\n      .filter(function(s) {\n        return safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1;\n      })\n      .sort(function(a, b) { return scoreStation(b, query) - scoreStation(a, query); })\n      .slice(0, 15)\n      .map(mapStation);\n  }).catch(function() { return []; });\n\n  return Promise.all([eclipsePromise, radioPromise]).then(function(results) {\n    var combined = results[0].concat(results[1]);\n    return { tracks: combined, total: combined.length };\n  });\n}\n\n// ─── getTrackStreamUrl ────────────────────────────────────────────────────────\n// FIX: for social/unknown IDs, pass ?title=&artist= so the server's social\n// fallback block can search by song name instead of the raw foreign ID string.\n\nfunction getTrackStreamUrl(trackId, preferredQuality, context) {\n  var id = String(trackId);\n  var settings = (context && context.settings) || {};\n  var targetQuality = (settings.quality && settings.quality.value) || preferredQuality || 'LOSSLESS';\n  var fallbackMode = (settings.fallbackMode && settings.fallbackMode.value) || 'flexible';\n\n  // Radio station — use streamUrl from search result directly (instant, no extra fetch)\n  if (isRadioId(id)) {\n    var ctxUrl = context && context.track && safeUrl(context.track.streamUrl);\n    if (ctxUrl) {\n      return Promise.resolve({ streamUrl: ctxUrl, track: { id: trackId, audioQuality: 'HIGH', format: detectFormat(ctxUrl, 0) } });\n    }\n    var uuid = id.slice(5);\n    return rbFetch('/json/stations/byuuid/' + encodeURIComponent(uuid), {}).then(function(rows) {\n      var station = Array.isArray(rows) && rows[0] ? rows[0] : null;\n      if (!station) throw new Error('Station not found');\n      var url = safeUrl(station.url_resolved || station.urlresolved || station.url);\n      if (!url) throw new Error('No stream URL for station');\n      rbFetch('/json/url/' + encodeURIComponent(station.stationuuid), {}).catch(function() {});\n      return {\n        streamUrl: url,\n        track: { id: trackId, audioQuality: 'HIGH', format: detectFormat(url, station.hls) }\n      };\n    });\n  }\n\n  // Direct stream URL (podcasts, audiobook chapters, etc.)\n  if (id.indexOf('direct__') === 0) {\n    var streamUrl = decodeURIComponent(id.slice(8));\n    return Promise.resolve({\n      streamUrl: streamUrl,\n      track: { id: trackId, audioQuality: 'HIGH' }\n    });\n  }\n\n  // HiFi track — race direct HiFi (fast, no server hop) vs server (Qobuz→HiFi→SC)\n  // fetchDirect now has a 2s timeout so a slow/dead instance fails fast.\n  // Promise.any fires both simultaneously — first to succeed plays.\n  if (id.indexOf('hifi_') === 0) {\n    var qualitiesToTry = [targetQuality];\n    if (fallbackMode !== 'strict') {\n      var fallbacks = qualityFallbacks(targetQuality);\n      for (var i = 0; i < fallbacks.length; i++) { qualitiesToTry.push(fallbacks[i]); }\n    }\n    // Direct HiFi: hits preferred instance from client, no server hop\n    function tryQualityDirect(index) {\n      if (index >= qualitiesToTry.length) return Promise.reject(new Error('Direct HiFi exhausted'));\n      return resolveHifiDirect(id, qualitiesToTry[index])\n        .catch(function() { return tryQualityDirect(index + 1); });\n    }\n    var directPromise = tryQualityDirect(0);\n    // Server promise: Qobuz hi-res → HiFi → SC fallback\n    var serverPromise = eclipseFetch('/stream/' + encodeURIComponent(id), { quality: targetQuality })\n      .then(function(data) {\n        var url = data.url || data.streamURL || data.stream_url || null;\n        if (!url) throw new Error('No stream URL from server');\n        return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || data.quality || targetQuality } };\n      });\n    // Race — whichever resolves first wins\n    return Promise.any([directPromise, serverPromise])\n      .catch(function() { throw new Error('No stream found for: ' + id); });\n  }\n\n  // Known non-hifi prefixes that have a proper /stream/ handler — call directly\n  var knownPrefixes = ['sc_', 'ia_music_', 'ia_book_', 'apple_ep_', 'pi_ep_', 'taddy_ep_', 'lvox_'];\n  var isKnown = false;\n  for (var k = 0; k < knownPrefixes.length; k++) {\n    if (id.indexOf(knownPrefixes[k]) === 0) { isKnown = true; break; }\n  }\n  if (isKnown) {\n    return eclipseFetch('/stream/' + encodeURIComponent(id))\n      .then(function(data) {\n        var url = data.url || data.streamURL || data.stream_url || null;\n        if (!url) throw new Error('No stream URL');\n        return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || data.quality || 'HIGH' } };\n      });\n  }\n\n  // ── Social / Cross-Addon fallback ─────────────────────────────────────────\n  // Unknown ID prefix = Social tab, Tidal app, Apple Music, Deezer, Spotify, etc.\n  // Pass title+artist from context so the server can search by song name.\n  // context.track is populated by Eclipse when playing from Social/Library tabs.\n  var socialTitle  = (context && context.track && context.track.title)  ? String(context.track.title).trim()  : '';\n  var socialArtist = (context && context.track && context.track.artist) ? String(context.track.artist).trim() : '';\n\n  var socialParams = { quality: targetQuality };\n  if (socialTitle)  socialParams.title  = socialTitle;\n  if (socialArtist) socialParams.artist = socialArtist;\n\n  return eclipseFetch('/stream/' + encodeURIComponent(id), socialParams)\n    .then(function(data) {\n      var url = data.url || data.streamURL || data.stream_url || null;\n      if (!url) throw new Error('No stream URL');\n      return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || data.quality || 'HIGH' } };\n    });\n}\n\n// ─── getAlbum ─────────────────────────────────────────────────────────────────\n\nfunction getAlbum(albumId) {\n  var id = String(albumId);\n  if (isRadioId(id)) {\n    var uuid = id.slice(5);\n    return rbFetch('/json/stations/byuuid/' + encodeURIComponent(uuid), {}).then(function(rows) {\n      var station = Array.isArray(rows) && rows[0] ? rows[0] : null;\n      if (!station) throw new Error('Station not found');\n      return {\n        album: {\n          id: id,\n          title: cleanText(station.name) || 'Radio Station',\n          artist: cleanText(station.country || station.language || 'Radio Browser'),\n          albumCover: stationArtwork(station),\n          year: 0,\n          description: stationSubtitle(station),\n          trackCount: 1\n        },\n        tracks: [mapStation(station)]\n      };\n    });\n  }\n  return eclipseFetch('/album/' + encodeURIComponent(id)).then(function(data) {\n    return {\n      album: {\n        id: data.id || id,\n        title: data.title || 'Unknown Album',\n        artist: data.artist || data.creator || '',\n        albumCover: data.artworkURL || data.artwork || '',\n        year: safeYear(data.year),\n        description: data.description || '',\n        trackCount: data.trackCount || (data.tracks ? data.tracks.length : 0)\n      },\n      tracks: (data.tracks || []).map(normaliseTrack)\n    };\n  });\n}\n\n// ─── getArtist ────────────────────────────────────────────────────────────────\n\nfunction getArtist(artistId) {\n  var id = String(artistId);\n  if (id.indexOf('rbartist_') === 0) {\n    var country = decodeURIComponent(id.slice(9));\n    return rbFetch('/json/stations/bycountryexact/' + encodeURIComponent(country), {\n      hidebroken: true, order: 'clickcount', reverse: true, limit: 30\n    }).then(function(rows) {\n      var stations = Array.isArray(rows)\n        ? rows.filter(function(s) { return safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1; })\n        : [];\n      return {\n        artist: { id: id, name: country, artworkURL: stations[0] ? stationArtwork(stations[0]) : null },\n        topTracks: stations.slice(0, 8).map(mapStation),\n        albums: stations.slice(0, 12).map(function(s) {\n          return { id: 'rbst_' + s.stationuuid, title: cleanText(s.name), artist: country, albumCover: stationArtwork(s), year: 0 };\n        })\n      };\n    });\n  }\n  return eclipseFetch('/artist/' + encodeURIComponent(id)).then(function(data) {\n    return {\n      artist: { id: data.id || id, name: data.name || 'Unknown Artist', artworkURL: data.artworkURL || data.picture || '' },\n      topTracks: (data.topTracks || []).map(normaliseTrack),\n      albums: (data.albums || []).map(function(a) {\n        return { id: String(a.id || ''), title: a.title || 'Unknown Album', artist: a.artist || data.name || '', albumCover: a.artworkURL || a.cover || '', year: safeYear(a.year) };\n      })\n    };\n  });\n}\n\n// ─── Module export ────────────────────────────────────────────────────────────\n\nreturn {\n  id: 'ricky-all-in-one',\n  name: 'All-In-One',\n  author: 'Ricky',\n  version: '1.0.7',\n  description: 'HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',\n  labels: ['High Quality', 'Multi-Source', 'Radio', 'Settings'],\n  settings: {\n    quality: {\n      type: 'selector',\n      label: 'Audio Quality',\n      description: 'Select preferred streaming quality for HiFi tracks',\n      options: [\n        { label: '128kbps',         value: 'LOW'      },\n        { label: '320kbps',         value: 'HIGH'     },\n        { label: 'Lossless (FLAC)', value: 'LOSSLESS' }\n      ],\n      defaultValue: 'LOSSLESS'\n    },\n    fallbackMode: {\n      type: 'selector',\n      label: 'Quality Fallback',\n      description: 'Allow fallback to other qualities if preferred is unavailable',\n      options: [\n        { label: 'Flexible', value: 'flexible' },\n        { label: 'Strict',   value: 'strict'   }\n      ],\n      defaultValue: 'flexible'\n    }\n  },\n  searchTracks: searchTracks,\n  getTrackStreamUrl: getTrackStreamUrl,\n  getAlbum: getAlbum,\n  getArtist: getArtist\n};\n";

app.get('/8spine', async function(c) {
  var base = getBaseUrl(c);
  return c.json({
    id: 'ricky-all-in-one',
    name: 'All-In-One',
    author: 'Ricky',
    version: '1.0.7',
    description: 'Qobuz, HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',
    download: base + '/8spine.js'
  });
});

app.get('/8spine.js', async function(c) {
  return c.html(SPINE_MODULE_CODE);
});

app.get('/8spine-source.json', async function(c) {
  var base = getBaseUrl(c);

  var ourEntry = {
    id: 'ricky-all-in-one',
    name: 'All-In-One',
    author: 'Ricky',
    version: '1.0.7',
    description: 'Qobuz, HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',
    labels: ['High Quality', 'Multi-Source', 'Radio', 'Settings'],
    download: base + '/8spine.js'
  };

  // Add more 8spine-source.json URLs here to include additional sources
  var EXTRA_SPINE_SOURCES = [
    'https://monochrome.rickyaddons.dpdns.org/8spine-source.json',
    'https://eclipse3.cyrusna29.workers.dev/8spine-source.json',
    'https://qobuz-tidal-eclipse.cyrusna29.workers.dev/8spine-source.json',
  ];

  var merged = { 'category:music': [ourEntry] };

  var results = await Promise.all(
    EXTRA_SPINE_SOURCES.map(function(url) {
      return fetch(url, { headers: { 'Accept': 'application/json' } })
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(function() { return null; });
    })
  );

  for (var i = 0; i < results.length; i++) {
    var ext = results[i];
    if (!ext || typeof ext !== 'object') continue;
    var cats = Object.keys(ext);
    for (var j = 0; j < cats.length; j++) {
      var cat = cats[j];
      var items = ext[cat];
      if (!Array.isArray(items)) continue;
      if (!merged[cat]) merged[cat] = [];
      for (var k = 0; k < items.length; k++) {
        var item = items[k];
        if (!merged[cat].find(function(e) { return e.id === item.id; })) {
          merged[cat].push(item);
        }
      }
    }
  }

  return c.json(merged);
});

// ─── Catch-all token info ─────────────────────────────────────────────────────
app.get('/:token', function(c) {
  var t = c.req.param('token');
  if (['health','favicon.ico','generate','refresh','search','stream','album','playlist','manifest.json'].includes(t)) return next();
  return c.json({ name: 'Eclipse Universal Addon', version: '1.3.0', token: t, status: 'running' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// ─── Keepalive: ping cold-start instances on cron ────────────────────────────
const KEEPALIVE_TARGETS = [
  'https://hifi-api-pj08.onrender.com',      // Render free — cold starts after 15min idle
  'https://qobuz-api1.onrender.com',          // Render free — cold starts after 15min idle
  'https://trypt-hifi-dl-456461932686.us-west1.run.app', // Cloud Run free — cold starts too
  'https://hifi-api-bffw.onrender.com',
];

async function runKeepalive() {
  await Promise.allSettled(
    KEEPALIVE_TARGETS.map(url =>
      axios.get(url, { timeout: 10000 }).catch(() => {})
    )
  );
  console.log('[keepalive] pinged', KEEPALIVE_TARGETS.length, 'instances');
}

export default {
  fetch: app.fetch.bind(app),
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runKeepalive());
  },
};
