// mcp_server_incident_management.js
require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');

// Configuration from environment variables
const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = process.env.DB_NAME || "incident_management";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";
const PORT = process.env.PORT || 8001;
const HOST = process.env.HOST || '0.0.0.0';

// Store current call session info
const currentCallSession = {};

// MongoDB connection
let client;
let db = null;

async function connectMongoDB() {
    try {
        client = new MongoClient(MONGO_URL, {
            ssl: true,
            tlsAllowInvalidCertificates: true
        });
        await client.connect();
        db = client.db(DB_NAME);
        // Test connection
        await db.admin().ping();
        console.log(`✅ MongoDB connected to ${DB_NAME}`);
    } catch (error) {
        console.error(`❌ MongoDB error: ${error}`);
        db = null;
    }
}

function generateTicketReference() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 9000) + 1000;
    return `INC${year}${month}${day}${random}`;
}

async function findUserByPhone(phone) {
    /**Find user by phone number with multiple format matching*/
    if (!phone) {
        return null;
    }

    // Clean phone number
    const cleanPhone = phone.replace(/\+91/g, '').replace(/\+/g, '').replace(/\s/g, '').replace(/-/g, '');

    // Try different phone number formats
    const phonePatterns = [
        phone,  // Original format
        `+91${cleanPhone}`,  // With +91
        `91${cleanPhone}`,   // With 91 prefix
        cleanPhone,  // Without country code
        `+${cleanPhone}`,  // With + but no country code
    ];

    console.log(`🔍 Searching for user with phone patterns: ${JSON.stringify(phonePatterns)}`);

    // If MongoDB is not available, return mock user for testing
    if (!db) {
        return {
            "_id": new ObjectId(),
            "full_name": "Test User",
            "phone": phone,
            "email": "test@example.com",
            "role": "support_agent"
        };
    }

    try {
        for (const pattern of phonePatterns) {
            const user = await db.collection('users').findOne({"phone": pattern});
            if (user) {
                console.log(`👤 Found user: ${user.full_name} with phone: ${user.phone}`);
                return user;
            }
        }

        console.log(`❌ No user found for phone: ${phone}`);
        return null;
    } catch (error) {
        console.error(`❌ Error finding user: ${error}`);
        return null;
    }
}

// Store call context endpoint (called by ElevenLabs when call starts)
async function storeCallContext(req, res) {
    /**Store the calling number and incident context for this session*/
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
            // Find user by the number being called
            const user = await findUserByPhone(callerNumber);
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
        }

        res.json({"status": "success"});
    } catch (error) {
        console.error(`❌ Error storing call context: ${error}`);
        res.json({"status": "error"});
    }
}

