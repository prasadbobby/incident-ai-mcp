# mcp_server_incident_management.py
import asyncio
import json
import ssl
from datetime import datetime
import random
from pymongo import MongoClient
from bson import ObjectId
from starlette.applications import Starlette
from starlette.responses import Response, JSONResponse
from starlette.routing import Route
from starlette.requests import Request
import uvicorn
import requests

# Configuration
MONGO_URL = "mongodb+srv://bobby:bobby@cluster0.nvavp.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
DB_NAME = "incident_management"
BACKEND_URL = "http://localhost:5000"  # Your incident backend

# Store current call session info
current_call_session = {}

# MongoDB connection
try:
    client = MongoClient(MONGO_URL, tls=True, tlsAllowInvalidCertificates=True)
    db = client[DB_NAME]
    # Test connection
    db.admin.command('ping')
    print(f"✅ MongoDB connected to {DB_NAME}")
except Exception as e:
    print(f"❌ MongoDB error: {e}")
    db = None

def generate_ticket_reference():
    now = datetime.now()
    return f"INC{now.year}{str(now.month).zfill(2)}{str(now.day).zfill(2)}{random.randint(1000, 9999)}"

def find_user_by_phone(phone):
    """Find user by phone number with multiple format matching"""
    if not phone:
        return None

    # Clean phone number
    clean_phone = phone.replace('+91', '').replace('+', '').replace(' ', '').replace('-', '')

    # Try different phone number formats
    phone_patterns = [
        phone,  # Original format
        f"+91{clean_phone}",  # With +91
        f"91{clean_phone}",   # With 91 prefix
        clean_phone,  # Without country code
        f"+{clean_phone}",  # With + but no country code
    ]

    print(f"🔍 Searching for user with phone patterns: {phone_patterns}")

    # If MongoDB is not available, return mock user for testing
    if not db:
        return {
            "_id": ObjectId(),
            "full_name": "Test User",
            "phone": phone,
            "email": "test@example.com",
            "role": "support_agent"
        }

    for pattern in phone_patterns:
        user = db.users.find_one({"phone": pattern})
        if user:
            print(f"👤 Found user: {user['full_name']} with phone: {user['phone']}")
            return user

    print(f"❌ No user found for phone: {phone}")
    return None

# Store call context endpoint (called by ElevenLabs when call starts)
async def store_call_context(request):
    """Store the calling number for this session"""
    try:
        data = await request.json()
        caller_number = data.get('to_number')  # The number being called to
        call_id = data.get('call_id', 'default')

        if caller_number:
            # Find user by the number being called
            user = find_user_by_phone(caller_number)
            if user:
                current_call_session[call_id] = {
                    'user': user,
                    'caller_number': caller_number
                }
                print(f"📞 Call session stored for {user['full_name']} ({caller_number})")

        return JSONResponse({"status": "success"})
    except Exception as e:
        print(f"❌ Error storing call context: {e}")
        return JSONResponse({"status": "error"})

# MCP Protocol Handler
async def handle_mcp_request(request: Request):
    """Handle MCP JSON-RPC requests"""
    try:
        body = await request.body()
        if not body:
            return JSONResponse({
                "jsonrpc": "2.0",
                "error": {"code": -32700, "message": "Parse error"}
            }, status_code=400)

        try:
            message = json.loads(body)
        except json.JSONDecodeError:
            return JSONResponse({
                "jsonrpc": "2.0",
                "error": {"code": -32700, "message": "Parse error"}
            }, status_code=400)

        print(f"📨 MCP Request: {message}")

        method = message.get("method")
        msg_id = message.get("id")
        params = message.get("params", {})

        if method == "initialize":
            response = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {"listChanged": False}
                    },
                    "serverInfo": {
                        "name": "critical-incident-escalation-mcp",
                        "version": "1.0.0"
                    }
                }
            }

        elif method == "tools/list":
            tools = [
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
            ]

            response = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"tools": tools}
            }

        elif method == "tools/call":
            tool_name = params.get("name")
            arguments = params.get("arguments", {})

            print(f"🔧 Tool called: {tool_name}")
            print(f"📋 Arguments: {arguments}")

            if tool_name == "get_incident_status":
                result = await get_incident_status(arguments)
            elif tool_name == "search_incidents":
                result = await search_incidents(arguments)
            elif tool_name == "get_sop_document":
                result = await get_sop_document(arguments)
            elif tool_name == "execute_resolution_script":
                result = await execute_resolution_script(arguments)
            else:
                result = {"content": [{"type": "text", "text": "Unknown tool"}]}

            response = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": result
            }

        elif method == "notifications/initialized":
            response = {"jsonrpc": "2.0", "id": msg_id, "result": {}}

        else:
            response = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"}
            }

        print(f"📤 MCP Response: {response}")
        return JSONResponse(response)

    except Exception as e:
        print(f"❌ MCP error: {e}")
        return JSONResponse({
            "jsonrpc": "2.0",
            "id": message.get("id") if 'message' in locals() else None,
            "error": {"code": -32603, "message": f"Internal error: {str(e)}"}
        }, status_code=500)


