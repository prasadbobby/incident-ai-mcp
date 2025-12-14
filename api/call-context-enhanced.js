// api/call-context-enhanced.js - Enhanced call context with real-time incident fetching
require('dotenv').config();
const { findUserByPhone } = require('../lib/utils');
const { connectToDatabase } = require('../lib/mongodb');
const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const data = req.body;
        const callerNumber = data.to_number;
        const callId = data.call_id || 'default';
        const incidentNumber = data.incident_number;

        console.log(`📞 Enhanced call context for call ${callId}, incident: ${incidentNumber}`);

        let incidentContext = null;
        let user = null;

        // Connect to database
        const { db } = await connectToDatabase();

        // Find user by phone number
        if (callerNumber) {
            user = await findUserByPhone(db, callerNumber);
        }

        // Fetch real-time incident data if incident number provided
        if (incidentNumber) {
            incidentContext = await fetchLatestIncidentData(incidentNumber, db);
        }

        // If no specific incident, check for latest critical incidents
        if (!incidentContext && user) {
            incidentContext = await fetchUserLatestCriticalIncident(user, db);
        }

        // Store enhanced context in database (persistent across serverless calls)
        if (incidentContext || user) {
            await storeCallContextInDB(db, {
                call_id: callId,
                caller_number: callerNumber,
                user: user,
                incident: incidentContext,
                timestamp: new Date(),
                status: 'active'
            });

            console.log(`✅ Enhanced call context stored in DB for ${user ? user.full_name : 'unknown'}`);
            if (incidentContext) {
                console.log(`🎫 Live incident: ${incidentContext.number} - Priority: ${incidentContext.priority} - Status: ${incidentContext.state}`);
            }
        }

        // Return the full context for immediate use by ElevenLabs
        res.status(200).json({
            "status": "success",
            "call_id": callId,
            "user": user,
            "incident": incidentContext,
            "has_live_data": !!incidentContext
        });

    } catch (error) {
        console.error(`❌ Error in enhanced call context: ${error}`);
        res.status(500).json({
            "status": "error",
            "message": error.toString()
        });
    }
};

async function fetchLatestIncidentData(incidentNumber, db) {
    /**Fetch the latest incident data from multiple sources*/
    try {
        // First try MongoDB
        let incident = await db.collection('tickets').findOne(
            { number: incidentNumber },
            { sort: { created_on: -1 } }
        );

        if (!incident) {
            incident = await db.collection('incidents').findOne(
                { number: incidentNumber },
                { sort: { created_on: -1 } }
            );
        }

        // If not in MongoDB, try ServiceNow API
        if (!incident) {
            try {
                const response = await axios.post(`${BACKEND_URL}/api/search_servicenow`,
                    { "incident_number": incidentNumber },
                    { timeout: 10000 }
                );

                if (response.status === 200 && response.data.incidents?.length > 0) {
                    incident = response.data.incidents[0];
                }
            } catch (apiError) {
                console.error(`❌ ServiceNow API error: ${apiError}`);
            }
        }

        if (incident) {
            return {
                number: incident.number || incidentNumber,
                short_description: incident.short_description || incident.description,
                description: incident.description || incident.incident_description,
                priority: incident.priority,
                state: incident.state,
                assignment_group: incident.assignment_group,
                created_on: incident.created_on,
                updated_on: incident.updated_on || new Date(),
                caller_id: incident.caller_id,
                category: incident.category,
                subcategory: incident.subcategory,
                urgency: incident.urgency,
                impact: incident.impact,
                sla_due: incident.sla_due,
                work_notes: incident.work_notes || incident.comments
            };
        }

        return null;
    } catch (error) {
        console.error(`❌ Error fetching incident data: ${error}`);
        return null;
    }
}

async function fetchUserLatestCriticalIncident(user, db) {
    /**Fetch the user's latest critical/high priority incident*/
    try {
        // Look for incidents assigned to user or their group
        const query = {
            $or: [
                { assigned_to: user._id },
                { assignment_group: user.role },
                { caller_id: user._id },
                { assigned_to: user.full_name },
                { priority: { $in: ['1 - Critical', '2 - High', 'Critical', 'High'] } }
            ],
            state: { $nin: ['Resolved', 'Closed', 'Cancelled'] }
        };

        let incident = await db.collection('tickets').findOne(query, { sort: { created_on: -1 } });
        if (!incident) {
            incident = await db.collection('incidents').findOne(query, { sort: { created_on: -1 } });
        }

        return incident ? {
            number: incident.number,
            short_description: incident.short_description || incident.description,
            description: incident.description,
            priority: incident.priority,
            state: incident.state,
            assignment_group: incident.assignment_group,
            created_on: incident.created_on,
            updated_on: incident.updated_on || new Date()
        } : null;

    } catch (error) {
        console.error(`❌ Error fetching user incidents: ${error}`);
        return null;
    }
}

async function storeCallContextInDB(db, contextData) {
    /**Store call context in database for persistence across serverless calls*/
    try {
        await db.collection('call_contexts').replaceOne(
            { call_id: contextData.call_id },
            contextData,
            { upsert: true }
        );

        // Clean up old call contexts (older than 24 hours)
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await db.collection('call_contexts').deleteMany({
            timestamp: { $lt: yesterday }
        });

    } catch (error) {
        console.error(`❌ Error storing call context in DB: ${error}`);
    }
}