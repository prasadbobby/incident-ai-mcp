// lib/mongodb.js - MongoDB connection helper for Vercel
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = process.env.DB_NAME || "incident_management";

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    if (cachedClient && cachedDb) {
        return { client: cachedClient, db: cachedDb };
    }

    try {
        const client = new MongoClient(MONGO_URL, {
            ssl: true,
            tlsAllowInvalidCertificates: true
        });

        await client.connect();
        const db = client.db(DB_NAME);

        // Test connection
        await db.admin().ping();
        console.log(`✅ MongoDB connected to ${DB_NAME}`);

        cachedClient = client;
        cachedDb = db;

        return { client, db };
    } catch (error) {
        console.error(`❌ MongoDB error: ${error}`);
        throw error;
    }
}

module.exports = { connectToDatabase };