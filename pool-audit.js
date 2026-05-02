// Cryptographic seal + verify for pool entries.
// Admin clicks "Seal Entries" → snapshot is uploaded to Firebase Storage,
// SHA-256 hash is recorded on the event doc. Anyone can verify by re-fetching
// the snapshot and re-hashing in the browser.

(function (root) {
    'use strict';

    // Recursively sort object keys so hash is stable regardless of insertion order
    function canonicalize(obj) {
        if (Array.isArray(obj)) return obj.map(canonicalize);
        if (obj && typeof obj === 'object' && obj.constructor === Object) {
            const sorted = {};
            Object.keys(obj).sort().forEach(k => { sorted[k] = canonicalize(obj[k]); });
            return sorted;
        }
        return obj;
    }

    // Strip non-essential fields (timestamps, etc.) so re-saves don't change the hash.
    function essentialEntry(rawEntry) {
        return {
            phone: rawEntry.phone || '',
            name: rawEntry.name || '',
            picks: rawEntry.picks || {},
            locks: Array.isArray(rawEntry.locks) ? rawEntry.locks.slice().sort() : []
        };
    }

    async function sha256Hex(str) {
        const buf = new TextEncoder().encode(str);
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Build canonical JSON for a set of entries — used for hashing + storage snapshot
    function buildCanonicalJson(entries, eventMeta) {
        const sorted = entries.slice().sort((a, b) => (a.phone || '').localeCompare(b.phone || ''));
        const payload = {
            version: 1,
            eventId: eventMeta.eventId,
            eventName: eventMeta.eventName,
            sealedAt: eventMeta.sealedAtIso,
            entryCount: sorted.length,
            entries: sorted.map(essentialEntry)
        };
        return JSON.stringify(canonicalize(payload), null, 2);
    }

    // ----- Admin: seal entries -----
    async function sealEntries(eventId, eventData) {
        if (!eventData || !eventData.collectionName) throw new Error('No event collectionName');
        const snap = await db.collection(eventData.collectionName).get();
        const entries = snap.docs.map(d => d.data());
        if (entries.length === 0) throw new Error('No entries to seal');

        const sealedAtIso = new Date().toISOString();
        const canonicalStr = buildCanonicalJson(entries, {
            eventId,
            eventName: eventData.name || 'Unnamed event',
            sealedAtIso
        });
        const hash = await sha256Hex(canonicalStr);

        // Try to also upload to Storage (redundant public archive). Don't fail seal if it fails.
        let url = null, path = null;
        if (typeof firebase !== 'undefined' && firebase.storage) {
            try {
                const blob = new Blob([canonicalStr], { type: 'application/json' });
                path = `audit/${eventId}/${Date.now()}-${hash.slice(0, 8)}.json`;
                const ref = firebase.storage().ref(path);
                await ref.put(blob, { contentType: 'application/json' });
                url = await ref.getDownloadURL();
            } catch (err) {
                console.warn('Storage upload failed (non-fatal — snapshot stored in Firestore):', err);
            }
        }

        // Save seal + snapshot text to event doc. Snapshot in Firestore avoids CORS issues on verify.
        await db.collection('events').doc(eventId).update({
            auditSeal: {
                hash,
                url,
                path,
                sealedAt: firebase.firestore.Timestamp.fromDate(new Date(sealedAtIso)),
                sealedAtIso,
                entryCount: entries.length,
                snapshotJson: canonicalStr,
                version: 2
            }
        });

        return { hash, url, entryCount: entries.length, sealedAtIso };
    }

    // ----- Public: verify seal -----
    async function verifySeal(eventData) {
        const seal = eventData && eventData.auditSeal;
        if (!seal || !seal.hash) {
            return { ok: false, status: 'no-seal', message: 'No seal recorded for this event yet.' };
        }
        try {
            // Prefer Firestore-stored snapshot (no CORS); fall back to Storage URL fetch
            let text;
            if (seal.snapshotJson) {
                text = seal.snapshotJson;
            } else if (seal.url) {
                const resp = await fetch(seal.url);
                if (!resp.ok) {
                    return { ok: false, status: 'fetch-failed', message: `Could not fetch snapshot (HTTP ${resp.status})` };
                }
                text = await resp.text();
            } else {
                return { ok: false, status: 'no-snapshot', message: 'Seal has no snapshot to verify against.' };
            }

            const recomputedHash = await sha256Hex(text);
            const ok = recomputedHash === seal.hash;
            return {
                ok,
                status: ok ? 'verified' : 'mismatch',
                expected: seal.hash,
                recomputed: recomputedHash,
                snapshotJson: text,
                sealedAtIso: seal.sealedAtIso,
                entryCount: seal.entryCount,
                message: ok
                    ? `Verified ✓ — ${seal.entryCount} entries sealed at ${new Date(seal.sealedAtIso).toLocaleString()}.`
                    : `Mismatch! Snapshot hash differs from recorded hash. Tampering possible.`
            };
        } catch (err) {
            console.error('verifySeal error:', err);
            return { ok: false, status: 'error', message: 'Verify error: ' + err.message };
        }
    }

    // Helper: short hash for display
    function shortHash(hash) {
        if (!hash) return '';
        return hash.slice(0, 8) + '…' + hash.slice(-8);
    }

    root.PoolAudit = { sealEntries, verifySeal, shortHash, sha256Hex, buildCanonicalJson };
})(typeof window !== 'undefined' ? window : this);
