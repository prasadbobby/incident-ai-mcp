// api/mcp.js - Vercel serverless MCP handler
require('dotenv').config();
const axios = require('axios');
const { connectToDatabase } = require('../lib/mongodb');
const { generateTicketReference, currentCallSession } = require('../lib/utils');

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

// Tool implementations (imported from original mcp.js)
async function getCurrentIncidentContext(toolArgs) {
    const callId = toolArgs.call_id || 'default';

    try {
        const session = currentCallSession[callId];

        if (!session) {
            return {"content": [{"type": "text", "text": "No active call session found. Please ensure the emergency call context is properly established."}]};
        }

        const user = session.user;
        const incident = session.incident;

        let responseText = "🚨 **CURRENT EMERGENCY CALL CONTEXT:**\n\n";

        // User context
        if (user) {
            responseText += `👤 **CALLER:** ${user.full_name}\n`;
            responseText += `📞 **PHONE:** ${user.phone}\n`;
            responseText += `📧 **EMAIL:** ${user.email}\n`;
            responseText += `🎭 **ROLE:** ${user.role}\n\n`;
        }

        // Incident context
        if (incident && incident.incident_number) {
            responseText += `🎫 **INCIDENT NUMBER:** ${incident.incident_number}\n`;

            if (incident.short_description) {
                responseText += `📋 **DESCRIPTION:** ${incident.short_description}\n`;
            }

            if (incident.priority) {
                responseText += `⚡ **PRIORITY:** ${incident.priority}\n`;
            }

            if (incident.state) {
                responseText += `🎯 **STATUS:** ${incident.state}\n`;
            }

            if (incident.assignment_group) {
                responseText += `👥 **ASSIGNED TEAM:** ${incident.assignment_group}\n`;
            }

            if (incident.created_on) {
                responseText += `📅 **CREATED:** ${incident.created_on}\n`;
            }

            responseText += "\n🔄 **EMERGENCY SUPPORT:** This is your selected critical incident. I can provide status updates, resolution procedures, or execute emergency scripts for this incident.";
        } else {
            responseText += "⚠️ **NO INCIDENT SELECTED:** No specific incident context found for this call. ";
            responseText += "Please provide the incident number or select an incident for emergency support.";
        }

        return {"content": [{"type": "text", "text": responseText}]};

    } catch (error) {
        console.error(`❌ Error getting current incident context: ${error}`);
        return {"content": [{"type": "text", "text": "🚨 **ERROR:** Unable to retrieve current incident context. Please try again or provide the incident number manually."}]};
    }
}

async function searchIncidents(toolArgs) {
    const description = (toolArgs.description || "").trim();
    const assignmentGroup = (toolArgs.assignment_group || "").trim();

    if (!description) {
        return {"content": [{"type": "text", "text": "Please provide the critical incident description to search for similar cases."}]};
    }

    try {
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
    const incidentNumber = (toolArgs.incident_number || "").trim();

    if (!incidentNumber) {
        return {"content": [{"type": "text", "text": "Please provide the critical incident number for escalation details."}]};
    }

    try {
        const response = await axios.post(`${BACKEND_URL}/api/search_servicenow`,
                                        {"incident_number": incidentNumber},
                                        {timeout: 15000});

        if (response.status === 200) {
            const data = response.data;
            const incidents = data.incidents || [];

            if (incidents.length > 0) {
                const incident = incidents[0];
                const priority = (incident.priority || '').toLowerCase();

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
    const issueType = (toolArgs.issue_type || "").trim();

    if (!issueType) {
        return {"content": [{"type": "text", "text": "Please specify the critical issue type for emergency resolution procedures."}]};
    }

    try {
        const response = await axios.post(`${BACKEND_URL}/api/search_incidents`,
                                        {"description": issueType},
                                        {timeout: 30000});

        if (response.status === 200) {
            const data = response.data;

            if (data.generated_sop) {
                const sopText = data.generated_sop;

                const lines = sopText.split('\n');
                const criticalSteps = [];
                for (let i = 0; i < Math.min(8, lines.length); i++) {
                    const line = lines[i];
                    if (line.trim() && (line.toLowerCase().includes('step') || /^[1-5]\./.test(line))) {
                        criticalSteps.push(line.trim());
                    }
                }

                let responseText = `🚨 **EMERGENCY SOP - ${issueType.charAt(0).toUpperCase() + issueType.slice(1)}:**\n\n`;
                responseText += "⚡ **IMMEDIATE ACTIONS REQUIRED:**\n\n";

                if (criticalSteps.length > 0) {
                    for (let i = 0; i < Math.min(4, criticalSteps.length); i++) {
                        responseText += `**${i + 1}.** ${criticalSteps[i]}\n`;
                    }
                    responseText += "\n🔄 **NEXT:** Execute these steps immediately and report status.\n";
                    responseText += "📞 **ESCALATION:** If any step fails, escalate to senior support immediately.";
                } else {
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
                            const outputSummary = res.output.length > 150 ? res.output.substring(0, 150) + "..." : res.output;
                            responseText += `📊 **SYSTEM OUTPUT:** ${outputSummary}\n\n`;
                        }
                    }

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

// Main MCP handler
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
        res.status(200).json(response);

    } catch (error) {
        console.error(`❌ MCP error: ${error}`);
        res.status(500).json({
            "jsonrpc": "2.0",
            "id": req.body?.id || null,
            "error": {"code": -32603, "message": `Internal error: ${error.toString()}`}
        });
    }
};