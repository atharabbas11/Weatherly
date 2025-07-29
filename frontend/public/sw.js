// Add this to handle periodic background sync
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'weather-update') {
    console.log('Periodic sync received');
    event.waitUntil(
      fetch('http://localhost:5000/api/force-update')
        .then(response => response.json())
        .then(data => console.log('Background update completed', data))
    );
  }
});

// Enhanced push handler
self.addEventListener('push', (event) => {
  const payload = event.data?.json() || {
    title: 'Weather Update',
    body: 'New weather information available',
    icon: '/icons/weather.png'
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: '/icons/badge.png',
      data: payload.data,
      vibrate: [200, 100, 200],
      actions: [
        { action: 'view', title: 'View' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'view') {
    const url = event.notification.data?.url || '/';
    event.waitUntil(clients.openWindow(url));
  }
});