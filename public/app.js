/* Frontend loader and renderer for binary lat/lon pairs as yellow polylines split by activity */
(function(){
  const styleSelect = document.getElementById('styleSelect');
  const headerEl = document.querySelector('header');

  const CACHE_NAME = 'htmap-v3-lines';

  // Register service worker (for offline/caching support)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed', err));
  }

  // Basemaps: light and dark - using Carto and OSM tiles
  const lightTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  });
  const darkTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: ['a','b','c','d'],
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  });

  const map = L.map('map', {
    center: [0,0],
    zoom: 2,
    zoomControl: true,
    preferCanvas: true, // better performance
    layers: [lightTiles]
  });

  const widthInput = document.getElementById('widthInput');
  const opacityInput = document.getElementById('opacityInput');
  const colorInput = document.getElementById('colorInput');
  const widthVal = document.getElementById('widthVal');
  const opacityVal = document.getElementById('opacityVal');

  // State: segments is an array of arrays of [lat, lon]
  let segments = [];
  let polylines = [];

  function getLineColor() {
    const val = (colorInput && typeof colorInput.value === 'string') ? colorInput.value : '#ffd400';
    return val || '#ffd400';
  }

  function updateLineStyles() {
    const w = Math.max(1, Math.min(50, Number(widthInput.value) || 3));
    const o = Math.max(0.05, Math.min(1, Number(opacityInput.value) || 0.8));
    const c = getLineColor();
    widthVal.textContent = String(w);
    opacityVal.textContent = o.toFixed(2);
    for (const pl of polylines) {
      pl.setStyle({ weight: w, opacity: o, color: c });
    }
  }

  widthInput.addEventListener('input', updateLineStyles);
  opacityInput.addEventListener('input', updateLineStyles);
  if (colorInput) colorInput.addEventListener('input', updateLineStyles);

  function setStyle(style) {
    if (style === 'dark') {
      if (map.hasLayer(lightTiles)) map.removeLayer(lightTiles);
      if (!map.hasLayer(darkTiles)) map.addLayer(darkTiles);
      headerEl.classList.add('dark');
    } else {
      if (map.hasLayer(darkTiles)) map.removeLayer(darkTiles);
      if (!map.hasLayer(lightTiles)) map.addLayer(lightTiles);
      headerEl.classList.remove('dark');
    }
  }

  styleSelect.addEventListener('change', () => setStyle(styleSelect.value));

  const loadingEl = document.getElementById('loading');
  const loadingPctEl = document.getElementById('loadingPct');

  function showLoading() {
    loadingEl.classList.remove('hidden');
    updateLoading(0);
  }
  function hideLoading() {
    loadingEl.classList.add('hidden');
  }
  function updateLoading(pct) {
    const clamped = Math.max(0, Math.min(100, Math.floor(pct)));
    loadingPctEl.textContent = clamped + '%';
    const fill = loadingEl.querySelector('.fill');
    if (fill) fill.style.width = clamped + '%';
  }

  async function loadBinary(url) {
    showLoading();

    // Try cache first (local) for fast repeat loads
    let cache;
    let cachedRes;
    if ('caches' in window) {
      try {
        cache = await caches.open(CACHE_NAME);
        cachedRes = await cache.match(url);
      } catch (e) {
        // ignore cache errors
      }
    }

    const useBuffer = async (buf) => {
      const segs = parseSegments(buf);
      return segs;
    };

    if (cachedRes) {
      const buf = await cachedRes.arrayBuffer();
      updateLoading(100);
      hideLoading();
      refreshCache(url, cache).catch(()=>{});
      return useBuffer(buf);
    }

    // Not in cache: fetch with streaming progress, then store in cache
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Failed to fetch ' + url);
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !window.ReadableStream) {
      const buf = await res.arrayBuffer();
      if (cache) {
        try { await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch {}
      }
      updateLoading(100);
      hideLoading();
      return useBuffer(buf);
    }

    const reader = res.body.getReader();
    let received = 0;
    let lastShown = -1;
    let target;
    let offset = 0;
    const chunks = [];

    if (total > 0) target = new Uint8Array(total);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total > 0) { target.set(value, offset); offset += value.byteLength; }
      else { chunks.push(value); }
      received += value.byteLength;
      if (total > 0) {
        const p = Math.floor((received / total) * 100);
        if (p !== lastShown) { updateLoading(p); lastShown = p; }
      }
    }

    let buf;
    if (total > 0) {
      buf = target.buffer;
      updateLoading(100);
      if (cache) { try { await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch {} }
    } else {
      let size = 0; for (const c of chunks) size += c.byteLength;
      const all = new Uint8Array(size);
      let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
      buf = all.buffer;
      updateLoading(100);
      if (cache) { try { await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch {} }
    }

    hideLoading();
    return useBuffer(buf);
  }

  async function refreshCache(url, cache) {
    if (!cache) return;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
      }
    } catch {}
  }

  function parseSegments(buf) {
    // Format: consecutive little-endian int32 pairs (lat_e7, lon_e7)
    // Activity separator: pair (-2147483648, -2147483648)
    const view = new DataView(buf);
    const countPairs = (view.byteLength / 8) | 0;
    const INT32_MIN = -2147483648;

    const segs = [];
    let current = [];

    // Optional safety: split segments on very large jumps as well
    const maxGapMeters = 2000; // 2km

    function haversine(lat1, lon1, lat2, lon2) {
      const R = 6371000; // meters
      const toRad = Math.PI / 180;
      const dLat = (lat2 - lat1) * toRad;
      const dLon = (lon2 - lon1) * toRad;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toRad)*Math.cos(lat2*toRad)*Math.sin(dLon/2)**2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    }

    let prev = null;
    for (let i = 0; i < countPairs; i++) {
      const lat_e7 = view.getInt32(i*8, true);
      const lon_e7 = view.getInt32(i*8 + 4, true);
      if (lat_e7 === INT32_MIN && lon_e7 === INT32_MIN) {
        if (current.length > 1) segs.push(current);
        current = [];
        prev = null;
        continue;
      }
      const lat = lat_e7 / 1e7;
      const lon = lon_e7 / 1e7;
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (prev) {
        const d = haversine(prev[0], prev[1], lat, lon);
        if (d > maxGapMeters) {
          if (current.length > 1) segs.push(current);
          current = [];
        }
      }
      current.push([lat, lon]);
      prev = [lat, lon];
    }
    if (current.length > 1) segs.push(current);
    return segs;
  }

  function fitToSegments(segs) {
    if (!segs.length) return;
    let minLat =  90, maxLat = -90, minLon =  180, maxLon = -180;
    for (const seg of segs) {
      for (const p of seg) {
        const lat = p[0], lon = p[1];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
    const bounds = L.latLngBounds([[minLat, minLon],[maxLat, maxLon]]);
    map.fitBounds(bounds.pad(0.1));
  }

  function renderSegments(segs) {
    // Remove previous
    for (const pl of polylines) {
      map.removeLayer(pl);
    }
    polylines = [];

    const w = Math.max(1, Math.min(50, Number(widthInput.value) || 3));
    const o = Math.max(0.05, Math.min(1, Number(opacityInput.value) || 0.8));

    const c = getLineColor();
    for (const seg of segs) {
      if (seg.length < 2) continue;
      const pl = L.polyline(seg, {
        color: c,
        weight: w,
        opacity: o
      });
      pl.addTo(map);
      polylines.push(pl);
    }
  }

  // Load summary (total distance) with network-first and cache fallback
  async function loadSummary(url) {
    const totalEl = document.getElementById('totalKm');
    function setVal(v) { if (totalEl) totalEl.textContent = v; }

    let cache;
    if ('caches' in window) {
      try { cache = await caches.open(CACHE_NAME); } catch {}
    }

    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        setVal((data.total_km ?? 0).toFixed(2));
        if (cache) { try { await cache.put(url, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })); } catch {} }
        return;
      }
    } catch {}

    if (cache) {
      try {
        const cached = await cache.match(url);
        if (cached) {
          const data = await cached.json();
          setVal((data.total_km ?? 0).toFixed(2));
          return;
        }
      } catch {}
    }

    setVal('--');
  }

  // Kick off
  setStyle('light');
  loadSummary('summary.json');
  loadBinary('points.bin').then(segs => {
    segments = segs;
    renderSegments(segments);
    updateLineStyles();
    fitToSegments(segments);
  }).catch(err => {
    console.error(err);
    const label = document.querySelector('#loading .label');
    if (label) label.textContent = 'Failed to load tracks';
    setTimeout(() => hideLoading(), 1500);
  });
})();

