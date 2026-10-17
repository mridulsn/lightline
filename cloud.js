/* lightline cloud: optional log in (Google or Discord) and a backup of your progress, ported from Ruledrift's cloud.js.

   - The game never needs this. Signed out, offline or with the server down, play goes on and this device's storage
     stays the source of truth.
   - No SDK. Firebase Auth and Firestore are plain HTTPS, so this is fetch calls only.
   - The sign-in server (auth.mridulsaravanan.com) checks Google's or Discord's answer and hands back a Firebase
     custom token, which is traded here for a Firebase session.
   - A failed read of the backup is never treated as "no backup": the caller must not write after one. */
(function (root) {
  'use strict';

  var API = /(^|\.)mridulsaravanan\.com$/.test(location.hostname) ? 'https://auth.mridulsaravanan.com' : '';
  var APP = 'lightline';
  var SESSION_KEY = 'lightline.session', LAST_SYNC_KEY = 'lightline.lastSync', QUEUE_KEY = 'lightline.pendingSync';
  var STATE_KEY = 'lightline.signInState';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) { /* storage off */ } }

  // ---------- server settings, asked once per visit (and again after a failure) ----------
  var settingsLoad = null;
  function settings() {
    if (!settingsLoad) {
      var ask = fetch(API + '/api/config?app=' + APP, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
      var giveUp = new Promise(function (res) { setTimeout(function () { res(null); }, 5000); });
      settingsLoad = Promise.race([ask, giveUp]);
      settingsLoad.then(function (s) { if (!s) settingsLoad = null; });
    }
    return settingsLoad;
  }
  function endpoints() {
    return settings().then(function (s) {
      if (!s || !s.cloud || !s.apiKey || !s.projectId) return null;
      return {
        auth: s.authHost ? s.authHost + '/' : 'https://',
        firestore: s.fsHost || 'https://firestore.googleapis.com',
        apiKey: s.apiKey, projectId: s.projectId, googleClientId: s.googleClientId || '',
        providers: s.providers || {}
      };
    });
  }

  // ---------- session ----------
  function readSession() {
    var raw = lsGet(SESSION_KEY);
    try { var s = raw ? JSON.parse(raw) : null; return s && s.user && s.user.id ? s : null; } catch (e) { return null; }
  }
  function writeSession(s) { lsSet(SESSION_KEY, s ? JSON.stringify(s) : null); return s; }
  function currentUser() { var s = readSession(); return s ? s.user : null; }
  function lastSyncedAt() { return Number(lsGet(LAST_SYNC_KEY)) || 0; }
  function markSynced() { lsSet(LAST_SYNC_KEY, String(Date.now())); }
  function queueSync() { lsSet(QUEUE_KEY, '1'); }
  function hasQueued() { return lsGet(QUEUE_KEY) === '1'; }

  // read the uid and expiry out of a Firebase ID token (not trusted for anything else)
  function tokenClaims(idToken) {
    try {
      var body = String(idToken).split('.')[1];
      var c = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
      return { uid: c.user_id || c.sub || '', exp: Number(c.exp) || 0 };
    } catch (e) { return { uid: '', exp: 0 }; }
  }

  var MESSAGES = {
    state_mismatch: 'That sign-in did not start in this browser tab, so it was refused. Please try again.',
    verify_failed: 'The sign-in could not be confirmed. Please try again.',
    no_token: 'The sign-in server sent nothing back. Please try again.',
    network: 'Could not reach the sign-in server. Check your connection and try again.',
    off: 'Logging in is not available right now. Your progress is still saved on this device.',
    google_refused: 'Google sign-in was refused. Nothing was changed.'
  };
  function message(code) { return MESSAGES[code] || String(code || ''); }

  // trade the sign-in server's custom token for a Firebase session
  function sessionFromCustomToken(token, who) {
    return endpoints().then(function (ep) {
      if (!ep) return { error: 'off' };
      return fetch(ep.auth + 'identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + encodeURIComponent(ep.apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, returnSecureToken: true })
      }).then(function (res) {
        if (!res.ok) return { error: 'verify_failed' };
        return res.json().then(function (j) {
          var uid = tokenClaims(j.idToken).uid;
          if (!j.idToken || !uid) return { error: 'verify_failed' };
          return { session: writeSession({
            access_token: j.idToken, refresh_token: j.refreshToken || null,
            expires_at: Date.now() + (Number(j.expiresIn) || 3600) * 1000,
            user: { id: uid, name: who.name || (who.email || '').split('@')[0] || 'Player', email: who.email || '', provider: who.provider || '' }
          }) };
        });
      });
    }).catch(function () { return { error: 'network' }; });
  }

  // ---------- Discord: a full-page trip to the sign-in server and back ----------
  function randomState() {
    var a = new Uint8Array(16), s = '';
    crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
  }
  function startDiscord() {
    var state = randomState();
    try { window.sessionStorage.setItem(STATE_KEY, state); } catch (e) { /* the check below will then refuse */ }
    location.href = API + '/api/auth/discord?app=' + APP + '&cs=' + state;
  }
  function hasSignInHash(h) { return /[#&](fp-auth|fp-auth-error)=/.test(String(h || '')); }
  /* The result comes back in the #fragment. It is read and scrubbed at once: a token left in the address bar ends up
     in history, screenshots and shared links. Resolves to {session} or {error} or null (nothing to do). */
  function consumeRedirect() {
    if (!hasSignInHash(location.hash)) return Promise.resolve(null);
    var p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    var expected = null;
    try { expected = window.sessionStorage.getItem(STATE_KEY); window.sessionStorage.removeItem(STATE_KEY); } catch (e) { expected = null; }
    var err = p.get('fp-auth-error');
    if (err) return Promise.resolve(err === 'Sign-in was cancelled.' ? null : { error: err });
    if (!expected || p.get('cs') !== expected) return Promise.resolve({ error: 'state_mismatch' });
    var token = p.get('fp-auth');
    if (!token) return Promise.resolve({ error: 'no_token' });
    return sessionFromCustomToken(token, { provider: p.get('p') || 'discord', name: p.get('n') || '', email: p.get('e') || '' });
  }

  // ---------- Google: Google's own button (Google Identity Services), loaded only when the log in pop-up opens ----------
  var gisLoad = null;
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve(window.google.accounts.id);
    if (gisLoad) return gisLoad;
    gisLoad = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = GIS_SRC; el.async = true; el.defer = true;
      el.onload = function () { if (window.google && window.google.accounts && window.google.accounts.id) resolve(window.google.accounts.id); else reject(new Error('gsi empty')); };
      el.onerror = function () { reject(new Error('gsi blocked')); };
      document.head.appendChild(el);
    });
    gisLoad.catch(function () { gisLoad = null; });
    return gisLoad;
  }
  function signInWithGoogleCredential(credential) {
    return fetch(API + '/api/auth/google?app=' + APP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: credential })
    }).then(function (res) {
      if (!res.ok) return { error: 'google_refused' };
      return res.json().then(function (j) {
        if (!j || !j.token) return { error: 'google_refused' };
        return sessionFromCustomToken(j.token, { provider: 'google', name: j.name || '', email: j.email || '' });
      });
    }).catch(function () { return { error: 'network' }; });
  }
  // render Google's button into el; onDone gets {session} or {error}. Rejects if Google's script cannot load.
  function mountGoogle(el, width, onDone) {
    return Promise.all([loadGis(), endpoints()]).then(function (r) {
      var id = r[0], ep = r[1];
      if (!ep || !ep.googleClientId) throw new Error('google off');
      id.initialize({
        client_id: ep.googleClientId, auto_select: false,
        callback: function (resp) { (resp && resp.credential ? signInWithGoogleCredential(resp.credential) : Promise.resolve({ error: 'google_refused' })).then(onDone); }
      });
      el.textContent = '';
      id.renderButton(el, { type: 'standard', theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'left',
        width: Math.max(200, Math.min(400, Math.round(width || 300))) });
    });
  }
  // which providers the server really has switched on: {google, discord}, or null if it cannot be reached
  function providers() {
    return endpoints().then(function (ep) {
      if (!ep) return settings().then(function (s) { return s ? { google: false, discord: false } : null; });
      return { google: !!ep.providers.google && !!ep.googleClientId, discord: !!ep.providers.discord };
    });
  }

  // ---------- tokens ----------
  function validToken() {
    var s = readSession();
    if (!s) return Promise.resolve(null);
    if (s.expires_at && Date.now() < s.expires_at - 60000) return Promise.resolve(s.access_token);
    if (!s.refresh_token) return Promise.resolve(null);
    return endpoints().then(function (ep) {
      if (!ep) return null;
      return fetch(ep.auth + 'securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(ep.apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(s.refresh_token)
      }).then(function (res) {
        if (!res.ok) { if (res.status === 400 || res.status === 401 || res.status === 403) writeSession(null); return null; }
        return res.json().then(function (j) {
          s.access_token = j.id_token; s.refresh_token = j.refresh_token || s.refresh_token;
          s.expires_at = Date.now() + (Number(j.expires_in) || 3600) * 1000;
          writeSession(s);
          return j.id_token;
        });
      });
    }).catch(function () { return null; });
  }

  // ---------- the backup: one Firestore document, lightline/{uid}, holding the profile as a JSON string ----------
  function docUrl(ep, uid) {
    return ep.firestore + '/v1/projects/' + ep.projectId + '/databases/(default)/documents/lightline/' + encodeURIComponent(uid);
  }
  function authed(fn) {
    return Promise.all([validToken(), endpoints()]).then(function (r) {
      var user = currentUser();
      if (!r[0] || !r[1] || !user) return null;
      return fn(r[0], r[1], user);
    });
  }
  // {ok, data}: ok=false means the read failed and nothing may be written
  function pull() {
    return authed(function (token, ep, user) {
      return fetch(docUrl(ep, user.id), { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' }).then(function (res) {
        if (res.status !== 200) return Lightline.readPullResponse(res.status, null);
        return res.json().then(function (doc) { return Lightline.readPullResponse(200, doc); }, function () { return { ok: false, data: null }; });
      });
    }).then(function (r) { return r || { ok: false, data: null }; }, function () { return { ok: false, data: null }; });
  }
  function push(profile) {
    return authed(function (token, ep, user) {
      return fetch(docUrl(ep, user.id) + '?updateMask.fieldPaths=data&updateMask.fieldPaths=updatedAt', {
        method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { data: { stringValue: JSON.stringify(profile) }, updatedAt: { timestampValue: new Date().toISOString() } } })
      }).then(function (res) {
        if (res.ok) { lsSet(QUEUE_KEY, null); markSynced(); return true; }
        return false;
      });
    }).then(function (ok) { if (!ok) queueSync(); return !!ok; }, function () { queueSync(); return false; });
  }
  function deleteCloud() {
    return authed(function (token, ep, user) {
      return fetch(docUrl(ep, user.id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).then(function (res) {
        if (res.ok || res.status === 404) { lsSet(LAST_SYNC_KEY, null); lsSet(QUEUE_KEY, null); return true; }
        return false;
      });
    }).then(function (ok) { return !!ok; }, function () { return false; });
  }
  function signOut() { writeSession(null); lsSet(LAST_SYNC_KEY, null); lsSet(QUEUE_KEY, null); }

  root.LightlineCloud = {
    API: API, APP: APP, currentUser: currentUser, lastSyncedAt: lastSyncedAt, hasQueued: hasQueued, tokenClaims: tokenClaims,
    message: message, startDiscord: startDiscord, hasSignInHash: hasSignInHash, consumeRedirect: consumeRedirect,
    mountGoogle: mountGoogle, providers: providers, pull: pull, push: push, deleteCloud: deleteCloud, signOut: signOut
  };
})(this);