// MCP Protocol Handler
async function handleMcpRequest(req, res) {
    /**Handle MCP JSON-RPC requests*/
    try {
        const body = req.body;
        if (!body) {
            return res.status(400).json({
                "jsonrpc": "2.0",
                "error": {"code": -32700, "message": "Parse error"}
            });
        }

        const message = body;
        console.log(`📨 MCP Request: ${JSON.stringify(message)}`);

        const method = message.method;
        const msgId = message.id;
        const params = message.params || {};

        let response;

        if (method === "initialize") {
            response = {
                "jsonrpc": "2.0",
                "id": msgId,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {"listChanged": false}
                    },
                    "serverInfo": {
                        "name": "critical-incident-escalation-mcp",
                        "version": "1.0.0"
                    }
                }
            };

        } else if (method === "tools/list") {
            const tools = [
                {
                    "name": "get_current_incident_context",
                    "description": "Get the current incident context for this emergency call session",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "call_id": {
                                "type": "string",
                                "description": "Call session ID (optional, defaults to 'default')"
                            }
                        },
                        "required": []
                    }
                },
                {
                    "name": "get_incident_status",
                    "description": "Get detailed status and information for a specific critical incident",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "incident_number": {
                                "type": "string",
                                "description": "Incident number (e.g., INC0010001)"
                            }
                        },
                        "required": ["incident_number"]
                    }
                },
                {
                    "name": "search_incidents",
                    "description": "Search for similar critical incidents and resolution procedures",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "description": {
                                "type": "string",
                                "description": "Critical incident description to find similar cases"
                            },
                            "assignment_group": {
                                "type": "string",
                                "description": "Assignment group (optional)"
                            }
                        },
                        "required": ["description"]
                    }
                },
                {
                    "name": "get_sop_document",
                    "description": "Retrieve step-by-step resolution procedures for critical issues",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "issue_type": {
                                "type": "string",
                                "description": "Type of critical issue requiring immediate resolution"
                            }
                        },
                        "required": ["issue_type"]
                    }
                },
                {
                    "name": "execute_resolution_script",
                    "description": "Execute automated resolution script for critical incident resolution",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "script_name": {
                                "type": "string",
                                "description": "Name of the critical resolution script"
                            },
                            "ticket_id": {
                                "type": "string",
                                "description": "Critical incident ticket ID"
                            }
                        },
                        "required": ["script_name"]
                    }
                }
            ];

            response = {
                "jsonrpc": "2.0",
                "id": msgId,
                "result": {"tools": tools}
            };

        } else if (method === "tools/call") {
            const toolName = params.name;
            const toolArgs = params.arguments || {};

            console.log(`🔧 Tool called: ${toolName}`);
            console.log(`📋 Arguments: ${JSON.stringify(toolArgs)}`);

            let result;
            if (toolName === "get_current_incident_context") {
                result = await getCurrentIncidentContext(toolArgs);
            } else if (toolName === "get_incident_status") {
                result = await getIncidentStatus(toolArgs);
            } else if (toolName === "search_incidents") {
                result = await searchIncidents(toolArgs);
            } else if (toolName === "get_sop_document") {
                result = await getSopDocument(toolArgs);
            } else if (toolName === "execute_resolution_script") {
                result = await executeResolutionScript(toolArgs);
            } else {
                result = {"content": [{"type": "text", "text": "Unknown tool"}]};
            }

            response = {
                "jsonrpc": "2.0",
                "id": msgId,
                "result": result
            };

        } else if (method === "notifications/initialized") {
            response = {"jsonrpc": "2.0", "id": msgId, "result": {}};

        } else {
            response = {
                "jsonrpc": "2.0",
                "id": msgId,
                "error": {"code": -32601, "message": `Method not found: ${method}`}
            };
        }

        console.log(`📤 MCP Response: ${JSON.stringify(response)}`);
        res.json(response);

    } catch (error) {
        console.error(`❌ MCP error: ${error}`);
        res.status(500).json({
            "jsonrpc": "2.0",
            "id": req.body?.id || null,
            "error": {"code": -32603, "message": `Internal error: ${error.toString()}`}
        });
    }
}

