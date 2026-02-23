// MV3 service worker

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopRequested = false;
let downloadRunning = false;

function sanitizeSegment(s, maxLen = 80) {
  // Make a filesystem-safe segment across platforms (esp. Windows downloads).
  let out = (s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Windows disallows trailing dot/space
  out = out.replace(/[\.\s]+$/g, '');
  if (!out) out = 'untitled';
  return out.slice(0, maxLen);
}

async function getStored(key, fallback) {
  const obj = await chrome.storage.local.get([key]);
  return obj[key] ?? fallback;
}

async function setStored(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function setSessionStored(key, value) {
  if (!chrome.storage?.session) return;
  await chrome.storage.session.set({ [key]: value });
}

async function setDownloadRunning(value) {
  downloadRunning = !!value;
  if (chrome.storage?.session) {
    await setSessionStored('downloadRunning', downloadRunning);
    return;
  }
  await setStored('downloadRunning', downloadRunning);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

async function setProgress(text) {
  if (chrome.storage?.session) {
    await setSessionStored('progressText', text);
    return;
  }
  await setStored('progressText', text);
}

async function setFinalReport(text) {
  if (chrome.storage?.session) {
    await setSessionStored('finalReport', text);
    return;
  }
  await setStored('finalReport', text);
}

function makeDataUrl(mime, text) {
  // Avoid Blob/ObjectURL (not available in MV3 service worker in some builds).
  // Use a data: URL instead.
  const enc = encodeURIComponent(text);
  return `data:${mime};charset=utf-8,${enc}`;
}

async function downloadTextFile(filename, text) {
  const url = makeDataUrl('text/plain', text ?? '');
  return chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
}

async function safeDownload(opName, context, fn, retryFn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const msg = String(e?.message || e);
    const ctx = context ? `\n${context}` : '';

    // Retry once with a fallback filename if it's an Invalid filename error.
    if (retryFn && /Invalid filename/i.test(msg)) {
      try {
        await setProgress(`⚠️ ${opName} 파일명 문제로 재시도 중…${ctx}`);
        const v = await retryFn();
        return { ok: true, value: v, retried: true };
      } catch (e2) {
        const msg2 = String(e2?.message || e2);
        await setProgress(`❌ ${opName} 실패: ${msg2}${ctx}`);
        return { ok: false, error: msg2 };
      }
    }

    await setProgress(`❌ ${opName} 실패: ${msg}${ctx}`);
    return { ok: false, error: msg };
  }
}

async function downloadUrl(filename, url) {
  return chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
}

async function getAlbumApiInfo(tabId) {
  const res = await chrome.tabs.sendMessage(tabId, { kind: 'GET_ALBUM_API_INFO' });
  if (!res?.ok || !res.info?.baseUrl) throw new Error('CANT_DETECT_ALBUM_API');
  return res.info; // {childId, baseUrl, sampleUrl}
}

async function fetchAlbumsJsonViaTab(tabId, url) {
  const res = await chrome.tabs.sendMessage(tabId, { kind: 'FETCH_ALBUMS_PAGE', url });
  if (!res?.ok) throw new Error(res?.status ? `HTTP_${res.status}` : (res?.error || 'FETCH_FAILED'));
  return res.json;
}

async function getReportApiInfo(tabId) {
  const res = await chrome.tabs.sendMessage(tabId, { kind: 'GET_REPORT_API_INFO' });
  if (!res?.ok || !res.info?.baseUrl) throw new Error('CANT_DETECT_REPORT_API');
  return res.info; // {childId, baseUrl, sampleUrl}
}

async function fetchReportsJsonViaTab(tabId, url) {
  const res = await chrome.tabs.sendMessage(tabId, { kind: 'FETCH_REPORTS_PAGE', url });
  if (!res?.ok) throw new Error(res?.status ? `HTTP_${res.status}` : (res?.error || 'FETCH_FAILED'));
  return res.json;
}

function pickBestVideoUrl(v) {
  return v?.high || v?.low || null;
}

function pickBestImageUrl(img) {
  // Prefer original over resized.
  return img?.original || img?.large || img?.large_resize || img?.small || img?.small_resize || null;
}

function ymInRange(ym, fromYm, toYm) {
  if (!ym) return false;
  const okFmt = /^20\d{2}-\d{2}$/.test(ym);
  if (!okFmt) return true; // don't block on weird input
  if (fromYm && /^20\d{2}-\d{2}$/.test(fromYm) && ym < fromYm) return false;
  if (toYm && /^20\d{2}-\d{2}$/.test(toYm) && ym > toYm) return false;
  return true;
}

async function downloadAlbumFromApi(root, album, index, total, filters, startTs, counters) {
  if (stopRequested) return { ok: true, skipped: true, stopped: true };

  const created = album.created || '';
  const date = created.slice(0, 10) || 'unknown-date'; // YYYY-MM-DD
  const ym = created.slice(0, 7) || '';
  const fromYm = filters?.fromYm || '';
  const toYm = filters?.toYm || '';
  if ((fromYm || toYm) && !ymInRange(ym, fromYm, toYm)) {
    return { ok: true, skipped: true };
  }

  const title = sanitizeSegment(album.title || 'album', 60);
  const rootSeg = sanitizeSegment(root, 40);
  // Base dir (human-friendly) + fallback dir (minimal) for Invalid filename errors.
  // User preference: keep folder names clean (no trailing id) when possible.
  const dirBase = `${rootSeg}/${date}-${title}`;
  const dirFallback = `${rootSeg}/${date}-${album.id}`;

  await setProgress(`Idx: ${index + 1} (다운로드: ${counters.albumsDownloaded}, 스킵: ${counters.albumsSkipped || 0})\n경과: ${fmtElapsed(Date.now()-startTs)}\n현재: ${date}-${title} (text)`);
  counters.albumsDownloaded++;

  const label = `${date}-${title} (id=${album.id})`;

  const textRes = await safeDownload(
    'text 저장',
    `앨범: ${label}\n파일: text.txt`,
    () => downloadTextFile(`${dirBase}/text.txt`, album.content || ''),
    () => downloadTextFile(`${dirFallback}/text.txt`, album.content || '')
  );
  if (!textRes.ok) { counters.errors++; return { ok: false, error: textRes.error }; }

  const pad = (n) => String(n).padStart(3, '0');

  const images = (album.attached_images || []).map(pickBestImageUrl).filter(Boolean);
  for (const [i, url] of images.entries()) {
    if (stopRequested) break;
    const ext = (new URL(url)).pathname.split('.').pop() || 'jpg';
    await setProgress(`Idx: ${index + 1} (다운로드: ${counters.albumsDownloaded}, 스킵: ${counters.albumsSkipped || 0})\n경과: ${fmtElapsed(Date.now()-startTs)}\n현재: ${date}-${title} photo ${i + 1}/${images.length}`);
    const filenameBase = `${dirBase}/photos/${pad(i + 1)}.${ext}`;
    const filenameFallback = `${dirFallback}/photos/${pad(i + 1)}.${ext}`;
    const r = await safeDownload(
      'photo 다운로드',
      `앨범: ${label}\n파일: photos/${pad(i + 1)}.${ext}`,
      () => downloadUrl(filenameBase, url),
      () => downloadUrl(filenameFallback, url)
    );
    if (!r.ok) { counters.errors++; return { ok: false, error: r.error }; }
    counters.photosDownloaded++;
    await sleep(80);
  }

  const videos = (album.attached_videos || []).map(pickBestVideoUrl).filter(Boolean);
  for (const [i, url] of videos.entries()) {
    if (stopRequested) break;
    const ext = (new URL(url)).pathname.split('.').pop() || 'mp4';
    await setProgress(`Idx: ${index + 1} (다운로드: ${counters.albumsDownloaded}, 스킵: ${counters.albumsSkipped || 0})\n경과: ${fmtElapsed(Date.now()-startTs)}\n현재: ${date}-${title} video ${i + 1}/${videos.length}`);
    const filenameBase = `${dirBase}/videos/${pad(i + 1)}.${ext}`;
    const filenameFallback = `${dirFallback}/videos/${pad(i + 1)}.${ext}`;
    const r = await safeDownload(
      'video 다운로드',
      `앨범: ${label}\n파일: videos/${pad(i + 1)}.${ext}`,
      () => downloadUrl(filenameBase, url),
      () => downloadUrl(filenameFallback, url)
    );
    if (!r.ok) { counters.errors++; return { ok: false, error: r.error }; }
    counters.videosDownloaded++;
    await sleep(120);
  }

  await setStored('lastProgress', { index: index + 1, total, albumId: album.id });
  return { ok: true, dir: dirBase, counts: { images: images.length, videos: videos.length } };
}

async function startDownloadAlbums(tabId, root, filters) {
  stopRequested = false;
  await setStored('stopRequested', false);
  await setFinalReport('');

  const startTs = Date.now();
  const rangeText = (filters?.fromYm || filters?.toYm)
    ? `${filters?.fromYm || '...'} ~ ${filters?.toYm || '...'}`
    : '전체';
  await setProgress(`시작: root=${sanitizeSegment(root)} / 기간=${rangeText}`);

  const counters = { albumsDownloaded: 0, albumsSkipped: 0, photosDownloaded: 0, videosDownloaded: 0, errors: 0, lastError: '' };

  // Stream scan pages and download without storing the full album list (avoids chrome.storage quota).
  const { childId, baseUrl } = await getAlbumApiInfo(tabId);

  // Kidsnote API supports larger page_size (tested: 100).
  const pageSize = 100;
  const tz = 'Asia/Seoul';

  let pageToken = null;
  let seenTokens = new Set();

  // first page (total count is unreliable on some accounts)
  const firstUrl = new URL(baseUrl);
  firstUrl.searchParams.set('page_size', String(pageSize));
  firstUrl.searchParams.set('tz', tz);
  firstUrl.searchParams.set('child', childId);
  const first = await fetchAlbumsJsonViaTab(tabId, firstUrl.toString());

  // Only trust count if it looks plausible (> page size). Otherwise show "?".
  const total = (typeof first.count === 'number' && first.count > (first.results?.length || 0)) ? first.count : null;

  await setStored('lastProgress', { index: 0, total: total ?? '?', albumId: null });

  let processed = 0;
  let doneRange = false;

  const fromYm = filters?.fromYm || '';
  const toYm = filters?.toYm || '';

  function inRange(ym) {
    return !(fromYm || toYm) || ymInRange(ym, fromYm, toYm);
  }

  async function handleResults(results) {
    for (const album of results || []) {
      if (stopRequested) { doneRange = true; break; }
      const created = album.created || '';
      const ym = created.slice(0, 7) || '';

      // Optimization for old ranges: data is newest->oldest.
      if (toYm && ym && ym > toYm) {
        counters.albumsSkipped++; processed++;
        continue;
      }
      if (fromYm && ym && ym < fromYm) {
        doneRange = true;
        break;
      }

      if (!inRange(ym)) {
        counters.albumsSkipped++; processed++;
        continue;
      }

      const res = await downloadAlbumFromApi(root, album, processed, total ?? '?', filters, startTs, counters);
      if (!res?.ok) {
        counters.lastError = res.error || 'unknown';
        // Persist last error details for the popup
        await setStored('lastErrorDetail', counters.lastError);
        doneRange = true; // stop on fatal error to avoid silent partial runs
        break;
      }
      processed++;
      await setStored('lastProgress', { index: processed, total: total ?? '?', albumId: album.id });
      await sleep(80);
    }

    // Light progress update during scanning/skipping so it doesn't look stuck.
    if (fromYm || toYm) {
      const sampleYm = (results?.[0]?.created || '').slice(0, 7);
      await setProgress(`탐색/다운로드 중… 경과 ${fmtElapsed(Date.now()-startTs)}\nIdx:${processed} (다운로드:${counters.albumsDownloaded}, 스킵:${counters.albumsSkipped}) 현재:${sampleYm || '?'} 목표:${rangeText}`);
    }
  }

  await handleResults(first.results);
  pageToken = first.next;

  for (let i = 0; i < 5000; i++) {
    if (!pageToken) break;
    if (seenTokens.has(pageToken)) break;
    seenTokens.add(pageToken);

    if (doneRange) break;

    const url = new URL(baseUrl);
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('tz', tz);
    url.searchParams.set('child', childId);
    url.searchParams.set('page', pageToken);

    const j = await fetchAlbumsJsonViaTab(tabId, url.toString());
    await handleResults(j.results);
    pageToken = j.next;
  }

  const elapsed = fmtElapsed(Date.now()-startTs);
  const errPart = counters.errors ? `\n에러: ${counters.errors}건\n마지막: ${counters.lastError}` : '';
  const report = `결과:\n- 앨범: ${counters.albumsDownloaded}개\n- 사진: ${counters.photosDownloaded}개\n- 동영상: ${counters.videosDownloaded}개${errPart}\n- 총 소요: ${elapsed}`;
  await setFinalReport(report);

  await setStored('lastProgress', { index: processed, total: total ?? '?', albumId: null, done: true, downloadedAlbums: counters.albumsDownloaded });
  await setProgress(stopRequested ? `중단됨 (${elapsed})` : `완료 (${elapsed})`);
}


function pickBestReportImageUrl(img) {
  // same shape as album images
  return img?.original || img?.large || img?.large_resize || img?.small || img?.small_resize || null;
}

function flattenVideoUrl(v) {
  if (!v) return [];
  if (typeof v === 'string') return [v];
  if (typeof v === 'object') return [v.high, v.low, v.url].filter(Boolean);
  return [];
}

function getReportVideoUrls(report) {
  const urls = [];
  urls.push(...flattenVideoUrl(report.attached_video));
  urls.push(...flattenVideoUrl(report.material_video));
  // Some responses may include arrays
  if (Array.isArray(report.attached_videos)) {
    for (const v of report.attached_videos) urls.push(...flattenVideoUrl(v));
  }
  return [...new Set(urls)].filter(Boolean);
}

function getReportFiles(report) {
  const files = [];
  const arr = report.attached_files;
  if (Array.isArray(arr)) {
    for (const f of arr) {
      if (!f) continue;
      if (typeof f === 'string') files.push({ url: f, name: null });
      else files.push({ url: f.url || f.file || f.download_url || f.downloadUrl || null, name: f.name || f.filename || f.original_name || null });
    }
  }
  return files.filter((x) => x.url);
}

function extractUrlExtension(url) {
  try {
    const last = (new URL(url)).pathname.split('/').pop() || '';
    const m = last.match(/\.([A-Za-z0-9]{1,10})$/);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function hasFileLikeExtension(name) {
  return /\.[A-Za-z0-9]{1,10}$/.test(name || '');
}

async function downloadReportFromApi(root, report, index, total, filters, startTs, counters) {
  if (stopRequested) return { ok: true, skipped: true, stopped: true };

  const created = report.created || report.date_written || '';
  const date = String(created).slice(0, 10) || 'unknown-date';
  const ym = String(created).slice(0, 7) || '';

  const fromYm = filters?.fromYm || '';
  const toYm = filters?.toYm || '';
  if ((fromYm || toYm) && !ymInRange(ym, fromYm, toYm)) {
    return { ok: true, skipped: true };
  }

  const title = sanitizeSegment(report.class_name || report.author_name || 'report', 60);
  const reportId = sanitizeSegment(String(report.id || `item-${index + 1}`), 40);
  const rootSeg = sanitizeSegment(root, 40);
  // Keep per-item folder unique to avoid mixing files when title/date repeats.
  const dirBase = `${rootSeg}/${date}-${title}-${reportId}`;
  const dirFallback = `${rootSeg}/${date}-${reportId}`;

  await setProgress(`Idx: ${index + 1} (다운로드: ${counters.itemsDownloaded}, 스킵: ${counters.itemsSkipped || 0})\n경과: ${fmtElapsed(Date.now()-startTs)}\n현재: ${date}-${title} (text)`);
  counters.itemsDownloaded++;

  const label = `${date}-${title} (id=${report.id})`;

  const textRes = await safeDownload(
    'text 저장',
    `알림장: ${label}\n파일: text.txt`,
    () => downloadTextFile(`${dirBase}/text.txt`, report.content || ''),
    () => downloadTextFile(`${dirFallback}/text.txt`, report.content || '')
  );
  if (!textRes.ok) { counters.errors++; return { ok: false, error: textRes.error }; }

  const pad = (n) => String(n).padStart(3, '0');

  const images = (report.attached_images || []).map(pickBestReportImageUrl).filter(Boolean);
  for (const [i, url] of images.entries()) {
    if (stopRequested) break;
    const ext = (new URL(url)).pathname.split('.').pop() || 'jpg';
    await setProgress(`Idx: ${index + 1} (다운로드: ${counters.itemsDownloaded}, 스킵: ${counters.itemsSkipped || 0})\n경과: ${fmtElapsed(Date.now()-startTs)}\n현재: ${date}-${title} photo ${i + 1}/${images.length}`);
    const filenameBase = `${dirBase}/photos/${pad(i + 1)}.${ext}`;
    const filenameFallback = `${dirFallback}/photos/${pad(i + 1)}.${ext}`;
    const r = await safeDownload(
      'photo 다운로드',
      `알림장: ${label}\n파일: photos/${pad(i + 1)}.${ext}`,
      () => downloadUrl(filenameBase, url),
      () => downloadUrl(filenameFallback, url)
    );
    if (!r.ok) { counters.errors++; return { ok: false, error: r.error }; }
    counters.photosDownloaded++;
    await sleep(80);
  }

  const videos = getReportVideoUrls(report);
  for (const [i, url] of videos.entries()) {
    if (stopRequested) break;
    const ext = (new URL(url)).pathname.split('.').pop() || 'mp4';
    await setProgress(`Idx: ${index + 1} (다운로드: ${counters.itemsDownloaded}, 스킵: ${counters.itemsSkipped || 0})\n경과: ${fmtElapsed(Date.now()-startTs)}\n현재: ${date}-${title} video ${i + 1}/${videos.length}`);
    const filenameBase = `${dirBase}/videos/${pad(i + 1)}.${ext}`;
    const filenameFallback = `${dirFallback}/videos/${pad(i + 1)}.${ext}`;
    const r = await safeDownload(
      'video 다운로드',
      `알림장: ${label}\n파일: videos/${pad(i + 1)}.${ext}`,
      () => downloadUrl(filenameBase, url),
      () => downloadUrl(filenameFallback, url)
    );
    if (!r.ok) { counters.errors++; return { ok: false, error: r.error }; }
    counters.videosDownloaded++;
    await sleep(120);
  }

  const files = getReportFiles(report);
  for (const [i, f] of files.entries()) {
    if (stopRequested) break;
    const url = f.url;
    const baseName = sanitizeSegment(f.name || `file_${pad(i + 1)}`, 60);
    const urlExt = extractUrlExtension(url);
    const fname = (urlExt && !hasFileLikeExtension(baseName)) ? `${baseName}.${urlExt}` : baseName;
    await setProgress(`Idx: ${index + 1} (다운로드: ${counters.itemsDownloaded}, 스킵: ${counters.itemsSkipped || 0})\n경과: ${fmtElapsed(Date.now()-startTs)}\n현재: ${date}-${title} file ${i + 1}/${files.length}`);
    const filenameBase = `${dirBase}/files/${fname}`;
    const filenameFallback = `${dirFallback}/files/${fname}`;
    const r = await safeDownload(
      'file 다운로드',
      `알림장: ${label}\n파일: files/${fname}`,
      () => downloadUrl(filenameBase, url),
      () => downloadUrl(filenameFallback, url)
    );
    if (!r.ok) { counters.errors++; return { ok: false, error: r.error }; }
    counters.filesDownloaded++;
    await sleep(80);
  }

  return { ok: true };
}

async function startDownloadReports(tabId, root, filters) {
  stopRequested = false;
  await setStored('stopRequested', false);
  await setFinalReport('');

  const startTs = Date.now();
  const rangeText = (filters?.fromYm || filters?.toYm)
    ? `${filters?.fromYm || '...'} ~ ${filters?.toYm || '...'}`
    : '전체';
  await setProgress(`시작(알림장): root=${sanitizeSegment(root)} / 기간=${rangeText}`);

  const counters = { itemsDownloaded: 0, itemsSkipped: 0, photosDownloaded: 0, videosDownloaded: 0, filesDownloaded: 0, errors: 0, lastError: '' };

  const { childId, baseUrl } = await getReportApiInfo(tabId);
  const pageSize = 100;
  const tz = 'Asia/Seoul';

  let pageToken = null;
  let seenTokens = new Set();

  const firstUrl = new URL(baseUrl);
  firstUrl.searchParams.set('page_size', String(pageSize));
  firstUrl.searchParams.set('tz', tz);
  firstUrl.searchParams.set('child', childId);
  const first = await fetchReportsJsonViaTab(tabId, firstUrl.toString());
  const total = (typeof first.count === 'number' && first.count > (first.results?.length || 0)) ? first.count : null;

  let processed = 0;
  let doneRange = false;

  const fromYm = filters?.fromYm || '';
  const toYm = filters?.toYm || '';

  function inRange(ym) {
    return !(fromYm || toYm) || ymInRange(ym, fromYm, toYm);
  }

  async function handleResults(results) {
    for (const r of results || []) {
      if (stopRequested) { doneRange = true; break; }
      const created = r.created || r.date_written || '';
      const ym = String(created).slice(0, 7) || '';

      if (toYm && ym && ym > toYm) { counters.itemsSkipped++; processed++; continue; }
      if (fromYm && ym && ym < fromYm) { doneRange = true; break; }
      if (!inRange(ym)) { counters.itemsSkipped++; processed++; continue; }

      const res = await downloadReportFromApi(root, r, processed, total ?? '?', filters, startTs, counters);
      if (!res?.ok) {
        counters.lastError = res.error || 'unknown';
        doneRange = true;
        break;
      }
      processed++;
      await sleep(80);
    }

    if (fromYm || toYm) {
      const sampleYm = String(results?.[0]?.created || results?.[0]?.date_written || '').slice(0, 7);
      await setProgress(`탐색/다운로드(알림장) 중… 경과 ${fmtElapsed(Date.now()-startTs)}\nIdx:${processed} (다운로드:${counters.itemsDownloaded}, 스킵:${counters.itemsSkipped}) 현재:${sampleYm || '?'} 목표:${rangeText}`);
    }
  }

  await handleResults(first.results);
  pageToken = first.next;

  for (let i = 0; i < 5000; i++) {
    if (!pageToken) break;
    if (seenTokens.has(pageToken)) break;
    seenTokens.add(pageToken);
    if (doneRange) break;

    const url = new URL(baseUrl);
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('tz', tz);
    url.searchParams.set('child', childId);
    url.searchParams.set('page', pageToken);

    const j = await fetchReportsJsonViaTab(tabId, url.toString());
    await handleResults(j.results);
    pageToken = j.next;
  }

  const elapsed = fmtElapsed(Date.now()-startTs);
  const errPart = counters.errors ? `\n에러: ${counters.errors}건\n마지막: ${counters.lastError}` : '';
  const report = `결과(알림장):\n- 글: ${counters.itemsDownloaded}개\n- 사진: ${counters.photosDownloaded}개\n- 동영상: ${counters.videosDownloaded}개\n- 파일: ${counters.filesDownloaded}개${errPart}\n- 총 소요: ${elapsed}`;
  await setFinalReport(report);
  await setProgress(stopRequested ? `중단됨 (${elapsed})` : `완료 (${elapsed})`);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.kind === 'ENSURE_ALBUM_PAGE') {
        // 1) Ensure we're on the album list page.
        const tab = await chrome.tabs.get(msg.tabId);
        const isAlbum = tab.url?.startsWith('https://www.kidsnote.com/service/album');
        if (!isAlbum) {
          await chrome.tabs.update(msg.tabId, { url: 'https://www.kidsnote.com/service/album' });
          await sleep(1200);
        }

        // 2) Force reload so content scripts attach after extension reloads.
        await chrome.tabs.reload(msg.tabId);
        await sleep(1500);

        // 3) Verify content script is reachable.
        let pingOk = false;
        for (let i = 0; i < 10; i++) {
          try {
            const res = await chrome.tabs.sendMessage(msg.tabId, { kind: 'PING_KN_DL' });
            if (res?.ok) { pingOk = true; break; }
          } catch {}
          await sleep(400);
        }
        if (!pingOk) throw new Error('CONTENT_SCRIPT_NOT_READY');

        // 4) Verify we can detect the album API.
        const api = await getAlbumApiInfo(msg.tabId);
        await setStored('scanInfo', { childId: api.childId, baseUrl: api.baseUrl, ts: Date.now() });
        await setStored('filters', msg.filters || {});
        await setProgress('준비 완료: 앨범 페이지/세션 OK');
        sendResponse({ ok: true, message: '준비 완료: 앨범 페이지/세션 OK' });
        return;
      }

      if (msg?.kind === 'STOP_DOWNLOAD') {
        stopRequested = true;
        await setStored('stopRequested', true);
        await setProgress('정지 요청됨… 현재 파일 처리 후 중단합니다.');
        sendResponse({ ok: true });
        return;
      }

      
      if (msg?.kind === 'ENSURE_REPORT_PAGE') {
        const tab = await chrome.tabs.get(msg.tabId);
        const isReport = tab.url?.startsWith('https://www.kidsnote.com/service/report');
        if (!isReport) {
          await chrome.tabs.update(msg.tabId, { url: 'https://www.kidsnote.com/service/report' });
          await sleep(1200);
        }
        await chrome.tabs.reload(msg.tabId);
        await sleep(1500);

        let pingOk = false;
        for (let i = 0; i < 10; i++) {
          try {
            const res = await chrome.tabs.sendMessage(msg.tabId, { kind: 'PING_KN_DL_REPORT' });
            if (res?.ok) { pingOk = true; break; }
          } catch {}
          await sleep(400);
        }
        if (!pingOk) throw new Error('CONTENT_SCRIPT_NOT_READY');

        const api = await getReportApiInfo(msg.tabId);
        await setStored('scanInfoReport', { childId: api.childId, baseUrl: api.baseUrl, ts: Date.now() });
        await setStored('filters', msg.filters || {});
        await setProgress('준비 완료: 알림장 페이지/세션 OK');
        sendResponse({ ok: true, message: '준비 완료: 알림장 페이지/세션 OK' });
        return;
      }

      if (msg?.kind === 'START_DOWNLOAD_ALBUM') {
        if (downloadRunning) {
          sendResponse({ ok: false, error: 'ALREADY_RUNNING' });
          return;
        }
        const filters = msg.filters || (await getStored('filters', {}));
        if (!msg.tabId) throw new Error('MISSING_TAB_ID');
        await setDownloadRunning(true);
        startDownloadAlbums(msg.tabId, msg.root || 'Kidsnote', filters)
          .then(() => console.log('done'))
          .catch(async (e) => {
            const err = String(e?.message || e);
            console.error(e);
            await setProgress(`❌ 실행 실패: ${err}`);
            await setFinalReport(`결과:
- 에러: ${err}`);
          })
          .finally(async () => {
            await setDownloadRunning(false);
          });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.kind === 'START_DOWNLOAD_REPORT') {
        if (downloadRunning) {
          sendResponse({ ok: false, error: 'ALREADY_RUNNING' });
          return;
        }
        const filters = msg.filters || (await getStored('filters', {}));
        if (!msg.tabId) throw new Error('MISSING_TAB_ID');
        await setDownloadRunning(true);
        startDownloadReports(msg.tabId, msg.root || 'Kidsnote', filters)
          .then(() => console.log('done'))
          .catch(async (e) => {
            const err = String(e?.message || e);
            console.error(e);
            await setProgress(`❌ 실행 실패: ${err}`);
            await setFinalReport(`결과:
- 에러: ${err}`);
          })
          .finally(async () => {
            await setDownloadRunning(false);
          });
        sendResponse({ ok: true });
        return;
      }

sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      console.error(e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
