require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- IN-MEMORY STATE (Exact Match to Local PC Structure) ---
let dbState = {};
let tripSummary = {};

// --- MONGODB CONNECTION ---
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log("[MONGODB] Connected to MongoDB Atlas successfully!");
    await loadStateFromDB();
  })
  .catch(err => console.error("[MONGODB] Connection error:", err));

// --- MONGOOSE SCHEMAS ---
const telemetrySchema = new mongoose.Schema({
  pbs: String,
  sub: String,
  dev: String,
  key: String, // 'power', 'status', or feeder name (e.g., NG3_1A)
  data: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now }
});
const TelemetryData = mongoose.model('TelemetryData', telemetrySchema);

const tripSummarySchema = new mongoose.Schema({
  feederKey: { type: String, unique: true },
  pbs: String,
  sub: String,
  dev: String,
  relay: String,
  thisMonthTrips: { type: Number, default: 0 },
  lastMonthTrips: { type: Number, default: 0 },
  lastTripTime: { type: String, default: "--" },
  lastOnTime: { type: String, default: "--" },
  faultReason: { type: String, default: "" }
});
const TripSummary = mongoose.model('TripSummary', tripSummarySchema);

// Load state from MongoDB into local nested structure on startup
async function loadStateFromDB() {
  try {
    const allTelemetry = await TelemetryData.find({});
    allTelemetry.forEach(item => {
      const { pbs, sub, dev, key, data, timestamp } = item;
      if (!dbState[pbs]) dbState[pbs] = {};
      if (!dbState[pbs][sub]) dbState[pbs][sub] = {};
      if (!dbState[pbs][sub][dev]) dbState[pbs][sub][dev] = {};
      
      dbState[pbs][sub][dev][key] = data;
      if (key === 'power' || key !== 'status') {
        dbState[pbs][sub][dev]['lastHeartbeat'] = Math.floor(new Date(timestamp).getTime() / 1000);
      }
    });

    const allTrips = await TripSummary.find({});
    allTrips.forEach(t => {
      tripSummary[t.feederKey] = {
        thisMonthTrips: t.thisMonthTrips,
        lastMonthTrips: t.lastMonthTrips,
        lastTripTime: t.lastTripTime,
        lastOnTime: t.lastOnTime,
        faultReason: t.faultReason
      };
    });
    console.log(`[STARTUP] Loaded nested state for ${Object.keys(dbState).length} PBS from MongoDB.`);
  } catch (err) {
    console.error("[STARTUP ERROR] Failed to load state from DB:", err);
  }
}

function setDeepValue(obj, pathArray, value) {
  let current = obj;
  for (let i = 0; i < pathArray.length - 1; i++) {
    const key = pathArray[i];
    if (!current[key] || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  const lastKey = pathArray[pathArray.length - 1];
  current[lastKey] = value;
}

// --- REST API ENDPOINTS ---

// 1. ESP32 Telemetry Ingestion Endpoint
app.post('/api/telemetry', async (req, res) => {
  try {
    const { pbs, sub, dev, feeder, status, power } = req.body;
    if (!pbs || !sub || !dev || !feeder) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    let payloadToStore;
    if (feeder === 'power') {
      payloadToStore = power; // Station-level power object
    } else {
      payloadToStore = { status, power }; // Feeder status + power object
    }

    // Save to MongoDB
    await TelemetryData.findOneAndUpdate(
      { pbs, sub, dev, key: feeder },
      { data: payloadToStore, timestamp: new Date() },
      { upsert: true, new: true }
    );

    // Replicate exact local in-memory structure
    setDeepValue(dbState, [pbs, sub, dev, feeder], payloadToStore);
    setDeepValue(dbState, [pbs, sub, dev, 'lastHeartbeat'], Math.floor(Date.now() / 1000));

    // Broadcast live update to dashboard via Socket.io
    io.emit('db_update', { fullDb: dbState });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("[TELEMETRY ERROR]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Dashboard Data Feed for ALL_PBS.html
app.get('/api/dashboardData', async (req, res) => {
  try {
    const tripList = [];
    const faultList = [];

    for (let pbs in dbState) {
      for (let sub in dbState[pbs]) {
        for (let dev in dbState[pbs][sub]) {
          for (let relay in dbState[pbs][sub][dev]) {
            if (["power", "deviceStatus", "lastHeartbeat"].includes(relay)) continue;

            const feederKey = `${pbs}_${sub}_${dev}_${relay}`;
            const summary = tripSummary[feederKey] || { thisMonthTrips: 0, lastMonthTrips: 0, lastTripTime: "--", lastOnTime: "--", faultReason: "" };

            tripList.push({
              pbs, sub, dev, relay, feeder: relay,
              thisMonthTrips: summary.thisMonthTrips,
              lastMonthTrips: summary.lastMonthTrips,
              lastTripTime: summary.lastTripTime,
              lastOnTime: summary.lastOnTime,
              area: "N/A"
            });

            faultList.push({ pbs, sub, dev, relay, feeder: relay, fault: summary.faultReason || "" });
          }
        }
      }
    }

    res.json({ trip: tripList, fault: faultList, reliability: [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Save Fault / Maintenance Reason
app.post('/api/saveFault', async (req, res) => {
  try {
    const { pbs, sub, dev, relay, message, status } = req.body;
    const feederKey = `${pbs}_${sub}_${dev}_${relay}`;

    let summary = await TripSummary.findOne({ feederKey });
    if (!summary) {
      summary = new TripSummary({ feederKey, pbs, sub, dev, relay });
    }

    if (status === "ON" || message === "CLEAR") {
      summary.faultReason = "";
    } else if (message) {
      const formattedTime = new Date().toISOString();
      const newEntry = `[${formattedTime}] ${message}`;
      summary.faultReason = summary.faultReason ? `${summary.faultReason}\n${newEntry}` : newEntry;
    }

    await summary.save();
    tripSummary[feederKey] = {
      thisMonthTrips: summary.thisMonthTrips,
      lastMonthTrips: summary.lastMonthTrips,
      lastTripTime: summary.lastTripTime,
      lastOnTime: summary.lastOnTime,
      faultReason: summary.faultReason
    };

    res.json({ success: true, faultReason: summary.faultReason });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
  socket.emit('initial_state', dbState);
});

// --- START SERVER ---
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` BREB Cloud Telemetry Server Active on Port ${PORT} `);
  console.log(`===================================================`);
});
