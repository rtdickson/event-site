require('dotenv').config();
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
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

// ============================================================================
// Multi-event SMS routing (Phase 1)
// ============================================================================
// resolveTargetEvent(from, body, typeHint) returns:
//   { event, eventDoc, code, source, body: cleanedBody }    — success
//   { event: null, source: 'none', error: 'no-events' | 'ambiguous', candidates }
//
// source ∈ 'explicit-code' | 'sms-context' | 'single-accepting' | 'single-featured' | 'none'
// typeHint ∈ 'pool' | 'gathering' | null   (null = match any)
//
// Resolution order:
//   1. Explicit code in the body (e.g., "STATS PKNS26")
//   2. sms-context for the sender (their last event)
//   3. Single accepting event matching the type hint
//   4. Single featured (visible, not archived) event matching the type hint
//   5. Ambiguous — return candidates so the caller can prompt the user
async function resolveTargetEvent(from, body, typeHint = null) {
    const rawBody = String(body || '');
    const tokens = rawBody.trim().toLowerCase().split(/\s+/);

    // 1) Explicit code
    const candidateCodes = tokens.filter(t => /^[a-z0-9]{3,12}$/.test(t));
    for (const code of candidateCodes) {
        const snap = await db.collection('events').where('eventCode', '==', code).limit(1).get();
        if (!snap.empty) {
            const doc = snap.docs[0];
            const cleaned = stripCode(rawBody, code);
            return { event: doc.data(), eventDoc: doc, code, source: 'explicit-code', body: cleaned };
        }
    }

    // 2) sms-context for the sender (only honored if type still matches and event is reachable)
    const norm = normalizePhone(from);
    if (norm) {
        try {
            const ctxSnap = await db.collection('sms-context').doc(norm).get();
            if (ctxSnap.exists) {
                const lastCode = ctxSnap.data().lastEventCode;
                if (lastCode) {
                    const codeSnap = await db.collection('events').where('eventCode', '==', lastCode).limit(1).get();
                    if (!codeSnap.empty) {
                        const doc = codeSnap.docs[0];
                        const data = doc.data();
                        const lc = data.lifecycle || (data.isFeatured || data.isActive ? 'accepting' : 'archived');
                        const matchesType = !typeHint || data.type === typeHint;
                        const reachable = lc === 'accepting' || lc === 'locked' || lc === 'complete';
                        if (matchesType && reachable) {
                            return { event: data, eventDoc: doc, code: lastCode, source: 'sms-context', body: rawBody };
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[resolveTargetEvent] sms-context lookup failed:', e.message);
        }
    }

    // 3) Single accepting event of the right type
    const acceptingSnap = await db.collection('events').where('lifecycle', '==', 'accepting').get();
    let candidates = acceptingSnap.docs.map(d => ({ doc: d, data: d.data() }));
    if (typeHint) candidates = candidates.filter(c => (c.data.type || 'gathering') === typeHint);
    if (candidates.length === 1) {
        const c = candidates[0];
        return { event: c.data, eventDoc: c.doc, code: c.data.eventCode, source: 'single-accepting', body: rawBody };
    }

    // 4) Fallback: single featured (visible) event of the right type — covers legacy events
    //    not yet migrated to lifecycle but still flagged isActive/isFeatured
    if (candidates.length === 0) {
        const featSnap = await db.collection('events').get();
        let wider = featSnap.docs
            .map(d => ({ doc: d, data: d.data() }))
            .filter(c => (c.data.isFeatured !== undefined ? c.data.isFeatured : c.data.isActive))
            .filter(c => {
                const lc = c.data.lifecycle;
                return !lc || (lc !== 'draft' && lc !== 'archived');
            });
        if (typeHint) wider = wider.filter(c => (c.data.type || 'gathering') === typeHint);
        if (wider.length === 1) {
            const c = wider[0];
            return { event: c.data, eventDoc: c.doc, code: c.data.eventCode, source: 'single-featured', body: rawBody };
        }
        if (wider.length > 1) {
            return {
                event: null, source: 'none', error: 'ambiguous',
                candidates: wider.map(c => ({ code: c.data.eventCode, name: c.data.name, type: c.data.type }))
            };
        }
        return { event: null, source: 'none', error: 'no-events' };
    }

    // Multiple accepting — ambiguous
    return {
        event: null, source: 'none', error: 'ambiguous',
        candidates: candidates.map(c => ({ code: c.data.eventCode, name: c.data.name, type: c.data.type }))
    };
}

function stripCode(body, code) {
    if (!code) return body;
    const re = new RegExp('\\b' + code + '\\b', 'gi');
    return String(body).replace(re, '').replace(/\s+/g, ' ').trim();
}

async function writeSmsContext(from, code) {
    if (!code) return;
    const norm = normalizePhone(from);
    if (!norm) return;
    try {
        await db.collection('sms-context').doc(norm).set({
            phone: from,
            lastEventCode: code,
            lastInteractionAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn('[sms-context] write failed:', err.message);
    }
}

// Build the "I'm confused, here are your options" reply for an ambiguous resolution.
function ambiguousReply(verb, resolution) {
    if (!resolution.candidates || resolution.candidates.length === 0) {
        return `No active events right now. Visit https://75pinegrove.com.`;
    }
    const examples = resolution.candidates
        .filter(c => c.code)
        .slice(0, 3)
        .map(c => `${verb} ${c.code.toUpperCase()}${verb === 'YES' ? ' [# guests]' : ''}`)
        .join(' or ');
    return `Multiple events are open. Reply with: ${examples}.`;
}

function noEventReply(typeHint) {
    if (typeHint === 'pool') return 'No pool is open right now. Visit https://75pinegrove.com.';
    if (typeHint === 'gathering') return 'No gathering is open right now. Visit https://75pinegrove.com.';
    return 'No active events right now. Visit https://75pinegrove.com.';
}

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
            // First token after optional verb (used to detect command verbs robustly)
            const firstToken = lower.split(/\s+/)[0] || '';

            // JULEP — recipe (theme command, works for anyone; no event context needed)
            if (lower === 'julep' || firstToken === 'julep') {
                await twilioClient.messages.create({
                    body: 'Mint Julep:\n• 2 oz bourbon\n• 1 tsp sugar (or simple syrup)\n• 8-10 mint leaves\n• Crushed ice\n\nMuddle mint with sugar in a copper cup. Fill with crushed ice. Pour bourbon. Stir til frosted. Top with more ice. Garnish with mint sprig. Sip slowly.',
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: From
                });
                return res.status(200).send('<Response></Response>');
            }

            // MUTE / UNMUTE — apply to the resolved event (any type)
            if (firstToken === 'mute' || firstToken === 'unmute') {
                const resolution = await resolveTargetEvent(From, messageText, null);
                if (!resolution.event) {
                    await twilioClient.messages.create({
                        body: resolution.error === 'ambiguous' ? ambiguousReply(firstToken.toUpperCase(), resolution) : 'No active event to mute/unmute.',
                        from: process.env.TWILIO_PHONE_NUMBER, to: From
                    });
                    return res.status(200).send('<Response></Response>');
                }
                await writeSmsContext(From, resolution.code);
                return handleMuteToggle(From, firstToken === 'mute', resolution.eventDoc, resolution.event, res);
            }

            // PICKS — pool-scoped
            if (firstToken === 'picks') {
                const resolution = await resolveTargetEvent(From, messageText, 'pool');
                if (!resolution.event) {
                    await twilioClient.messages.create({
                        body: resolution.error === 'ambiguous' ? ambiguousReply('PICKS', resolution) : noEventReply('pool'),
                        from: process.env.TWILIO_PHONE_NUMBER, to: From
                    });
                    return res.status(200).send('<Response></Response>');
                }
                await writeSmsContext(From, resolution.code);
                return handleMyPicks(From, resolution.event, res);
            }

            // STATS — pool-scoped if a pool is reachable, else falls through to admin gathering stats below
            if (firstToken === 'stats') {
                const resolution = await resolveTargetEvent(From, messageText, 'pool');
                if (resolution.event) {
                    await writeSmsContext(From, resolution.code);
                    return handlePoolStats(From, resolution.event, res);
                }
                // No pool reachable — admin gathering STATS handler below will pick this up
            }

            // SAY <message> — trash talk relay to the resolved pool's entrants
            if (firstToken === 'say') {
                const resolution = await resolveTargetEvent(From, messageText, 'pool');
                if (!resolution.event) {
                    await twilioClient.messages.create({
                        body: resolution.error === 'ambiguous' ? ambiguousReply('SAY', resolution) : noEventReply('pool'),
                        from: process.env.TWILIO_PHONE_NUMBER, to: From
                    });
                    return res.status(200).send('<Response></Response>');
                }
                await writeSmsContext(From, resolution.code);
                return handleTrashTalk(From, resolution.body || messageText, resolution.event, res);
            }

            // PICK <#>  — pool-scoped winner pick (must come AFTER the verb-only commands above)
            if (firstToken === 'pick') {
                const resolution = await resolveTargetEvent(From, messageText, 'pool');
                if (!resolution.event) {
                    await twilioClient.messages.create({
                        body: resolution.error === 'ambiguous' ? ambiguousReply('PICK', resolution) : noEventReply('pool'),
                        from: process.env.TWILIO_PHONE_NUMBER, to: From
                    });
                    return res.status(200).send('<Response></Response>');
                }
                await writeSmsContext(From, resolution.code);
                return handlePoolPick(From, resolution.body || messageText, resolution.event, resolution.event.collectionName, resolution.event.name);
            }

            // Admin-only verbs against the resolved gathering
            if (adminNumbers.includes(From) && (lower === 'update' || lower === 'wic' || lower === 'help' || lower === 'stats')) {
                let responseMessage = '';
                if (lower === 'help') {
                    responseMessage = 'Commands:\nUPDATE - Event details\nWIC - Who is coming\nSTATS - Guest count or pool leaderboard\nPICKS - your pool slip\nPICK <#> - quick pool winner pick\nSAY <msg> - trash talk relay\nMUTE / UNMUTE - silence an event\nJULEP - recipe\n\nAppend an event code (e.g. STATS BEL26) to target a specific event when multiple are live.';
                } else {
                    const resolution = await resolveTargetEvent(From, messageText, 'gathering');
                    if (!resolution.event) {
                        responseMessage = resolution.error === 'ambiguous' ? ambiguousReply(lower.toUpperCase(), resolution) : noEventReply('gathering');
                    } else {
                        await writeSmsContext(From, resolution.code);
                        if (lower === 'update') responseMessage = await getEventUpdate(resolution.event);
                        else if (lower === 'wic') responseMessage = await getWhoIsComing(resolution.event);
                        else if (lower === 'stats') responseMessage = await getEventStats(resolution.event);
                    }
                }
                await twilioClient.messages.create({
                    body: responseMessage,
                    from: process.env.TWILIO_PHONE_NUMBER, to: From
                });
                return res.status(200).send('<Response></Response>');
            }

            // Fall through: treat as RSVP (YES/NO/MAYBE) or pool fallback
            return handleRegularRSVP(From, Body);
            
        } catch (error) {
            console.error('Error handling SMS:', error);
            return res.status(200).send('<Response></Response>');
        }
    });
});

// Handles bare YES/NO/MAYBE replies (and bare-message fallthroughs).
// Uses resolveTargetEvent so multi-event scenarios route correctly.
async function handleRegularRSVP(From, Body) {
    const lower = (Body || '').trim().toLowerCase();
    const firstToken = lower.split(/\s+/)[0] || '';
    const isRsvpVerb = firstToken === 'yes' || firstToken === 'no' || firstToken === 'maybe';

    // Type hint: RSVP verbs strongly suggest gathering, but with no verb we can match either type
    const typeHint = isRsvpVerb ? 'gathering' : null;
    const resolution = await resolveTargetEvent(From, Body, typeHint);

    if (!resolution.event) {
        const msg = resolution.error === 'ambiguous'
            ? ambiguousReply(isRsvpVerb ? firstToken.toUpperCase() : 'YES', resolution)
            : 'Sorry, no active events to respond to right now. Visit https://75pinegrove.com for details.';
        await twilioClient.messages.create({ body: msg, from: process.env.TWILIO_PHONE_NUMBER, to: From });
        return;
    }

    const activeEvent = resolution.event;
    const eventCollectionName = activeEvent.collectionName;
    const eventName = activeEvent.name;
    const cleanedBody = resolution.body || Body;

    // Branch: pool events get the PICK parser (handles bare "PICK 7" style messages)
    if (activeEvent.type === 'pool') {
        await writeSmsContext(From, resolution.code);
        return handlePoolPick(From, cleanedBody, activeEvent, eventCollectionName, eventName);
    }

    console.log(`Processing SMS RSVP for: ${eventName} (collection: ${eventCollectionName})`);

    const responseText = cleanedBody.trim().toLowerCase();
    let attending = '';
    let guests = 0;

    if (responseText.startsWith('yes')) {
        attending = 'Yes';
        guests = parseInt(responseText.split(/\s+/)[1]) || 1;
    } else if (responseText.startsWith('no')) {
        attending = 'No';
        guests = 0;
    } else if (responseText.startsWith('maybe')) {
        attending = 'Maybe';
        guests = parseInt(responseText.split(/\s+/)[1]) || 1;
    } else {
        const codeHint = resolution.code ? ` (or add code ${resolution.code.toUpperCase()})` : '';
        await twilioClient.messages.create({
            body: `Reply YES [# guests], NO, or MAYBE [# guests] to RSVP for ${eventName}${codeHint}. Or visit https://75pinegrove.com`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return;
    }

    await db.collection(eventCollectionName).add({
        name: 'Unknown (SMS)',
        phone: From,
        attending,
        guests,
        notes: '',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    await writeSmsContext(From, resolution.code);

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

        const isAlloc = PoolConfig.isAllocationMode(config);

        const formatPick = (q, rawV) => {
            const v = PoolConfig.getPickValue(rawV);
            if (Array.isArray(v)) {
                return v.filter(x => x != null).map(id => {
                    const c = cById[Number(id)];
                    return c ? `#${c.id} ${c.name}` : `#${id}`;
                }).join(', ');
            }
            if (q.kind === 'pickContestant' || q.kind === 'pickLongshot' || q.kind === 'pickInTopN') {
                const c = cById[Number(v)];
                return c ? `#${c.id} ${c.name}` : `#${v}`;
            }
            if (q.kind === 'autoProp') {
                return '(auto-prop)';
            }
            return String(v);
        };

        const shortLabel = (q) => {
            return q.id === 'win' ? 'Win'
                : q.id === 'place' ? '2nd'
                : q.id === 'show' ? '3rd'
                : q.id === 'tri' ? 'Tri'
                : q.id === 'box3' ? 'Box'
                : q.id === 'longshot' ? 'Longshot'
                : q.id === 'time' ? 'Time'
                : q.id === 'timeou' ? 'Time O/U'
                : q.id === 'fav' ? 'Fav top-3'
                : q.id === 'top5' ? 'Top 5'
                : q.id === 'exacta' ? 'Exacta'
                : q.label || q.id;
        };

        const lines = [];
        questions.forEach(q => {
            const rawV = picks[q.id];
            const v = PoolConfig.getPickValue(rawV);
            const stake = PoolConfig.getPickStake(rawV);
            const isAutoProp = q.kind === 'autoProp';
            // For non-autoProp, skip if no pick. For autoProp, include if staked (allocation) or always (fixed)
            if (!isAutoProp) {
                if (v === null || v === undefined || v === '') return;
                if (Array.isArray(v) && !v.some(x => x != null && x !== '')) return;
            } else if (isAlloc && (stake === null || stake <= 0)) {
                return;
            }
            const lock = locks.includes(q.id) ? ' 🔒' : '';
            const label = shortLabel(q);
            if (isAlloc) {
                const stakeStr = `$${(stake || 0).toLocaleString()}`;
                const pickStr = isAutoProp ? '' : ' — ' + formatPick(q, rawV);
                lines.push(`${label} (${stakeStr})${pickStr}`);
            } else {
                lines.push(`${label}${lock}: ${formatPick(q, rawV)}`);
            }
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
        if (locks.length >= 2 && !isAlloc) {
            body += `\n\n${locks.length}-leg parlay → bonus if all hit`;
        }
        if (isAlloc) {
            const totalStaked = questions.reduce((s, q) => {
                const st = PoolConfig.getPickStake(picks[q.id]);
                return s + (st || 0);
            }, 0);
            body += `\n\nTotal staked: $${totalStaked.toLocaleString()}`;
            body += `\nMax possible: $${max.toLocaleString()}`;
        } else {
            body += `\nPotential purse: $${max.toLocaleString()}`;
        }

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

        const isAlloc = PoolConfig.isAllocationMode(config);
        const byPurse = enriched.slice().sort((a, b) => b.max - a.max);
        const total = enriched.reduce((s, e) => s + e.max, 0);

        let body = `${activeEvent.name} (${enriched.length} ${enriched.length === 1 ? 'player' : 'players'})\n`;
        body += `Combined max possible: $${total.toLocaleString()}\n\n`;
        body += isAlloc ? `Max possible per player (all bets hit):\n` : `Potential purses:\n`;
        for (let i = 0; i < byPurse.length; i++) {
            const e = byPurse[i];
            if (isAlloc) {
                // Gradient/multi-bet — odds heuristic isn't meaningful, drop it
                body += `${i+1}. ${e.name}: $${e.max.toLocaleString()}\n`;
            } else {
                body += `${i+1}. ${e.name}: $${e.max.toLocaleString()} (${PoolConfig.formatOddsAgainst(e.prob)})\n`;
            }
        }
        if (!isAlloc) {
            const byProb = enriched.slice().sort((a, b) => b.prob - a.prob);
            body += `\nMost likely: ${byProb[0].name} (${PoolConfig.formatOddsAgainst(byProb[0].prob)})\n`;
            body += `Longest shot: ${byProb[byProb.length-1].name} (${PoolConfig.formatOddsAgainst(byProb[byProb.length-1].prob)})`;
        }

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

// MUTE / UNMUTE: toggle the sender on the resolved event's mutedPhones list
async function handleMuteToggle(From, mute, eventDoc, event, res) {
    try {
        if (!eventDoc || !event) {
            await twilioClient.messages.create({
                body: 'No event to mute/unmute. Visit https://75pinegrove.com for what is live.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }
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

// SAY <message> — relay trash talk to all entrants of the resolved event.
// Sender's name from contacts collection (falls back to phone last 4).
// Excludes the sender. Reply with delivery count.
async function handleTrashTalk(From, Body, activeEvent, res) {
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

        if (!activeEvent) {
            await twilioClient.messages.create({
                body: 'No active event to broadcast to.',
                from: process.env.TWILIO_PHONE_NUMBER,
                to: From
            });
            return res.status(200).send('<Response></Response>');
        }
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
                // Skip "X picked your horse" alerts for allocation pools — they don't have a single
                // 'win' pick to compare against, and gradient/multi-horse bets don't map to this alert shape.
                const isAllocPool = event.poolConfig && event.poolConfig.bankrollMode === 'allocate';
                if (winnerPick && !isAllocPool && (isNewEntry || winnerChanged)) {
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

            // oddsChangeBatch: fire SMS to a list of players whose picks were affected by
            // scratches or longshot drops after an odds import. Body shape:
            //   { eventId, notifications: [{ phone, body }] }
            // Skips muted phones, normalizes to E.164, returns summary.
            if (action === 'oddsChangeBatch') {
                const { notifications } = req.body || {};
                if (!Array.isArray(notifications) || notifications.length === 0) {
                    return res.status(400).json({ success: false, error: 'notifications array required' });
                }
                const MAX = 30;
                if (notifications.length > MAX) {
                    return res.status(400).json({ success: false, error: `too many notifications (max ${MAX})` });
                }
                let sent = 0, failed = 0, muted = 0;
                for (const n of notifications) {
                    if (!n || !n.phone || !n.body) { failed++; continue; }
                    if (isMuted(event, n.phone)) { muted++; continue; }
                    const to = toE164(n.phone);
                    if (!to) { failed++; console.warn('Bad phone for oddsChange:', n.phone); continue; }
                    try {
                        await twilioClient.messages.create({
                            body: n.body,
                            from: process.env.TWILIO_PHONE_NUMBER,
                            to
                        });
                        sent++;
                    } catch (e) {
                        console.error('oddsChange SMS failed for', n.phone, '→', to, e.message);
                        failed++;
                    }
                }
                return res.status(200).json({ success: true, sent, failed, muted, total: notifications.length });
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
    const CLOSE_GRACE_MS = 60 * 1000; // matches pool-config.js — 6:00pm close → real lock 6:00:59

    // Help / status text
    if (responseText === 'help' || responseText === '') {
        await twilioClient.messages.create({
            body: `${eventName} pool.\nPICK <#> - winner pick (e.g. PICK 7)\nPICKS - your slip\nSTATS - leaderboard & odds\nSAY <msg> - trash talk to all entrants\nMUTE / UNMUTE - silence this event\nJULEP - mint julep recipe\nFull slip (parlays, props): https://75pinegrove.com`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: From
        });
        return;
    }

    if (closesMs && now >= closesMs + CLOSE_GRACE_MS) {
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

// Admin gathering commands — each accepts the resolved event passed in by handleSMS.
async function getEventUpdate(eventData) {
    if (!eventData) return 'No event found.';
    let message = `${eventData.name}\n`;
    message += `Date: ${eventData.date}\n`;
    if (eventData.description) message += `Details: ${eventData.description}\n`;
    if (eventData.whatToBring) message += `Bring: ${eventData.whatToBring}\n`;
    return message;
}

async function getWhoIsComing(eventData) {
    if (!eventData || !eventData.collectionName) return 'No event found.';
    const rsvps = await db.collection(eventData.collectionName).orderBy('timestamp', 'desc').get();
    const attendees = [];
    rsvps.forEach(doc => {
        const rsvp = doc.data();
        if (rsvp.attending === 'Yes' || rsvp.attending === 'Maybe') {
            const guests = rsvp.guests > 1 ? ` +${rsvp.guests - 1}` : '';
            const status = rsvp.attending === 'Maybe' ? ' (Maybe)' : '';
            attendees.push(`${rsvp.name}${guests}${status}`);
        }
    });
    if (attendees.length === 0) return `${eventData.name}: No confirmed attendees yet.`;
    let message = `${eventData.name} - Coming:\n\n` + attendees.join('\n');
    return message.length > 1500 ? message.substring(0, 1400) + '...(more)' : message;
}

async function getEventStats(eventData) {
    if (!eventData || !eventData.collectionName) return 'No event found.';
    const rsvps = await db.collection(eventData.collectionName).orderBy('timestamp', 'desc').get();
    let yesCount = 0, maybeCount = 0, noCount = 0;
    rsvps.forEach(doc => {
        const rsvp = doc.data();
        const guests = rsvp.guests || 1;
        if (rsvp.attending === 'Yes') yesCount += guests;
        else if (rsvp.attending === 'Maybe') maybeCount += guests;
        else if (rsvp.attending === 'No') noCount += guests;
    });
    return `${eventData.name}\nYes: ${yesCount} guests\nMaybe: ${maybeCount} guests\nNo: ${noCount} guests\nTotal Expected: ${yesCount + maybeCount}`;
}

// ============================================================================
// Lifecycle auto-transitions (Phase 1)
// ============================================================================
// accepting → locked   : scheduled every 5min; flips when closesAt + grace has passed
// locked    → complete : Firestore trigger; flips when results become populated
//
// Admins can still manually override via the lifecycle dropdown in the form.

const CLOSE_GRACE_MS = 60 * 1000;

// Helper: does this event have meaningful results entered?
function hasResultsEntered(eventData) {
    if (!eventData || !eventData.poolConfig) return false;
    const pc = eventData.poolConfig;
    if (Array.isArray(pc.fullFinish) && pc.fullFinish.length > 0) return true;
    if (pc.results && typeof pc.results === 'object') {
        return Object.values(pc.results).some(v => v !== null && v !== undefined && v !== '');
    }
    return false;
}

// Helper: has the event's closesAt passed (with grace)?
function isPastClose(eventData) {
    const closesAt = eventData && eventData.poolConfig && eventData.poolConfig.closesAt;
    if (!closesAt) {
        // Non-pool events: fall back to event dateRaw
        if (eventData && eventData.type === 'gathering' && eventData.dateRaw) {
            const t = new Date(eventData.dateRaw).getTime();
            return !isNaN(t) && t + CLOSE_GRACE_MS < Date.now();
        }
        return false;
    }
    const ms = closesAt.toMillis ? closesAt.toMillis()
            : closesAt.seconds ? closesAt.seconds * 1000
            : null;
    if (!ms) return false;
    return Date.now() > ms + CLOSE_GRACE_MS;
}

// Runs every 5 minutes — flips any 'accepting' events whose closesAt has passed.
exports.lifecycleTickToLocked = onSchedule({ schedule: 'every 5 minutes', timeoutSeconds: 60 }, async () => {
    try {
        const snap = await db.collection('events').where('lifecycle', '==', 'accepting').get();
        let flipped = 0;
        for (const doc of snap.docs) {
            const data = doc.data();
            if (!isPastClose(data)) continue;
            // Pool events flip to 'locked'; gatherings go straight to 'complete' after their event date.
            const nextState = (data.type === 'pool') ? 'locked' : 'complete';
            await doc.ref.update({ lifecycle: nextState, lifecycleAutoTransitionedAt: admin.firestore.FieldValue.serverTimestamp() });
            console.log(`[lifecycleTick] ${data.name} (${data.eventCode}): accepting → ${nextState}`);
            flipped++;
        }
        return { flipped };
    } catch (err) {
        console.error('[lifecycleTickToLocked] error:', err);
        return null;
    }
});

// Firestore trigger — flips 'locked' → 'complete' when results are saved.
exports.lifecycleOnResults = onDocumentUpdated('events/{eventId}', async (event) => {
    try {
        const before = event.data && event.data.before ? event.data.before.data() : null;
        const after = event.data && event.data.after ? event.data.after.data() : null;
        if (!before || !after) return;

        // Only consider pool events for this trigger
        if (after.type !== 'pool') return;

        const wasComplete = before.lifecycle === 'complete';
        const isLockedOrAccepting = after.lifecycle === 'locked' || after.lifecycle === 'accepting';
        if (wasComplete || !isLockedOrAccepting) return;

        const beforeHadResults = hasResultsEntered(before);
        const afterHasResults = hasResultsEntered(after);
        if (afterHasResults && !beforeHadResults) {
            await event.data.after.ref.update({
                lifecycle: 'complete',
                lifecycleAutoTransitionedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[lifecycleOnResults] ${after.name} (${after.eventCode}): ${after.lifecycle} → complete`);
        }
    } catch (err) {
        console.error('[lifecycleOnResults] error:', err);
    }
});