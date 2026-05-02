require('dotenv').config();
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const twilio = require('twilio');
const cors = require('cors');
const PoolConfig = require('./pool-config.js');

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
            
            // Create default message with SMS instructions if no custom message provided
            const defaultMessage = message || `You're invited to ${eventName.replace('-', ' ')} at Pine Grove Gatherings!

RSVP options:
• Reply to this text: YES [# of guests], MAYBE [# of guests], or NO  
• Or visit https://75pinegrove.com (password: FriendsOnly2025)`;

            for (const phone of phoneNumbers) {
                if (!phone.match(/^\+1\d{10}$/)) {
                    throw new Error(`Invalid phone number: ${phone}`);
                }
                await twilioClient.messages.create({
                    body: defaultMessage,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: phone
                });
                console.log('Sent SMS to:', phone);
                
                // Log the invite with error handling
                try {
                    await db.collection('invites').add({
                        phone: phone,
                        eventName: eventName,
                        message: defaultMessage,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        method: 'sms'
                    });
                    console.log('Invite logged for:', phone);
                } catch (inviteLogError) {
                    console.error('Error logging invite (continuing anyway):', inviteLogError);
                }
                
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
        
        try {
            if (!twilioClient) {
                throw new Error('Twilio client not initialized. Check environment variables.');
            }

            const adminNumbers = ['+16135368709','+16135615101'];
            const messageText = Body.trim();
            const lower = messageText.toLowerCase();

            // MUTE / UNMUTE — per-event opt-out (active event only)
            if (lower === 'mute' || lower === 'unmute') {
                return handleMuteToggle(From, lower === 'mute', res);
            }

            // PICKS — anyone can request their own slip back from the active pool
            if (lower === 'picks') {
                const activeForPicks = await db.collection('events').where('isActive', '==', true).limit(1).get();
                if (!activeForPicks.empty && activeForPicks.docs[0].data().type === 'pool') {
                    return handleMyPicks(From, activeForPicks.docs[0].data(), res);
                }
                await twilioClient.messages.create({
                    body: 'No active pool event right now.',
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: From
                });
                return res.status(200).send('<Response></Response>');
            }

            // STATS — for pool events, anyone can request (gathering STATS stays admin-only below)
            if (lower === 'stats') {
                const activeForStats = await db.collection('events').where('isActive', '==', true).limit(1).get();
                if (!activeForStats.empty && activeForStats.docs[0].data().type === 'pool') {
                    return handlePoolStats(From, activeForStats.docs[0].data(), res);
                }
                // else fall through to admin handler below
            }

            // JULEP — recipe (theme command, works for anyone)
            if (lower === 'julep') {
                await twilioClient.messages.create({
                    body: 'Mint Julep:\n• 2 oz bourbon\n• 1 tsp sugar (or simple syrup)\n• 8-10 mint leaves\n• Crushed ice\n\nMuddle mint with sugar in a copper cup. Fill with crushed ice. Pour bourbon. Stir til frosted. Top with more ice. Garnish with mint sprig. Sip slowly.',
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: From
                });
                return res.status(200).send('<Response></Response>');
            }

            // SAY <message> — relay trash talk to all entrants of the active event
            if (/^say\s+/i.test(messageText)) {
                return handleTrashTalk(From, messageText, res);
            }

            if (adminNumbers.includes(From)) {
                // Handle admin commands
                let responseMessage = '';
                
                if (lower === 'update') {
                    responseMessage = await getEventUpdate();
                } else if (lower === 'wic') {
                    responseMessage = await getWhoIsComing();
                } else if (lower === 'stats') {
                    responseMessage = await getEventStats();
                } else if (lower === 'help') {
                    responseMessage = 'Commands:\nUPDATE - Event details\nWIC - Who is coming\nSTATS - Guest count\nSAY <msg> - trash talk relay\nMUTE / UNMUTE - silence this event\nJULEP - mint julep recipe\nHELP - This message';
                } else {
                    // If admin sends RSVP-style message, treat as regular RSVP
                    return handleRegularRSVP(From, Body);
                }
                
                // Send admin response
                await twilioClient.messages.create({
                    body: responseMessage,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: From
                });
                
                return res.status(200).send('<Response></Response>');
            } else {
                // Handle regular RSVP
                return handleRegularRSVP(From, Body);
            }
            
        } catch (error) {
            console.error('Error handling SMS:', error);
            return res.status(200).send('<Response></Response>');
        }
    });
});

