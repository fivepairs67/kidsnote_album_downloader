const $ = (id) => document.getElementById(id);

const LOG_MAX_LINES = 200;
const LOG_SESSION_KEY = 'popupLogLines';
const STATUS_STORAGE_AREA = 'session';
const statusStorage = chrome.storage?.session || null;
let logLines = [];
const statusState = { progressText: '', finalReport: '' };

// Clear legacy persistent keys from older versions.
void chrome.storage.local.remove(['progressText', 'finalReport']).catch(() => {});

function renderLogs() {
  const el = $('log');
  if (!el) return;
  el.textContent = logLines.join('\n');
  // Keep view pinned to bottom while running.
  el.scrollTop = el.scrollHeight;
}

async function initLogs() {
  if (!chrome.storage?.session) {
    renderLogs();
    return;
  }
  try {
    const obj = await chrome.storage.session.get([LOG_SESSION_KEY]);
    const stored = Array.isArray(obj[LOG_SESSION_KEY])
      ? obj[LOG_SESSION_KEY].filter((v) => typeof v === 'string')
      : [];
    // If logs were added before restore finishes, keep both.
    logLines = stored.concat(logLines).slice(-LOG_MAX_LINES);
  } catch {}
  renderLogs();
}

function persistLogs() {
  if (!chrome.storage?.session) return;
  void chrome.storage.session.set({ [LOG_SESSION_KEY]: logLines }).catch(() => {});
}

const logInitPromise = initLogs();

function log(msg) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const line = `${ts}  ${msg}`;

  // Append logs (newest at bottom) and cap line count.
  logLines.push(line);
  logLines = logLines.slice(-LOG_MAX_LINES);
  renderLogs();
  void logInitPromise.then(() => persistLogs());
}

function setProgressText(t) {
  const el = $('progress');
  if (!el) return;
  el.textContent = t || '(대기 중)';
  el.scrollTop = el.scrollHeight;
}

function setReportText(t) {
  const el = $('report');
  if (!el) return;
  el.textContent = t || '';
}

function renderStatus(progressText, reportText) {
  const p = progressText || '(대기 중)';
  const r = reportText || '';
  const combined = r ? `${p}\n\n${r}` : p;
  setProgressText(combined);
  // Result is now shown inside the status box above.
  setReportText('');
}

function showAlert(message) {
  const el = $('alert');
  if (!el) return;
  if (!message) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'block';
  el.textContent = message;
}

