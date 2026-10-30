// Stream Saver Service Worker for zero-OOM download streaming on browsers without File System Access API
const map = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'PORT_INITIALIZE') {
    const port = event.ports[0];
    const downloadUrl = data.url;
    const filename = data.filename || 'converted.mp4';
    const size = data.size;

    const stream = new ReadableStream({
      start(controller) {
        port.onmessage = (e) => {
          if (e.data === 'end') {
            controller.close();
            port.close();
          } else if (e.data === 'abort') {
            controller.error(new Error('Download aborted'));
            port.close();
          } else {
            controller.enqueue(new Uint8Array(e.data));
          }
        };
      },
      cancel() {
        port.postMessage('abort');
      }
    });

    const headers = [
      ['Content-Type', 'video/mp4'],
      ['Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`]
    ];
    if (size) {
      headers.push(['Content-Length', size.toString()]);
    }

    map.set(downloadUrl, { stream, headers });
    port.postMessage({ type: 'READY' });
  }
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (map.has(url)) {
    const record = map.get(url);
    map.delete(url);
    event.respondWith(
      new Response(record.stream, {
        headers: new Headers(record.headers)
      })
    );
  }
});