async function getCurrentIncidentContext(toolArgs) {
    /**Get the current incident context with real-time data from database*/
    const callId = toolArgs.call_id || 'default';

    try {
        // First check in-memory storage for backward compatibility
        let session = currentCallSession[callId];

        // If not in memory, fetch from database
        if (!session && db) {
            const callContext = await db.collection('call_contexts').findOne(
                { call_id: callId, status: 'active' },
                { sort: { timestamp: -1 } }
            );

            if (callContext) {
                session = {
                    user: callContext.user,
                    incident: callContext.incident,
                    caller_number: callContext.caller_number
                };
                console.log(`📞 Retrieved call context from database for call ${callId}`);
            }
        }

        // If still no session, automatically get latest incident from database
        if (!session && db) {
            console.log(`🔍 No call context found, fetching latest incident from database...`);

            // Try to get latest critical incident first
            session = await getLatestCriticalIncidentForCall(callId);

            // If no critical incident, get any recent incident
            if (!session) {
                const latestIncident = await getLatestIncidentFromDatabase();
                if (latestIncident) {
                    session = { incident: latestIncident };
                    console.log(`📋 Using latest incident: ${latestIncident.ticket_id || latestIncident.number}`);
                }
            }
        }

        // Always try to provide some incident context
        if (!session || !session.incident) {
            // Generate a basic context for the call
            const basicContext = {
                number: `ESCALATION-${Date.now()}`,
                description: "Critical incident escalation call initiated",
                priority: "High",
                state: "New",
                created_on: new Date().toISOString(),
                short_description: "Emergency support call"
            };

            session = { incident: basicContext };
            console.log(`⚠️ No incident found, using basic context for emergency call`);
        }

        const user = session.user;
        const incident = session.incident;

        // Determine response type based on how incident was found
        let responseHeader = "🚨 **LIVE EMERGENCY CALL CONTEXT:**\n\n";
        let contextSource = "";

        if (incident.number && incident.number.startsWith('ESCALATION-')) {
            responseHeader = "🚨 **EMERGENCY ESCALATION CALL:**\n\n";
            contextSource = "📞 **CALL TYPE:** General emergency escalation\n";
        } else if (incident.ticket_id) {
            responseHeader = "🚨 **LATEST INCIDENT ESCALATION:**\n\n";
            contextSource = "📋 **CONTEXT:** Latest incident from database\n";
        } else {
            contextSource = "📞 **CALL STATUS:** Active incident escalation\n";
        }

        let responseText = responseHeader + contextSource + "\n";

        // User context
        if (user) {
            responseText += `👤 **EMERGENCY CONTACT:** ${user.full_name}\n`;
            responseText += `📞 **PHONE:** ${user.phone}\n`;
            responseText += `📧 **EMAIL:** ${user.email}\n`;
            responseText += `🎭 **ROLE:** ${user.role}\n\n`;
        }

        // Real-time incident context
        if (incident) {
            const incidentNumber = incident.number || incident.incident_number;

            // Fetch latest incident status in real-time
            const liveIncident = await fetchLiveIncidentData(incidentNumber);
            const currentIncident = liveIncident || incident;

            responseText += `🎫 **INCIDENT NUMBER:** ${currentIncident.number || incidentNumber}\n`;

            if (currentIncident.short_description) {
                responseText += `📋 **DESCRIPTION:** ${currentIncident.short_description}\n`;
            }

            if (currentIncident.priority) {
                const priority = currentIncident.priority;
                const priorityEmoji = priority.includes('1') || priority.toLowerCase().includes('critical') ? '🚨' : '⚡';
                responseText += `${priorityEmoji} **PRIORITY:** ${priority}\n`;
            }

            if (currentIncident.state) {
                responseText += `🎯 **CURRENT STATUS:** ${currentIncident.state}\n`;
            }

            if (currentIncident.assignment_group) {
                responseText += `👥 **ASSIGNED TEAM:** ${currentIncident.assignment_group}\n`;
            }

            if (currentIncident.created_on) {
                responseText += `📅 **CREATED:** ${currentIncident.created_on}\n`;
            }

            if (currentIncident.updated_on) {
                responseText += `🔄 **LAST UPDATE:** ${currentIncident.updated_on}\n`;
            }

            // Calculate SLA if possible
            if (currentIncident.priority && currentIncident.created_on) {
                const slaInfo = calculateSLAStatus(currentIncident);
                if (slaInfo) {
                    responseText += `⏰ **SLA STATUS:** ${slaInfo}\n`;
                }
            }

            // Add context-specific support message
            if (incident.number && incident.number.startsWith('ESCALATION-')) {
                responseText += "\n🔄 **EMERGENCY SUPPORT:** I'm ready to assist with this escalation. I can help find specific incidents, provide resolution procedures, or execute emergency scripts.";
            } else if (incident.ticket_id) {
                responseText += "\n🔄 **LIVE INCIDENT SUPPORT:** I have the latest incident from your database. I can provide status updates, resolution procedures, or execute emergency scripts for this incident.";
                responseText += "\n✅ **DATABASE INTEGRATION:** Using most recent incident data automatically.";
            } else {
                responseText += "\n🔄 **LIVE EMERGENCY SUPPORT:** I have the current incident data. I can provide real-time status updates, resolution procedures, or execute emergency scripts immediately.";
            }

            if (liveIncident) {
                responseText += "\n✅ **REAL-TIME DATA:** Incident information updated from live database.";
            }
        } else {
            responseText += "⚠️ **NO INCIDENT CONTEXT:** No specific incident found for this emergency call. ";
            responseText += "I can help you find critical incidents or provide the incident number for immediate escalation support.";
        }

        return {"content": [{"type": "text", "text": responseText}]};

    } catch (error) {
        console.error(`❌ Error getting current incident context: ${error}`);
        return {"content": [{"type": "text", "text": "🚨 **EMERGENCY SYSTEM ERROR:** Unable to retrieve current incident context. Please provide the incident number manually or escalate to senior support immediately."}]};
    }
}

