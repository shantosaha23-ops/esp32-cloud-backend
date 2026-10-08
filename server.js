const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// 1. Paste your MongoDB Connection String here (replace <db_password> with your actual password)
const MONGO_URI = "mongodb+srv://shantosaha23_db_user:mysecurepassword123@cluster0.ynwdtc4.mongodb.net/?appName=Cluster0&compressors=zlib";

mongoose.connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB Atlas successfully!"))
  .catch(err => console.error("MongoDB connection error:", err));

// 2. Define a schema for your ESP32 sensor data
const sensorSchema = new mongoose.Schema({
  temperature: Number,
  humidity: Number,
  timestamp: { type: Date, default: Date.now }
});

const SensorData = mongoose.model('SensorData', sensorSchema);

// 3. API endpoint for your ESP32 to POST data
app.post('/api/sensors', async (req, res) => {
  try {
    const { temperature, humidity } = req.body;
    
    // Save to MongoDB
    const newData = new SensorData({ temperature, humidity });
    await newData.save();

    console.log(`Received -> Temp: ${temperature}°C, Humidity: ${humidity}%`);
    res.status(201).json({ message: "Data saved successfully!" });
  } catch (error) {
    console.error("Error saving data:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 4. Simple GET route to check if server is running
app.get('/', (req, res) => {
  res.send("ESP32 Cloud Backend is running!");
});

// Start server (Render uses process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});