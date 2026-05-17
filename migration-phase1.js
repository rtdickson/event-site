// Phase 1 migration — one-time backfill of new event schema fields.
//
// Adds to every event:
//   - eventCode      : short alphanumeric route key (3–12 [a-z0-9])
//   - isFeatured     : replaces isActive for "show on home page" semantics
//   - notifyAdminOnEntry : default true
//   - lifecycle      : 'draft' | 'accepting' | 'locked' | 'complete' | 'archived'
//
// Idempotent — checks meta/migrations/phase1 before running. Safe to invoke
// on every admin page load.

(function (root) {
    'use strict';

    const MIGRATION_DOC = 'meta/migrations';
    const MIGRATION_KEY = 'phase1CompletedAt';

    // Known historical event-code overrides — name slugify won't produce these,
    // and they're the codes Todd already uses in conversation/SMS.
    const KNOWN_CODES = {
        'kentucky derby 2026': 'kd26',
        'kentucky derby': 'kd26',
        'derby 2026': 'kd26',
        'preakness 2026': 'pkns26',
        'preakness stakes 2026': 'pkns26',
        'preakness': 'pkns26',
        'belmont 2026': 'bel26',
        'belmont stakes 2026': 'bel26'
    };

    function slugifyCode(name) {
        if (!name) return null;
        const slug = String(name).toLowerCase()
            .replace(/[^a-z0-9]+/g, '')
            .slice(0, 12);
        if (slug.length < 3) return null;
        return slug;
    }

    function deriveLifecycle(data) {
        const isPool = data.type === 'pool';
        const isGathering = data.type === 'gathering';
        const isActive = !!data.isActive;
        const now = Date.now();

        // Pool: results entered → complete
        if (isPool && data.poolConfig) {
            const pc = data.poolConfig;
            const hasResults = !!(pc.results && Object.values(pc.results).some(v => v !== null && v !== undefined && v !== ''));
            const hasFullFinish = Array.isArray(pc.fullFinish) && pc.fullFinish.length > 0;
            if (hasResults || hasFullFinish) return 'complete';

            // Closes-at past → locked
            const closesMs = pc.closesAt && pc.closesAt.toMillis ? pc.closesAt.toMillis()
                          : pc.closesAt && pc.closesAt.seconds ? pc.closesAt.seconds * 1000
                          : null;
            if (closesMs && closesMs < now) return 'locked';
        }

        // Gathering: event date past → complete (no real lock state for gatherings)
        if (isGathering && data.dateRaw) {
            const dateMs = new Date(data.dateRaw).getTime();
            if (!isNaN(dateMs) && dateMs < now - 24 * 60 * 60 * 1000) return 'complete';
        }

        if (isActive) return 'accepting';
        return 'archived';
    }

    async function pickUniqueCode(db, baseName, existingCodes) {
        const explicit = KNOWN_CODES[String(baseName || '').toLowerCase().trim()];
        let candidate = explicit || slugifyCode(baseName) || ('ev' + Math.random().toString(36).slice(2, 6));

        // Ensure unique against the set we've handed out so far (and any existing eventCodes)
        if (!existingCodes.has(candidate)) return candidate;

        // Append numeric suffix until unique, respecting the 12-char limit
        for (let i = 2; i < 100; i++) {
            const suffix = String(i);
            const trimmed = candidate.slice(0, 12 - suffix.length) + suffix;
            if (!existingCodes.has(trimmed)) return trimmed;
        }
        // Fallback — should never hit
        return candidate.slice(0, 8) + Math.random().toString(36).slice(2, 6);
    }

    async function runMigration(db) {
        try {
            const metaRef = db.collection('meta').doc('migrations');
            const metaSnap = await metaRef.get();
            const meta = metaSnap.exists ? metaSnap.data() : {};

            if (meta[MIGRATION_KEY]) {
                console.log('[migration-phase1] Already completed at', meta[MIGRATION_KEY].toDate ? meta[MIGRATION_KEY].toDate() : meta[MIGRATION_KEY]);
                return { ranOnEvents: 0, alreadyRan: true };
            }

            console.log('[migration-phase1] Running schema backfill…');
            const events = await db.collection('events').get();

            // Pre-collect every existing eventCode so we can detect collisions
            const existingCodes = new Set();
            events.forEach(d => {
                const c = d.data().eventCode;
                if (c) existingCodes.add(c);
            });

            const batch = db.batch();
            let updateCount = 0;

            for (const doc of events.docs) {
                const data = doc.data();
                const patch = {};

                if (!data.eventCode) {
                    const newCode = await pickUniqueCode(db, data.name, existingCodes);
                    existingCodes.add(newCode);
                    patch.eventCode = newCode;
                }

                if (data.isFeatured === undefined) {
                    patch.isFeatured = !!data.isActive;
                }

                if (data.notifyAdminOnEntry === undefined) {
                    patch.notifyAdminOnEntry = true;
                }

                if (!data.lifecycle) {
                    patch.lifecycle = deriveLifecycle(data);
                }

                if (Object.keys(patch).length > 0) {
                    batch.update(doc.ref, patch);
                    updateCount++;
                    console.log(`[migration-phase1] ${data.name}:`, patch);
                }
            }

            if (updateCount > 0) {
                await batch.commit();
            }

            await metaRef.set({
                [MIGRATION_KEY]: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            console.log(`[migration-phase1] Complete — updated ${updateCount} event(s).`);
            return { ranOnEvents: updateCount, alreadyRan: false };
        } catch (err) {
            console.error('[migration-phase1] Failed:', err);
            return { error: err.message };
        }
    }

    // Lifecycle helpers exported for the rest of the app
    function inferLifecycleFromEvent(data) {
        if (data && data.lifecycle) return data.lifecycle;
        return deriveLifecycle(data || {});
    }

    function isVisibleOnHome(data) {
        if (!data) return false;
        if (!data.isFeatured) return false;
        const lc = inferLifecycleFromEvent(data);
        return lc !== 'draft' && lc !== 'archived';
    }

    function isAccepting(data) {
        return inferLifecycleFromEvent(data) === 'accepting';
    }

    root.MigrationPhase1 = {
        run: runMigration,
        inferLifecycle: inferLifecycleFromEvent,
        isVisibleOnHome,
        isAccepting,
        LIFECYCLES: ['draft', 'accepting', 'locked', 'complete', 'archived']
    };
})(typeof window !== 'undefined' ? window : this);