async function fetchLiveIncidentData(incidentNumber) {
    /**Fetch the most current incident data from database and API*/
    if (!incidentNumber || !db) return null;

    try {
        // Check MongoDB first - try all possible collection names
        let incident = await db.collection('processed_incidents').findOne(
            { $or: [
                { number: incidentNumber },
                { ticket_id: incidentNumber },
                { incident_number: incidentNumber }
            ]},
            { sort: { updated_on: -1, created_on: -1 } }
        );

        if (!incident) {
            incident = await db.collection('tickets').findOne(
                { number: incidentNumber },
                { sort: { updated_on: -1, created_on: -1 } }
            );
        }

        if (!incident) {
            incident = await db.collection('incidents').findOne(
                { number: incidentNumber },
                { sort: { updated_on: -1, created_on: -1 } }
            );
        }

        // If found in DB, try to get even more recent data from ServiceNow API
        if (incident) {
            try {
                const response = await axios.post(`${BACKEND_URL}/api/search_servicenow`,
                    { "incident_number": incidentNumber },
                    { timeout: 5000 }
                );

                if (response.status === 200 && response.data.incidents?.length > 0) {
                    const apiIncident = response.data.incidents[0];
                    // Use API data if it's newer
                    const apiUpdateTime = new Date(apiIncident.updated_on || apiIncident.created_on);
                    const dbUpdateTime = new Date(incident.updated_on || incident.created_on);

                    if (apiUpdateTime > dbUpdateTime) {
                        return apiIncident;
                    }
                }
            } catch (apiError) {
                console.log(`⚠️ ServiceNow API unavailable, using database data`);
            }
        }

        return incident;
    } catch (error) {
        console.error(`❌ Error fetching live incident data: ${error}`);
        return null;
    }
}

async function getLatestCriticalIncidentForCall(callId) {
    /**Get the latest critical incident if no specific context found*/
    if (!db) return null;

    try {
        // Look for the most recent critical/high priority incidents - check processed_incidents first
        let criticalIncident = await db.collection('processed_incidents').findOne(
            {
                $or: [
                    { priority: { $in: ['1 - Critical', '2 - High', 'Critical', 'High', '1', '2'] }},
                    { 'sla_info.priority': { $in: ['1 - Critical', '2 - High', 'Critical', 'High', '1', '2'] }}
                ],
                status: { $nin: ['Resolved', 'Closed', 'Cancelled', 'completed'] }
            },
            { sort: { created_on: -1 } }
        );

        if (!criticalIncident) {
            criticalIncident = await db.collection('tickets').findOne(
                {
                    priority: { $in: ['1 - Critical', '2 - High', 'Critical', 'High', '1', '2'] },
                    state: { $nin: ['Resolved', 'Closed', 'Cancelled'] }
                },
                { sort: { created_on: -1 } }
            );
        }

        if (!criticalIncident) {
            const incident = await db.collection('incidents').findOne(
                {
                    priority: { $in: ['1 - Critical', '2 - High', 'Critical', 'High', '1', '2'] },
                    state: { $nin: ['Resolved', 'Closed', 'Cancelled'] }
                },
                { sort: { created_on: -1 } }
            );
            return incident ? { incident } : null;
        }

        return { incident: criticalIncident };
    } catch (error) {
        console.error(`❌ Error getting latest critical incident: ${error}`);
        return null;
    }
}

