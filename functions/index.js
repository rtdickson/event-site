require('dotenv').config();
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const twilio = require('twilio');
const cors = require('cors');

const corsOptions = {
    origin: ['https://75pinegrove.com', 'http://localhost:8080'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
};
const corsMiddleware = cors(corsOptions);

try {
    admin.initializeApp();
} catch (error) {
    console.error('Error initializing Firebase Admin:', error);
}
const db = admin.firestore();
let twilioClient;
try {
    if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
        console.error('Missing Twilio environment variables');
    } else {
        twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
        console.log('Twilio client initialized successfully');
    }
} catch (error) {
    console.error('Error initializing Twilio client:', error);
}

exports.sendInvites = onRequest({ invoker: 'public' }, async (req, res) => {
    return corsMiddleware(req, res, async () => {
        console.log('sendInvites - Method:', req.method, 'Origin:', req.get('origin'), 'Body:', req.body);
        if (req.method === 'OPTIONS') {
            console.log('Handling OPTIONS request for sendInvites');
            return res.status(204).send('');
        }
        if (req.method !== 'POST') {
            return res.status(405).json({ success: false, error: 'Method Not Allowed' });
        }
        const { eventName, phoneNumbers, message } = req.body;
        if (!eventName || !phoneNumbers || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
            return res.status(400).json({ success: false, error: 'Invalid request: eventName and phoneNumbers are required' });
        }
        try {
            if (!twilioClient) {
                throw new Error('Twilio client not initialized. Check environment variables.');
            }
            for (const phone of phoneNumbers) {
                if (!phone.match(/^\+1\d{10}$/)) {
                    throw new Error(`Invalid phone number: ${phone}`);
                }
                await twilioClient.messages.create({
                    body: message || `You're invited to ${eventName.replace('-', ' ')} at Pine Grove Gatherings! RSVP at https://75pinegrove.com with password FriendsOnly2025`,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: phone
                });
                console.log('Sent SMS to:', phone);
                const contactSnapshot = await db.collection('contacts').where('phone', '==', phone).get();
                if (contactSnapshot.empty) {
                    await db.collection('contacts').add({
                        name: 'Unknown',
                        phone,
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }
            return res.status(200).json({ success: true });
        } catch (error) {
            console.error('Error sending invites:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    });
});

exports.handleSMS = onRequest({ invoker: 'public' }, async (req, res) => {
    return corsMiddleware(req, res, async () => {
        console.log('handleSMS - Method:', req.method, 'Origin:', req.get('origin'), 'Body:', req.body);
        if (req.method === 'OPTIONS') {
            console.log('Handling OPTIONS request for handleSMS');
            return res.status(204).send('');
        }
        const { From, Body } = req.body;
        const eventName = 'dinner-party';
        try {
            if (!twilioClient) {
                throw new Error('Twilio client not initialized. Check environment variables.');
            }
            const responseText = Body.trim().toLowerCase();
            let attending = '';
            let guests = 0;
            if (responseText.startsWith('yes')) {
                attending = 'Yes';
                guests = parseInt(responseText.split(' ')[1]) || 0;
            } else if (responseText.startsWith('no')) {
                attending = 'No';
            } else if (responseText.startsWith('maybe')) {
                attending = 'Maybe';
                guests = parseInt(responseText.split(' ')[1]) || 0;
            } else {
                throw new Error('Invalid response');
            }
            await db.collection(`rsvps-${eventName}`).add({
                name: 'Unknown (SMS)',
                phone: From,
                attending,
                guests,
                notes: '',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            await twilioClient.messages.create({
                body: 'RSVP recorded! Visit https://75pinegrove.com for details.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            console.log('SMS RSVP recorded from:', From);
            return res.status(200).send('<Response></Response>');
        } catch (error) {
            console.error('Error handling SMS:', error);
            return res.status(200).send('<Response></Response>');
        }
    });
});