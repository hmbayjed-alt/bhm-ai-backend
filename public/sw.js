// BHM AI — Minimal service worker (PWA যোগ্যতার জন্য দরকার)
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

// শুধু পাস-থ্রু ফেচ — অফলাইন ক্যাশিং এখনো যোগ করা হয়নি
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