async function getLatestIncidentFromDatabase() {
    /**Get the most recent incident from any collection for emergency call context*/
    if (!db) return null;

    try {
        console.log(`🔍 Searching for latest incident across all collections...`);

        // Try processed_incidents first (most likely to have data)
        let latestIncident = await db.collection('processed_incidents').findOne(
            {},
            { sort: { processing_timestamp: -1, created_on: -1 } }
        );

        if (latestIncident) {
            console.log(`📋 Found incident in processed_incidents: ${latestIncident.ticket_id}`);
            return {
                number: latestIncident.ticket_id,
                ticket_id: latestIncident.ticket_id,
                description: latestIncident.classification?.category || "Processed incident",
                priority: latestIncident.sla_info?.priority || "Medium",
                state: latestIncident.status || "Processed",
                assignment_group: latestIncident.assigned_poc || "Support Team",
                created_on: latestIncident.processing_timestamp,
                short_description: `${latestIncident.classification?.category} incident - ${latestIncident.assigned_poc}`
            };
        }

        // Try tickets collection
        latestIncident = await db.collection('tickets').findOne(
            {},
            { sort: { created_on: -1 } }
        );

        if (latestIncident) {
            console.log(`📋 Found incident in tickets: ${latestIncident.number}`);
            return latestIncident;
        }

        // Try incidents collection
        latestIncident = await db.collection('incidents').findOne(
            {},
            { sort: { created_on: -1 } }
        );

        if (latestIncident) {
            console.log(`📋 Found incident in incidents: ${latestIncident.number}`);
            return latestIncident;
        }

        console.log(`⚠️ No incidents found in any collection`);
        return null;

    } catch (error) {
        console.error(`❌ Error getting latest incident: ${error}`);
        return null;
    }
}

function calculateSLAStatus(incident) {
    /**Calculate SLA status based on priority and creation time*/
    if (!incident.created_on || !incident.priority) return null;

    const created = new Date(incident.created_on);
    const now = new Date();
    const hoursElapsed = (now - created) / (1000 * 60 * 60);

    let slaHours = 8; // Default
    if (incident.priority.includes('1') || incident.priority.toLowerCase().includes('critical')) {
        slaHours = 4;
    } else if (incident.priority.includes('2') || incident.priority.toLowerCase().includes('high')) {
        slaHours = 8;
    }

    const remainingHours = slaHours - hoursElapsed;

    if (remainingHours <= 0) {
        return `🚨 SLA BREACHED (${Math.abs(remainingHours).toFixed(1)} hours over)`;
    } else if (remainingHours < 1) {
        return `⚠️ CRITICAL - ${(remainingHours * 60).toFixed(0)} minutes remaining`;
    } else {
        return `✅ ${remainingHours.toFixed(1)} hours remaining`;
    }
}

async function searchIncidents(toolArgs) {
    /**Search for similar critical incidents and resolution procedures*/
    const description = (toolArgs.description || "").trim();
    const assignmentGroup = (toolArgs.assignment_group || "").trim();

    if (!description) {
        return {"content": [{"type": "text", "text": "Please provide the critical incident description to search for similar cases."}]};
    }

    try {
        // Call your incident search API
        const payload = {
            "description": description,
            "assignment_group": assignmentGroup
        };

        const response = await axios.post(`${BACKEND_URL}/api/search_incidents`, payload, {timeout: 30000});

        if (response.status === 200) {
            const data = response.data;

            if (data.success && data.similar_incidents) {
                const similarIncidents = data.similar_incidents;
                let responseText = `🚨 **CRITICAL ESCALATION:** Found ${similarIncidents.length} similar high-priority incidents:\n\n`;

                for (let i = 0; i < Math.min(2, similarIncidents.length); i++) {
                    const incident = similarIncidents[i];
                    responseText += `**${incident.number}** - ${incident.similarity} match\n`;
                    responseText += `Resolution: ${(incident.resolution || 'Check SOP procedures').substring(0, 150)}...\n`;
                    responseText += `Team: ${incident.assignment_group}\n\n`;
                }

                if (data.generated_sop) {
                    responseText += "📋 **IMMEDIATE ACTIONS AVAILABLE:**\nI have the step-by-step resolution procedure ready. Shall I provide the emergency resolution steps now?";
                }

                return {"content": [{"type": "text", "text": responseText}]};
            } else {
                const responseText = "🚨 **CRITICAL ESCALATION:** No similar incidents found in database. " +
                                  "This appears to be a unique critical issue requiring immediate investigation by the assigned team.";
                return {"content": [{"type": "text", "text": responseText}]};
            }
        } else {
            return {"content": [{"type": "text", "text": "🚨 **CRITICAL ESCALATION:** Unable to access incident database. Recommend immediate manual investigation."}]};
        }

    } catch (error) {
        console.error(`❌ Critical search error: ${error}`);
        return {"content": [{"type": "text", "text": "🚨 **CRITICAL ESCALATION:** Technical difficulties accessing incident data. Escalate to senior support immediately."}]};
    }
}

