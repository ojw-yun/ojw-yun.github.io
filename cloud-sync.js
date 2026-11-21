(() => {
  'use strict';
  // 词芽 GitHub Private Repository JSON sync. Never include credentials in site source.
  const api = window.wordBud;
  if (!api) return;
  const OWNER = 'ojw-yun';
  const REPO = 'ciya-progress-private';
  const PATH = 'progress.json';
  const API_ROOT = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
  const STORE = 'wordbud_v3_records';
  const HISTORY = 'wordbud_v3_history';
  const OPTIONS = 'wordbud_v3_options';
  const SPRINT = 'ciya_sprint_settings_v1';
  const TOKEN_KEY = 'ciya_private_sync_token_v1';
  const KEYS = [STORE, HISTORY, OPTIONS, SPRINT];
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''; } catch {}
  let inFlight = false, dirty = false, timer = null, lastPush = 0, retryDelay = 15000, status = token ? '正在连接…' : '仅本机保存', retryTimer = null;

  function setStatus(message) {
    status = message;
    const el = document.getElementById('ciya-cloud-status');
    if (el) el.textContent = message;
  }
  function panel() {
    const connected = !!token;
    return '<section class="panel ciya-cloud-panel" aria-label="学习记录云端同步">' +
      '<div class="ciya-cloud-top"><div class="ciya-cloud-icon">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M7 18a5 5 0 0 1-1-9.9A7 7 0 0 1 19.5 10 4 4 0 0 1 19 18H7Z"/><path d="M12 10v7m-3-3 3 3 3-3"/></svg>' +
      '</div><div><h3>学习记录自动云备份</h3><p>同步至你自己的 GitHub 私有仓库 progress.json</p></div></div>' +
      '<p class="ciya-cloud-pill"><span class="' + (connected ? 'ciya-online' : 'ciya-local') + '"></span><span id="ciya-cloud-status">' + esc(status) + '</span></p>' +
      (connected ?
      '<div class="ciya-cloud-actions"><button type="button" class="btn primary" data-cloud-action="sync">现在同步</button><button type="button" class="btn outline" data-cloud-action="disconnect">断开连接</button></div>' +
      '<p class="ciya-cloud-note">学习时自动保存到本机，并在短暂间隔后尝试上传 JSON。断网时保留本机记录，下次联网会重新尝试。请勿在共享设备上保存访问密钥。</p>'
      :
      '<div class="ciya-cloud-setup"><p>首次使用需要一个名为 <strong>' + REPO + '</strong> 的 <strong>Private 私有仓库</strong>，以及仅可写入该仓库的 GitHub 精细化访问令牌。</p>' +
      '<label for="ciya-github-pat">你的 GitHub 访问令牌（仅在当前设备输入，不要发送到聊天）</label>' +
      '<input id="ciya-github-pat" type="password" class="ciya-cloud-input" placeholder="github_pat_..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />' +
      '<label class="ciya-cloud-check"><input id="ciya-gh-remember" type="checkbox" /> 记住此私人设备（密钥保存在本机浏览器，设备丢失时有风险）</label>' +
      '<button type="button" class="btn primary full" data-cloud-action="connect">验证并开启自动同步</button>' +
      '<p class="ciya-cloud-links"><a href="https://github.com/new" target="_blank" rel="noopener noreferrer">创建 Private 仓库</a> · <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建精细化令牌</a></p>' +
      '<p class="ciya-cloud-note">令牌仅授权这个私人仓库的 Contents：Read and write；不要授予其它仓库权限。连接之前，学习记录仍会保存在本机。</p></div>'
      ) + '</section>';
  }
  const toB64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  };
  const fromB64 = (text) => {
    const binary = atob(String(text || '').replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };
  async function github(path, method, body, allow404) {
    const resp = await fetch('https://api.github.com' + path, {
      method: method || 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? {'Content-Type': 'application/json'} : {})
      },
      ...(body ? {body:JSON.stringify(body)} : {}),
      cache:'no-store'
    });
    if (allow404 && resp.status === 404) return null;
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) throw Error('GitHub 授权失效或权限不足（' + resp.status + '）');
      if (resp.status === 404) throw Error('找不到私人仓库，请确认仓库名称和令牌权限');
      if (resp.status === 409) throw Error('CONFLICT');
      throw Error('GitHub 网络请求失败（' + resp.status + '）');
    }
    return resp.json();
  }
  function saneRecord(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    return {
      seen:Math.max(0,Math.min(10000000,Number(r.seen)||0)),
      right:Math.max(0,Math.min(10000000,Number(r.right)||0)),
      wrong:Math.max(0,Math.min(10000000,Number(r.wrong)||0)),
      streak:Math.max(0,Math.min(100000,Number(r.streak)||0)),
      due:Number(r.due)||0,
      last:Number(r.last)||0,
      firstSeen:Number(r.firstSeen)||0,
      star:!!r.star
    };
  }
  function mergeFromCloud(remote) {
    if (!remote || remote.app !== '词芽' || !remote.records || typeof remote.records !== 'object') {
      throw Error('云端 JSON 不是有效的词芽记录，未覆盖本机数据');
    }
    let changed = false;
    for (const [id, value] of Object.entries(remote.records)) {
      if (!api.byId.has(id)) continue;
      const cloud = saneRecord(value), local = saneRecord(api.rec[id]);
      if (!cloud) continue;
      if (!local) { api.rec[id] = cloud; changed = true; continue; }
      if (cloud.last > local.last) {
        api.rec[id] = {
          ...cloud,
          seen:Math.max(local.seen,cloud.seen),
          right:Math.max(local.right,cloud.right),
          wrong:Math.max(local.wrong,cloud.wrong),
          firstSeen:Math.min(local.firstSeen || Infinity, cloud.firstSeen || Infinity) || cloud.firstSeen
        };
        if (!Number.isFinite(api.rec[id].firstSeen)) api.rec[id].firstSeen = 0;
        changed = true;
      }
    }
    if (remote.history && typeof remote.history === 'object') {
      for (const [day, ids] of Object.entries(remote.history)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(ids)) continue;
        const existing = api.history[day] || [];
        const joined = [...new Set([...existing, ...ids.filter(id => api.byId.has(id))])];
        if (joined.length !== existing.length) {
          api.history[day] = joined.slice(0, 2000);
          changed = true;
        }
      }
    }
    if (changed) {
      try {
        localStorage.setItem(STORE, JSON.stringify(api.rec));
        localStorage.setItem(HISTORY, JSON.stringify(api.history));
      } catch {}
      api.render();
    }
  }
  function snapshot() {
    let sprint = {};
    try { sprint = JSON.parse(localStorage.getItem(SPRINT) || '{}'); } catch {}
    return {
      app:'词芽',
      version:4,
      updatedAt:new Date().toISOString(),
      records:api.rec,
      history:api.history,
      options:api.options,
      sprint
    };
  }
  async function verifyRepo() {
    const info = await github('/repos/' + OWNER + '/' + REPO);
    if (!info.private) throw Error('为保护学习记录，请把 ' + REPO + ' 设置为 Private 私有仓库');
    if (info.full_name !== OWNER + '/' + REPO) throw Error('仓库信息不匹配');
  }
  async function sync(force) {
    if (!token || inFlight) { if (inFlight) dirty = true; return; }
    if (!navigator.onLine) { setStatus('离线 · 已在本机保存'); return; }
    const delta = Date.now() - lastPush;
    if (!force && delta < 25000) {
      clearTimeout(timer);
      timer = setTimeout(() => sync(false), 25000 - delta);
      return;
    }
    inFlight = true;
    dirty = false;
    setStatus('同步中…');
    try {
      await verifyRepo();
      for (let attempt = 0; attempt < 2; attempt++) {
        const remoteFile = await github('/repos/' + OWNER + '/' + REPO + '/contents/' + PATH, 'GET', null, true);
        if (remoteFile) {
          const remote = JSON.parse(fromB64(remoteFile.content));
          mergeFromCloud(remote);
        }
        try {
          await github('/repos/' + OWNER + '/' + REPO + '/contents/' + PATH, 'PUT', {
            message: '词芽自动备份 ' + new Date().toLocaleString('zh-CN'),
            content: toB64(JSON.stringify(snapshot())),
            ...(remoteFile ? {sha:remoteFile.sha} : {}),
            branch:'main'
          });
          lastPush = Date.now();
          retryDelay = 15000;
          setStatus('已自动备份 · ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}));
          break;
        } catch (e) {
          if (e.message === 'CONFLICT' && attempt === 0) continue;
          throw e;
        }
      }
    } catch(e) {
      dirty = true;
      const message = (e instanceof TypeError) ? '连接 GitHub 失败，网络恢复后重试' : (e.message || '同步暂时失败');
      setStatus('同步失败 · 本机已保留（' + message + '）');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => sync(true), retryDelay);
      retryDelay = Math.min(300000, retryDelay * 2);
    } finally {
      inFlight = false;
      if (dirty && token) {
        clearTimeout(timer);
        timer = setTimeout(() => sync(false), 9000);
      }
    }
  }
  function schedule() {
    if (!token) {setStatus('仅本机保存（尚未开启云同步）'); return;}
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => sync(false), 6000);
    setStatus('本机已保存 · 等待自动同步');
  }
  function storeToken(value, remember) {
    token = value.trim();
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
      if (remember) localStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.setItem(TOKEN_KEY, token);
    } catch {}
  }
  document.addEventListener('click', e => {
    const button = e.target.closest('[data-cloud-action]');
    if (!button) return;
    const act = button.getAttribute('data-cloud-action');
    if (act === 'connect') {
      const input = document.getElementById('ciya-github-pat');
      const value = input && input.value.trim();
      if (!value) { setStatus('请先填写你自己的 GitHub 访问令牌'); return; }
      storeToken(value, !!document.getElementById('ciya-gh-remember')?.checked);
      if (input) input.value = '';
      api.render();
      sync(true);
    } else if (act === 'sync') {
      clearTimeout(timer);
      sync(true);
    } else if (act === 'disconnect') {
      token = '';
      try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch {}
      clearTimeout(timer); clearTimeout(retryTimer);
      setStatus('仅本机保存 · 云端连接已断开');
      api.render();
    }
  });
  window.addEventListener('ciya:progress-changed', e => {
    if (KEYS.includes(e.detail?.key)) schedule();
  });
  document.addEventListener('change', e => {
    if (e.target?.id === 'sprint-intensity') schedule();
  });
  window.addEventListener('online', () => { if(token) sync(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token && dirty) sync(true);
    if (document.visibilityState === 'hidden' && token && dirty) sync(true);
  });
  window.ciyaCloud = {panel, sync, status: () => status};
  api.render();
  if (token) sync(true);
})();