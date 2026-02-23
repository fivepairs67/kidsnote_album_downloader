// Runs on https://www.kidsnote.com/service/album*
// Kidsnote album list is rendered without <a href> per item.
// We detect the underlying API endpoint from resource timing.

function findAlbumApiFromPerformance() {
  const entries = performance.getEntriesByType('resource').map((e) => e.name);
  const hit = entries.find((u) => /\/api\/v1_3\/children\/\d+\/albums\//.test(u));
  if (!hit) return null;
  const u = new URL(hit);
  const m = hit.match(/\/api\/v1_3\/children\/(\d+)\/albums\//);
  if (!m) return null;
  const childId = m[1];
  const baseUrl = `https://www.kidsnote.com/api/v1_3/children/${childId}/albums/`;
  const defaultQuery = {};
  for (const [k, v] of u.searchParams.entries()) {
    // Pagination/runtime params are controlled by the service worker.
    if (k === 'page' || k === 'page_size' || k === 'tz' || k === 'child') continue;
    defaultQuery[k] = v;
  }
  return { childId, baseUrl, sampleUrl: hit, defaultQuery };
}

function findFirstNumber(obj, min=1000) {
  const seen = new Set();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === 'number' && v >= min && /(child|children)/i.test(k)) return v;
      if (typeof v === 'string' && /^\d{4,}$/.test(v) && /(child|children)/i.test(k)) return Number(v);
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

async function detectChildIdFallback() {
  // Try me/info endpoint (observed structure: { user, children: [...] })
  const r = await fetch('https://www.kidsnote.com/api/v1/me/info/', { credentials: 'include' }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j) return null;

  // Prefer first child id
  const child0 = Array.isArray(j.children) ? j.children[0] : null;
  const direct = child0?.id || j.child_id || j.childId || j.current_child_id || j.currentChildId;
  if (direct) return Number(direct);

  // Last resort heuristic scan
  const n = findFirstNumber(j, 1000);
  return n;
}

async function validateChildId(childId) {
  if (!childId) return false;
  const url = `https://www.kidsnote.com/api/v1_3/children/${childId}/albums/?page_size=1&tz=Asia%2FSeoul&child=${childId}`;
  const r = await fetch(url, { credentials: 'include' }).catch(() => null);
  return !!(r && r.ok);
}

function isAllowedAlbumsApiUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'www.kidsnote.com') return false;
    return /^\/api\/v1_3\/children\/\d+\/albums\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'PING_KN_DL') {
    sendResponse({ ok: true, url: location.href });
    return true;
  }

  if (msg?.kind === 'GET_ALBUM_API_INFO') {
    // Ensure we can infer childId.
    (async () => {
      let info = findAlbumApiFromPerformance();
      if (!info) {
        // Fallback: derive childId from me/info and validate against albums endpoint.
        const childId = await detectChildIdFallback();
        if (childId && await validateChildId(childId)) {
          info = { childId: String(childId), baseUrl: `https://www.kidsnote.com/api/v1_3/children/${childId}/albums/`, sampleUrl: null, defaultQuery: {} };
        }
      }
      sendResponse({ ok: !!info, info });
    })();
    return true;
  }

  if (msg?.kind === 'FETCH_ALBUMS_PAGE') {
    (async () => {
      try {
        if (!isAllowedAlbumsApiUrl(msg.url)) {
          sendResponse({ ok: false, error: 'DISALLOWED_FETCH_URL' });
          return;
        }
        const r = await fetch(msg.url, { credentials: 'include' });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        sendResponse({ ok: r.ok, status: r.status, json });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});
