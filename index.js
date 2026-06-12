/* ============================================================
   m All-in-One Addon v2.1  –  Cloudflare Worker
   Sources: Qobuz · Tidal · Deezer · SoundCloud · MusicBrainz
            Internet Archive · Podcast Index · Radio Browser
   ============================================================ */

// ─── Constants ───────────────────────────────────────────────────────────────
const VERSION = "2.1.0";
const DEFAULT_TIMEOUT_MS = 8000;

const SOURCE_IDS = {
  TIDAL:           "tidal",
  QOBUZ:           "qobuz",
  DEEZER:          "deezer",
  SOUNDCLOUD:      "soundcloud",
  MUSICBRAINZ:     "musicbrainz",
  INTERNET_ARCHIVE:"internetarchive",
  PODCAST:         "podcast",
  AUDIOBOOK:       "audiobook",
  RADIO:           "radio",
};

// Default search source order (user can override via manifest URL)
const DEFAULT_SEARCH_ORDER = [
  SOURCE_IDS.TIDAL,
  SOURCE_IDS.QOBUZ,
  SOURCE_IDS.DEEZER,
  SOURCE_IDS.SOUNDCLOUD,
  SOURCE_IDS.MUSICBRAINZ,
  SOURCE_IDS.INTERNET_ARCHIVE,
];

// Default stream source order
const DEFAULT_STREAM_ORDER = [
  SOURCE_IDS.QOBUZ,
  SOURCE_IDS.TIDAL,
  SOURCE_IDS.DEEZER,
  SOURCE_IDS.SOUNDCLOUD,
  SOURCE_IDS.INTERNET_ARCHIVE,
];

// ─── CORS helper ─────────────────────────────────────────────────────────────
function corsHeaders(origin, allowed) {
  const ao = allowed === "*" ? "*" : (origin || "*");
  return {
    "Access-Control-Allow-Origin": ao,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function jsonResp(data, status = 200, origin = "*", allowedOrigins = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, allowedOrigins),
    },
  });
}