// Move your existing RSVP logic into this function
async function handleRegularRSVP(From, Body) {
    // Find the active event
    const activeEventSnapshot = await db.collection('events').where('isActive', '==', true).limit(1).get();

    if (activeEventSnapshot.empty) {
        console.log('No active event found for SMS RSVP');
        await twilioClient.messages.create({
            body: 'Sorry, there are currently no active events to RSVP for. Visit https://75pinegrove.com for more information.',
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return;
    }

    const activeEvent = activeEventSnapshot.docs[0].data();
    const eventCollectionName = activeEvent.collectionName;
    const eventName = activeEvent.name;

    // Branch: pool events get the PICK parser
    if (activeEvent.type === 'pool') {
        return handlePoolPick(From, Body, activeEvent, eventCollectionName, eventName);
    }

    console.log(`Processing SMS RSVP for active event: ${eventName} (collection: ${eventCollectionName})`);
    
    const responseText = Body.trim().toLowerCase();
    let attending = '';
    let guests = 0;
    
    if (responseText.startsWith('yes')) {
        attending = 'Yes';
        guests = parseInt(responseText.split(' ')[1]) || 1;
    } else if (responseText.startsWith('no')) {
        attending = 'No';
        guests = 0;
    } else if (responseText.startsWith('maybe')) {
        attending = 'Maybe';
        guests = parseInt(responseText.split(' ')[1]) || 1;
    } else {
        await twilioClient.messages.create({
            body: `Please reply with: YES [# guests], NO, or MAYBE [# guests] to RSVP for ${eventName}. Or visit https://75pinegrove.com`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return;
    }
    
    // Save RSVP to the active event's collection
    await db.collection(eventCollectionName).add({
        name: 'Unknown (SMS)',
        phone: From,
        attending,
        guests,
        notes: '',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Send confirmation message with event name
    await twilioClient.messages.create({
        body: `RSVP recorded for ${eventName}! Visit https://75pinegrove.com for event details.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: From
    });
    
    console.log(`SMS RSVP recorded from: ${From} for event: ${eventName}`);
}

// PICKS: return the sender's own slip from the active pool event.
async function handleMyPicks(From, activeEvent, res) {
    try {
        const collection = activeEvent.collectionName;
        const config = activeEvent.poolConfig || {};
        const contestants = config.contestants || [];
        const cById = {};
        contestants.forEach(c => { cById[Number(c.id)] = c; });

        // Forgiving phone match
        const fromNorm = String(From).replace(/\D/g, '').slice(-10);
        const snap = await db.collection(collection).get();
        let entry = null;
        snap.forEach(doc => {
            if (entry) return;
            const d = doc.data();
            const norm = String(d.phone || '').replace(/\D/g, '').slice(-10);
            if (norm === fromNorm) entry = d;
        });

        if (!entry) {
            await twilioClient.messages.create({
                body: `No picks found for you in ${activeEvent.name}. Make picks at https://75pinegrove.com (password: FriendsOnly2025) or text PICK <#> for a quick winner pick.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }

        const picks = entry.picks || {};
        const locks = entry.locks || [];
        const questions = config.questions || [];

        const formatPick = (q, v) => {
            if (Array.isArray(v)) {
                return v.filter(x => x != null).map(id => {
                    const c = cById[Number(id)];
                    return c ? `#${c.id} ${c.name}` : `#${id}`;
                }).join('-');
            }
            if (q.kind === 'pickContestant' || q.kind === 'pickLongshot') {
                const c = cById[Number(v)];
                return c ? `#${c.id} ${c.name}` : `#${v}`;
            }
            return String(v);
        };

        const lines = [];
        questions.forEach(q => {
            const v = picks[q.id];
            if (v === null || v === undefined || v === '') return;
            if (Array.isArray(v) && !v.some(x => x != null && x !== '')) return;
            const lock = locks.includes(q.id) ? ' 🔒' : '';
            // Short label per question for SMS
            const label = q.id === 'win' ? 'Win'
                : q.id === 'place' ? '2nd'
                : q.id === 'show' ? '3rd'
                : q.id === 'tri' ? 'Tri'
                : q.id === 'box3' ? 'Box'
                : q.id === 'longshot' ? 'Longshot'
                : q.id === 'time' ? 'Time'
                : q.id === 'fav' ? 'Fav top-3'
                : q.label || q.id;
            lines.push(`${label}${lock}: ${formatPick(q, v)}`);
        });

        if (lines.length === 0) {
            await twilioClient.messages.create({
                body: `Your slip for ${activeEvent.name} is empty. Make picks at https://75pinegrove.com.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }

        const max = PoolConfig.maxPossiblePayoff(config, entry, contestants);
        let body = `Your picks for ${activeEvent.name}:\n` + lines.join('\n');
        if (locks.length >= 2) {
            body += `\n\n${locks.length}-leg parlay → bonus if all hit`;
        }
        body += `\nPotential purse: $${max.toLocaleString()}`;

        await twilioClient.messages.create({
            body,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return res.status(200).send('<Response></Response>');
    } catch (err) {
        console.error('handleMyPicks error:', err);
        try {
            await twilioClient.messages.create({
                body: 'PICKS hit an error. Try again or visit https://75pinegrove.com.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
        } catch (_) {}
        return res.status(200).send('<Response></Response>');
    }
}

// Pool STATS: leaderboard by potential purse + likeliest/longest shot.
// Available to anyone (not admin-only) when active event is a pool.
async function handlePoolStats(From, activeEvent, res) {
    try {
        const collection = activeEvent.collectionName;
        if (!collection) {
            await twilioClient.messages.create({
                body: 'No entries collection found.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }
        const config = activeEvent.poolConfig || {};
        const contestants = config.contestants || [];
        const snap = await db.collection(collection).get();
        if (snap.empty) {
            await twilioClient.messages.create({
                body: `${activeEvent.name}: no entries yet.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }

        // Look up names from contacts (forgiving phone match)
        const contactsSnap = await db.collection('contacts').get();
        const contactsByNorm = {};
        contactsSnap.forEach(d => {
            const data = d.data();
            if (!data.phone) return;
            const n = String(data.phone).replace(/\D/g, '').slice(-10);
            contactsByNorm[n] = data.name;
        });
        const nameFor = (entry) => {
            const n = String(entry.phone || '').replace(/\D/g, '').slice(-10);
            return contactsByNorm[n] || entry.name || 'Unknown';
        };

        const enriched = snap.docs.map(doc => {
            const d = doc.data();
            return {
                name: nameFor(d),
                max: PoolConfig.maxPossiblePayoff(config, d, contestants),
                prob: PoolConfig.slipProbability(d, config, contestants)
            };
        }).filter(e => e.max > 0);

        if (enriched.length === 0) {
            await twilioClient.messages.create({
                body: `${activeEvent.name}: no picks made yet.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }

        const byPurse = enriched.slice().sort((a, b) => b.max - a.max);
        const byProb = enriched.slice().sort((a, b) => b.prob - a.prob);
        const total = enriched.reduce((s, e) => s + e.max, 0);

        let body = `${activeEvent.name} (${enriched.length} ${enriched.length === 1 ? 'player' : 'players'})\n`;
        body += `Combined potential: $${total.toLocaleString()}\n\n`;
        body += `Potential purses:\n`;
        for (let i = 0; i < byPurse.length; i++) {
            const e = byPurse[i];
            body += `${i+1}. ${e.name}: $${e.max.toLocaleString()} (${PoolConfig.formatOddsAgainst(e.prob)})\n`;
        }
        body += `\nMost likely: ${byProb[0].name} (${PoolConfig.formatOddsAgainst(byProb[0].prob)})\n`;
        body += `Longest shot: ${byProb[byProb.length-1].name} (${PoolConfig.formatOddsAgainst(byProb[byProb.length-1].prob)})`;

        await twilioClient.messages.create({
            body,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return res.status(200).send('<Response></Response>');
    } catch (err) {
        console.error('handlePoolStats error:', err);
        try {
            await twilioClient.messages.create({
                body: 'STATS hit an error. Try again.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
        } catch (_) {}
        return res.status(200).send('<Response></Response>');
    }
}

// Phone normalization: strip non-digits, take last 10
function normalizePhone(p) {
    if (!p) return '';
    const digits = String(p).replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

// E.164 format for Twilio — assumes US/Canada (+1) when no country code
function toE164(phone) {
    if (!phone) return null;
    const s = String(phone).trim();
    if (s.startsWith('+')) return s;
    const digits = s.replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits[0] === '1') return '+' + digits;
    return null; // unrecognized format — caller should skip
}

// Returns the poolConfig.mutedPhones array (normalized), or [] if none
function mutedPhonesFor(event) {
    const list = event && event.poolConfig && event.poolConfig.mutedPhones;
    return Array.isArray(list) ? list.map(normalizePhone) : [];
}

function isMuted(event, phone) {
    return mutedPhonesFor(event).includes(normalizePhone(phone));
}

// MUTE / UNMUTE: toggle the sender on the active event's mutedPhones list
async function handleMuteToggle(From, mute, res) {
    try {
        const activeSnap = await db.collection('events').where('isActive', '==', true).limit(1).get();
        if (activeSnap.empty) {
            await twilioClient.messages.create({
                body: 'No active event right now.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }
        const eventDoc = activeSnap.docs[0];
        const event = eventDoc.data();
        const eventName = event.name || 'this event';

        const current = (event.poolConfig && event.poolConfig.mutedPhones) || [];
        const norm = normalizePhone(From);
        const existing = current.map(normalizePhone);
        let next, replyText;

        if (mute) {
            if (existing.includes(norm)) {
                replyText = `You're already muted for ${eventName}. Reply UNMUTE to turn messages back on.`;
                next = current;
            } else {
                next = current.concat([From]);
                replyText = `Muted for ${eventName}. You'll still get pick confirmations for your own submits, but no more chatter or alerts. Reply UNMUTE to undo.`;
            }
        } else {
            if (!existing.includes(norm)) {
                replyText = `You weren't muted for ${eventName}.`;
                next = current;
            } else {
                next = current.filter(p => normalizePhone(p) !== norm);
                replyText = `Unmuted — you'll get ${eventName} updates again.`;
            }
        }

        if (next !== current) {
            await db.collection('events').doc(eventDoc.id).update({
                'poolConfig.mutedPhones': next
            });
        }

        await twilioClient.messages.create({
            body: replyText,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return res.status(200).send('<Response></Response>');
    } catch (err) {
        console.error('handleMuteToggle error:', err);
        return res.status(200).send('<Response></Response>');
    }
}

// SAY <message> — relay trash talk to all entrants of the active event.
// Sender's name from contacts collection (falls back to phone last 4).
// Excludes the sender. Reply with delivery count.
async function handleTrashTalk(From, Body, res) {
    console.log('SAY received from', From, 'body:', JSON.stringify(Body));
    try {
        const message = Body.replace(/^say\s+/i, '').trim();
        console.log('SAY message extracted:', JSON.stringify(message));
        if (!message) {
            await twilioClient.messages.create({
                body: 'SAY needs a message. Try: SAY this trifecta is going to crush you',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }
        if (message.length > 200) {
            await twilioClient.messages.create({
                body: 'Keep SAY messages under 200 characters.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }

        // Find active event
        const activeSnap = await db.collection('events').where('isActive', '==', true).limit(1).get();
        if (activeSnap.empty) {
            await twilioClient.messages.create({
                body: 'No active event to broadcast to.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }
        const activeEvent = activeSnap.docs[0].data();
        const collection = activeEvent.collectionName;
        if (!collection) {
            return res.status(200).send('<Response></Response>');
        }

        // Look up sender name from contacts (forgiving phone match)
        const fromNorm = String(From).replace(/\D/g, '').slice(-10);
        let senderName = null;
        const contactsSnap = await db.collection('contacts').get();
        contactsSnap.forEach(doc => {
            const d = doc.data();
            if (!d.phone) return;
            const norm = String(d.phone).replace(/\D/g, '').slice(-10);
            if (norm === fromNorm) senderName = d.name || senderName;
        });
        // Fallback: name from sender's pool entry, then last-4-digits
        if (!senderName) {
            try {
                const entrySnap = await db.collection(collection).get();
                entrySnap.forEach(doc => {
                    if (senderName) return;
                    const d = doc.data();
                    const norm = String(d.phone || '').replace(/\D/g, '').slice(-10);
                    if (norm === fromNorm && d.name && !/^unknown/i.test(d.name)) {
                        senderName = d.name;
                    }
                });
            } catch (e) { console.warn('Entry name fallback failed:', e); }
        }
        if (!senderName) senderName = From.slice(-4);

        // Get all entrant phones (skip sender + muted)
        const entriesSnap = await db.collection(collection).get();
        const phones = new Set();
        entriesSnap.forEach(doc => {
            const p = (doc.data() || {}).phone;
            if (!p) return;
            const norm = normalizePhone(p);
            if (norm === fromNorm) return; // skip sender
            if (isMuted(activeEvent, p)) return; // skip muted
            phones.add(p);
        });
        console.log('SAY targets (raw phones):', Array.from(phones));

        if (phones.size === 0) {
            await twilioClient.messages.create({
                body: 'No one else has entered yet — your trash talk needs an audience.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }

        const relayText = `[${senderName}] ${message}\nReply MUTE to silence this event.`;
        let sent = 0, failed = 0;
        for (const phone of phones) {
            const to = toE164(phone);
            if (!to) { console.warn('Skipping unparseable phone:', phone); failed++; continue; }
            try {
                await twilioClient.messages.create({
                    body: relayText,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to
                });
                sent++;
            } catch (e) {
                console.error('SAY relay failed for', phone, '→', to, e.message);
                failed++;
            }
        }

        await twilioClient.messages.create({
            body: `Relayed to ${sent} ${sent === 1 ? 'person' : 'people'}${failed ? ` (${failed} failed)` : ''}.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });

        return res.status(200).send('<Response></Response>');
    } catch (err) {
        console.error('handleTrashTalk error:', err);
        try {
            await twilioClient.messages.create({
                body: 'SAY relay hit an error. Try again.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
        } catch (_) {}
        return res.status(200).send('<Response></Response>');
    }
}

// Outbound notifications: confirmations to players, alerts to admin, broadcast to entrants.
// Called from the web client (after pool submit) and the admin pool panel (broadcast).
const ADMIN_NUMBERS = ['+16135368709', '+16135615101'];

exports.sendNotification = onRequest({ invoker: 'public' }, async (req, res) => {
    return corsMiddleware(req, res, async () => {
        if (req.method === 'OPTIONS') return res.status(204).send('');
        if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });

        try {
            if (!twilioClient) throw new Error('Twilio not initialized');

            const { action, eventId, playerName, playerPhone, pickSummary, message, adminPin } = req.body || {};
            if (!action || !eventId) {
                return res.status(400).json({ success: false, error: 'action and eventId required' });
            }

            const eventSnap = await db.collection('events').doc(eventId).get();
            if (!eventSnap.exists) {
                return res.status(404).json({ success: false, error: 'Event not found' });
            }
            const event = eventSnap.data();

            if (action === 'entry-confirm') {
                if (!playerPhone) return res.status(400).json({ success: false, error: 'playerPhone required' });
                const to = toE164(playerPhone);
                if (!to) return res.status(400).json({ success: false, error: 'unparseable playerPhone' });
                const text = `Got your picks for ${event.name}! ${pickSummary ? '\n' + pickSummary + '\n' : ''}Edit anytime before close: https://75pinegrove.com`;
                await twilioClient.messages.create({
                    body: text,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to
                });
                return res.status(200).json({ success: true });
            }

            if (action === 'entry-admin-notify') {
                const text = `[${event.name}] ${playerName || 'Someone'} just submitted picks${pickSummary ? ': ' + pickSummary : '.'}`;
                for (const num of ADMIN_NUMBERS) {
                    try {
                        await twilioClient.messages.create({
                            body: text,
                            from: process.env.TWILIO_PHONE_NUMBER,
                            to: num
                        });
                    } catch (e) {
                        console.error('Admin notify failed for', num, e.message);
                    }
                }
                return res.status(200).json({ success: true });
            }

            // entry-submitted: combined action — confirm to player, notify admin, alert anyone
            // who picked the same winner. Only sends match alerts on new entries or when the
            // winner pick changed (client passes winnerChanged boolean).
            if (action === 'entry-submitted') {
                const { winnerPick, winnerChanged, isNewEntry } = req.body || {};

                // 1) Confirm to player
                const playerTo = toE164(playerPhone);
                if (playerTo) {
                    try {
                        await twilioClient.messages.create({
                            body: `Got your picks for ${event.name}! ${pickSummary ? '\n' + pickSummary + '\n' : ''}Edit anytime before close: https://75pinegrove.com`,
                            from: process.env.TWILIO_PHONE_NUMBER,
                            to: playerTo
                        });
                    } catch (e) { console.error('Confirm SMS failed:', e.message); }
                }

                // 2) Notify admins
                const adminText = `[${event.name}] ${playerName || 'Someone'} just ${isNewEntry ? 'submitted' : 'updated'} picks${pickSummary ? ': ' + pickSummary : '.'}`;
                const playerNorm = normalizePhone(playerPhone);
                for (const num of ADMIN_NUMBERS) {
                    if (normalizePhone(num) === playerNorm) continue; // don't double-text admin if they submitted
                    try {
                        await twilioClient.messages.create({
                            body: adminText,
                            from: process.env.TWILIO_PHONE_NUMBER,
                            to: num
                        });
                    } catch (e) { console.error('Admin notify failed for', num, e.message); }
                }

                // 3) Match alert: someone picked the same winner (skip muted phones)
                let matchesSent = 0;
                if (winnerPick && (isNewEntry || winnerChanged)) {
                    const config = event.poolConfig || {};
                    const contestants = config.contestants || [];
                    const winContestant = contestants.find(c => Number(c.id) === Number(winnerPick));
                    const horseLabel = winContestant ? `#${winContestant.id} ${winContestant.name}` : `#${winnerPick}`;

                    if (event.collectionName) {
                        const playerNorm2 = normalizePhone(playerPhone);
                        const entrySnap = await db.collection(event.collectionName).get();
                        for (const doc of entrySnap.docs) {
                            const d = doc.data();
                            if (!d.phone) continue;
                            if (normalizePhone(d.phone) === playerNorm2) continue;
                            if (Number((d.picks || {}).win) !== Number(winnerPick)) continue;
                            if (isMuted(event, d.phone)) continue;
                            const to = toE164(d.phone);
                            if (!to) { console.warn('Skipping unparseable phone for match alert:', d.phone); continue; }
                            try {
                                await twilioClient.messages.create({
                                    body: `[${event.name}] ${playerName || 'Someone'} just picked ${horseLabel} too — you've got company on that pick. https://75pinegrove.com\nReply MUTE to silence this event.`,
                                    from: process.env.TWILIO_PHONE_NUMBER,
                                    to
                                });
                                matchesSent++;
                            } catch (e) { console.error('Match alert failed for', d.phone, '→', to, e.message); }
                        }
                    }
                }

                return res.status(200).json({ success: true, matchesSent });
            }

            if (action === 'broadcast') {
                // Light gate: require admin pin matching env var. Set via firebase functions:config or .env.
                const expectedPin = process.env.ADMIN_PIN;
                if (!expectedPin || adminPin !== expectedPin) {
                    return res.status(403).json({ success: false, error: 'Bad admin pin' });
                }
                if (!message) return res.status(400).json({ success: false, error: 'message required' });

                const collection = event.collectionName;
                if (!collection) return res.status(400).json({ success: false, error: 'Event has no collectionName' });

                const entrySnap = await db.collection(collection).get();
                const phones = new Set();
                entrySnap.forEach(doc => {
                    const p = (doc.data() || {}).phone;
                    if (p) phones.add(p);
                });

                const broadcastBody = `${message}\n\nReply MUTE to silence this event.`;
                let sent = 0, failed = 0, muted = 0;
                for (const phone of phones) {
                    if (isMuted(event, phone)) { muted++; continue; }
                    const to = toE164(phone);
                    if (!to) { console.warn('Skipping unparseable phone:', phone); failed++; continue; }
                    try {
                        await twilioClient.messages.create({
                            body: broadcastBody,
                            from: process.env.TWILIO_PHONE_NUMBER,
                            to
                        });
                        sent++;
                    } catch (e) {
                        console.error('Broadcast failed for', phone, '→', to, e.message);
                        failed++;
                    }
                }
                return res.status(200).json({ success: true, sent, failed, muted, total: phones.size });
            }

            return res.status(400).json({ success: false, error: 'Unknown action' });
        } catch (err) {
            console.error('sendNotification error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    });
});

// Pool: parse "PICK n" SMS, save as a pool entry on the active pool event.
// MVP: only the winner pick is supported via SMS; full slip building stays on the web.
async function handlePoolPick(From, Body, activeEvent, eventCollectionName, eventName) {
    const config = activeEvent.poolConfig || {};
    const contestants = config.contestants || [];
    const closesAt = config.closesAt;
    const now = Date.now();
    const closesMs = closesAt && closesAt.toMillis ? closesAt.toMillis()
                  : closesAt && closesAt.seconds ? closesAt.seconds * 1000
                  : null;

    const responseText = (Body || '').trim().toLowerCase();

    // Help / status text
    if (responseText === 'help' || responseText === '') {
        await twilioClient.messages.create({
            body: `${eventName} pool.\nPICK <#> - winner pick (e.g. PICK 7)\nPICKS - your slip\nSTATS - leaderboard & odds\nSAY <msg> - trash talk to all entrants\nMUTE / UNMUTE - silence this event\nJULEP - mint julep recipe\nFull slip (parlays, props): https://75pinegrove.com`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return;
    }

    if (closesMs && now > closesMs) {
        await twilioClient.messages.create({
            body: `Picks for ${eventName} are locked. Standings will post after the race at https://75pinegrove.com.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return;
    }

    const m = responseText.match(/^pick\s+(\d+)\b/);
    if (!m) {
        await twilioClient.messages.create({
            body: `Reply PICK <number> with your winner pick for ${eventName} (e.g. PICK 7). Visit https://75pinegrove.com for the full slip.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return;
    }

    const pickNum = parseInt(m[1], 10);
    const contestant = contestants.find(c => Number(c.id) === pickNum);
    if (!contestant) {
        const validRange = contestants.length > 0 ? `1-${Math.max(...contestants.map(c => c.id))}` : 'the field';
        await twilioClient.messages.create({
            body: `#${pickNum} isn't in the field. Pick from ${validRange}. Reply PICK <n>.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return;
    }

    // Upsert: if this phone already has an entry, update it; else create.
    const existing = await db.collection(eventCollectionName)
        .where('phone', '==', From)
        .limit(1)
        .get();

    const payload = {
        phone: From,
        name: existing.empty ? 'Unknown (SMS)' : (existing.docs[0].data().name || 'Unknown (SMS)'),
        picks: Object.assign({}, existing.empty ? {} : (existing.docs[0].data().picks || {}), { win: pickNum }),
        locks: existing.empty ? [] : (existing.docs[0].data().locks || []),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    if (existing.empty) {
        await db.collection(eventCollectionName).add(payload);
    } else {
        await db.collection(eventCollectionName).doc(existing.docs[0].id).update(payload);
    }

    await twilioClient.messages.create({
        body: `Got it — winner pick: #${pickNum} ${contestant.name} (${contestant.odds}). Add a parlay or other picks at https://75pinegrove.com.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: From
    });

    console.log(`SMS pool pick recorded from ${From}: #${pickNum} ${contestant.name}`);
}

// Add these new admin command functions
async function getEventUpdate() {
    const activeEvent = await getActiveEventData();
    if (!activeEvent) return 'No active event found.';
    
    const { eventData } = activeEvent;
    
    let message = `${eventData.name}\n`;
    message += `Date: ${eventData.date}\n`;
    if (eventData.description) {
        message += `Details: ${eventData.description}\n`;
    }
    if (eventData.whatToBring) {
        message += `Bring: ${eventData.whatToBring}\n`;
    }
    
    return message;
}

async function getWhoIsComing() {
    const activeEvent = await getActiveEventData();
    if (!activeEvent) return 'No active event found.';
    
    const { eventData, rsvps } = activeEvent;
    
    const attendees = [];
    rsvps.forEach(doc => {
        const rsvp = doc.data();
        if (rsvp.attending === 'Yes' || rsvp.attending === 'Maybe') {
            const guests = rsvp.guests > 1 ? ` +${rsvp.guests - 1}` : '';
            const status = rsvp.attending === 'Maybe' ? ' (Maybe)' : '';
            attendees.push(`${rsvp.name}${guests}${status}`);
        }
    });
    
    if (attendees.length === 0) {
        return `${eventData.name}: No confirmed attendees yet.`;
    }
    
    let message = `${eventData.name} - Coming:\n\n`;
    message += attendees.join('\n');
    
    return message.length > 1500 ? message.substring(0, 1400) + '...(more)' : message;
}

async function getEventStats() {
    const activeEvent = await getActiveEventData();
    if (!activeEvent) return 'No active event found.';
    
    const { eventData, rsvps } = activeEvent;
    
    let yesCount = 0, maybeCount = 0, noCount = 0;
    
    rsvps.forEach(doc => {
        const rsvp = doc.data();
        const guests = rsvp.guests || 1;
        
        if (rsvp.attending === 'Yes') {
            yesCount += guests;
        } else if (rsvp.attending === 'Maybe') {
            maybeCount += guests;
        } else if (rsvp.attending === 'No') {
            noCount += guests;
        }
    });
    
    return `${eventData.name}\nYes: ${yesCount} guests\nMaybe: ${maybeCount} guests\nNo: ${noCount} guests\nTotal Expected: ${yesCount + maybeCount}`;
}

async function getActiveEventData() {
    const activeEventSnapshot = await db.collection('events')
        .where('isActive', '==', true)
        .limit(1)
        .get();
    
    if (activeEventSnapshot.empty) {
        return null;
    }
    
    const eventData = activeEventSnapshot.docs[0].data();
    
    const rsvpSnapshot = await db.collection(eventData.collectionName)
        .orderBy('timestamp', 'desc')
        .get();
    
    return {
        eventData,
        rsvps: rsvpSnapshot
    };
}