function setBadge(progressText, reportText) {
  const badge = $('badge');
  const badgeText = $('badgeText');
  if (!badge || !badgeText) return;

  const p = (progressText || '').toLowerCase();
  const r = (reportText || '').toLowerCase();

  let cls = '';
  let text = 'Idle';

  if (p.includes('❌') || r.includes('에러') || r.includes('error')) {
    cls = 'err';
    text = 'Error';
  } else if (p.includes('완료')) {
    cls = 'ok';
    text = 'Done';
  } else if (p.includes('중단')) {
    cls = 'warn';
    text = 'Stopped';
  } else if (p.includes('시작') || p.includes('탐색') || p.includes('현재') || p.includes('idx:')) {
    cls = 'running';
    text = 'Running';
  } else if (p && p !== '(대기 중)') {
    cls = 'running';
    text = 'Working';
  }

  badge.className = `badge ${cls}`.trim();
  badgeText.textContent = text;

  const statusPanel = document.getElementById('statusPanel');
  if (statusPanel) {
    const map = {
      ok: 'rgba(22,163,74,.35)',
      running: 'rgba(37,99,235,.35)',
      warn: 'rgba(245,158,11,.35)',
      err: 'rgba(220,38,38,.35)',
      '': 'rgba(229,231,235,1)'
    };
    statusPanel.style.boxShadow = `0 0 0 3px ${map[cls] || map['']} , var(--shadow)`;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getFilters() {
  const fromYm = ($('fromYm')?.value || '').trim();
  const toYm = ($('toYm')?.value || '').trim();
  return { fromYm, toYm };
}

$('scanAlbum').addEventListener('click', async () => {
  const tab = await getActiveTab();
  const filters = getFilters();
  if (!tab?.id) return;

  // Always set default root for album mode when preparing connection.
  const rootEl = $('root');
  if (rootEl) {
    rootEl.value = 'Kidsnote_album';
  }

  log('준비/연결(앨범) 요청...');

  chrome.runtime.sendMessage({ kind: 'ENSURE_ALBUM_PAGE', tabId: tab.id, filters }, (res) => {
    if (chrome.runtime.lastError) {
      log('에러: ' + chrome.runtime.lastError.message);
      return;
    }
    if (!res?.ok) {
      log('실패: ' + (res?.error || 'unknown'));
      return;
    }
    log(res?.message || '준비 완료');
  });
});

$('scanReport').addEventListener('click', async () => {
  const tab = await getActiveTab();
  const filters = getFilters();
  if (!tab?.id) return;

  // Always set default root for report mode when preparing connection.
  const rootEl = $('root');
  if (rootEl) {
    rootEl.value = 'Kidsnote_report';
  }

  log('준비/연결(알림장) 요청...');

  chrome.runtime.sendMessage({ kind: 'ENSURE_REPORT_PAGE', tabId: tab.id, filters }, (res) => {
    if (chrome.runtime.lastError) {
      log('에러: ' + chrome.runtime.lastError.message);
      return;
    }
    if (!res?.ok) {
      log('실패: ' + (res?.error || 'unknown'));
      return;
    }
    log(res?.message || '준비 완료');
  });
});

function validateYm(ym) {
  if (!ym) return true;
  return /^20\d{2}-\d{2}$/.test(ym);
}

function validateRangeOrAlert(filters) {
  // Clear any previous inline alert
  showAlert('');

  if (!validateYm(filters.fromYm) || !validateYm(filters.toYm)) {
    const msg = '기간 형식 오류: YYYY-MM 형식만 가능 (예: 2024-10)';
    showAlert(msg);
    log(msg);
    setBadge('❌ ' + msg, '');
    return { ok: false };
  }
  if (filters.fromYm && filters.toYm && filters.fromYm > filters.toYm) {
    const msg = '기간 형식 오류: from이 to보다 클 수 없음';
    showAlert(msg);
    log(msg);
    setBadge('❌ ' + msg, '');
    return { ok: false };
  }
  return { ok: true };
}

async function startDownload(kind) {
  const tab = await getActiveTab();
  const root = $('root').value.trim() || 'Kidsnote';
  const filters = getFilters();
  if (!tab?.id) return;
  if (!validateRangeOrAlert(filters).ok) return;

  const rangeText = (filters.fromYm || filters.toYm) ? `${filters.fromYm || '...'} ~ ${filters.toYm || '...'}` : '전체';
  log(`다운로드 시작 요청(${kind})... (root=${root}, 기간=${rangeText})`);

  chrome.runtime.sendMessage({ kind, tabId: tab.id, root, filters }, (res) => {
    if (chrome.runtime.lastError) {
      log('에러: ' + chrome.runtime.lastError.message);
      return;
    }
    if (!res?.ok) {
      const err = res?.error || 'unknown';
      if (err === 'ALREADY_RUNNING') {
        log('이미 다운로드가 진행 중입니다. 완료 또는 정지 후 다시 시도하세요.');
      } else {
        log('시작 실패: ' + err);
      }
      return;
    }
    log('다운로드 워커 시작됨');
  });
}

$('downloadAlbum').addEventListener('click', () => startDownload('START_DOWNLOAD_ALBUM'));
$('downloadReport').addEventListener('click', () => startDownload('START_DOWNLOAD_REPORT'));

$('stop').addEventListener('click', async () => {
  log('정지 요청...');
  chrome.runtime.sendMessage({ kind: 'STOP_DOWNLOAD' }, (res) => {
    if (chrome.runtime.lastError) {
      log('에러: ' + chrome.runtime.lastError.message);
      return;
    }
    log(res?.ok ? '정지 플래그 설정됨(현재 진행 중인 파일 이후 중단)' : '정지 실패');
  });
});

// Live progress via storage (session by default so it resets after full browser restart)
if (statusStorage) {
  statusStorage.get(['progressText','finalReport']).then((o) => {
    statusState.progressText = o.progressText || '';
    statusState.finalReport = o.finalReport || '';
    renderStatus(statusState.progressText, statusState.finalReport);
    setBadge(statusState.progressText, statusState.finalReport);
  });
} else {
  renderStatus('', '');
  setBadge('', '');
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== STATUS_STORAGE_AREA) return;
  if (changes.progressText) {
    statusState.progressText = changes.progressText.newValue || '';
  }
  if (changes.finalReport) {
    statusState.finalReport = changes.finalReport.newValue || '';
  }
  renderStatus(statusState.progressText, statusState.finalReport);
  setBadge(statusState.progressText, statusState.finalReport);
});
