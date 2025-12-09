// api/health.js - Vercel serverless health check
require('dotenv').config();
const { connectToDatabase } = require('../lib/mongodb');

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const healthData = {
            "status": "healthy",
            "timestamp": new Date().toISOString(),
            "backend_url": BACKEND_URL,
            "environment": "vercel"
        };

        try {
            const { db } = await connectToDatabase();

            // Check multiple possible collection names for tickets/incidents
            const ticketsCount = await db.collection('tickets').countDocuments({});
            const incidentsCount = await db.collection('incidents').countDocuments({});
            const usersCount = await db.collection('users').countDocuments({});

            // List all collections to help debug
            const collections = await db.listCollections().toArray();
            const collectionNames = collections.map(col => col.name);

            healthData.database = {
                connected: true,
                collections: collectionNames,
                counts: {
                    tickets: ticketsCount,
                    incidents: incidentsCount,
                    users: usersCount
                }
            };

            // Maintain backward compatibility
            healthData.tickets = ticketsCount + incidentsCount;
            healthData.users = usersCount;
        } catch (dbError) {
            console.error(`❌ Database query error: ${dbError}`);
            healthData.database = {
                connected: false,
                error: dbError.toString()
            };
            healthData.tickets = 0;
            healthData.users = 0;
        }

        res.status(200).json(healthData);
    } catch (error) {
        res.status(500).json({
            "status": "unhealthy",
            "error": error.toString(),
            "environment": "vercel"
        });
    }
};