async def search_incidents(arguments):
    """Search for similar critical incidents and resolution procedures"""
    description = arguments.get("description", "").strip()
    assignment_group = arguments.get("assignment_group", "").strip()

    if not description:
        return {"content": [{"type": "text", "text": "Please provide the critical incident description to search for similar cases."}]}

    try:
        # Call your incident search API
        payload = {
            "description": description,
            "assignment_group": assignment_group
        }

        response = requests.post(f"{BACKEND_URL}/api/search_incidents", json=payload, timeout=30)

        if response.status_code == 200:
            data = response.json()

            if data.get('success') and data.get('similar_incidents'):
                similar_incidents = data['similar_incidents']
                response_text = f"🚨 **CRITICAL ESCALATION:** Found {len(similar_incidents)} similar high-priority incidents:\n\n"

                for i, incident in enumerate(similar_incidents[:2], 1):
                    response_text += f"**{incident['number']}** - {incident['similarity']} match\n"
                    response_text += f"Resolution: {incident.get('resolution', 'Check SOP procedures')[:150]}...\n"
                    response_text += f"Team: {incident['assignment_group']}\n\n"

                if data.get('generated_sop'):
                    response_text += "📋 **IMMEDIATE ACTIONS AVAILABLE:**\nI have the step-by-step resolution procedure ready. Shall I provide the emergency resolution steps now?"

                return {"content": [{"type": "text", "text": response_text}]}
            else:
                response_text = "🚨 **CRITICAL ESCALATION:** No similar incidents found in database. "
                response_text += "This appears to be a unique critical issue requiring immediate investigation by the assigned team."
                return {"content": [{"type": "text", "text": response_text}]}
        else:
            return {"content": [{"type": "text", "text": "🚨 **CRITICAL ESCALATION:** Unable to access incident database. Recommend immediate manual investigation."}]}

    except Exception as e:
        print(f"❌ Critical search error: {e}")
        return {"content": [{"type": "text", "text": "🚨 **CRITICAL ESCALATION:** Technical difficulties accessing incident data. Escalate to senior support immediately."}]}