async function getIncidentStatus(toolArgs) {
    /**Get detailed status for critical incident escalation*/
    const incidentNumber = (toolArgs.incident_number || "").trim();

    if (!incidentNumber) {
        return {"content": [{"type": "text", "text": "Please provide the critical incident number for escalation details."}]};
    }

    try {
        // Call ServiceNow search API
        const response = await axios.post(`${BACKEND_URL}/api/search_servicenow`,
                                        {"incident_number": incidentNumber},
                                        {timeout: 15000});

        if (response.status === 200) {
            const data = response.data;
            const incidents = data.incidents || [];

            if (incidents.length > 0) {
                const incident = incidents[0];
                const priority = (incident.priority || '').toLowerCase();

                // Critical escalation format
                let responseText = `🚨 **CRITICAL ESCALATION - ${incident.number}**\n\n`;
                responseText += `⚡ **PRIORITY:** ${incident.priority} - IMMEDIATE ATTENTION REQUIRED\n`;
                responseText += `📋 **ISSUE:** ${incident.short_description}\n`;
                responseText += `🎯 **CURRENT STATUS:** ${incident.state}\n`;
                responseText += `👥 **ASSIGNED TEAM:** ${incident.assignment_group}\n`;
                responseText += `📅 **CREATED:** ${incident.created_on}\n\n`;

                if (priority.includes('critical') || priority.includes('1')) {
                    responseText += "🚨 **CRITICAL SLA:** 4 hours maximum resolution time\n";
                } else if (priority.includes('high') || priority.includes('2')) {
                    responseText += "⚠️ **HIGH PRIORITY SLA:** 8 hours resolution target\n";
                }

                if (incident.state.toLowerCase() === 'resolved' || incident.state.toLowerCase() === 'closed') {
                    responseText += "\n✅ **STATUS UPDATE:** This incident has been resolved. Confirming resolution with user.";
                } else {
                    responseText += `\n🔄 **URGENT ACTION REQUIRED:** Incident is ${incident.state} - Team needs immediate response.`;
                }

                responseText += "\n\nDo you need the resolution procedures or SOP guidance for this critical incident?";

                return {"content": [{"type": "text", "text": responseText}]};
            } else {
                return {"content": [{"type": "text", "text": `🚨 **CRITICAL:** Could not locate incident ${incidentNumber} in system. Verify incident number or escalate to senior support.`}]};
            }
        } else {
            return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM ISSUE:** Cannot access incident database. Escalate to infrastructure team immediately."}]};
        }

    } catch (error) {
        console.error(`❌ Critical status check error: ${error}`);
        return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM FAILURE:** Database connectivity issues. Immediate escalation to infrastructure required."}]};
    }
}

