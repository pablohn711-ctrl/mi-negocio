/* Conecta la app con Firebase: inicio de sesión con Google + Firestore.
   Si falta la configuración o no carga Firebase, la app sigue funcionando en local. */
import { firebaseConfig as cfg } from './firebase-config.js';
import { createSync } from './sync-core.js';

const SY = window.SY, APP = window.APP;
const V = '10.14.1', B = 'https://www.gstatic.com/firebasejs/' + V + '/';
const configured = !!(cfg && cfg.apiKey && cfg.projectId && !/PEGA/i.test(cfg.apiKey + cfg.projectId));
SY.cfg = configured;

function label() {
  if (!SY.user) return '';
  if (SY.status === 'connecting') return 'Conectando…';
  if (!navigator.onLine) return 'Sin conexión: los cambios se subirán al reconectar';
  if (SY.pending) return 'Subiendo cambios…';
  return '✓ Sincronizado';
}
SY.label = label;
const setStatus = (s, extra) => { SY.status = s; if (extra) Object.assign(SY, extra); APP.refresh(); };
window.addEventListener('online', () => APP.refresh());
window.addEventListener('offline', () => APP.refresh());

if (!configured) {
  setStatus('local');
} else {
  (async () => {
    let A, Au, Fs;
    try {
      [A, Au, Fs] = await Promise.all([import(B + 'firebase-app.js'), import(B + 'firebase-auth.js'), import(B + 'firebase-firestore.js')]);
    } catch (e) {
      setStatus('noload');
      return;
    }
    const app = A.initializeApp(cfg);
    const auth = Au.getAuth(app);
    let db;
    try {
      db = Fs.initializeFirestore(app, { localCache: Fs.persistentLocalCache({ tabManager: Fs.persistentMultipleTabManager() }) });
    } catch (e) { db = Fs.getFirestore(app); }
    let sync = null, uid = null;

    const backend = {
      set: (c, id, data) => Fs.setDoc(Fs.doc(db, 'usuarios', uid, c, id), data),
      listen: (c, cb, onErr) => Fs.onSnapshot(Fs.collection(db, 'usuarios', uid, c), snap => {
        cb(snap.docChanges().map(x => ({ id: x.doc.id, type: x.type, data: x.type === 'removed' ? null : x.doc.data() })),
          { fromCache: snap.metadata.fromCache, offline: !navigator.onLine, pending: snap.metadata.hasPendingWrites });
      }, onErr)
    };

    const stop = () => { if (sync) { sync.stop(); sync = null; } APP.onSave = null; };

    SY.login = async () => {
      SY.err = '';
      const provider = new Au.GoogleAuthProvider();
      try {
        await Au.signInWithPopup(auth, provider);
      } catch (e) {
        const code = e && e.code || '';
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
        if (code === 'auth/popup-blocked') { try { await Au.signInWithRedirect(auth, provider); return; } catch (e2) {} }
        SY.err = code === 'auth/unauthorized-domain'
          ? 'Este sitio no está autorizado en Firebase. Agrega "' + location.hostname + '" en Authentication → Configuración → Dominios autorizados.'
          : 'No se pudo iniciar sesión (' + (code || 'error') + ').';
        APP.refresh();
      }
    };
    SY.logout = async () => {
      stop();
      APP.reset();
      try { localStorage.removeItem('negocio_uid'); } catch (e) {}
      await Au.signOut(auth);
    };

    Au.onAuthStateChanged(auth, user => {
      stop();
      if (!user) { SY.user = null; SY.pending = false; setStatus('signedout'); return; }
      uid = user.uid;
      let last = null;
      try { last = localStorage.getItem('negocio_uid'); } catch (e) {}
      if (last && last !== uid) APP.reset();           // otra cuenta en este aparato: empezar limpio
      try { localStorage.setItem('negocio_uid', uid); } catch (e) {}
      SY.user = { uid, email: user.email || '', name: user.displayName || '' };
      setStatus('connecting');
      sync = createSync({
        getState: APP.getS,
        backend,
        onChange: () => { APP.persist(); APP.refresh(); },
        onStatus: st => { SY.pending = !!st.pending; setStatus(st.ready ? 'ok' : 'connecting'); },
        onError: e => { SY.err = 'Error de sincronización: ' + (e && (e.code || e.message) || e); APP.refresh(); }
      });
      APP.onSave = () => sync && sync.local();
      sync.start();
    });
  })();
}