async def get_incident_status(arguments):
    """Get detailed status for critical incident escalation"""
    incident_number = arguments.get("incident_number", "").strip()

    if not incident_number:
        return {"content": [{"type": "text", "text": "Please provide the critical incident number for escalation details."}]}

    try:
        # Call ServiceNow search API
        response = requests.post(f"{BACKEND_URL}/api/search_servicenow",
                               json={"incident_number": incident_number},
                               timeout=15)

        if response.status_code == 200:
            data = response.json()
            incidents = data.get('incidents', [])

            if incidents:
                incident = incidents[0]
                priority = incident.get('priority', '').lower()

                # Critical escalation format
                response_text = f"🚨 **CRITICAL ESCALATION - {incident['number']}**\n\n"
                response_text += f"⚡ **PRIORITY:** {incident['priority']} - IMMEDIATE ATTENTION REQUIRED\n"
                response_text += f"📋 **ISSUE:** {incident['short_description']}\n"
                response_text += f"🎯 **CURRENT STATUS:** {incident['state']}\n"
                response_text += f"👥 **ASSIGNED TEAM:** {incident['assignment_group']}\n"
                response_text += f"📅 **CREATED:** {incident['created_on']}\n\n"

                if 'critical' in priority or '1' in priority:
                    response_text += "🚨 **CRITICAL SLA:** 4 hours maximum resolution time\n"
                elif 'high' in priority or '2' in priority:
                    response_text += "⚠️ **HIGH PRIORITY SLA:** 8 hours resolution target\n"

                if incident['state'].lower() in ['resolved', 'closed']:
                    response_text += "\n✅ **STATUS UPDATE:** This incident has been resolved. Confirming resolution with user."
                else:
                    response_text += f"\n🔄 **URGENT ACTION REQUIRED:** Incident is {incident['state']} - Team needs immediate response."

                response_text += "\n\nDo you need the resolution procedures or SOP guidance for this critical incident?"

                return {"content": [{"type": "text", "text": response_text}]}
            else:
                return {"content": [{"type": "text", "text": f"🚨 **CRITICAL:** Could not locate incident {incident_number} in system. Verify incident number or escalate to senior support."}]}
        else:
            return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM ISSUE:** Cannot access incident database. Escalate to infrastructure team immediately."}]}

    except Exception as e:
        print(f"❌ Critical status check error: {e}")
        return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM FAILURE:** Database connectivity issues. Immediate escalation to infrastructure required."}]}


async def get_sop_document(arguments):
    """Get critical resolution procedures for immediate escalation"""
    issue_type = arguments.get("issue_type", "").strip()

    if not issue_type:
        return {"content": [{"type": "text", "text": "Please specify the critical issue type for emergency resolution procedures."}]}

    try:
        # Search for SOP using the search API
        response = requests.post(f"{BACKEND_URL}/api/search_incidents",
                               json={"description": issue_type},
                               timeout=30)

        if response.status_code == 200:
            data = response.json()

            if data.get('generated_sop'):
                sop_text = data['generated_sop']

                # Extract critical steps for emergency response
                lines = sop_text.split('\n')
                critical_steps = []
                for line in lines[:8]:  # First 8 lines for critical response
                    if line.strip() and ('step' in line.lower() or line.startswith(('1.', '2.', '3.', '4.', '5.'))):
                        critical_steps.append(line.strip())

                response_text = f"🚨 **EMERGENCY SOP - {issue_type.title()}:**\n\n"
                response_text += "⚡ **IMMEDIATE ACTIONS REQUIRED:**\n\n"

                if critical_steps:
                    for i, step in enumerate(critical_steps[:4], 1):  # Limit to 4 critical steps
                        response_text += f"**{i}.** {step}\n"
                    response_text += "\n🔄 **NEXT:** Execute these steps immediately and report status.\n"
                    response_text += "📞 **ESCALATION:** If any step fails, escalate to senior support immediately."
                else:
                    # Fallback to first critical paragraph
                    first_paragraph = sop_text.split('\n\n')[0] if sop_text else ""
                    response_text += f"**CRITICAL PROCEDURE:**\n{first_paragraph[:250]}...\n\n"
                    response_text += "🔄 **ACTION:** Begin this procedure immediately and monitor progress."

                response_text += "\n\nDo you need clarification on any of these critical steps?"

                return {"content": [{"type": "text", "text": response_text}]}
            else:
                return {"content": [{"type": "text", "text": f"🚨 **CRITICAL:** No SOP available for '{issue_type}'. This requires immediate manual intervention by senior technical team."}]}
        else:
            return {"content": [{"type": "text", "text": "🚨 **CRITICAL:** Cannot access SOP database. Escalate to senior support for manual resolution procedures."}]}

    except Exception as e:
        print(f"❌ Critical SOP error: {e}")
        return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM ISSUE:** SOP system unavailable. Immediate escalation to infrastructure team required."}]}


