// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Replace the two placeholders with your Supabase project URL +
// publishable key (same ones you used in topbar.js/gym.html).
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://htazemqyxrjvwkhpggdj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_d9JQrKQutJKSN_dDSYNeBg_-WB1V6c1';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, lastSyncedJson = null;
    const dirtyKey = 'cloudsync:dirty:' + appKey;

    function emitStatus(status) {
      try { window.dispatchEvent(new CustomEvent('cloud-sync-status', { detail: status || {} })); } catch (e) {}
    }
    function markDirty() {
      try { localStorage.setItem(dirtyKey, new Date().toISOString()); } catch (e) {}
    }
    function clearDirty() {
      try { localStorage.removeItem(dirtyKey); } catch (e) {}
    }
    function isDirty() {
      try { return !!localStorage.getItem(dirtyKey); } catch (e) { return false; }
    }

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }
    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) { markDirty(); schedulePush(); } } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) { markDirty(); schedulePush(); } } catch (e) {}
    };
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) { try { origSet(k, incoming); changed = true; } catch (e) {} }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }
    async function pushNow(options) {
      if (!supa) return false;
      const state = collect();
      const json = JSON.stringify(state);
      const force = options && options.force;
      if (!force && json === lastSyncedJson) {
        clearDirty();
        return true;
      }
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) {
          lastSyncedJson = json;
          clearDirty();
          emitStatus({ appKey, state: 'pushed', at: new Date().toISOString() });
          return true;
        } else {
          emitStatus({ appKey, state: 'error', message: error.message || 'Sync failed' });
          return false;
        }
      } catch (e) {
        emitStatus({ appKey, state: 'error', message: e && e.message ? e.message : 'Sync failed' });
        return false;
      }
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }
    function flushOnUnload() {
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
        clearDirty();
      } catch (e) {}
    }
    async function pullNow() {
      if (!supa) return false;
      try {
        const { data, error } = await supa.from('app_state').select('data,updated_at').eq('key', appKey).maybeSingle();
        if (error) {
          emitStatus({ appKey, state: 'error', message: error.message || 'Sync failed' });
          return false;
        }
        if (data && data.data && Object.keys(data.data).length > 0) {
          const incoming = JSON.stringify(data.data);
          if (incoming !== lastSyncedJson) {
            lastSyncedJson = incoming;
            applyRemote(data.data);
            emitStatus({ appKey, state: 'pulled', at: data.updated_at || new Date().toISOString() });
          }
          return true;
        }
      } catch (e) {
        emitStatus({ appKey, state: 'error', message: e && e.message ? e.message : 'Sync failed' });
      }
      return false;
    }
    async function syncNow(options) {
      if (!supa) return false;
      if ((options && options.forcePush) || isDirty()) {
        return pushNow({ force: true });
      }
      return pullNow();
    }
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data,updated_at').eq('key', appKey).maybeSingle();
        if (isDirty()) {
          await pushNow();
        } else if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {}
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();
    window.cloudSyncNow = syncNow;
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('focus', () => { syncNow(); });
    window.addEventListener('online', () => { syncNow(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushOnUnload();
      else syncNow();
    });
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) schedulePush(); });
  };
})();
