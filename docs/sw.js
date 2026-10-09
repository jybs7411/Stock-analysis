// PentAnalyst 서비스 워커 — 앱 껍데기(HTML·CSS·아이콘·글꼴)만 저장한다. 시세·검색 같은 API 응답은 절대 저장하지 않는다(항상 최신).
// c66c01ae07 는 build.py 가 내용 해시로 바꿔 넣는다 (배포할 때마다 캐시가 새로 만들어짐).
const VERSION = 'c66c01ae07';
const SHELL = 'pa-shell-' + VERSION;
const RUNTIME = 'pa-runtime';
const PRECACHE = ['./', 'app.css', 'fa/css/all.min.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('pa-shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) return; // 프록시 API 는 건드리지 않는다
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') { // 화면(HTML): 인터넷이 되면 항상 최신, 안 되면 저장본
      e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put('./', copy)); return r; }).catch(() => caches.match('./')));
      return;
    }
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(req, copy)); } return r; })));
    return;
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) { // 글꼴: 저장본을 먼저 보여주고 뒤에서 갱신
    e.respondWith(caches.open(RUNTIME).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
  }
});
