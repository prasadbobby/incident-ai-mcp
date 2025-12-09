// lib/utils.js - Shared utilities
const { ObjectId } = require('mongodb');

function generateTicketReference() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 9000) + 1000;
    return `INC${year}${month}${day}${random}`;
}

async function findUserByPhone(db, phone) {
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

// In-memory session storage (Note: this won't persist across serverless function calls)
const currentCallSession = {};

module.exports = {
    generateTicketReference,
    findUserByPhone,
    currentCallSession
};