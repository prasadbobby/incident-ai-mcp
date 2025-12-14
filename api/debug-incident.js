// api/debug-incident.js - Debug endpoint to see actual incident structure
require('dotenv').config();
const { connectToDatabase } = require('../lib/mongodb');

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { db } = await connectToDatabase();

        // Get one sample incident to see the structure
        const sampleIncident = await db.collection('processed_incidents').findOne(
            {},
            { sort: { processing_timestamp: -1 } }
        );

        if (!sampleIncident) {
            return res.status(404).json({
                error: "No incidents found in processed_incidents collection"
            });
        }

        // Return the structure
        res.status(200).json({
            message: "Sample incident structure from processed_incidents collection",
            incident: sampleIncident,
            availableFields: Object.keys(sampleIncident),
            structureAnalysis: {
                hasTicketId: !!sampleIncident.ticket_id,
                hasId: !!sampleIncident.id,
                hasObjectId: !!sampleIncident._id,
                hasNumber: !!sampleIncident.number,
                hasDescription: !!sampleIncident.description,
                hasShortDescription: !!sampleIncident.short_description,
                hasPriority: !!sampleIncident.priority,
                hasStatus: !!sampleIncident.status,
                hasClassification: !!sampleIncident.classification,
                hasSlaInfo: !!sampleIncident.sla_info,
                hasAssignedPoc: !!sampleIncident.assigned_poc,
                hasProcessingTimestamp: !!sampleIncident.processing_timestamp
            }
        });

    } catch (error) {
        console.error('Debug incident error:', error);
        res.status(500).json({
            error: error.toString()
        });
    }
};