async function getSopDocument(toolArgs) {
    /**Get critical resolution procedures for immediate escalation*/
    const issueType = (toolArgs.issue_type || "").trim();

    if (!issueType) {
        return {"content": [{"type": "text", "text": "Please specify the critical issue type for emergency resolution procedures."}]};
    }

    try {
        // Search for SOP using the search API
        const response = await axios.post(`${BACKEND_URL}/api/search_incidents`,
                                        {"description": issueType},
                                        {timeout: 30000});

        if (response.status === 200) {
            const data = response.data;

            if (data.generated_sop) {
                const sopText = data.generated_sop;

                // Extract critical steps for emergency response
                const lines = sopText.split('\n');
                const criticalSteps = [];
                for (let i = 0; i < Math.min(8, lines.length); i++) { // First 8 lines for critical response
                    const line = lines[i];
                    if (line.trim() && (line.toLowerCase().includes('step') || /^[1-5]\./.test(line))) {
                        criticalSteps.push(line.trim());
                    }
                }

                let responseText = `🚨 **EMERGENCY SOP - ${issueType.charAt(0).toUpperCase() + issueType.slice(1)}:**\n\n`;
                responseText += "⚡ **IMMEDIATE ACTIONS REQUIRED:**\n\n";

                if (criticalSteps.length > 0) {
                    for (let i = 0; i < Math.min(4, criticalSteps.length); i++) { // Limit to 4 critical steps
                        responseText += `**${i + 1}.** ${criticalSteps[i]}\n`;
                    }
                    responseText += "\n🔄 **NEXT:** Execute these steps immediately and report status.\n";
                    responseText += "📞 **ESCALATION:** If any step fails, escalate to senior support immediately.";
                } else {
                    // Fallback to first critical paragraph
                    const firstParagraph = sopText.split('\n\n')[0] || "";
                    responseText += `**CRITICAL PROCEDURE:**\n${firstParagraph.substring(0, 250)}...\n\n`;
                    responseText += "🔄 **ACTION:** Begin this procedure immediately and monitor progress.";
                }

                responseText += "\n\nDo you need clarification on any of these critical steps?";

                return {"content": [{"type": "text", "text": responseText}]};
            } else {
                return {"content": [{"type": "text", "text": `🚨 **CRITICAL:** No SOP available for '${issueType}'. This requires immediate manual intervention by senior technical team.`}]};
            }
        } else {
            return {"content": [{"type": "text", "text": "🚨 **CRITICAL:** Cannot access SOP database. Escalate to senior support for manual resolution procedures."}]};
        }

    } catch (error) {
        console.error(`❌ Critical SOP error: ${error}`);
        return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM ISSUE:** SOP system unavailable. Immediate escalation to infrastructure team required."}]};
    }
}

async function executeResolutionScript(toolArgs) {
    /**Execute critical automated resolution script for emergency response*/
    const scriptName = (toolArgs.script_name || "").trim();
    const ticketId = (toolArgs.ticket_id || "").trim();

    if (!scriptName) {
        return {"content": [{"type": "text", "text": "Please specify which critical resolution script to execute for emergency response."}]};
    }

    try {
        const payload = {
            "ticket_id": ticketId || generateTicketReference(),
            "scripts": [scriptName],
            "description": `CRITICAL: Emergency script execution - ${scriptName}`,
            "assignment_group": "Critical Response Team",
            "priority": "critical"
        };

        const response = await axios.post(`${BACKEND_URL}/api/execute_scripts`,
                                        payload,
                                        {timeout: 60000});

        if (response.status === 200) {
            const data = response.data;

            if (data.success) {
                const result = data.result;

                let responseText = `🚨 **CRITICAL SCRIPT EXECUTION - ${scriptName.toUpperCase()}**\n\n`;
                responseText += `📋 **CRITICAL INCIDENT:** ${result.ticket_id || ticketId}\n`;
                responseText += `⚡ **EMERGENCY SCRIPT:** ${scriptName}\n\n`;

                if (result.resolution_results) {
                    for (const res of result.resolution_results) {
                        const status = res.status;
                        if (status === 'success') {
                            responseText += `✅ **EMERGENCY RESOLUTION SUCCESS:**\n${res.resolution}\n\n`;
                        } else {
                            responseText += `🚨 **CRITICAL FAILURE:**\n${res.resolution}\n\n`;
                        }

                        if (res.output) {
                            // Critical output summary
                            const outputSummary = res.output.length > 150 ? res.output.substring(0, 150) + "..." : res.output;
                            responseText += `📊 **SYSTEM OUTPUT:** ${outputSummary}\n\n`;
                        }
                    }

                    // Determine next steps
                    const successCount = result.resolution_results.filter(res => res.status === 'success').length;
                    if (successCount > 0) {
                        responseText += "🔄 **NEXT ACTION:** Verify system functionality and confirm resolution with end users.";
                    } else {
                        responseText += "🚨 **IMMEDIATE ESCALATION REQUIRED:** Script failed - escalate to senior technical team immediately.";
                    }
                } else {
                    responseText += "⚠️ **SCRIPT STATUS:** Execution completed but no results returned. Manual verification required.";
                }

                return {"content": [{"type": "text", "text": responseText}]};
            } else {
                return {"content": [{"type": "text", "text": `🚨 **CRITICAL SCRIPT FAILURE:** ${data.error || 'Unknown error'} - Immediate manual intervention required.`}]};
            }
        } else {
            return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM ISSUE:** Cannot execute emergency scripts. Escalate to infrastructure team immediately."}]};
        }

    } catch (error) {
        console.error(`❌ Critical script execution error: ${error}`);
        return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM FAILURE:** Script execution system unavailable. Manual resolution procedures required immediately."}]};
    }
}

