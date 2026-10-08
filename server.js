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

// --- MONGODB CONNECTION ---
mongoose.connect(MONGO_URI)
  .then(() => console.log("[MONGODB] Connected to MongoDB Atlas successfully!"))
  .catch(err => console.error("[MONGODB] Connection error:", err));

// --- MONGOOSE SCHEMAS ---
const telemetrySchema = new mongoose.Schema({
  pbs: { type: String, required: true },
  sub: { type: String, required: true },
  dev: { type: String, required: true },
  feeder: { type: String, required: true },
  status: { type: String, default: "OFF" },
  power: {
    V: Number,
    I: Number,
    P: Number,
    PF: Number,
    F: Number
  },
  timestamp: { type: Date, default: Date.now }
});

const TelemetryData = mongoose.model('TelemetryData', telemetrySchema);

const tripSummarySchema = new mongoose.Schema({
  feederKey: { type: String, unique: true },
  thisMonthTrips: { type: Number, default: 0 },
  lastMonthTrips: { type: Number, default: 0 },
  lastTripTime: { type: String, default: "--" },
  lastOnTime: { type: String, default: "--" },
  faultReason: { type: String, default: "" }
});

const TripSummary = mongoose.model('TripSummary', tripSummarySchema);

// --- REST API ENDPOINTS ---

// 1. ESP32 Telemetry Ingestion Endpoint
app.post('/api/telemetry', async (req, res) => {
  try {
    const { pbs, sub, dev, feeder, status, power } = req.body;
    
    if (!pbs || !sub || !dev || !feeder) {
      return res.status(400).json({ success: false, message: "Missing required fields (pbs, sub, dev, feeder)" });
    }

    // Save/Update telemetry data
    await TelemetryData.findOneAndUpdate(
      { pbs, sub, dev, feeder },
      { status, power, timestamp: new Date() },
      { upsert: true, new: true }
    );

    // Broadcast real-time update to web dashboard via Socket.io
    io.emit('db_update', { pbs, sub, dev, feeder, status, power });

    res.status(200).json({ success: true, message: "Telemetry received and saved." });
  } catch (err) {
    console.error("[TELEMETRY ERROR]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Dashboard Data Feed for ALL_PBS.html
app.get('/api/dashboardData', async (req, res) => {
  try {
    const allTelemetry = await TelemetryData.find({});
    const allTrips = await TripSummary.find({});
    
    const tripList = allTrips.map(t => ({
      feederKey: t.feederKey,
      thisMonthTrips: t.thisMonthTrips,
      lastMonthTrips: t.lastMonthTrips,
      lastTripTime: t.lastTripTime,
      lastOnTime: t.lastOnTime
    }));

    const faultList = allTrips.filter(t => t.faultReason).map(t => ({
      feederKey: t.feederKey,
      fault: t.faultReason
    }));

    res.json({ trip: tripList, fault: faultList, telemetry: allTelemetry });
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
      summary = new TripSummary({ feederKey });
    }

    if (status === "ON" || message === "CLEAR") {
      summary.faultReason = "";
    } else if (message) {
      const formattedTime = new Date().toISOString();
      const newEntry = `[${formattedTime}] ${message}`;
      summary.faultReason = summary.faultReason ? `${summary.faultReason}\n${newEntry}` : newEntry;
    }

    await summary.save();
    res.json({ success: true, faultReason: summary.faultReason });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- SOCKET CONNECTION ---
io.on('connection', async (socket) => {
  console.log('[SOCKET] Client connected.');
  try {
    const allTelemetry = await TelemetryData.find({});
    socket.emit('initial_state', allTelemetry);
  } catch (err) {
    console.error('[SOCKET ERROR]', err);
  }
});

// --- START SERVER ---
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` BREB Cloud Telemetry Server Active                `);
  console.log(` Port                 : ${PORT}                    `);
  console.log(`===================================================`);
});
