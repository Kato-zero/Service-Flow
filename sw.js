// Service Worker for ServiceFlow Business Manager
const CACHE_NAME = 'serviceflow-v1';
const OFFLINE_CACHE = 'serviceflow-offline-v1';

// Files to cache for offline access
const urlsToCache = [
  '/',
  '/index.html',
  '/reports.html',
  '/manifest.json',
  '/offline.html'  // Optional: create a simple offline page
];

// Install event - cache core files
self.addEventListener('install', event => {
  console.log('Service Worker installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Caching core files');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        // Force the waiting service worker to become active
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('Service Worker activating...');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && cacheName !== OFFLINE_CACHE) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Take control of all clients immediately
      return self.clients.claim();
    })
  );
});

// Fetch event - serve from cache first, then network
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  
  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }
  
  // Handle API requests differently (don't cache them)
  if (requestUrl.pathname.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(error => {
        console.log('API request failed while offline:', error);
        return new Response(
          JSON.stringify({ error: 'You are offline. Please check your connection.' }),
          { 
            status: 503, 
            headers: { 'Content-Type': 'application/json' } 
          }
        );
      })
    );
    return;
  }
  
  // For HTML pages - network first with cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache the fresh version
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // If network fails, try cache
          return caches.match(event.request)
            .then(cachedResponse => {
              if (cachedResponse) {
                return cachedResponse;
              }
              // If no cache, show offline page
              return caches.match('/offline.html');
            });
        })
    );
    return;
  }
  
  // For static assets - cache first, then network
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          // Return cached version
          return cachedResponse;
        }
        
        // Not in cache, fetch from network
        return fetch(event.request)
          .then(response => {
            // Check if valid response
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // Cache the new response
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
            
            return response;
          })
          .catch(error => {
            console.log('Fetch failed:', error);
            // Return a simple offline response for images
            if (event.request.url.match(/\.(jpg|jpeg|png|gif|svg)$/)) {
              return new Response(
                '<svg role="img" aria-label="Offline" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#f1f5f9"/><text x="200" y="150" text-anchor="middle" font-family="Arial" font-size="24" fill="#64748b">📴 Offline</text></svg>',
                { headers: { 'Content-Type': 'image/svg+xml' } }
              );
            }
            
            // Return offline page for navigation requests
            if (event.request.mode === 'navigate') {
              return caches.match('/offline.html');
            }
            
            return new Response('Offline content not available', {
              status: 503,
              statusText: 'Service Unavailable'
            });
          });
      })
  );
});

// Handle background sync for offline appointments
self.addEventListener('sync', event => {
  console.log('Background sync event:', event.tag);
  
  if (event.tag === 'sync-appointments') {
    event.waitUntil(syncOfflineAppointments());
  }
});

// Function to sync offline appointments when back online
async function syncOfflineAppointments() {
  console.log('Syncing offline appointments...');
  
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const requests = await cache.keys();
    
    for (const request of requests) {
      const response = await cache.match(request);
      if (response) {
        const appointment = await response.json();
        
        // Try to send to server (if you have a backend)
        // For now, just add to localStorage when back online
        const existingData = localStorage.getItem('serviceflow_appointments');
        const appointments = existingData ? JSON.parse(existingData) : [];
        
        // Check if already exists
        const exists = appointments.some(a => a.id === appointment.id);
        if (!exists) {
          appointments.push(appointment);
          localStorage.setItem('serviceflow_appointments', JSON.stringify(appointments));
          console.log('Synced appointment:', appointment);
        }
        
        // Remove from offline cache after syncing
        await cache.delete(request);
      }
    }
    
    // Notify all clients that sync completed
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'SYNC_COMPLETE',
        message: 'Offline appointments have been synced'
      });
    });
    
    console.log('Offline appointments synced successfully');
  } catch (error) {
    console.error('Error syncing offline appointments:', error);
  }
}

// Handle push notifications (optional)
self.addEventListener('push', event => {
  console.log('Push notification received:', event);
  
  let data = {
    title: 'ServiceFlow',
    body: 'You have a new appointment update',
    icon: '/icon-192.png'
  };
  
  if (event.data) {
    try {
      data = JSON.parse(event.data.text());
    } catch (error) {
      data.body = event.data.text();
    }
  }
  
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      data: {
        url: data.url || '/'
      }
    })
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
  console.log('Notification clicked:', event);
  
  event.notification.close();
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // Open the app if it exists, otherwise open new window
        for (let client of windowClients) {
          if (client.url === event.notification.data.url && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(event.notification.data.url || '/');
        }
      })
  );
});

// Message handling from main thread
self.addEventListener('message', event => {
  console.log('Message received from main thread:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CACHE_APPOINTMENT') {
    // Store appointment for offline sync
    event.waitUntil(
      caches.open(OFFLINE_CACHE).then(cache => {
        const appointment = event.data.appointment;
        const request = new Request(`/offline-appointment-${appointment.id}.json`);
        const response = new Response(JSON.stringify(appointment), {
          headers: { 'Content-Type': 'application/json' }
        });
        return cache.put(request, response);
      })
    );
  }
});

// Periodic background sync for data updates (optional)
self.addEventListener('periodicsync', event => {
  console.log('Periodic sync event:', event.tag);
  
  if (event.tag === 'update-data') {
    event.waitUntil(updateDataInBackground());
  }
});

async function updateDataInBackground() {
  console.log('Updating data in background...');
  // You can add logic to fetch latest data from server here
  // For now, just log it
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch('/index.html');
  if (response.ok) {
    await cache.put('/index.html', response);
  }
}