// ─── Timeout-wrapped fetch ────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── Normalisation helpers ────────────────────────────────────────────────────
function normaliseStr(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")               // strip accents
    .replace(/[\u2018\u2019\u201C\u201D]/g, "")   // smart quotes
    .replace(/\bfeat\.?\s+\w+.*/i, "")            // strip feat. tags
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function durationBucket(secs) {
  // bucket to nearest 4 seconds to absorb minor encode-length differences
  if (!secs) return 0;
  return Math.round(Number(secs) / 4);
}

/** Build a fuzzy track identity key from available metadata */
function trackKey(isrc, title, artist, durationSec, album) {
  if (isrc) {
    const clean = String(isrc).toUpperCase().replace(/\s/g, "");
    if (clean.length >= 12) return `isrc:${clean}`;
  }
  const t  = normaliseStr(title);
  const a  = normaliseStr(artist);
  const d  = durationBucket(durationSec);
  return `track:${a}|${t}|${d}`;
}

/** Build album identity key */
function albumKey(mbid, title, artist) {
  if (mbid) return `mbid:${mbid}`;
  const t = normaliseStr(title);
  const a = normaliseStr(artist);
  return `album:${a}|${t}`;
}

/** Build artist identity key */
function artistKey(mbid, name) {
  if (mbid) return `artist-mbid:${mbid}`;
  return `artist:${normaliseStr(name)}`;
}

// ─── Deduplication engine ─────────────────────────────────────────────────────
class DedupeSet {
  constructor() { this.seen = new Set(); }
  /** Returns true if this item is new (not a dupe). Registers it if new. */
  check(key) {
    if (!key || this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

/**
 * Merge results from multiple sources respecting priority order.
 * Each source result set is { tracks:[], albums:[], artists:[] }
 * Returns merged { tracks:[], albums:[], artists:[] }
 */
function mergeResults(orderedSourceResults) {
  // orderedSourceResults is ALREADY in user-priority order.
  // Source 1 fills ALL its results first. Source 2 only fills gaps.
  // Tracks: dedup by ISRC first, then title+artist+duration.
  // Albums: sort newest-first within each source before merging, dedup by mbid/title+artist.
  // Artists: dedup by mbid/name.
  const trackDedupe  = new DedupeSet();
  const albumDedupe  = new DedupeSet();
  const artistDedupe = new DedupeSet();

  const sortNewest = arr => arr.slice().sort((a, b) => {
    const da = String(a?.year || a?.releaseDate || "0000");
    const db = String(b?.year || b?.releaseDate || "0000");
    return db.localeCompare(da);
  });

  const merged = { tracks: [], albums: [], artists: [] };

  for (const { source, results } of orderedSourceResults) {
    if (!results) continue;

    // --- tracks (priority-first: all of source 1, then gaps from source 2, etc.) ---
    for (const t of (results.tracks || [])) {
      const key = trackKey(t.isrc, t.title, t.artist, t.duration, t.album);
      if (trackDedupe.check(key)) {
        merged.tracks.push({ ...t, _source: source });
      }
    }

    // --- albums (sort newest-first within each source, then priority-merge) ---
    for (const a of sortNewest(results.albums || [])) {
      const key = albumKey(a.mbid, a.title, a.artist);
      if (albumDedupe.check(key)) {
        merged.albums.push({ ...a, _source: source });
      }
    }

    // --- artists ---
    for (const a of (results.artists || [])) {
      const key = artistKey(a.mbid, a.name);
      if (artistDedupe.check(key)) {
        merged.artists.push({ ...a, _source: source });
      }
    }
  }

  return merged;
}

// ─── MusicBrainz enrichment (ISRC / MBID lookup) ─────────────────────────────
const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_HEADERS = { "User-Agent": "EclipseAllInOne/2.0 (eclipse-addon)" };

async function mbLookupISRC(isrc) {
  if (!isrc) return null;
  try {
    const url = `${MB_BASE}/recording?query=isrc:${isrc}&fmt=json&limit=1`;
    const r = await fetchWithTimeout(url, { headers: MB_HEADERS }, 5000);
    if (!r.ok) return null;
    const d = await r.json();
    const rec = d.recordings?.[0];
    if (!rec) return null;
    return {
      mbid: rec.id,
      title: rec.title,
      artist: rec["artist-credit"]?.[0]?.name || "",
      duration: rec.length ? Math.round(rec.length / 1000) : null,
      album: rec.releases?.[0]?.title || "",
    };
  } catch { return null; }
}

async function mbSearchTracks(query, limit = 10) {
  try {
    const q = encodeURIComponent(query);
    const url = `${MB_BASE}/recording?query=${q}&fmt=json&limit=${limit}`;
    const r = await fetchWithTimeout(url, { headers: MB_HEADERS }, 6000);
    if (!r.ok) return { tracks: [], albums: [], artists: [] };
    const d = await r.json();
    const tracks = (d.recordings || []).map(rec => ({
      id:       `mb-${rec.id}`,
      mbid:     rec.id,
      isrc:     rec.isrcs?.[0] || null,
      title:    rec.title,
      artist:   rec["artist-credit"]?.[0]?.name || "",
      album:    rec.releases?.[0]?.title || "",
      duration: rec.length ? Math.round(rec.length / 1000) : null,
      cover:    null,
      streamable: false,
      source:   SOURCE_IDS.MUSICBRAINZ,
    }));
    return { tracks, albums: [], artists: [] };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function mbSearchAlbums(query, limit = 10) {
  try {
    const q = encodeURIComponent(query);
    const url = `${MB_BASE}/release?query=${q}&fmt=json&limit=${limit}`;
    const r = await fetchWithTimeout(url, { headers: MB_HEADERS }, 6000);
    if (!r.ok) return { tracks: [], albums: [], artists: [] };
    const d = await r.json();
    const albums = (d.releases || []).map(rel => ({
      id:     `mb-${rel.id}`,
      mbid:   rel.id,
      title:  rel.title,
      artist: rel["artist-credit"]?.[0]?.name || "",
      year:   rel.date?.substring(0, 4) || null,
      cover:  null,
      source: SOURCE_IDS.MUSICBRAINZ,
    }));
    return { tracks: [], albums, artists: [] };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function mbSearchArtists(query, limit = 10) {
  try {
    const q = encodeURIComponent(query);
    const url = `${MB_BASE}/artist?query=${q}&fmt=json&limit=${limit}`;
    const r = await fetchWithTimeout(url, { headers: MB_HEADERS }, 6000);
    if (!r.ok) return { tracks: [], albums: [], artists: [] };
    const d = await r.json();
    const artists = (d.artists || []).map(a => ({
      id:     `mb-${a.id}`,
      mbid:   a.id,
      name:   a.name,
      genres: (a.tags || []).slice(0, 5).map(t => t.name),
      cover:  null,
      source: SOURCE_IDS.MUSICBRAINZ,
    }));
    return { tracks: [], albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function mbSearch(query, limit = 10) {
  const [tr, al, ar] = await Promise.all([
    mbSearchTracks(query, limit),
    mbSearchAlbums(query, Math.ceil(limit / 2)),
    mbSearchArtists(query, Math.ceil(limit / 2)),
  ]);
  return {
    tracks:  tr.tracks,
    albums:  al.albums,
    artists: ar.artists,
  };
}

// ─── Qobuz adapter ───────────────────────────────────────────────────────────
const QOBUZ_BASE = "https://www.qobuz.com/api.json/0.2";

async function qobuzGetToken(appId, email, password) {
  const url = `${QOBUZ_BASE}/user/login?app_id=${appId}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
  const r = await fetchWithTimeout(url, {}, 8000);
  if (!r.ok) throw new Error("Qobuz login failed: " + r.status);
  const d = await r.json();
  return d.user_auth_token;
}

async function qobuzSearch(query, token, appId, limit = 20) {
  if (!token || !appId) return { tracks: [], albums: [], artists: [] };
  try {
    const q = encodeURIComponent(query);
    const url = `${QOBUZ_BASE}/catalog/search?query=${q}&app_id=${appId}&user_auth_token=${token}&limit=${limit}&offset=0`;
    const r = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return { tracks: [], albums: [], artists: [] };
    const d = await r.json();

    const tracks = (d.tracks?.items || []).map(t => ({
      id:       `qobuz-${t.id}`,
      sourceId: String(t.id),
      isrc:     t.isrc || null,
      title:    t.title,
      artist:   t.performer?.name || t.album?.artist?.name || "",
      album:    t.album?.title || "",
      duration: t.duration || null,
      cover:    t.album?.image?.large || t.album?.image?.small || null,
      quality:  t.maximum_sampling_rate ? `${t.maximum_sampling_rate}kHz/${t.maximum_bit_depth}bit` : "FLAC",
      explicit: t.parental_warning || false,
      year:     t.album?.released_at ? new Date(t.album.released_at * 1000).getFullYear() : null,
      source:   SOURCE_IDS.QOBUZ,
    }));

    const albums = (d.albums?.items || []).map(a => ({
      id:       `qobuz-${a.id}`,
      sourceId: String(a.id),
      title:    a.title,
      artist:   a.artist?.name || "",
      year:     a.released_at ? new Date(a.released_at * 1000).getFullYear() : null,
      cover:    a.image?.large || a.image?.small || null,
      trackCount: a.tracks_count || null,
      source:   SOURCE_IDS.QOBUZ,
    }));

    const artists = (d.artists?.items || []).map(a => ({
      id:       `qobuz-${a.id}`,
      sourceId: String(a.id),
      name:     a.name,
      cover:    a.picture || null,
      source:   SOURCE_IDS.QOBUZ,
    }));

    return { tracks, albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function qobuzGetStreamUrl(trackId, token, appId, appSecret, quality = 27) {
  // quality: 5=MP3 320, 6=FLAC, 7=FLAC 24bit ≤96kHz, 27=FLAC 24bit ≤192kHz
  try {
    const ts = Math.floor(Date.now() / 1000);
    const rStr = `trackgetFileUrlformat_id${quality}intentstreamtrack_id${trackId}${ts}${appSecret}`;
    const hashBuf = await crypto.subtle.digest("MD5", new TextEncoder().encode(rStr));
    const hashArr = Array.from(new Uint8Array(hashBuf));
    const sig = hashArr.map(b => b.toString(16).padStart(2, "0")).join("");
    const url = `${QOBUZ_BASE}/track/getFileUrl?track_id=${trackId}&format_id=${quality}&intent=stream&request_ts=${ts}&request_sig=${sig}&app_id=${appId}&user_auth_token=${token}`;
    const r = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return null;
    const d = await r.json();
    return d.url || null;
  } catch { return null; }
}

// ─── Tidal adapter ────────────────────────────────────────────────────────────
const TIDAL_BASE     = "https://openapi.tidal.com/v2";
const TIDAL_AUTH_URL = "https://auth.tidal.com/v1/oauth2/token";
const TIDAL_COUNTRY  = "US";

async function tidalClientCredentials(clientId, clientSecret) {
  const creds = btoa(`${clientId}:${clientSecret}`);
  const r = await fetchWithTimeout(TIDAL_AUTH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  }, 8000);
  if (!r.ok) throw new Error("Tidal auth failed");
  const d = await r.json();
  return d.access_token;
}

async function tidalRefreshToken(clientId, clientSecret, refreshToken) {
  const creds = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const r = await fetchWithTimeout(TIDAL_AUTH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  }, 8000);
  if (!r.ok) throw new Error("Tidal refresh failed");
  const d = await r.json();
  return d.access_token;
}

async function tidalSearch(query, accessToken, limit = 20) {
  if (!accessToken) return { tracks: [], albums: [], artists: [] };
  try {
    const q = encodeURIComponent(query);
    const url = `${TIDAL_BASE}/searchresults/${q}?countryCode=${TIDAL_COUNTRY}&include=tracks,albums,artists&limit=${limit}`;
    const r = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return { tracks: [], albums: [], artists: [] };
    const d = await r.json();

    const tracks = (d.tracks?.items || d.included?.filter(i => i.type === "tracks") || []).map(t => {
      const attrs = t.attributes || t;
      return {
        id:       `tidal-${t.id || attrs.id}`,
        sourceId: String(t.id || attrs.id),
        isrc:     attrs.isrc || null,
        title:    attrs.title || attrs.name || "",
        artist:   attrs.artists?.[0]?.name || attrs.artistName || "",
        album:    attrs.album?.title || attrs.albumTitle || "",
        duration: attrs.duration || null,
        cover:    attrs.imageLinks?.find(l => l.meta?.height >= 320)?.href || attrs.coverArt || null,
        quality:  attrs.mediaMetadata?.tags?.includes("HIRES_LOSSLESS") ? "HiRes FLAC" :
                  attrs.mediaMetadata?.tags?.includes("LOSSLESS") ? "FLAC" :
                  attrs.mediaMetadata?.tags?.includes("DOLBY_ATMOS") ? "Dolby Atmos" : "AAC 320",
        explicit: attrs.explicit || false,
        source:   SOURCE_IDS.TIDAL,
      };
    });

    const albums = (d.albums?.items || d.included?.filter(i => i.type === "albums") || []).map(a => {
      const attrs = a.attributes || a;
      return {
        id:       `tidal-${a.id || attrs.id}`,
        sourceId: String(a.id || attrs.id),
        title:    attrs.title || attrs.name || "",
        artist:   attrs.artists?.[0]?.name || "",
        year:     attrs.releaseDate ? attrs.releaseDate.substring(0, 4) : null,
        cover:    attrs.imageLinks?.[0]?.href || null,
        trackCount: attrs.numberOfTracks || null,
        source:   SOURCE_IDS.TIDAL,
      };
    });

    const artists = (d.artists?.items || d.included?.filter(i => i.type === "artists") || []).map(a => {
      const attrs = a.attributes || a;
      return {
        id:     `tidal-${a.id || attrs.id}`,
        sourceId: String(a.id || attrs.id),
        name:   attrs.name || "",
        cover:  attrs.imageLinks?.[0]?.href || null,
        source: SOURCE_IDS.TIDAL,
      };
    });

    return { tracks, albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function tidalGetStreamUrl(trackId, accessToken, quality = "LOSSLESS") {
  // quality: LOW, HIGH, LOSSLESS, HI_RES_LOSSLESS
  try {
    const url = `${TIDAL_BASE}/tracks/${trackId}/playbackinfo?audioquality=${quality}&playbackmode=STREAM&assetpresentation=FULL&countryCode=${TIDAL_COUNTRY}`;
    const r = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return null;
    const d = await r.json();
    // Tidal returns either a direct URL or a manifest (BTS/DASH)
    if (d.manifest) {
      const manifest = atob(d.manifest);
      const urlMatch = manifest.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/);
      if (urlMatch) return urlMatch[1];
    }
    return d.url || d.urls?.[0] || null;
  } catch { return null; }
}

// ─── Deezer adapter ──────────────────────────────────────────────────────────
const DEEZER_BASE = "https://api.deezer.com";
// For streaming, Deezer requires the private API + ARL cookie (blowfish decrypt)
// Public search API does not need credentials
const DEEZER_PRIVATE = "https://www.deezer.com/ajax/gw-light.php";

async function deezerSearch(query, arl, limit = 20) {
  try {
    const q = encodeURIComponent(query);
    const url = `${DEEZER_BASE}/search?q=${q}&limit=${limit}`;
    const r = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return { tracks: [], albums: [], artists: [] };
    const d = await r.json();

    const tracks = (d.data || []).map(t => ({
      id:       `deezer-${t.id}`,
      sourceId: String(t.id),
      isrc:     null, // enriched separately
      title:    t.title,
      artist:   t.artist?.name || "",
      album:    t.album?.title || "",
      duration: t.duration || null,
      cover:    t.album?.cover_xl || t.album?.cover_medium || null,
      explicit: t.explicit_lyrics || false,
      source:   SOURCE_IDS.DEEZER,
    }));

    // Albums search
    const urlA = `${DEEZER_BASE}/search/album?q=${q}&limit=${Math.ceil(limit/2)}`;
    const rA = await fetchWithTimeout(urlA, {}, DEFAULT_TIMEOUT_MS);
    const dA = rA.ok ? await rA.json() : { data: [] };
    const albums = (dA.data || []).map(a => ({
      id:       `deezer-${a.id}`,
      sourceId: String(a.id),
      title:    a.title,
      artist:   a.artist?.name || "",
      cover:    a.cover_xl || a.cover_medium || null,
      year:     null,
      source:   SOURCE_IDS.DEEZER,
    }));

    // Artists search
    const urlAr = `${DEEZER_BASE}/search/artist?q=${q}&limit=${Math.ceil(limit/2)}`;
    const rAr = await fetchWithTimeout(urlAr, {}, DEFAULT_TIMEOUT_MS);
    const dAr = rAr.ok ? await rAr.json() : { data: [] };
    const artists = (dAr.data || []).map(a => ({
      id:     `deezer-${a.id}`,
      sourceId: String(a.id),
      name:   a.name,
      cover:  a.picture_xl || a.picture_medium || null,
      source: SOURCE_IDS.DEEZER,
    }));

    return { tracks, albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function deezerGetISRC(trackId) {
  try {
    const r = await fetchWithTimeout(`${DEEZER_BASE}/track/${trackId}`, {}, 5000);
    if (!r.ok) return null;
    const d = await r.json();
    return d.isrc || null;
  } catch { return null; }
}

async function deezerGetStreamUrl(trackId, arl) {
  if (!arl) return null;
  try {
    // Step 1: get user token via private API
    const cookieHeader = `arl=${arl}`;
    const step1 = await fetchWithTimeout(`${DEEZER_PRIVATE}?method=deezer.getUserData&api_version=1.0&api_token=null&input=3`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
      body: "{}",
    }, 8000);
    if (!step1.ok) return null;
    const userData = await step1.json();
    const apiToken = userData.results?.checkForm || null;
    if (!apiToken) return null;

    // Step 2: get track token
    const step2 = await fetchWithTimeout(`${DEEZER_PRIVATE}?method=song.getListData&api_version=1.0&api_token=${apiToken}&input=3`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ song_ids: [parseInt(trackId)] }),
    }, 8000);
    if (!step2.ok) return null;
    const trackData = await step2.json();
    const trackInfo = trackData.results?.data?.[0];
    if (!trackInfo) return null;

    const trackToken = trackInfo.TRACK_TOKEN;
    const md5Origin  = trackInfo.MD5_ORIGIN;
    const mediaVersion = trackInfo.MEDIA_VERSION;
    if (!md5Origin) return null;

    // Step 3: build CDN URL (format 1=MP3 128, 3=MP3 320, 9=FLAC)
    // Using Deezer's public CDN path construction
    const format = 9; // FLAC, fall back handled by stream resolver
    const step = `${md5Origin}\x04${format}\x04${trackId}\x04${mediaVersion}`;
    const stepMd5 = await md5Hex(step);
    const path = `${stepMd5}\x04${step}\x04`;
    const paddedPath = path + "\x00".repeat(16 - (path.length % 16));
    // AES/ECB encryption not available in Workers via subtle crypto easily —
    // return the track token to the client or proxy through
    // For now return a special marker that the stream resolver handles
    return `deezer-cdn://${trackId}?token=${encodeURIComponent(trackToken)}&md5=${md5Origin}&mv=${mediaVersion}`;
  } catch { return null; }
}

async function md5Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("MD5", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}


// ─── SoundCloud adapter ──────────────────────────────────────────────────────
const SC_BASE = "https://api-v2.soundcloud.com";

async function scSearch(query, clientId, limit = 20) {
  if (!clientId) return { tracks: [], albums: [], artists: [] };
  try {
    const q = encodeURIComponent(query);
    const url = `${SC_BASE}/search?q=${q}&client_id=${clientId}&limit=${limit}`;
    const r = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return { tracks: [], albums: [], artists: [] };
    const d = await r.json();

    const tracks  = [];
    const albums  = [];
    const artists = [];

    for (const item of (d.collection || [])) {
      if (item.kind === "track") {
        tracks.push({
          id:       `sc-${item.id}`,
          sourceId: String(item.id),
          isrc:     null,
          title:    item.title,
          artist:   item.user?.username || "",
          album:    "",
          duration: item.duration ? Math.round(item.duration / 1000) : null,
          cover:    item.artwork_url?.replace("-large", "-t500x500") || null,
          explicit: false,
          streamUrl: item.stream_url || null,
          source:   SOURCE_IDS.SOUNDCLOUD,
        });
      } else if (item.kind === "playlist" || item.kind === "album") {
        albums.push({
          id:       `sc-${item.id}`,
          sourceId: String(item.id),
          title:    item.title,
          artist:   item.user?.username || "",
          cover:    item.artwork_url?.replace("-large", "-t500x500") || null,
          trackCount: item.track_count || null,
          source:   SOURCE_IDS.SOUNDCLOUD,
        });
      } else if (item.kind === "user") {
        artists.push({
          id:     `sc-${item.id}`,
          sourceId: String(item.id),
          name:   item.username || item.full_name || "",
          cover:  item.avatar_url?.replace("-large", "-t500x500") || null,
          source: SOURCE_IDS.SOUNDCLOUD,
        });
      }
    }
    return { tracks, albums, artists };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function scGetStreamUrl(trackId, clientId) {
  if (!clientId) return null;
  try {
    const url = `${SC_BASE}/tracks/${trackId}?client_id=${clientId}`;
    const r = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return null;
    const d = await r.json();
    // Find the HLS or progressive stream
    const progressive = d.media?.transcodings?.find(t =>
      t.format?.protocol === "progressive" && t.format?.mime_type === "audio/mpeg"
    );
    const hls = d.media?.transcodings?.find(t =>
      t.format?.protocol === "hls"
    );
    const chosen = progressive || hls;
    if (!chosen) return null;
    const streamR = await fetchWithTimeout(`${chosen.url}?client_id=${clientId}`, {}, DEFAULT_TIMEOUT_MS);
    if (!streamR.ok) return null;
    const sd = await streamR.json();
    return sd.url || null;
  } catch { return null; }
}

// ─── Internet Archive adapter ────────────────────────────────────────────────
const IA_BASE = "https://archive.org";

async function iaSearch(query, limit = 20) {
  try {
    const q = encodeURIComponent(`(${query}) AND mediatype:(audio)`);
    const url = `${IA_BASE}/advancedsearch.php?q=${q}&fl[]=identifier,title,creator,year,description,mediatype&rows=${limit}&output=json`;
    const r = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return { tracks: [], albums: [], artists: [] };
    const d = await r.json();

    const tracks  = [];
    const albums  = [];

    for (const doc of (d.response?.docs || [])) {
      if (doc.mediatype === "audio") {
        const isAlbum = doc.description?.toLowerCase().includes("album") ||
                        doc.creator !== doc.title;
        if (isAlbum) {
          albums.push({
            id:     `ia-${doc.identifier}`,
            sourceId: doc.identifier,
            title:  Array.isArray(doc.title) ? doc.title[0] : (doc.title || ""),
            artist: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || ""),
            year:   doc.year || null,
            cover:  `${IA_BASE}/services/img/${doc.identifier}`,
            source: SOURCE_IDS.INTERNET_ARCHIVE,
          });
        } else {
          tracks.push({
            id:     `ia-${doc.identifier}`,
            sourceId: doc.identifier,
            isrc:   null,
            title:  Array.isArray(doc.title) ? doc.title[0] : (doc.title || ""),
            artist: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || ""),
            album:  "",
            duration: null,
            cover:  `${IA_BASE}/services/img/${doc.identifier}`,
            source: SOURCE_IDS.INTERNET_ARCHIVE,
          });
        }
      }
    }
    return { tracks, albums, artists: [] };
  } catch { return { tracks: [], albums: [], artists: [] }; }
}

async function iaGetStreamUrl(identifier) {
  try {
    const url = `${IA_BASE}/metadata/${identifier}`;
    const r = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return null;
    const d = await r.json();
    const files = d.files || [];
    const audio = files.find(f => f.name?.match(/\.(flac|mp3|ogg|m4a|wav|aiff)$/i));
    if (!audio) return null;
    return `${IA_BASE}/download/${identifier}/${audio.name}`;
  } catch { return null; }
}

// ─── Podcast Index adapter ───────────────────────────────────────────────────
const PI_BASE = "https://api.podcastindex.org/api/1.0";

async function piHeaders(apiKey, apiSecret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const hashBuf = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(apiKey + apiSecret + ts)
  );
  const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return {
    "X-Auth-Key":  apiKey,
    "X-Auth-Date": ts,
    "Authorization": hash,
    "User-Agent":  "EclipseAllInOne/2.0",
  };
}

async function piSearch(query, apiKey, apiSecret, limit = 20) {
  if (!apiKey || !apiSecret) return [];
  try {
    const q = encodeURIComponent(query);
    const url = `${PI_BASE}/search/byterm?q=${q}&max=${limit}`;
    const r = await fetchWithTimeout(url, { headers: await piHeaders(apiKey, apiSecret) }, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.feeds || []).map(f => ({
      id:          `podcast-${f.id}`,
      sourceId:    String(f.id),
      title:       f.title,
      author:      f.author,
      cover:       f.artwork || f.image,
      description: f.description,
      feedUrl:     f.url,
      categories:  Object.values(f.categories || {}),
      type:        "podcast",
    }));
  } catch { return []; }
}

async function piGetEpisodes(feedId, apiKey, apiSecret, limit = 20) {
  if (!apiKey || !apiSecret) return [];
  try {
    const url = `${PI_BASE}/episodes/byfeedid?id=${feedId}&max=${limit}`;
    const r = await fetchWithTimeout(url, { headers: await piHeaders(apiKey, apiSecret) }, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.items || []).map(e => ({
      id:          `episode-${e.id}`,
      sourceId:    String(e.id),
      title:       e.title,
      description: e.description,
      duration:    e.duration,
      published:   e.datePublished,
      streamUrl:   e.enclosureUrl,
      cover:       e.image || e.feedImage,
      feedId:      String(feedId),
      type:        "episode",
    }));
  } catch { return []; }
}

// ─── Internet Archive audiobook search ──────────────────────────────────────
async function iaAudiobookSearch(query, limit = 20) {
  try {
    const q = encodeURIComponent(`(${query}) AND mediatype:(audio) AND subject:(audiobook OR spoken word OR librivox)`);
    const url = `${IA_BASE}/advancedsearch.php?q=${q}&fl[]=identifier,title,creator,year&rows=${limit}&output=json`;
    const r = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.response?.docs || []).map(doc => ({
      id:       `audiobook-${doc.identifier}`,
      sourceId: doc.identifier,
      title:    Array.isArray(doc.title) ? doc.title[0] : (doc.title || ""),
      author:   Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || ""),
      year:     doc.year || null,
      cover:    `${IA_BASE}/services/img/${doc.identifier}`,
      type:     "audiobook",
    }));
  } catch { return []; }
}

// ─── Radio Browser adapter ───────────────────────────────────────────────────
const RADIO_BASE = "https://de1.api.radio-browser.info/json";

async function radioSearch(query, limit = 20) {
  try {
    const q = encodeURIComponent(query);
    const url = `${RADIO_BASE}/stations/search?name=${q}&limit=${limit}&hidebroken=true&order=clickcount&reverse=true`;
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": "EclipseAllInOne/2.0" } }, DEFAULT_TIMEOUT_MS);
    if (!r.ok) return [];
    const d = await r.json();
    return d.map(s => ({
      id:       `radio-${s.stationuuid}`,
      sourceId: s.stationuuid,
      name:     s.name,
      country:  s.country,
      language: s.language,
      genre:    s.tags,
      bitrate:  s.bitrate,
      codec:    s.codec,
      streamUrl: s.url_resolved || s.url,
      cover:    s.favicon || null,
      type:     "radio",
    }));
  } catch { return []; }
}


// ─── Credential & token cache (in-memory, per isolate) ───────────────────────
let _qobuzToken     = null;
let _tidalToken     = null;
let _tokenExpiry    = {};

async function getQobuzToken(env) {
  if (_qobuzToken && _tokenExpiry.qobuz > Date.now()) return _qobuzToken;
  _qobuzToken = await qobuzGetToken(env.QOBUZ_APP_ID, env.QOBUZ_EMAIL, env.QOBUZ_PASSWORD);
  _tokenExpiry.qobuz = Date.now() + 55 * 60 * 1000; // 55 min
  return _qobuzToken;
}

async function getTidalToken(env) {
  if (_tidalToken && _tokenExpiry.tidal > Date.now()) return _tidalToken;
  if (env.TIDAL_REFRESH_TOKEN) {
    try {
      _tidalToken = await tidalRefreshToken(env.TIDAL_CLIENT_ID, env.TIDAL_CLIENT_SECRET, env.TIDAL_REFRESH_TOKEN);
      _tokenExpiry.tidal = Date.now() + 55 * 60 * 1000;
      return _tidalToken;
    } catch {}
  }
  if (env.TIDAL_ACCESS_TOKEN) {
    _tidalToken = env.TIDAL_ACCESS_TOKEN;
    _tokenExpiry.tidal = Date.now() + 30 * 60 * 1000;
    return _tidalToken;
  }
  if (env.TIDAL_CLIENT_ID && env.TIDAL_CLIENT_SECRET) {
    _tidalToken = await tidalClientCredentials(env.TIDAL_CLIENT_ID, env.TIDAL_CLIENT_SECRET);
    _tokenExpiry.tidal = Date.now() + 55 * 60 * 1000;
    return _tidalToken;
  }
  return null;
}

// ─── ISRC enrichment pass ─────────────────────────────────────────────────────
/**
 * For tracks missing an ISRC, try to resolve one via MusicBrainz.
 * Only runs on the first N tracks that need it to avoid blowing the timeout.
 */
async function enrichISRC(tracks, maxEnrich = 10) {
  let count = 0;
  const promises = tracks.map(async t => {
    if (t.isrc || count >= maxEnrich) return t;
    count++;
    const mb = await mbLookupISRC(null).catch(() => null);
    // reversed: lookup by title+artist on MB
    try {
      const q = encodeURIComponent(`recording:"${t.title}" AND artist:"${t.artist}"`);
      const url = `${MB_BASE}/recording?query=${q}&fmt=json&limit=1`;
      const r = await fetchWithTimeout(url, { headers: MB_HEADERS }, 3000);
      if (!r.ok) return t;
      const d = await r.json();
      const rec = d.recordings?.[0];
      if (rec?.isrcs?.length) {
        return { ...t, isrc: rec.isrcs[0], mbid: rec.id };
      }
    } catch {}
    return t;
  });
  return Promise.all(promises);
}

// ─── Unified search orchestrator ─────────────────────────────────────────────
async function unifiedSearch(query, searchSources, env, limit = 20) {
  if (!searchSources?.length) searchSources = DEFAULT_SEARCH_ORDER;

  // Fire all source searches CONCURRENTLY for speed
  const sourcePromises = searchSources.map(async sourceId => {
    let results = { tracks: [], albums: [], artists: [] };
    try {
      switch (sourceId) {
        case SOURCE_IDS.TIDAL: {
          const tok = await getTidalToken(env).catch(() => null);
          results = await tidalSearch(query, tok, limit);
          break;
        }
        case SOURCE_IDS.QOBUZ: {
          const tok = await getQobuzToken(env).catch(() => null);
          results = await qobuzSearch(query, tok, env.QOBUZ_APP_ID, limit);
          break;
        }
        case SOURCE_IDS.DEEZER:
          results = await deezerSearch(query, env.DEEZER_ARL, limit);
          break;
        case SOURCE_IDS.SOUNDCLOUD:
          results = await scSearch(query, env.SOUNDCLOUD_CLIENT_ID, limit);
          break;
        case SOURCE_IDS.MUSICBRAINZ:
          results = await mbSearch(query, limit);
          break;
        case SOURCE_IDS.INTERNET_ARCHIVE:
          results = await iaSearch(query, limit);
          break;
        default:
          break;
      }
    } catch {}
    return { source: sourceId, results };
  });

  // Wait for all concurrently — results still get merged in priority order
  const allResults = await Promise.all(sourcePromises);

  // Re-order by user priority — source 1 fills all, source 2 fills gaps only, etc.
  const ordered = searchSources.map(sid => allResults.find(r => r.source === sid)).filter(Boolean);

  // Priority-first merge with ISRC + title|artist dedup
  const merged = mergeResults(ordered);

  // ISRC enrichment on merged track list (best-effort, background)
  merged.tracks = await enrichISRC(merged.tracks, 8);

  return merged;
}

// ─── Stream resolver ─────────────────────────────────────────────────────────
async function resolveStream(sourceId, trackId, env, quality) {
  switch (sourceId) {
    case SOURCE_IDS.QOBUZ: {
      const tok = await getQobuzToken(env);
      const qFormat = quality === "hires" ? 27 : quality === "lossless" ? 6 : 5;
      return await qobuzGetStreamUrl(trackId, tok, env.QOBUZ_APP_ID, env.QOBUZ_APP_SECRET, qFormat);
    }
    case SOURCE_IDS.TIDAL: {
      const tok = await getTidalToken(env);
      const tidalQ = quality === "hires" ? "HI_RES_LOSSLESS" : quality === "lossless" ? "LOSSLESS" : "HIGH";
      return await tidalGetStreamUrl(trackId, tok, tidalQ);
    }
    case SOURCE_IDS.DEEZER:
      return await deezerGetStreamUrl(trackId, env.DEEZER_ARL);
    case SOURCE_IDS.SOUNDCLOUD:
      return await scGetStreamUrl(trackId, env.SOUNDCLOUD_CLIENT_ID);
    case SOURCE_IDS.INTERNET_ARCHIVE:
      return await iaGetStreamUrl(trackId);
    default:
      return null;
  }
}

/**
 * Try stream sources in priority order, return first working URL
 */
async function resolveStreamWithFallback(sourceId, trackId, streamSources, env, quality) {
  // Always try the requested source first
  const ordered = [sourceId, ...streamSources.filter(s => s !== sourceId)];
  for (const src of ordered) {
    try {
      const url = await resolveStream(src, trackId, env, quality);
      if (url) return { url, source: src };
    } catch {}
  }
  return null;
}

// ─── Config parser (from URL params) ─────────────────────────────────────────
function parseConfig(url) {
  const p = url.searchParams;
  const searchSources = p.get("searchSources")?.split(",").filter(Boolean) || DEFAULT_SEARCH_ORDER;
  const streamSources = p.get("streamSources")?.split(",").filter(Boolean) || DEFAULT_STREAM_ORDER;
  const quality = p.get("quality") || "lossless";
  const limit = Math.min(parseInt(p.get("limit") || "20", 10), 50);
  const podcastApiKey    = p.get("podcastApiKey") || "";
  const podcastApiSecret = p.get("podcastApiSecret") || "";
  const enablePodcasts   = p.get("podcasts") !== "false";
  const enableAudiobooks = p.get("audiobooks") !== "false";
  const enableRadio      = p.get("radio") !== "false";
  const timeout          = Math.min(parseInt(p.get("timeout") || "8000", 10), 20000);
  return { searchSources, streamSources, quality, limit,
           podcastApiKey, podcastApiSecret,
           enablePodcasts, enableAudiobooks, enableRadio, timeout };
}

// ─── Manifest builder ─────────────────────────────────────────────────────────
function buildManifest(baseUrl, config) {
  const q = new URLSearchParams({
    searchSources:    config.searchSources.join(","),
    streamSources:    config.streamSources.join(","),
    quality:          config.quality,
    limit:            String(config.limit),
    podcasts:         String(config.enablePodcasts),
    audiobooks:       String(config.enableAudiobooks),
    radio:            String(config.enableRadio),
    timeout:          String(config.timeout),
  });
  if (config.podcastApiKey)    q.set("podcastApiKey",    config.podcastApiKey);
  if (config.podcastApiSecret) q.set("podcastApiSecret", config.podcastApiSecret);

  const manifestBase = `${baseUrl}/manifest.json?${q.toString()}`;

  return {
    id:          "eclipse-all-in-one",
    version:     VERSION,
    name:        "Eclipse All-in-One",
    description: "Qobuz · Tidal · Deezer · SoundCloud · MusicBrainz · Internet Archive · Podcasts · Audiobooks · Radio",
    logo:        `${baseUrl}/logo.png`,
    background:  `${baseUrl}/bg.jpg`,
    contactEmail:"",
    behaviorHints: { configurable: true, configurationRequired: false },
    resources: ["catalog", "meta", "stream", "search"],
    types:     ["music", "album", "artist", "podcast", "audiobook", "radio"],
    catalogs: [
      {
        id: "eclipse-music-search",
        type: "music",
        name: "All Sources",
        extra: [{ name: "search", isRequired: true }],
      },
      ...(config.enablePodcasts ? [{
        id: "eclipse-podcasts",
        type: "podcast",
        name: "Podcasts",
        extra: [{ name: "search" }, { name: "genre" }],
      }] : []),
      ...(config.enableAudiobooks ? [{
        id: "eclipse-audiobooks",
        type: "audiobook",
        name: "Audiobooks",
        extra: [{ name: "search" }],
      }] : []),
      ...(config.enableRadio ? [{
        id: "eclipse-radio",
        type: "radio",
        name: "Radio",
        extra: [{ name: "search" }],
      }] : []),
    ],
    manifestUrl: manifestBase,
  };
}

// ─── Eclipse catalog response builder ────────────────────────────────────────
function buildCatalogResponse(merged, query) {
  const metas = [];

  // Artists first
  for (const a of merged.artists) {
    metas.push({
      id:          a.id,
      type:        "artist",
      name:        a.name,
      poster:      a.cover || null,
      background:  a.cover || null,
      description: `From ${a.source}`,
      _source:     a._source || a.source,
    });
  }
  // Albums
  for (const a of merged.albums) {
    metas.push({
      id:          a.id,
      type:        "album",
      name:        a.title,
      poster:      a.cover || null,
      description: `${a.artist}${a.year ? ` · ${a.year}` : ""}`,
      _source:     a._source || a.source,
    });
  }
  // Tracks
  for (const t of merged.tracks) {
    metas.push({
      id:          t.id,
      type:        "music",
      name:        t.title,
      poster:      t.cover || null,
      description: `${t.artist}${t.album ? ` · ${t.album}` : ""}${t.quality ? ` · ${t.quality}` : ""}`,
      runtime:     t.duration,
      released:    t.year ? String(t.year) : undefined,
      _source:     t._source || t.source,
      _isrc:       t.isrc || undefined,
    });
  }

  return { metas };
}


// ─── Config UI (HTML) ─────────────────────────────────────────────────────────
function configHTML(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Eclipse All-in-One · Addon Generator</title>
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&display=swap" rel="stylesheet"/>
<style>
  :root {
    --bg:           #0e0e10;
    --surface:      #18181b;
    --surface-2:    #1f1f23;
    --surface-3:    #27272c;
    --border:       rgba(255,255,255,0.08);
    --text:         #e4e4e7;
    --text-muted:   #71717a;
    --text-faint:   #3f3f46;
    --accent:       #7c3aed;
    --accent-hover: #6d28d9;
    --accent-glow:  rgba(124,58,237,0.18);
    --tidal:        #00ffff;
    --qobuz:        #007cba;
    --deezer:       #ef5466;
    --soundcloud:   #ff5500;
    --musicbrainz:  #ba478f;
    --ia:           #428bca;
    --success:      #22c55e;
    --radius:       12px;
    --transition:   180ms cubic-bezier(0.16,1,0.3,1);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: 'Satoshi', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100dvh;
    line-height: 1.6;
  }

  /* ── Layout ── */
  .container {
    max-width: 860px;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 2.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  .logo-mark {
    width: 44px; height: 44px; flex-shrink: 0;
    background: linear-gradient(135deg, var(--accent), #a855f7);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
  }
  .logo-mark svg { width: 24px; height: 24px; color: #fff; }
  .header-text h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.02em; }
  .header-text p  { font-size: 0.82rem; color: var(--text-muted); margin-top: 2px; }
  .version-badge {
    margin-left: auto;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 3px 9px;
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  /* ── Cards ── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
    margin-bottom: 1rem;
  }
  .card-title {
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 1.1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .card-title-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  /* ── Source order drag list ── */
  .source-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .source-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.9rem;
    cursor: grab;
    transition: background var(--transition), border-color var(--transition), box-shadow var(--transition);
    user-select: none;
  }
  .source-item:hover { background: var(--surface-3); border-color: rgba(255,255,255,0.12); }
  .source-item.dragging { opacity: 0.45; cursor: grabbing; }
  .source-item.drag-over { box-shadow: 0 0 0 2px var(--accent); border-color: var(--accent); }
  .source-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .source-name { font-size: 0.9rem; font-weight: 500; flex: 1; }
  .source-badge {
    font-size: 0.68rem; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; padding: 2px 7px; border-radius: 999px;
    background: var(--surface-3); color: var(--text-muted);
  }
  .source-toggle {
    width: 36px; height: 20px; position: relative; flex-shrink: 0;
  }
  .source-toggle input { opacity: 0; width: 0; height: 0; }
  .source-toggle-track {
    position: absolute; inset: 0;
    background: var(--surface-3); border-radius: 999px; cursor: pointer;
    transition: background var(--transition);
  }
  .source-toggle input:checked + .source-toggle-track { background: var(--accent); }
  .source-toggle-thumb {
    position: absolute;
    top: 3px; left: 3px;
    width: 14px; height: 14px;
    background: #fff; border-radius: 50%;
    transition: transform var(--transition);
    pointer-events: none;
  }
  .source-toggle input:checked ~ .source-toggle-thumb { transform: translateX(16px); }
  .drag-handle { color: var(--text-faint); flex-shrink: 0; cursor: grab; }
  .drag-handle svg { display: block; }

  /* ── Dropdowns / selects ── */
  .field { margin-bottom: 1rem; }
  .field:last-child { margin-bottom: 0; }
  .field label {
    display: block;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 0.4rem;
    letter-spacing: 0.03em;
  }
  .field input, .field select {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.85rem;
    font-family: inherit;
    font-size: 0.88rem;
    color: var(--text);
    outline: none;
    transition: border-color var(--transition), box-shadow var(--transition);
    appearance: none;
    -webkit-appearance: none;
  }
  .field input:focus, .field select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  .field input::placeholder { color: var(--text-faint); }
  .select-wrap { position: relative; }
  .select-wrap::after {
    content: "";
    position: absolute;
    right: 12px; top: 50%;
    transform: translateY(-50%);
    width: 0; height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid var(--text-muted);
    pointer-events: none;
  }

  /* ── Fieldset grid ── */
  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; }
  @media (max-width: 540px) { .field-grid { grid-template-columns: 1fr; } }

  /* ── Checkbox group ── */
  .checkbox-group { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .checkbox-pill {
    display: flex; align-items: center; gap: 0.5rem;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 999px; padding: 0.35rem 0.85rem;
    font-size: 0.82rem; font-weight: 500; cursor: pointer;
    transition: background var(--transition), border-color var(--transition);
  }
  .checkbox-pill input { display: none; }
  .checkbox-pill:has(input:checked) {
    background: var(--accent-glow); border-color: var(--accent); color: #c4b5fd;
  }
  .checkbox-pill .pill-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }

  /* ── Divider ── */
  .divider { height: 1px; background: var(--border); margin: 1.5rem 0; }

  /* ── Generate button ── */
  .btn-generate {
    width: 100%;
    background: linear-gradient(135deg, var(--accent), #a855f7);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    padding: 0.85rem 1.5rem;
    font-family: inherit;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    letter-spacing: -0.01em;
    transition: opacity var(--transition), box-shadow var(--transition);
    margin-top: 1.25rem;
    display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  }
  .btn-generate:hover { opacity: 0.9; box-shadow: 0 4px 24px rgba(124,58,237,0.35); }
  .btn-generate:active { opacity: 0.8; }

  /* ── Result box ── */
  .result-box {
    margin-top: 1.25rem;
    display: none;
    flex-direction: column;
    gap: 0.5rem;
  }
  .result-box.visible { display: flex; }
  .result-url-wrap {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    display: flex; align-items: center; gap: 0.75rem;
  }
  .result-url {
    flex: 1;
    font-size: 0.78rem;
    color: var(--text-muted);
    font-family: 'SF Mono', 'Fira Code', monospace;
    word-break: break-all;
    overflow: hidden;
  }
  .btn-copy {
    flex-shrink: 0;
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.4rem 0.75rem;
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }
  .btn-copy:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn-copy.copied { background: var(--success); color: #fff; border-color: var(--success); }
  .result-note { font-size: 0.75rem; color: var(--text-muted); text-align: center; }

  /* ── Collapsible sections ── */
  details summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 0;
  }
  details[open] summary { margin-bottom: 1.1rem; }
  details summary::after {
    content: "▸";
    margin-left: auto;
    font-size: 0.7rem;
    transition: transform var(--transition);
  }
  details[open] summary::after { transform: rotate(90deg); }

  /* ── Source color dots ── */
  .dot-tidal        { background: var(--tidal); }
  .dot-qobuz        { background: var(--qobuz); }
  .dot-deezer       { background: var(--deezer); }
  .dot-soundcloud   { background: var(--soundcloud); }
  .dot-musicbrainz  { background: var(--musicbrainz); }
  .dot-ia           { background: var(--ia); }
</style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <header class="header">
    <div class="logo-mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <circle cx="12" cy="12" r="3"/>
        <line x1="12" y1="2" x2="12" y2="5"/>
        <line x1="12" y1="19" x2="12" y2="22"/>
        <line x1="2" y1="12" x2="5" y2="12"/>
        <line x1="19" y1="12" x2="22" y2="12"/>
      </svg>
    </div>
    <div class="header-text">
      <h1>Eclipse All-in-One</h1>
      <p>Qobuz · Tidal · Deezer · SoundCloud · MusicBrainz · Internet Archive</p>
    </div>
    <span class="version-badge">v${VERSION}</span>
  </header>

  <!-- Search Sources -->
  <div class="card">
    <div class="card-title"><span class="card-title-dot"></span>Search Source Priority</div>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:1rem;">Drag to reorder. Results from source #1 appear first. Lower sources only fill in what's missing.</p>
    <div class="source-list" id="searchSourceList">
      <div class="source-item" draggable="true" data-source="tidal">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-tidal"></span>
        <span class="source-name">Tidal</span>
        <span class="source-badge">HiFi</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="qobuz">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-qobuz"></span>
        <span class="source-name">Qobuz</span>
        <span class="source-badge">Hi-Res</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="deezer">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-deezer"></span>
        <span class="source-name">Deezer</span>
        <span class="source-badge">HQ</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="soundcloud">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-soundcloud"></span>
        <span class="source-name">SoundCloud</span>
        <span class="source-badge">MP3</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="musicbrainz">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-musicbrainz"></span>
        <span class="source-name">MusicBrainz</span>
        <span class="source-badge">Meta</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="internetarchive">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-ia"></span>
        <span class="source-name">Internet Archive</span>
        <span class="source-badge">Free</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
    </div>
  </div>

  <!-- Stream Sources -->
  <div class="card">
    <div class="card-title"><span class="card-title-dot"></span>Stream Source Priority</div>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:1rem;">Source #1 is always tried first. If unavailable, falls back automatically down the list.</p>
    <div class="source-list" id="streamSourceList">
      <div class="source-item" draggable="true" data-source="qobuz">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-qobuz"></span>
        <span class="source-name">Qobuz</span>
        <span class="source-badge">Hi-Res</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="tidal">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-tidal"></span>
        <span class="source-name">Tidal</span>
        <span class="source-badge">HiFi</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="deezer">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-deezer"></span>
        <span class="source-name">Deezer</span>
        <span class="source-badge">HQ</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="soundcloud">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-soundcloud"></span>
        <span class="source-name">SoundCloud</span>
        <span class="source-badge">MP3</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
      <div class="source-item" draggable="true" data-source="internetarchive">
        <span class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg></span>
        <span class="source-dot dot-ia"></span>
        <span class="source-name">Internet Archive</span>
        <span class="source-badge">Free</span>
        <label class="source-toggle"><input type="checkbox" checked /><span class="source-toggle-track"></span><span class="source-toggle-thumb"></span></label>
      </div>
    </div>
  </div>

  <!-- Playback Quality -->
  <div class="card">
    <div class="card-title"><span class="card-title-dot"></span>Playback Quality</div>
    <div class="field-grid">
      <div class="field">
        <label for="qualitySelect">Audio Quality</label>
        <div class="select-wrap">
          <select id="qualitySelect">
            <option value="hires">Hi-Res FLAC (best quality)</option>
            <option value="lossless" selected>Lossless FLAC</option>
            <option value="high">High (AAC 320 / MP3 320)</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label for="limitSelect">Results Per Source</label>
        <div class="select-wrap">
          <select id="limitSelect">
            <option value="10">10</option>
            <option value="20" selected>20</option>
            <option value="30">30</option>
            <option value="50">50</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label for="timeoutSelect">Per-Source Timeout</label>
        <div class="select-wrap">
          <select id="timeoutSelect">
            <option value="4000">4 seconds (fast)</option>
            <option value="6000">6 seconds</option>
            <option value="8000" selected>8 seconds (default)</option>
            <option value="12000">12 seconds (slow connection)</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <!-- Extra Content -->
  <div class="card">
    <div class="card-title"><span class="card-title-dot"></span>Extra Content Sources</div>
    <div class="checkbox-group" style="margin-bottom:1.25rem;">
      <label class="checkbox-pill"><input type="checkbox" id="enablePodcasts" checked /><span class="pill-dot"></span>Podcasts</label>
      <label class="checkbox-pill"><input type="checkbox" id="enableAudiobooks" checked /><span class="pill-dot"></span>Audiobooks</label>
      <label class="checkbox-pill"><input type="checkbox" id="enableRadio" checked /><span class="pill-dot"></span>Radio</label>
    </div>

    <details>
      <summary><span class="card-title-dot"></span>Podcast Index API (optional)</summary>
      <div style="padding-top:0.25rem;">
        <div class="field-grid">
          <div class="field">
            <label for="piKey">API Key</label>
            <input type="text" id="piKey" placeholder="Podcast Index API key" />
          </div>
          <div class="field">
            <label for="piSecret">API Secret</label>
            <input type="password" id="piSecret" placeholder="Podcast Index API secret" />
          </div>
        </div>
        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.5rem;">
          Get free credentials at <a href="https://podcastindex.org" target="_blank" rel="noopener" style="color:#a78bfa;">podcastindex.org</a>. Without these, podcast search uses public RSS feeds only.
        </p>
      </div>
    </details>
  </div>

  <!-- Generate -->
  <button class="btn-generate" id="generateBtn" onclick="generateURL()">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="5 3 19 12 5 21 5 3"/></svg>
    Generate Manifest URL
  </button>

  <div class="result-box" id="resultBox">
    <div class="result-url-wrap">
      <span class="result-url" id="resultUrl"></span>
      <button class="btn-copy" id="copyBtn" onclick="copyURL()">Copy</button>
    </div>
    <p class="result-note">Open Eclipse → Settings → Connections → Add Connection → Addon → paste this URL</p>
  </div>

</div>

<script>
// ── Drag-to-reorder ──────────────────────────────────────────────────────────
function initDragList(listId) {
  const list = document.getElementById(listId);
  let dragged = null;

  list.querySelectorAll('.source-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      dragged = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.source-item').forEach(i => i.classList.remove('drag-over'));
      dragged = null;
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (dragged && dragged !== item) {
        list.querySelectorAll('.source-item').forEach(i => i.classList.remove('drag-over'));
        item.classList.add('drag-over');
      }
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      if (dragged && dragged !== item) {
        const items = [...list.querySelectorAll('.source-item')];
        const dragIdx = items.indexOf(dragged);
        const dropIdx = items.indexOf(item);
        if (dragIdx < dropIdx) {
          list.insertBefore(dragged, item.nextSibling);
        } else {
          list.insertBefore(dragged, item);
        }
      }
      list.querySelectorAll('.source-item').forEach(i => i.classList.remove('drag-over'));
    });
  });
}

initDragList('searchSourceList');
initDragList('streamSourceList');

// ── Generate URL ─────────────────────────────────────────────────────────────
function getOrderedSources(listId) {
  const list = document.getElementById(listId);
  const sources = [];
  list.querySelectorAll('.source-item').forEach(item => {
    const toggle = item.querySelector('input[type="checkbox"]');
    if (toggle?.checked) sources.push(item.dataset.source);
  });
  return sources;
}

function generateURL() {
  const base = window.location.origin;
  const searchSources = getOrderedSources('searchSourceList');
  const streamSources = getOrderedSources('streamSourceList');
  const quality   = document.getElementById('qualitySelect').value;
  const limit     = document.getElementById('limitSelect').value;
  const timeout   = document.getElementById('timeoutSelect').value;
  const podcasts  = document.getElementById('enablePodcasts').checked;
  const audiobooks = document.getElementById('enableAudiobooks').checked;
  const radio     = document.getElementById('enableRadio').checked;
  const piKey     = document.getElementById('piKey').value.trim();
  const piSecret  = document.getElementById('piSecret').value.trim();

  const params = new URLSearchParams({
    searchSources: searchSources.join(','),
    streamSources: streamSources.join(','),
    quality, limit, timeout,
    podcasts:   String(podcasts),
    audiobooks: String(audiobooks),
    radio:      String(radio),
  });
  if (piKey)    params.set('podcastApiKey',    piKey);
  if (piSecret) params.set('podcastApiSecret', piSecret);

  const url = base + '/manifest.json?' + params.toString();

  document.getElementById('resultUrl').textContent = url;
  const box = document.getElementById('resultBox');
  box.classList.add('visible');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function copyURL() {
  const url = document.getElementById('resultUrl').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  });
}
</script>
</body>
</html>`;
}


// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url     = new URL(request.url);
    const path    = url.pathname.replace(/\/$/, "") || "/";
    const origin  = request.headers.get("Origin") || "*";
    const allowed = env.ALLOWED_ORIGINS || "*";

    // Pre-flight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
    }

    // ── Config UI ──────────────────────────────────────────────────────────────
    if (path === "/" || path === "/configure") {
      return new Response(configHTML(url.origin), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    // ── Manifest ───────────────────────────────────────────────────────────────
    if (path === "/manifest.json") {
      const cfg = parseConfig(url);
      const manifest = buildManifest(url.origin, cfg);
      return jsonResp(manifest, 200, origin, allowed);
    }

    // ── Search / Catalog ───────────────────────────────────────────────────────
    // Eclipse calls: /catalog/{type}/{id}/search={query}.json
    const catalogMatch = path.match(/^\/catalog\/([^/]+)\/([^/]+)\/search=(.+)\.json$/);
    if (catalogMatch) {
      const [, type, catalogId, rawQuery] = catalogMatch;
      const query = decodeURIComponent(rawQuery);
      const cfg   = parseConfig(url);

      // Podcast / Audiobook / Radio special handling
      if (type === "podcast" || catalogId === "eclipse-podcasts") {
        const results = await piSearch(query, cfg.podcastApiKey, cfg.podcastApiSecret, cfg.limit);
        return jsonResp({ metas: results }, 200, origin, allowed);
      }
      if (type === "audiobook" || catalogId === "eclipse-audiobooks") {
        const results = await iaAudiobookSearch(query, cfg.limit);
        return jsonResp({ metas: results }, 200, origin, allowed);
      }
      if (type === "radio" || catalogId === "eclipse-radio") {
        const results = await radioSearch(query, cfg.limit);
        return jsonResp({ metas: results }, 200, origin, allowed);
      }

      // Music search — unified with dedup
      const merged = await unifiedSearch(query, cfg.searchSources, env, cfg.limit);
      const response = buildCatalogResponse(merged, query);
      return jsonResp(response, 200, origin, allowed);
    }

    // Also support simpler ?search= query param style
    if (path === "/catalog" || path.startsWith("/catalog")) {
      const query = url.searchParams.get("search") || url.searchParams.get("q") || "";
      if (query) {
        const cfg = parseConfig(url);
        const merged = await unifiedSearch(query, cfg.searchSources, env, cfg.limit);
        const response = buildCatalogResponse(merged, query);
        return jsonResp(response, 200, origin, allowed);
      }
    }

    // ── Meta ──────────────────────────────────────────────────────────────────
    // Eclipse calls: /meta/{type}/{id}.json
    const metaMatch = path.match(/^\/meta\/([^/]+)\/([^/]+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;

      // Podcast episodes
      if (type === "podcast") {
        const feedId = id.replace("podcast-", "");
        const cfg = parseConfig(url);
        const episodes = await piGetEpisodes(feedId, cfg.podcastApiKey, cfg.podcastApiSecret, 50);
        return jsonResp({
          meta: {
            id, type,
            videos: episodes.map(e => ({
              id:       e.id,
              title:    e.title,
              released: e.published ? new Date(e.published * 1000).toISOString() : null,
              overview: e.description,
              runtime:  e.duration,
              thumbnail: e.cover,
              streams: [{ url: e.streamUrl, title: e.title }],
            })),
          }
        }, 200, origin, allowed);
      }

      // Internet Archive audiobook chapters
      if (type === "audiobook" || id.startsWith("audiobook-") || id.startsWith("ia-")) {
        const identifier = id.replace(/^(audiobook-|ia-)/, "");
        try {
          const r = await fetchWithTimeout(`https://archive.org/metadata/${identifier}`, {}, DEFAULT_TIMEOUT_MS);
          const d = r.ok ? await r.json() : {};
          const files = (d.files || []).filter(f => f.name?.match(/\.(flac|mp3|ogg|m4a|wav)$/i));
          return jsonResp({
            meta: {
              id, type: "audiobook",
              name:   d.metadata?.title || identifier,
              description: d.metadata?.description || "",
              videos: files.map((f, i) => ({
                id:    `${id}-track${i}`,
                title: f.title || f.name,
                streams: [{ url: `https://archive.org/download/${identifier}/${f.name}`, title: f.name }],
              })),
            }
          }, 200, origin, allowed);
        } catch {
          return jsonResp({ meta: { id, type: "audiobook" } }, 200, origin, allowed);
        }
      }

      return jsonResp({ meta: { id, type } }, 200, origin, allowed);
    }

    // ── Stream ────────────────────────────────────────────────────────────────
    // Eclipse calls: /stream/{type}/{id}.json
    const streamMatch = path.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
    if (streamMatch) {
      const [, type, id] = streamMatch;
      const cfg = parseConfig(url);

      // Direct stream types
      if (type === "radio") {
        const stationId = id.replace("radio-", "");
        const url2 = `${RADIO_BASE}/stations/byuuid/${stationId}`;
        const r = await fetchWithTimeout(url2, { headers: { "User-Agent": "EclipseAllInOne/2.0" } }, DEFAULT_TIMEOUT_MS).catch(() => null);
        if (r?.ok) {
          const d = await r.json();
          const station = Array.isArray(d) ? d[0] : d;
          if (station?.url_resolved) {
            return jsonResp({
              streams: [{ url: station.url_resolved, title: station.name, behaviorHints: { notWebReady: false } }]
            }, 200, origin, allowed);
          }
        }
        return jsonResp({ streams: [] }, 200, origin, allowed);
      }

      // Determine source from id prefix
      let sourceId = null;
      let trackId  = id;

      if (id.startsWith("tidal-"))   { sourceId = SOURCE_IDS.TIDAL;           trackId = id.replace("tidal-", ""); }
      else if (id.startsWith("qobuz-")) { sourceId = SOURCE_IDS.QOBUZ;         trackId = id.replace("qobuz-", ""); }
      else if (id.startsWith("deezer-")) { sourceId = SOURCE_IDS.DEEZER;       trackId = id.replace("deezer-", ""); }
      else if (id.startsWith("sc-"))  { sourceId = SOURCE_IDS.SOUNDCLOUD;      trackId = id.replace("sc-", ""); }
      else if (id.startsWith("ia-"))  { sourceId = SOURCE_IDS.INTERNET_ARCHIVE; trackId = id.replace("ia-", ""); }

      if (!sourceId) {
        return jsonResp({ streams: [] }, 200, origin, allowed);
      }

      const resolved = await resolveStreamWithFallback(sourceId, trackId, cfg.streamSources, env, cfg.quality);
      if (!resolved) {
        return jsonResp({ streams: [] }, 200, origin, allowed);
      }

      return jsonResp({
        streams: [{
          url:   resolved.url,
          title: `${resolved.source.charAt(0).toUpperCase() + resolved.source.slice(1)} · ${cfg.quality}`,
          behaviorHints: { notWebReady: false },
        }]
      }, 200, origin, allowed);
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    return new Response(JSON.stringify({ error: "Not found", path }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin, allowed) },
    });
  },
};