// Health check endpoint
async function healthCheck(req, res) {
    /**Health check*/
    try {
        const healthData = {
            "status": "healthy",
            "timestamp": new Date().toISOString(),
            "backend_url": BACKEND_URL
        };

        if (db) {
            try {
                // Check actual collection names in your database
                const processedIncidentsCount = await db.collection('processed_incidents').countDocuments({});
                const ticketsCount = await db.collection('tickets').countDocuments({});
                const incidentsCount = await db.collection('incidents').countDocuments({});
                const usersCount = await db.collection('users').countDocuments({});
                const generatedSopsCount = await db.collection('generated_sops').countDocuments({});

                // List all collections to help debug
                const collections = await db.listCollections().toArray();
                const collectionNames = collections.map(col => col.name);

                healthData.database = {
                    connected: true,
                    collections: collectionNames,
                    counts: {
                        processed_incidents: processedIncidentsCount,
                        tickets: ticketsCount,
                        incidents: incidentsCount,
                        users: usersCount,
                        generated_sops: generatedSopsCount
                    }
                };

                // Maintain backward compatibility - count all incident-related collections
                const totalIncidents = processedIncidentsCount + ticketsCount + incidentsCount;
                healthData.tickets = totalIncidents;
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
        } else {
            healthData.database = {
                connected: false,
                error: "Database connection not established"
            };
        }

        res.json(healthData);
    } catch (error) {
        res.status(500).json({
            "status": "unhealthy",
            "error": error.toString()
        });
    }
}

// Initialize Express app
const app = express();
app.use(express.json());

// Routes
app.post("/", handleMcpRequest);
app.post("/mcp", handleMcpRequest);
app.get("/health", healthCheck);
app.post("/call-context", storeCallContext);

// Environment validation
function validateEnvironment() {
    const requiredVars = ['MONGO_URL', 'DB_NAME', 'BACKEND_URL'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
        console.warn(`⚠️ Missing environment variables: ${missingVars.join(', ')}`);
        console.warn('📝 Using default values. Consider setting these in .env file');
    }

    // Log configuration
    console.log('📋 Configuration:');
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   MongoDB: ${DB_NAME} database`);
    console.log(`   Backend: ${BACKEND_URL}`);
    console.log(`   Server: ${HOST}:${PORT}`);
}

// Start server
async function startServer() {
    validateEnvironment();
    await connectMongoDB();

    app.listen(PORT, HOST, () => {
        console.log("🚨 Critical Incident Escalation MCP Server Starting...");
        console.log("🔗 MCP Endpoint: / and /mcp");
        console.log("📞 Emergency escalation calls for critical incidents");
        console.log("⚡ Focus: Critical incident resolution and SOP guidance");
        console.log(`🔗 Backend URL: ${BACKEND_URL}`);
        console.log(`🚀 Server running on ${HOST}:${PORT}`);
    });
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    if (client) {
        await client.close();
    }
    process.exit(0);
});

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };