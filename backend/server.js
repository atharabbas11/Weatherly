import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import webpush from 'web-push';
import axios from 'axios';
import helmet from 'helmet';
import { MongoClient } from 'mongodb';
import weatherRouter from './weatherRoutes.js';

dotenv.config();

const app = express();
app.use(helmet()); // Security headers

// MongoDB connection setup
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const client = new MongoClient(mongoUri);
let db, subscriptionsCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('weatherdb');
    subscriptionsCollection = db.collection('subscriptions');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
}

// Initialize database connection
connectDB();

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000'

// Enhanced CORS configuration
app.use(cors({
  origin: frontendUrl,
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true
}));

app.use(express.json());

// VAPID keys setup
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (!vapidPublicKey || !vapidPrivateKey) {
  console.error('Missing VAPID keys in environment variables');
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:weather@example.com",
  vapidPublicKey,
  vapidPrivateKey
);

// Weather API Routes
app.use("/api/weather", weatherRouter);

// Push Notification Endpoints
app.post("/api/subscribe", async (req, res) => {
  try {
    const { subscription, location } = req.body;
    
    if (!subscription?.endpoint || !subscription?.keys) {
      return res.status(400).json({ error: "Invalid subscription format" });
    }

    const normalizedLocation = location.replace(/\s*,\s*/g, ',');
    const now = new Date();

    const subDoc = {
      ...subscription,
      createdAt: now,
      lastNotified: null,
      location: normalizedLocation,
      nextNotificationTime: calculateNextNotificationTime(now)
    };

    // Upsert subscription
    await subscriptionsCollection.updateOne(
      { endpoint: subscription.endpoint },
      { $set: subDoc },
      { upsert: true }
    );

    await sendWeatherUpdateForSubscription(subscription, normalizedLocation);
    
    res.status(201).json({ success: true });
  } catch (err) {
    console.error("Subscription error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/subscribe", async (req, res) => {
  try {
    const { endpoint } = req.body;
    const result = await subscriptionsCollection.deleteOne({ endpoint });
    if (result.deletedCount > 0) {
      return res.status(200).json({ success: true });
    }
    return res.status(404).json({ error: "Subscription not found" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/subscribe/check', async (req, res) => {
  try {
    const { endpoint } = req.body;
    const exists = await subscriptionsCollection.findOne({ endpoint });
    if (exists) {
      return res.status(200).json({
        subscribed: true,
        location: exists.location
      });
    }
    res.status(exists ? 200 : 404).end();
  } catch (err) {
    console.error('Subscription check error:', err);
    res.status(500).end();
  }
});

// Calculate next notification time (every 2 hours from now)
function calculateNextNotificationTime(now) {
  const next = new Date(now);
  // Round up to next even hour
  next.setHours(next.getHours() + (2 - (next.getHours() % 1)), 0, 0, 0);
  return next;
}

// Send weather update for specific subscription
async function sendWeatherUpdateForSubscription(subscription, location) {
  try {
    const weatherData = await fetchWeatherData(location);
    const now = new Date();
    const currentHour = now.getHours();
    const nextHour = (currentHour + 1) % 24;

    const currentData = weatherData.forecast.forecastday[0].hour[currentHour];
    const nextData = weatherData.forecast.forecastday[0].hour[nextHour];

    if (!currentData || !nextData) {
      throw new Error('Missing hourly data');
    }

    await sendLocationNotifications(location, currentData, nextData);
    
  } catch (err) {
    console.error(`Failed to send update for ${location}:`, err);
    await sendNotification(subscription, {
      title: "Weather Update Failed",
      body: `Couldn't get latest weather for ${location.split(',')[0]}`,
      icon: '/icons/error.png'
    });
  }
}

async function getAllSubscriptions() {
  try {
    return await subscriptionsCollection.find({}).toArray();
  } catch (err) {
    console.error('Error fetching subscriptions:', err);
    return [];
  }
}

async function fetchWeatherData(location) {
  try {
    const [city, region, country] = location.split(',');
    const apiUrl = `${backendUrl}/api/weather/city`;
    
    const response = await axios.get(apiUrl, {
      params: { 
        name: city.trim(),
        region: region.trim(),
        country: country.trim()
      }
    });
    
    return response.data;
  } catch (err) {
    console.error('Weather API Error:', err.message);
    throw err;
  }
}

async function sendNotification(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await subscriptionsCollection.deleteOne({ endpoint: subscription.endpoint });
    }
    return false;
  }
}

async function sendLocationNotifications(location, currentHourData, nextHourData) {
  const currentTime = new Date(currentHourData.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  const nextTime = new Date(nextHourData.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

  // Find subscribers for this location
  const locationSubscribers = await subscriptionsCollection.find({ location }).toArray();

  if (locationSubscribers.length === 0) {
    // console.log(`No active subscribers for ${location}`);
    return;
  }

  // console.log(`Sending notifications to ${locationSubscribers.length} subscribers for ${location}`);

  // Current conditions notification
  const currentNotification = {
    title: `⏱️ ${currentTime} Weather (${location.split(',')[0]})`,
    body: `${currentHourData.temp_c}°C, ${currentHourData.condition.text}` +
          `\n☁️ Cloud Cover: ${currentHourData.cloud}%` +
          `\n☔ Rain chance: ${currentHourData.chance_of_rain}%` +
          `\n🌬️ Wind: ${currentHourData.wind_kph} kph ${currentHourData.wind_dir}` +
          `\n☀️ UV Index: ${currentHourData.uv}%`,
    icon: currentHourData.condition.icon,
    data: {
      type: 'current_weather',
      location: location,
      time: currentHourData.time
    }
  };

  // Forecast notification
  const forecastNotification = {
    title: `🔮 ${nextTime} Forecast (${location.split(',')[0]})`,
    body: `Expected: ${nextHourData.temp_c}°C, ${nextHourData.condition.text}` +
          `\n☁️ Cloud Cover: ${nextHourData.cloud}%` +
          `\n☔ Rain chance: ${nextHourData.chance_of_rain}%` +
          `\n🌬️ Wind: ${nextHourData.wind_kph} kph ${nextHourData.wind_dir}` +
          `\n\☀️ UV Index: ${nextHourData.uv}%`,
    icon: nextHourData.condition.icon,
    data: {
      type: 'forecast',
      location: location,
      time: nextHourData.time
    }
  };

  // Send both notifications
  await sendBatchNotifications(locationSubscribers, currentNotification);
  await sendBatchNotifications(locationSubscribers, forecastNotification);
  
  // Update last notified time
  const now = new Date();
  await subscriptionsCollection.updateMany(
    { location },
    { $set: { lastNotified: now, nextNotificationTime: calculateNextNotificationTime(now) } }
  );
}

async function sendBatchNotifications(subscribers, payload) {
  if (!subscribers || subscribers.length === 0) return;

  // console.log(`Preparing to send "${payload.title}" to ${subscribers.length} subscribers`);
  
  const results = await Promise.allSettled(
    subscribers.map(sub => {
      return webpush.sendNotification(sub, JSON.stringify(payload))
        .catch(async err => {
          console.error(`Failed to send to ${sub.endpoint.substring(0, 30)}...:`, err.message);
          if (err.statusCode === 410 || err.statusCode === 404) {
            await subscriptionsCollection.deleteOne({ endpoint: sub.endpoint });
          }
          throw err;
        });
    })
  );

  const successful = results.filter(r => r.status === 'fulfilled').length;
  // console.log(`Sent ${successful}/${subscribers.length} notifications successfully`);
  return results;
}

// scheduler with timezone awareness
function scheduleTwoHourWeatherUpdates() {
  // Calculate time until next even hour (2pm, 4pm, etc.)
  const now = new Date();
  const currentHour = now.getHours();
  const minutesToNextUpdate = (120 - (currentHour % 2 * 60 + now.getMinutes())) % 120;

  // Initial run
  setTimeout(() => {
    sendTwoHourWeatherUpdates();
    // Then run every 2 hours
    setInterval(sendTwoHourWeatherUpdates, 2 * 60 * 60 * 1000);
  }, minutesToNextUpdate * 60 * 1000);

  // console.log(`First update in ${minutesToNextUpdate} minutes`);
}

async function sendTwoHourWeatherUpdates() {
  try {
    // console.log('\n=== Starting weather update ===', new Date().toISOString());
    const allSubs = await getAllSubscriptions();

    if (allSubs.length === 0) {
      // console.log('No subscribers - skipping');
      return;
    }

    // Group subscribers by location to minimize API calls
    const locationsMap = new Map();
    allSubs.forEach(sub => {
      if (!locationsMap.has(sub.location)) {
        locationsMap.set(sub.location, []);
      }
      locationsMap.get(sub.location).push(sub);
    });

    // console.log(`Processing ${locationsMap.size} unique locations`);

    // Process each location
    for (const [location, subscribers] of locationsMap) {
      try {
        // console.log(`🌤️ Processing location: ${location}`);
        const weatherData = await fetchWeatherData(location);
        const now = new Date();
        const currentHour = now.getHours();
        const nextHour = (currentHour + 2) % 24;

        // Get weather data for current and next hour
        const currentData = weatherData.forecast.forecastday[0].hour[currentHour];
        const nextData = weatherData.forecast.forecastday[0].hour[nextHour];

        if (!currentData || !nextData) {
          throw new Error('Missing hourly data');
        }

        await sendLocationNotifications(location, currentData, nextData);
        
      } catch (err) {
        console.error(`❌ Failed to process ${location}:`, err.message);
        
        // Send error notification to all subscribers of this location
        await sendBatchNotifications(subscribers, {
          title: "Weather Update Failed",
          body: `We couldn't get the latest weather for ${location.split(',')[0]}`,
          icon: '/icons/error.png'
        });
      }
    }
  } catch (err) {
    console.error('‼️ Critical scheduler error:', err);
  }
}

// Start the scheduler
scheduleTwoHourWeatherUpdates();

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  // console.log(`Server running on port ${PORT}`);
  // console.log(`VAPID Public Key: ${vapidPublicKey}`);
});