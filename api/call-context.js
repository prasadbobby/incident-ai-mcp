// api/call-context.js - Vercel serverless call context storage
require('dotenv').config();
const { findUserByPhone, currentCallSession } = require('../lib/utils');
const { connectToDatabase } = require('../lib/mongodb');

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const data = req.body;
        const callerNumber = data.to_number;  // The number being called to
        const callId = data.call_id || 'default';

        // Extract incident context from the request
        const incidentContext = {
            incident_number: data.incident_number,
            incident_description: data.incident_description,
            priority: data.priority,
            assignment_group: data.assignment_group,
            state: data.state,
            created_on: data.created_on,
            short_description: data.short_description
        };

        if (callerNumber) {
            try {
                const { db } = await connectToDatabase();
                // Find user by the number being called
                const user = await findUserByPhone(db, callerNumber);
                if (user) {
                    currentCallSession[callId] = {
                        'user': user,
                        'caller_number': callerNumber,
                        'incident': incidentContext
                    };
                    console.log(`📞 Call session stored for ${user.full_name} (${callerNumber})`);
                    if (incidentContext.incident_number) {
                        console.log(`🎫 Incident context: ${incidentContext.incident_number} - ${incidentContext.short_description}`);
                    }
                }

                // ✅ Also store in database for persistence across serverless calls
                if (incidentContext.incident_number) {
                    await db.collection('call_contexts').replaceOne(
                        { call_id: callId },
                        {
                            call_id: callId,
                            caller_number: callerNumber,
                            user: user,
                            incident: incidentContext,
                            timestamp: new Date(),
                            status: 'active'
                        },
                        { upsert: true }
                    );
                    console.log(`✅ Enhanced call context stored in database for ${callId}`);
                }

            } catch (dbError) {
                console.error(`❌ Database error in call context: ${dbError}`);
                // Continue without user lookup if database fails
            }
        }

        res.status(200).json({
            "status": "success",
            "call_id": callId,
            "incident_number": incidentContext.incident_number,
            "enhanced": true
        });
    } catch (error) {
        console.error(`❌ Error storing call context: ${error}`);
        res.status(500).json({"status": "error", "message": error.toString()});
    }
};