async def execute_resolution_script(arguments):
    """Execute critical automated resolution script for emergency response"""
    script_name = arguments.get("script_name", "").strip()
    ticket_id = arguments.get("ticket_id", "").strip()

    if not script_name:
        return {"content": [{"type": "text", "text": "Please specify which critical resolution script to execute for emergency response."}]}

    try:
        payload = {
            "ticket_id": ticket_id or generate_ticket_reference(),
            "scripts": [script_name],
            "description": f"CRITICAL: Emergency script execution - {script_name}",
            "assignment_group": "Critical Response Team",
            "priority": "critical"
        }

        response = requests.post(f"{BACKEND_URL}/api/execute_scripts",
                               json=payload,
                               timeout=60)

        if response.status_code == 200:
            data = response.json()

            if data.get('success'):
                result = data['result']

                response_text = f"🚨 **CRITICAL SCRIPT EXECUTION - {script_name.upper()}**\n\n"
                response_text += f"📋 **CRITICAL INCIDENT:** {result.get('ticket_id', ticket_id)}\n"
                response_text += f"⚡ **EMERGENCY SCRIPT:** {script_name}\n\n"

                if result.get('resolution_results'):
                    for res in result['resolution_results']:
                        status = res['status']
                        if status == 'success':
                            response_text += f"✅ **EMERGENCY RESOLUTION SUCCESS:**\n{res['resolution']}\n\n"
                        else:
                            response_text += f"🚨 **CRITICAL FAILURE:**\n{res['resolution']}\n\n"

                        if res.get('output'):
                            # Critical output summary
                            output_summary = res['output'][:150] + "..." if len(res['output']) > 150 else res['output']
                            response_text += f"📊 **SYSTEM OUTPUT:** {output_summary}\n\n"

                    # Determine next steps
                    success_count = sum(1 for res in result['resolution_results'] if res['status'] == 'success')
                    if success_count > 0:
                        response_text += "🔄 **NEXT ACTION:** Verify system functionality and confirm resolution with end users."
                    else:
                        response_text += "🚨 **IMMEDIATE ESCALATION REQUIRED:** Script failed - escalate to senior technical team immediately."
                else:
                    response_text += "⚠️ **SCRIPT STATUS:** Execution completed but no results returned. Manual verification required."

                return {"content": [{"type": "text", "text": response_text}]}
            else:
                return {"content": [{"type": "text", "text": f"🚨 **CRITICAL SCRIPT FAILURE:** {data.get('error', 'Unknown error')} - Immediate manual intervention required."}]}
        else:
            return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM ISSUE:** Cannot execute emergency scripts. Escalate to infrastructure team immediately."}]}

    except Exception as e:
        print(f"❌ Critical script execution error: {e}")
        return {"content": [{"type": "text", "text": "🚨 **CRITICAL SYSTEM FAILURE:** Script execution system unavailable. Manual resolution procedures required immediately."}]}

# Health check endpoint
async def health_check(request):
    """Health check"""
    try:
        health_data = {
            "status": "healthy",
            "timestamp": datetime.now().isoformat(),
            "backend_url": BACKEND_URL
        }

        if db:
            tickets_count = db.tickets.count_documents({})
            users_count = db.users.count_documents({})
            health_data.update({
                "tickets": tickets_count,
                "users": users_count
            })

        return JSONResponse(health_data)
    except Exception as e:
        return JSONResponse({
            "status": "unhealthy",
            "error": str(e)
        }, status_code=500)

# Routes
routes = [
    Route("/", handle_mcp_request, methods=["POST"]),
    Route("/mcp", handle_mcp_request, methods=["POST"]),
    Route("/health", health_check, methods=["GET"]),
    Route("/call-context", store_call_context, methods=["POST"]),
]

app = Starlette(routes=routes)

if __name__ == "__main__":
    print("🚨 Critical Incident Escalation MCP Server Starting...")
    print("🔗 MCP Endpoint: / and /mcp")
    print("📞 Emergency escalation calls for critical incidents")
    print("⚡ Focus: Critical incident resolution and SOP guidance")
    print(f"🔗 Backend URL: {BACKEND_URL}")
    uvicorn.run(app, host="0.0.0.0", port=8001)