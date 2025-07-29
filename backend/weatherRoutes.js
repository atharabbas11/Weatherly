import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
// console.log(WEATHER_API_KEY);

// GET weather by city query
router.get("/search/:query", async (req, res) => {
  const { query } = req.params;
  try {
    const response = await axios.get(`http://api.weatherapi.com/v1/search.json?key=${WEATHER_API_KEY}&q=${query}`);
    res.json(response.data);
  } catch {
    res.status(500).json({ error: "Failed to fetch location suggestions" });
  }
});

// GET weather by city
router.get('/city', async (req, res) => {
  try {
    const { name, region, country } = req.query;

    // Build a full location query string for accuracy
    const locationQuery = [name, region, country].filter(Boolean).join(', ');

    const response = await axios.get(`https://api.weatherapi.com/v1/forecast.json`, {
      params: {
        key: WEATHER_API_KEY,
        q: locationQuery,
        days: 3,
        aqi: "yes",
        alerts: "yes"
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error("City fetch error:", error.response?.data || error.message);
    res.status(500).json({ error: 'City weather fetch failed' });
  }
});

// GET weather by coordinates
router.get('/coords', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const response = await axios.get(
      `https://api.weatherapi.com/v1/forecast.json`,
      {
        params: {
          key: WEATHER_API_KEY,
          q: `${lat},${lon}`,
          days: 3,
          aqi: "yes",
          alerts: "yes"
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error("Coords fetch error:", error.response?.data || error.message);
    res.status(500).json({ error: 'Coordinates weather fetch failed' });
  }
});

export default router;
