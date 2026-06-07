// Pool admin panel: contestants, questions, entries, results, standings.
// Operates on the active pool event (or most recent if none active).

(function () {
    'use strict';

    let currentPoolEventId = null;
    let currentPoolEvent = null;
    const NOTIFY_URL = 'https://us-central1-piveevents.cloudfunctions.net/sendNotification';

    // ----- Auto-notify players when their picks scratch or drop out of longshot -----
    // Called after a successful CSV import. Diffs old vs new contestants, finds affected
    // entries, and fires a batched per-player SMS via the cloud function. Tracks what's
    // already been notified on poolConfig.lastNotifiedField so re-importing the same CSV
    // doesn't double-spam.
    async function notifyOddsChanges(oldContestantsSnapshot) {
        if (!currentPoolEvent || !currentPoolEventId) return '';
        const newContestants = currentPoolEvent.poolConfig.contestants || [];
        const oldById = new Map(oldContestantsSnapshot.map(c => [Number(c.id), c]));
        const newById = new Map(newContestants.map(c => [Number(c.id), c]));

        // Detect: scratched (in old, not in new) + longshot lost (was longshot, no longer)
        const scratchedNow = [];
        const longshotLostNow = [];
        oldContestantsSnapshot.forEach(oldC => {
            const id = Number(oldC.id);
            const newC = newById.get(id);
            if (!newC) {
                scratchedNow.push({ id, name: oldC.name });
            } else if (oldC.isLongshot && !newC.isLongshot) {
                longshotLostNow.push({ id, name: oldC.name, oldOdds: oldC.odds, newOdds: newC.odds });
            }
        });

        // De-dupe vs what was already notified before
        const lastNotified = (currentPoolEvent.poolConfig.lastNotifiedField) || { scratched: [], longshotLost: [] };
        const prevScratched = new Set((lastNotified.scratched || []).map(Number));
        const prevLongshotLost = new Set((lastNotified.longshotLost || []).map(Number));
        const newScratched = scratchedNow.filter(s => !prevScratched.has(s.id));
        const newLongshotLost = longshotLostNow.filter(s => !prevLongshotLost.has(s.id));

        if (newScratched.length === 0 && newLongshotLost.length === 0) {
            return '';
        }

        // Find affected entries
        const entriesSnap = await db.collection(currentPoolEvent.collectionName).get();
        const config = currentPoolEvent.poolConfig;
        const closeStr = config.closesAt && config.closesAt.toDate
            ? config.closesAt.toDate().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
            : 'close time';

        // Build per-phone notification batch
        const byPhone = new Map(); // phone → { name, scratched: [], longshotLost: [] }
        entriesSnap.forEach(doc => {
            const data = doc.data();
            const phone = data.phone;
            if (!phone) return;
            const affectedScratched = [];
            const affectedLongshot = [];

            newScratched.forEach(s => {
                const bets = affectedBetsForHorse(data, s.id, config);
                if (bets.length > 0) affectedScratched.push({ ...s, bets });
            });
            newLongshotLost.forEach(s => {
                // Longshot drop only affects the Long Shot bet pick
                if (affectedOnLongshotBet(data, s.id, config)) {
                    affectedLongshot.push(s);
                }
            });

            if (affectedScratched.length > 0 || affectedLongshot.length > 0) {
                byPhone.set(phone, { name: data.name || 'there', scratched: affectedScratched, longshotLost: affectedLongshot });
            }
        });

        if (byPhone.size === 0) {
            // No one was affected — still update the snapshot so we don't re-detect next time
            await savePoolConfig({
                lastNotifiedField: {
                    scratched: scratchedNow.map(s => s.id),
                    longshotLost: longshotLostNow.map(s => s.id)
                }
            });
            return `(${newScratched.length} scratched, ${newLongshotLost.length} longshot drops — no entries affected.)`;
        }

        // Cap at 30 SMS to prevent runaway
        const MAX_NOTIFICATIONS = 30;
        const notifications = [];
        let i = 0;
        for (const [phone, info] of byPhone) {
            if (i >= MAX_NOTIFICATIONS) break;
            notifications.push({
                phone,
                body: composeChangeMessage(currentPoolEvent.name, closeStr, info)
            });
            i++;
        }

        // Send via cloud function
        let sentSummary = '';
        try {
            const res = await fetch(NOTIFY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'oddsChangeBatch',
                    eventId: currentPoolEventId,
                    notifications
                })
            });
            const data = await res.json();
            if (data.success) {
                sentSummary = `Notified ${data.sent} player${data.sent === 1 ? '' : 's'}`;
                if (data.muted) sentSummary += ` (${data.muted} muted skipped)`;
                if (data.failed) sentSummary += ` — ${data.failed} failed`;
                sentSummary += '.';
            } else {
                sentSummary = `Notify call failed: ${data.error || 'unknown'}.`;
            }
        } catch (err) {
            console.error('oddsChangeBatch fetch failed:', err);
            sentSummary = `Notify call errored: ${err.message}.`;
        }

        // Update snapshot regardless (so we don't retry forever on a failure that succeeded server-side)
        await savePoolConfig({
            lastNotifiedField: {
                scratched: scratchedNow.map(s => s.id),
                longshotLost: longshotLostNow.map(s => s.id)
            }
        });

        return sentSummary;
    }

    // For a given entry, find which bet labels the affected horse appears on
    function affectedBetsForHorse(entry, horseId, config) {
        const bets = [];
        const picks = entry.picks || {};
        const PC = window.PoolConfig;
        const questions = config.questions || [];
        questions.forEach(q => {
            const rawPick = picks[q.id];
            const v = PC.getPickValue(rawPick);
            if (v === null || v === undefined || v === '') return;
            const matchesSingle = !Array.isArray(v) && Number(v) === Number(horseId);
            const matchesArray = Array.isArray(v) && v.some(x => Number(x) === Number(horseId));
            if (matchesSingle || matchesArray) {
                bets.push(humanBetLabel(q));
            }
        });
        return bets;
    }

    function affectedOnLongshotBet(entry, horseId, config) {
        const picks = entry.picks || {};
        const PC = window.PoolConfig;
        const longshotQ = (config.questions || []).find(q => q.kind === 'pickLongshot');
        if (!longshotQ) return false;
        const v = PC.getPickValue(picks[longshotQ.id]);
        return Number(v) === Number(horseId);
    }

    function humanBetLabel(q) {
        if (q.id === 'win') return 'Win';
        if (q.id === 'place') return 'Place';
        if (q.id === 'show') return 'Show';
        if (q.id === 'tri') return 'Trifecta';
        if (q.id === 'box3') return 'Top-3 Box';
        if (q.id === 'top5') return 'Top 5';
        if (q.id === 'exacta') return 'Exacta';
        if (q.id === 'longshot') return 'Long Shot';
        return q.label || q.id;
    }

    function composeChangeMessage(eventName, closeStr, info) {
        const lines = [];
        if (info.scratched.length === 1) {
            const s = info.scratched[0];
            lines.push(`#${s.id} ${s.name} SCRATCHED. You picked them for: ${s.bets.join(', ')}.`);
        } else if (info.scratched.length > 1) {
            lines.push('Scratched:');
            info.scratched.forEach(s => {
                lines.push(`• #${s.id} ${s.name} (you picked: ${s.bets.join(', ')})`);
            });
        }
        if (info.longshotLost.length === 1) {
            const s = info.longshotLost[0];
            lines.push(`#${s.id} ${s.name} dropped to ${s.newOdds} — no longer a longshot. Your Long Shot pick won't qualify.`);
        } else if (info.longshotLost.length > 1) {
            lines.push('No longer longshots:');
            info.longshotLost.forEach(s => {
                lines.push(`• #${s.id} ${s.name} (now ${s.newOdds})`);
            });
        }
        const intro = `[${eventName}] Heads up — your slip is affected:`;
        const outro = `Update at https://75pinegrove.com before picks lock ${closeStr}.`;
        return [intro, ...lines, outro].join('\n');
    }

    // ----- Entry point -----
    async function initializePoolAdmin() {
        const sidebarLink = document.querySelector('.sidebar-link[data-panel="pool"]');
        if (!sidebarLink) return;

        // Lazy-load on first click into the panel (and also on initial load if pool exists).
        sidebarLink.addEventListener('click', () => {
            // Defer to allow panel-switching CSS to apply
            setTimeout(loadAndRender, 0);
        });

        // Also try once on init so it's ready
        loadAndRender();
    }

    async function loadAndRender() {
        const empty = document.getElementById('pool-admin-empty');
        const content = document.getElementById('pool-admin-content');
        if (!empty || !content) return;

        try {
            const eventDoc = await findPoolEvent();
            if (!eventDoc) {
                empty.style.display = 'block';
                content.style.display = 'none';
                return;
            }
            currentPoolEventId = eventDoc.id;
            currentPoolEvent = eventDoc.data();
            // Ensure poolConfig exists
            if (!currentPoolEvent.poolConfig) {
                currentPoolEvent.poolConfig = {
                    contestants: [],
                    questions: window.PoolConfig.defaultDerbyQuestions(),
                    results: null,
                    defaultStake: 10
                };
            }
            // One-time migration: legacy questions had hardcoded stake:10 and fixed `payoff`.
            // New schema: questions inherit poolConfig.defaultStake; flat payoffs use payoffMultiplier.
            await migrateLegacyQuestions();
            empty.style.display = 'none';
            content.style.display = 'block';
            renderAll();
        } catch (err) {
            console.error('Error loading pool admin:', err);
        }
    }

    const POOL_SELECTION_KEY = 'poolAdmin.selectedEventId';

    async function listPoolEvents() {
        // Filter client-side instead of using a composite (type, createdAt) index —
        // the events collection is small and this avoids requiring a Firestore index.
        const snap = await db.collection('events')
            .orderBy('createdAt', 'desc')
            .get();
        return snap.docs.filter(d => d.data().type === 'pool');
    }

    async function findPoolEvent() {
        // Selected pool (admin chose explicitly) wins, if it still exists.
        const explicit = localStorage.getItem(POOL_SELECTION_KEY);
        if (explicit) {
            const explicitDoc = await db.collection('events').doc(explicit).get();
            if (explicitDoc.exists && explicitDoc.data().type === 'pool') return explicitDoc;
        }

        // Otherwise: prefer accepting pool; then any featured pool; then most recent.
        const pools = await listPoolEvents();
        if (pools.length === 0) return null;

        const accepting = pools.find(d => d.data().lifecycle === 'accepting');
        if (accepting) return accepting;

        const featured = pools.find(d => {
            const data = d.data();
            return (data.isFeatured !== undefined ? data.isFeatured : data.isActive);
        });
        if (featured) return featured;

        return pools[0]; // most recent
    }

    // One-time migration of legacy questions to new schema (no hardcoded stake, payoffMultiplier).
    async function migrateLegacyQuestions() {
        const questions = (currentPoolEvent.poolConfig.questions || []);
        const isAlloc = window.PoolConfig.isAllocationMode(currentPoolEvent.poolConfig);
        let dirty = false;
        const migrated = questions.map(q => {
            const next = Object.assign({}, q);
            // Strip legacy stake:10 baseline so question inherits defaultStake
            if (next.stake === 10) { delete next.stake; dirty = true; }
            // Convert legacy fixed payoff to multiplier (was set at $10 baseline)
            if (next.payoff !== undefined && next.payoffMultiplier === undefined) {
                next.payoffMultiplier = next.payoff / 10;
                delete next.payoff;
                dirty = true;
            }
            // Preakness gradient Top 5: backfill pickN if missing on pickInTopN in allocation pools
            if (isAlloc && next.kind === 'pickInTopN' && (next.pickN === undefined || next.pickN === null)) {
                next.pickN = 5;
                if (!next.topN) next.topN = 5;
                next.scoring = next.scoring || 'gradientOdds';
                dirty = true;
            }
            // Longshot: convert legacy autoProp (auto-hit if any 15:1+ in top 3) to pickLongshot
            // (player picks one 15:1+ horse, hits if it finishes top 3).
            if (isAlloc && next.kind === 'autoProp' && next.autoComputeFrom === 'longshotQualifiers') {
                next.kind = 'pickLongshot';
                delete next.autoComputeFrom;
                if (!next.label || /long\s*shot.*top\s*3/i.test(next.label)) {
                    next.label = 'Long Shot (15:1+) — position-scaled odds';
                }
                dirty = true;
            }
            // Longshot in allocation pools: convert flat-multiplier longshot to position-scaled odds.
            if (isAlloc && next.kind === 'pickLongshot' && next.scoring !== 'positionScaledOdds') {
                next.scoring = 'positionScaledOdds';
                if (next.payoffMultiplier !== undefined) delete next.payoffMultiplier;
                if (next.label && /to finish top 3/i.test(next.label)) {
                    next.label = 'Long Shot (15:1+) — position-scaled odds';
                }
                dirty = true;
            }
            // Box-3 in allocation pools: ensure new multiplier (7×). Old admin-created or legacy
            // events may have 10×; bring them in line.
            if (isAlloc && next.kind === 'unorderedTriple' && next.payoffMultiplier === 10) {
                next.payoffMultiplier = 7;
                dirty = true;
            }
            // Trifecta in allocation pools: bump from old 4× to new 12× to align with difficulty
            // (hardest bet; should be the top reward).
            if (isAlloc && next.kind === 'orderedTriple' && next.payoffMultiplier === 4) {
                next.payoffMultiplier = 12;
                dirty = true;
            }
            return next;
        });

        // Add Top-3 Box to allocation pools that don't have one yet (so existing Preakness
        // events pick it up automatically without admin needing to use the Add Bet picker).
        if (isAlloc && !migrated.some(q => q.kind === 'unorderedTriple')) {
            // Insert after exacta if present, else at end
            const exactaIdx = migrated.findIndex(q => q.id === 'exacta');
            const box3 = { id: 'box3', kind: 'unorderedTriple', label: 'Top-3 Box (any order)', payoffMultiplier: 7 };
            if (exactaIdx >= 0) {
                migrated.splice(exactaIdx + 1, 0, box3);
            } else {
                migrated.push(box3);
            }
            dirty = true;
        }
        if (dirty) {
            currentPoolEvent.poolConfig.questions = migrated;
            try {
                await db.collection('events').doc(currentPoolEventId).update({
                    'poolConfig.questions': migrated
                });
                console.log('[pool-admin] Migrated questions:', migrated);
            } catch (err) {
                console.warn('[pool-admin] Migration save failed (non-fatal):', err);
            }
        } else {
            console.log('[pool-admin] No question migration needed (everything up to date).');
        }
    }

    // ----- Persistence -----
    async function savePoolConfig(patch) {
        if (!currentPoolEventId) return;
        Object.assign(currentPoolEvent.poolConfig, patch);
        await db.collection('events').doc(currentPoolEventId).update({
            poolConfig: currentPoolEvent.poolConfig
        });
        showSavedToast();
    }

    // Global "✓ Saved" confirmation. Every savePoolConfig() flashes this so the admin
    // always knows a change persisted — no per-section save buttons or guesswork.
    let _savedToastEl = null;
    let _savedToastTimer = null;
    function showSavedToast() {
        if (!_savedToastEl) {
            _savedToastEl = document.createElement('div');
            _savedToastEl.className = 'pool-saved-toast';
            _savedToastEl.textContent = '✓ Saved';
            document.body.appendChild(_savedToastEl);
        }
        _savedToastEl.classList.add('show');
        if (_savedToastTimer) clearTimeout(_savedToastTimer);
        _savedToastTimer = setTimeout(() => _savedToastEl.classList.remove('show'), 1400);
    }

    // ----- Pool sub-tabs (Setup / Race Results / Manage) -----
    function wirePoolTabs() {
        const tabs = document.getElementById('pool-tabs');
        if (!tabs || tabs.dataset.wired) return;
        tabs.dataset.wired = '1';
        tabs.querySelectorAll('.pool-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-pooltab');
                tabs.querySelectorAll('.pool-tab-btn').forEach(b =>
                    b.classList.toggle('active', b === btn));
                document.querySelectorAll('[data-pooltab-panel]').forEach(panel =>
                    panel.classList.toggle('active', panel.getAttribute('data-pooltab-panel') === target));
            });
        });
    }

    // ----- Pool Settings (money + timing, editable inline in the Setup tab) -----
    let lastEntryCount = 0;

    function updatePotDisplay() {
        const el = document.getElementById('pool-settings-pot');
        if (!el) return;
        const buyIn = currentPoolEvent && currentPoolEvent.poolConfig && currentPoolEvent.poolConfig.buyIn;
        if (!buyIn || buyIn <= 0) { el.textContent = ''; return; }
        const pot = lastEntryCount * buyIn;
        el.textContent = `💵 Pot: ${lastEntryCount} player${lastEntryCount === 1 ? '' : 's'} × $${buyIn} = $${pot.toLocaleString()}`;
    }

    function renderPoolSettings() {
        const body = document.getElementById('pool-settings-body');
        if (!body || !currentPoolEvent) return;
        const cfg = currentPoolEvent.poolConfig || {};
        const isAlloc = window.PoolConfig.isAllocationMode(cfg);
        const c = cfg.allocationConstraints || {};
        const raceTime = currentPoolEvent.date || currentPoolEvent.dateRaw || '— not set —';
        const closesRaw = cfg.closesAtRaw || '';
        const buyIn = (cfg.buyIn != null) ? cfg.buyIn : '';

        const allocFields = isAlloc ? `
            <label class="pool-set-field">
                <span>Fantasy bankroll / player ($)</span>
                <input type="number" id="pool-set-bankroll" min="100" step="100" value="${cfg.bankrollAmount != null ? cfg.bankrollAmount : 5000}" />
            </label>
            <label class="pool-set-field">
                <span>Min per bet ($)</span>
                <input type="number" id="pool-set-min" min="0" step="50" value="${c.min != null ? c.min : 250}" />
            </label>
            <label class="pool-set-field">
                <span>Max per bet ($)</span>
                <input type="number" id="pool-set-max" min="100" step="100" value="${c.max != null ? c.max : 2000}" />
            </label>
            <label class="pool-set-field">
                <span>Step size ($ per +/−)</span>
                <input type="number" id="pool-set-step" min="25" step="25" value="${c.increment != null ? c.increment : 50}" />
            </label>` : `
            <label class="pool-set-field">
                <span>Fixed stake / pick ($ fun money)</span>
                <input type="number" id="pool-set-stake" min="1" value="${cfg.defaultStake != null ? cfg.defaultStake : 100}" />
            </label>`;

        body.innerHTML = `
            <div class="pool-settings-grid">
                <div class="pool-set-readonly">
                    <span class="pool-set-rolabel">Race time</span>
                    <span class="pool-set-rovalue">${escapeHtml(String(raceTime))}</span>
                    <a href="#" id="pool-set-edit-race" class="pool-set-editlink">Edit in Event Manager →</a>
                </div>
                <label class="pool-set-field">
                    <span>Picks lock at</span>
                    <input type="datetime-local" id="pool-set-closes" value="${escapeHtml(closesRaw)}" />
                </label>
                <label class="pool-set-field">
                    <span>Real buy-in / player ($)</span>
                    <input type="number" id="pool-set-buyin" min="0" step="1" placeholder="e.g. 10" value="${buyIn}" />
                </label>
                ${allocFields}
            </div>
            <div class="pool-settings-foot">
                <span id="pool-settings-pot" class="pool-admin-help"></span>
                <span id="pool-settings-msg" class="pool-admin-help"></span>
            </div>`;

        const editRace = document.getElementById('pool-set-edit-race');
        if (editRace) editRace.addEventListener('click', (e) => {
            e.preventDefault();
            const link = document.querySelector('.sidebar-link[data-panel="events"]');
            if (link) link.click();
        });

        const msg = document.getElementById('pool-settings-msg');
        const flash = (t) => { if (msg) { msg.textContent = t; msg.style.color = 'green'; } };
        const wire = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => handler(el));
        };

        // Picks lock time → closesAt (Timestamp) + closesAtRaw (string)
        wire('pool-set-closes', async (el) => {
            const raw = el.value;
            const patch = raw
                ? { closesAtRaw: raw, closesAt: firebase.firestore.Timestamp.fromDate(new Date(raw)) }
                : { closesAtRaw: '', closesAt: null };
            await savePoolConfig(patch);
            renderHeader();
            flash('✓ Lock time saved');
        });

        // Real-money buy-in per player (informational — drives the pot total)
        wire('pool-set-buyin', async (el) => {
            const n = parseInt(el.value, 10);
            await savePoolConfig({ buyIn: (Number.isFinite(n) && n >= 0) ? n : null });
            flash('✓ Buy-in saved');
            updatePotDisplay();
        });

        if (isAlloc) {
            wire('pool-set-bankroll', async (el) => {
                await savePoolConfig({ bankrollAmount: parseInt(el.value, 10) || 5000 });
                flash('✓ Bankroll saved');
            });
            const saveConstraints = async () => {
                await savePoolConfig({ allocationConstraints: {
                    min: parseInt(document.getElementById('pool-set-min').value, 10) || 250,
                    max: parseInt(document.getElementById('pool-set-max').value, 10) || 2000,
                    increment: parseInt(document.getElementById('pool-set-step').value, 10) || 50
                } });
                flash('✓ Bet limits saved');
            };
            ['pool-set-min', 'pool-set-max', 'pool-set-step'].forEach(id => wire(id, saveConstraints));
        } else {
            wire('pool-set-stake', async (el) => {
                await savePoolConfig({ defaultStake: parseInt(el.value, 10) || 100 });
                flash('✓ Stake saved');
            });
        }

        updatePotDisplay();
    }

    // ----- Render orchestrator -----
    function renderAll() {
        wirePoolTabs();
        renderHeader();
        renderPoolSettings();
        renderContestants();
        renderQuestions();
        renderEntries();
        renderResultsForm();
        renderStandings();
        renderInsights();
        renderOverUnderLine();
        renderLongshotQualifiers();
        renderAuditSeal();
        renderBroadcast();
    }

    function renderOverUnderLine() {
        const block = document.getElementById('pool-overunder-block');
        if (!block) return;
        const questions = currentPoolEvent.poolConfig.questions || [];
        const ouQ = questions.find(q => q.kind === 'overUnder');
        if (!ouQ) { block.style.display = 'none'; return; }
        block.style.display = 'block';

        const input = document.getElementById('pool-overunder-input');
        const msg = document.getElementById('pool-overunder-msg');
        if (input) input.value = ouQ.line || '';

        // Auto-save on blur/change — no separate Save button.
        if (input && !input.dataset.wired) {
            input.dataset.wired = '1';
            input.addEventListener('change', async () => {
                const newLine = input.value.trim();
                if (!newLine) { msg.textContent = 'Enter a line.'; msg.style.color = 'red'; return; }
                const current = currentPoolEvent.poolConfig.questions || [];
                const updated = current.map(q => q.kind === 'overUnder' ? Object.assign({}, q, { line: newLine }) : q);
                await savePoolConfig({ questions: updated });
                msg.textContent = `✓ Line set to ${newLine}`;
                msg.style.color = 'green';
            });
        }
    }

    function renderLongshotQualifiers() {
        const block = document.getElementById('pool-longshot-block');
        const list = document.getElementById('pool-longshot-list');
        if (!block || !list) return;

        const isAlloc = window.PoolConfig && window.PoolConfig.isAllocationMode(currentPoolEvent.poolConfig);
        const hasAutoProp = (currentPoolEvent.poolConfig.questions || []).some(q => q.kind === 'autoProp' && q.autoComputeFrom === 'longshotQualifiers');
        if (!isAlloc && !hasAutoProp) {
            block.style.display = 'none';
            return;
        }
        block.style.display = 'block';

        const contestants = currentPoolEvent.poolConfig.contestants || [];
        const currentSet = new Set((currentPoolEvent.poolConfig.longshotQualifiers || []).map(Number));
        list.innerHTML = '<div class="pool-longshot-grid">'
            + contestants.map(c => `
                <label class="pool-longshot-cell">
                    <input type="checkbox" data-qualifier-id="${c.id}" ${currentSet.has(Number(c.id)) ? 'checked' : ''} />
                    <span class="pool-longshot-pos">#${c.id}</span>
                    <span class="pool-longshot-name">${escapeHtml(c.name)}</span>
                    <span class="pool-longshot-odds">${escapeHtml(c.odds || '')}</span>
                </label>
            `).join('')
            + '</div>';

        const autoBtn = document.getElementById('pool-longshot-auto-btn');
        const msg = document.getElementById('pool-longshot-msg');

        // Persist whatever's currently checked. Called on every checkbox toggle and
        // after auto-suggest — no separate Save button.
        async function saveQualifiers() {
            const checked = Array.from(list.querySelectorAll('input[type=checkbox]:checked'))
                .map(cb => parseInt(cb.getAttribute('data-qualifier-id'), 10))
                .filter(Number.isFinite);
            await savePoolConfig({ longshotQualifiers: checked });
            msg.textContent = `✓ ${checked.length} qualifier${checked.length === 1 ? '' : 's'} saved`;
            msg.style.color = 'green';
            renderStandings();
        }

        // Checkboxes are re-created each render, so wire them fresh each time.
        list.querySelectorAll('input[type=checkbox]').forEach(cb => {
            cb.addEventListener('change', saveQualifiers);
        });

        if (autoBtn && !autoBtn.dataset.wired) {
            autoBtn.dataset.wired = '1';
            autoBtn.addEventListener('click', () => {
                // Check every contestant with morning-line odds >= 15:1, then save.
                const PC = window.PoolConfig;
                let n = 0;
                list.querySelectorAll('input[type=checkbox]').forEach(cb => {
                    const id = parseInt(cb.getAttribute('data-qualifier-id'), 10);
                    const c = (currentPoolEvent.poolConfig.contestants || []).find(c => Number(c.id) === id);
                    if (!c) return;
                    const qualifies = PC.parseOdds(c.odds).decimal >= 15;
                    cb.checked = qualifies;
                    if (qualifies) n++;
                });
                saveQualifiers();
            });
        }
    }

    function renderAuditSeal() {
        const status = document.getElementById('pool-audit-status');
        const btn = document.getElementById('pool-seal-btn');
        const msg = document.getElementById('pool-seal-msg');
        if (!status || !btn) return;

        const seal = currentPoolEvent && currentPoolEvent.auditSeal;
        if (seal && seal.hash) {
            const sealedDisplay = seal.sealedAtIso
                ? new Date(seal.sealedAtIso).toLocaleString()
                : (seal.sealedAt && seal.sealedAt.toDate ? seal.sealedAt.toDate().toLocaleString() : 'unknown');
            const autoNote = seal.auto ? ' <span class="pool-muted-badge" title="Sealed automatically when betting closed">⚙️ auto</span>' : '';
            const snapshotLink = seal.url
                ? `<a href="${escapeHtml(seal.url)}" target="_blank" rel="noopener">View snapshot JSON →</a>`
                : '<span class="pool-admin-help" style="margin:0;">Snapshot stored in the sealed record (verifiable on the event page).</span>';
            status.innerHTML = `
                <div class="pool-audit-current">
                    🔒 <strong>Sealed</strong> at ${escapeHtml(sealedDisplay)} · ${seal.entryCount} entries${autoNote}
                    <div class="pool-audit-hash">SHA-256: <code>${escapeHtml(seal.hash)}</code></div>
                    ${snapshotLink}
                </div>
            `;
            btn.textContent = 'Re-seal Entries';
        } else {
            status.textContent = 'Not sealed yet.';
            btn.textContent = 'Seal Entries Now';
        }

        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', async () => {
            if (!confirm('Snapshot all entries and publish a verifiable hash? Re-seal overwrites the previous seal.')) return;
            btn.disabled = true;
            const orig = btn.textContent;
            btn.textContent = 'Sealing…';
            msg.textContent = '';
            try {
                const result = await window.PoolAudit.sealEntries(currentPoolEventId, currentPoolEvent);
                msg.textContent = `Sealed ${result.entryCount} entries. Hash: ${result.hash}`;
                msg.style.color = 'green';
                // refresh local view
                const fresh = await db.collection('events').doc(currentPoolEventId).get();
                if (fresh.exists) currentPoolEvent = fresh.data();
                renderAuditSeal();
            } catch (err) {
                console.error('Seal error:', err);
                msg.textContent = 'Seal failed: ' + err.message;
                msg.style.color = 'red';
            } finally {
                btn.disabled = false;
                btn.textContent = orig;
            }
        });
    }

    async function renderInsights() {
        const container = document.getElementById('pool-insights-list');
        if (!container || !currentPoolEvent) return;
        try {
            const snap = await db.collection(currentPoolEvent.collectionName).get();
            if (snap.empty) {
                container.innerHTML = '<p class="pool-admin-help">No entries yet.</p>';
                return;
            }
            const PC = window.PoolConfig;
            const config = currentPoolEvent.poolConfig;
            const contestants = config.contestants || [];

            const enriched = snap.docs.map(doc => {
                const d = doc.data();
                return {
                    name: d.name || 'Unknown',
                    phone: d.phone,
                    picks: d.picks || {},
                    locks: d.locks || [],
                    max: PC.maxPossiblePayoff(config, d, contestants),
                    prob: PC.slipProbability(d, config, contestants),
                    pnl: PC.computePnL(d, config, contestants)
                };
            }).filter(e => e.max > 0);

            if (enriched.length === 0) {
                container.innerHTML = '<p class="pool-admin-help">Entries exist but no picks made yet.</p>';
                return;
            }

            // Compute fun stats — different angles for allocation vs fixed-stake pools
            const isAlloc = PC.isAllocationMode(config);
            const byPurse = enriched.slice().sort((a, b) => b.max - a.max);
            const total = enriched.reduce((s, e) => s + e.max, 0);
            const avg = Math.round(total / enriched.length);
            const biggest = byPurse[0];
            const smallest = byPurse[byPurse.length - 1];

            const lines = [
                `📊 ${enriched.length} ${enriched.length === 1 ? 'player' : 'players'} in. Combined max possible: $${total.toLocaleString()}.`,
                `🏆 Biggest possible payday: ${biggest.name} — $${biggest.max.toLocaleString()}.`,
                `💰 Average max possible: $${avg.toLocaleString()}.`,
            ];

            if (isAlloc) {
                // Allocation-specific: who concentrated, who diversified, biggest single bet
                const questions = config.questions || [];
                const stakesByPlayer = enriched.map(e => {
                    const stakes = questions.map(q => PC.getPickStake(e.picks[q.id]) || 0);
                    const max = Math.max(...stakes);
                    const min = Math.min(...stakes);
                    return { name: e.name, stakes, max, min, spread: max - min };
                });
                const mostConcentrated = stakesByPlayer.slice().sort((a, b) => b.spread - a.spread)[0];
                const mostDiversified = stakesByPlayer.slice().sort((a, b) => a.spread - b.spread)[0];
                const biggestBet = stakesByPlayer.slice().sort((a, b) => b.max - a.max)[0];
                lines.push(`🎯 Most concentrated slip: ${mostConcentrated.name} — biggest bet $${mostConcentrated.max.toLocaleString()}, smallest $${mostConcentrated.min.toLocaleString()}.`);
                lines.push(`🌐 Most diversified: ${mostDiversified.name} — spread of $${mostDiversified.spread.toLocaleString()} between biggest and smallest bet.`);
                if (biggestBet.max !== mostConcentrated.max) {
                    lines.push(`💵 Single biggest bet of the pool: ${biggestBet.name} at $${biggestBet.max.toLocaleString()}.`);
                }
            } else {
                // Fixed-stake (Derby): probability-based stats
                const byProb = enriched.slice().sort((a, b) => b.prob - a.prob);
                const longshot = byProb[byProb.length - 1];
                const favorite = byProb[0];
                const parlayCount = enriched.filter(e => e.locks.length >= 2).length;
                lines.push(`🎯 Most likely to hit their slip: ${favorite.name} at ${PC.formatOddsAgainst(favorite.prob)} — playing it relatively safe.`);
                lines.push(`🎲 Longest shot in the pool: ${longshot.name} needs ${PC.formatOddsAgainst(longshot.prob)} luck. Potential purse: $${longshot.max.toLocaleString()}.`);
                if (parlayCount > 0) {
                    lines.push(`🔒 ${parlayCount} ${parlayCount === 1 ? 'player' : 'players'} locked in a parlay bonus.`);
                }
            }

            // "If real money" lines — group + standout individuals
            const totalWagered = enriched.reduce((s, e) => s + e.pnl.wagered, 0);
            const totalEV = enriched.reduce((s, e) => s + e.pnl.ev, 0);
            const hasResults = !!config.results && PC.scoreSlip(config, { picks: {}, locks: [] }, contestants);
            const resultsEntered = config.results && Object.values(config.results).some(v => v != null && v !== '');

            lines.push(`💸 If we'd wagered real money: group risks $${totalWagered.toLocaleString()} across all slips.`);

            if (resultsEntered) {
                const totalReturned = enriched.reduce((s, e) => s + (e.pnl.returned || 0), 0);
                const groupNet = totalReturned - totalWagered;
                const sign = groupNet >= 0 ? '+' : '-';
                lines.push(`💵 Real-money result: group wagered $${totalWagered.toLocaleString()} → returned $${totalReturned.toLocaleString()} → net ${sign}$${Math.abs(groupNet).toLocaleString()}.`);

                const byNet = enriched.slice().sort((a, b) => (b.pnl.net || 0) - (a.pnl.net || 0));
                const winner = byNet[0];
                const loser = byNet[byNet.length - 1];
                lines.push(`📈 Biggest winner (real $): ${winner.name} ${winner.pnl.net >= 0 ? '+' : '-'}$${Math.abs(winner.pnl.net).toLocaleString()}.`);
                lines.push(`📉 Biggest loser (real $): ${loser.name} ${loser.pnl.net >= 0 ? '+' : '-'}$${Math.abs(loser.pnl.net).toLocaleString()}.`);
            } else {
                const sign = totalEV >= 0 ? '+' : '-';
                lines.push(`📉 Group expected value: ${sign}$${Math.abs(totalEV).toLocaleString()} (gambling math — odds are stacked).`);
                const byEV = enriched.slice().sort((a, b) => b.pnl.ev - a.pnl.ev);
                const leastBad = byEV[0];
                const worst = byEV[byEV.length - 1];
                const leastBadSign = leastBad.pnl.ev >= 0 ? '+' : '-';
                const worstSign = worst.pnl.ev >= 0 ? '+' : '-';
                lines.push(`🎯 Best expected value: ${leastBad.name} at ${leastBadSign}$${Math.abs(leastBad.pnl.ev).toLocaleString()}.`);
                lines.push(`🪦 Worst expected value: ${worst.name} at ${worstSign}$${Math.abs(worst.pnl.ev).toLocaleString()}.`);
            }

            container.innerHTML = '<ul class="pool-insights">'
                + lines.map(line =>
                    `<li class="pool-insight-line" title="Click to copy">${escapeHtml(line)}</li>`
                ).join('')
                + '</ul>';

            container.querySelectorAll('.pool-insight-line').forEach(li => {
                li.addEventListener('click', async () => {
                    try {
                        await navigator.clipboard.writeText(li.textContent);
                        const orig = li.style.background;
                        li.style.background = '#d4edda';
                        setTimeout(() => { li.style.background = orig; }, 600);
                    } catch (e) {
                        console.warn('Clipboard write failed:', e);
                    }
                });
            });
        } catch (err) {
            console.error('Error rendering insights:', err);
            container.innerHTML = '<p style="color:red;">Error loading insights.</p>';
        }
    }

    function renderBroadcast() {
        const btn = document.getElementById('pool-broadcast-btn');
        const countEl = document.getElementById('pool-broadcast-count');
        if (!btn || btn.dataset.wired) return;
        btn.dataset.wired = '1';

        // Show entry count next to the button
        if (countEl && currentPoolEvent && currentPoolEvent.collectionName) {
            db.collection(currentPoolEvent.collectionName).get().then(snap => {
                const phones = new Set();
                snap.forEach(d => { const p = (d.data() || {}).phone; if (p) phones.add(p); });
                countEl.textContent = `${phones.size} unique recipient${phones.size === 1 ? '' : 's'}`;
            }).catch(() => {});
        }

        btn.addEventListener('click', async () => {
            const msgInput = document.getElementById('pool-broadcast-message');
            const pinInput = document.getElementById('pool-broadcast-pin');
            const status = document.getElementById('pool-broadcast-msg');
            const message = msgInput.value.trim();
            const adminPin = pinInput.value.trim();

            if (!message) { status.textContent = 'Type a message first.'; status.style.color = 'red'; return; }
            if (!adminPin) { status.textContent = 'Enter the admin PIN.'; status.style.color = 'red'; return; }
            if (!confirm(`Send this SMS to all entrants?\n\n"${message}"`)) return;

            btn.disabled = true;
            status.textContent = 'Sending…';
            status.style.color = '#666';
            try {
                const res = await fetch(NOTIFY_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'broadcast',
                        eventId: currentPoolEventId,
                        message,
                        adminPin
                    })
                });
                const data = await res.json();
                if (data.success) {
                    status.textContent = `Sent to ${data.sent} of ${data.total} (${data.failed} failed).`;
                    status.style.color = 'green';
                    msgInput.value = '';
                    pinInput.value = '';
                } else {
                    status.textContent = `Failed: ${data.error || 'unknown error'}`;
                    status.style.color = 'red';
                }
            } catch (err) {
                console.error('Broadcast error:', err);
                status.textContent = 'Network error sending broadcast.';
                status.style.color = 'red';
            } finally {
                btn.disabled = false;
            }
        });
    }

    function renderHeader() {
        const header = document.getElementById('pool-admin-header');
        if (!header || !currentPoolEvent) return;
        const closesAt = currentPoolEvent.poolConfig.closesAt;
        const closesText = closesAt && closesAt.toDate
            ? closesAt.toDate().toLocaleString()
            : 'not set';
        const muted = (currentPoolEvent.poolConfig.mutedPhones || []).length;
        const isFeatured = currentPoolEvent.isFeatured !== undefined ? currentPoolEvent.isFeatured : currentPoolEvent.isActive;
        const lifecycle = currentPoolEvent.lifecycle || 'accepting';
        const code = currentPoolEvent.eventCode || '';

        header.innerHTML = `
            <div>
                <strong>${escapeHtml(currentPoolEvent.name)}</strong>
                ${code ? `<code class="pool-event-code">${escapeHtml(code)}</code>` : ''}
                ${isFeatured ? '<span class="pool-badge">FEATURED</span>' : ''}
                <span class="pool-lifecycle-badge pool-lifecycle-${lifecycle}">${lifecycle}</span>
                <span id="pool-event-switcher-wrap"></span>
            </div>
            <div class="pool-admin-meta">
                Closes: ${escapeHtml(closesText)}
                &middot; Stake: $${currentPoolEvent.poolConfig.defaultStake || 10}
                ${muted > 0 ? `&middot; <span class="pool-muted-count">🔇 ${muted} muted</span>` : ''}
            </div>
        `;
        renderPoolSwitcher();
    }

    async function renderPoolSwitcher() {
        const wrap = document.getElementById('pool-event-switcher-wrap');
        if (!wrap) return;
        try {
            const pools = await listPoolEvents();
            if (pools.length <= 1) return; // only show when there's a choice to make
            const opts = pools.map(d => {
                const data = d.data();
                const label = `${data.name}${data.eventCode ? ' [' + data.eventCode + ']' : ''}`;
                const selected = d.id === currentPoolEventId ? 'selected' : '';
                return `<option value="${d.id}" ${selected}>${escapeHtml(label)}</option>`;
            }).join('');
            wrap.innerHTML = `
                <label style="margin-left:12px; font-size:13px; color:#555;">Switch pool:
                    <select id="pool-event-switcher" style="margin-left:4px; padding:3px;">${opts}</select>
                </label>
            `;
            const sel = document.getElementById('pool-event-switcher');
            sel.addEventListener('change', () => {
                localStorage.setItem(POOL_SELECTION_KEY, sel.value);
                loadAndRender();
            });
        } catch (err) {
            console.warn('Pool switcher render failed:', err);
        }
    }

    // ----- Contestants -----
    function renderContestants() {
        const container = document.getElementById('pool-contestants-list');
        if (!container) return;
        const contestants = currentPoolEvent.poolConfig.contestants || [];
        if (contestants.length === 0) {
            container.innerHTML = '<p class="pool-admin-help">No horses yet. Add the field below.</p>';
        } else {
            container.innerHTML = '<table class="pool-table"><thead><tr><th>#</th><th>Name</th><th>Odds</th><th>Longshot</th><th></th></tr></thead><tbody>'
                + contestants.map(c => `
                    <tr>
                        <td>${c.id}</td>
                        <td>${escapeHtml(c.name)}</td>
                        <td>${escapeHtml(c.odds)}</td>
                        <td>${c.isLongshot ? '✓' : ''}</td>
                        <td><button data-contestant-id="${c.id}" class="pool-remove-btn">×</button></td>
                    </tr>
                `).join('') + '</tbody></table>';
            container.querySelectorAll('.pool-remove-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = Number(btn.getAttribute('data-contestant-id'));
                    if (!confirm(`Remove contestant #${id}?`)) return;
                    const next = (currentPoolEvent.poolConfig.contestants || []).filter(c => Number(c.id) !== id);
                    await savePoolConfig({ contestants: next });
                    renderContestants();
                    renderResultsForm();
                });
            });
        }

        // CSV file → textarea (no auto-import — user picks mode, then clicks Import)
        const fileInput = document.getElementById('pool-csv-file');
        if (fileInput && !fileInput.dataset.wired) {
            fileInput.dataset.wired = '1';
            fileInput.addEventListener('change', () => {
                const f = fileInput.files && fileInput.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    document.getElementById('pool-csv-input').value = e.target.result || '';
                    const msg = document.getElementById('pool-csv-msg');
                    if (msg) {
                        msg.textContent = `Loaded "${f.name}". Pick Append or Replace, then click Import.`;
                        msg.style.color = '#666';
                    }
                };
                reader.readAsText(f);
            });
        }

        // CSV import (idempotent)
        const importBtn = document.getElementById('pool-csv-import-btn');
        if (importBtn && !importBtn.dataset.wired) {
            importBtn.dataset.wired = '1';
            importBtn.addEventListener('click', async () => {
                const textarea = document.getElementById('pool-csv-input');
                const msg = document.getElementById('pool-csv-msg');
                const modeRadio = document.querySelector('input[name="csv-mode"]:checked');
                const mode = modeRadio ? modeRadio.value : 'append';
                const raw = textarea.value.trim();
                if (!raw) { msg.textContent = 'Paste some rows first.'; msg.style.color = 'red'; return; }

                const parsed = parseContestantCsv(raw);
                if (parsed.errors.length) {
                    msg.innerHTML = '<strong>Errors:</strong><br>' + parsed.errors.map(escapeHtml).join('<br>');
                    msg.style.color = 'red';
                    return;
                }
                if (parsed.rows.length === 0) {
                    msg.textContent = 'No valid rows parsed.';
                    msg.style.color = 'red';
                    return;
                }

                // Capture old contestants for change-detection (scratches, longshot drops)
                const oldContestantsSnapshot = (currentPoolEvent.poolConfig.contestants || []).map(c => Object.assign({}, c));

                let summary;
                if (parsed.mode === 'odds-only') {
                    // Merge: update odds (and recomputed longshot) on existing horses; report unmatched ids.
                    const current = (currentPoolEvent.poolConfig.contestants || []).slice();
                    const byId = new Map(current.map(c => [Number(c.id), c]));
                    const updatedIds = [];
                    const unknownIds = [];
                    parsed.rows.forEach(r => {
                        const existing = byId.get(Number(r.id));
                        if (!existing) { unknownIds.push(r.id); return; }
                        existing.odds = r.odds;
                        existing.isLongshot = r.isLongshot;
                        updatedIds.push(r.id);
                    });
                    await savePoolConfig({ contestants: current });
                    renderContestants();
                    renderResultsForm();
                    summary = `Updated odds for ${updatedIds.length} horse${updatedIds.length === 1 ? '' : 's'} (${updatedIds.join(', ')}).`;
                    if (unknownIds.length) summary += ` Unknown post #s skipped: ${unknownIds.join(', ')}.`;
                } else {
                    // Full import: add or replace
                    const existing = mode === 'replace' ? [] : (currentPoolEvent.poolConfig.contestants || []).slice();
                    const existingIds = new Set(existing.map(c => Number(c.id)));
                    const skipped = [];
                    parsed.rows.forEach(r => {
                        if (existingIds.has(Number(r.id))) {
                            skipped.push(r.id);
                        } else {
                            existing.push(r);
                            existingIds.add(Number(r.id));
                        }
                    });
                    existing.sort((a, b) => a.id - b.id);
                    await savePoolConfig({ contestants: existing });
                    renderContestants();
                    renderResultsForm();

                    const importedCount = parsed.rows.length - skipped.length;
                    summary = `Imported ${importedCount} horse${importedCount === 1 ? '' : 's'}.`;
                    if (skipped.length) summary += ` Skipped duplicate IDs: ${skipped.join(', ')}.`;
                }
                if (parsed.skipped && parsed.skipped.length) summary += ` Skipped from CSV: ${parsed.skipped.join(', ')}.`;

                // Detect changes vs the snapshot we took before save, and auto-notify affected players
                try {
                    const notifyLine = await notifyOddsChanges(oldContestantsSnapshot);
                    if (notifyLine) summary += ' ' + notifyLine;
                } catch (notifyErr) {
                    console.warn('Odds-change notify failed (non-fatal):', notifyErr);
                }

                msg.textContent = summary;
                msg.style.color = 'green';
                textarea.value = '';
                if (fileInput) fileInput.value = '';
            });
        }

        // Wire form (idempotent)
        const form = document.getElementById('pool-contestant-form');
        if (form && !form.dataset.wired) {
            form.dataset.wired = '1';
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const id = parseInt(document.getElementById('pool-contestant-id').value, 10);
                const name = document.getElementById('pool-contestant-name').value.trim();
                const odds = document.getElementById('pool-contestant-odds').value.trim();
                const isLongshot = document.getElementById('pool-contestant-longshot').checked;
                if (!id || !name || !odds) return;

                const list = (currentPoolEvent.poolConfig.contestants || []).slice();
                if (list.some(c => Number(c.id) === id)) {
                    alert(`Contestant #${id} already exists. Remove them first to change.`);
                    return;
                }
                list.push({ id, name, odds, isLongshot });
                list.sort((a, b) => a.id - b.id);
                await savePoolConfig({ contestants: list });
                form.reset();
                document.getElementById('pool-contestant-id').focus();
                renderContestants();
                renderResultsForm();
            });
        }
    }

    // ----- Questions -----
    function renderQuestions() {
        const container = document.getElementById('pool-questions-list');
        if (!container) return;
        const questions = currentPoolEvent.poolConfig.questions || [];
        const PC = window.PoolConfig;
        const bankrollMode = (currentPoolEvent.poolConfig.bankrollMode === 'allocate') ? 'allocate' : 'fixed';
        const usedIds = new Set(questions.map(q => q.id));

        let html = '';
        if (questions.length === 0) {
            html += '<p class="pool-admin-help">No bets yet. Add from the catalog below.</p>';
        } else {
            html += '<table class="pool-table"><thead><tr><th>Label</th><th>Kind</th><th>Stake</th><th>Payoff</th><th></th></tr></thead><tbody>'
                + questions.map(q => {
                    const stake = PC.effectiveStake(q, currentPoolEvent.poolConfig);
                    const flat = PC.payoffIfHit(q, stake);
                    const payoffText = q.kind === 'pickContestant' ? `odds × $${stake}`
                        : q.kind === 'overUnder' || q.kind === 'yesNo' ? `even ($${stake})`
                        : `$${flat.toLocaleString()} flat`;
                    return `
                        <tr>
                            <td>${escapeHtml(q.label)}${q.lockable ? ' <span class="pool-tag">lockable</span>' : ''}</td>
                            <td>${escapeHtml(q.kind)}</td>
                            <td>$${stake}</td>
                            <td>${payoffText}</td>
                            <td><button data-question-id="${q.id}" class="pool-remove-btn">×</button></td>
                        </tr>
                    `;
                }).join('') + '</tbody></table>';
        }

        // "Add Bet from Catalog" picker — bets available for this pool mode, grouped by category
        const catalog = PC.availableBetTypes ? PC.availableBetTypes(bankrollMode) : [];
        if (catalog.length > 0) {
            const byCategory = {};
            catalog.forEach(b => {
                if (!byCategory[b.category]) byCategory[b.category] = [];
                byCategory[b.category].push(b);
            });
            const optionGroups = Object.keys(byCategory).map(cat => {
                const opts = byCategory[cat].map(b => {
                    const inUse = usedIds.has(b.template.id);
                    return `<option value="${b.id}" ${inUse ? 'disabled' : ''}>${escapeHtml(b.catalogLabel)}${inUse ? ' (already added)' : ''}</option>`;
                }).join('');
                return `<optgroup label="${escapeHtml(cat)}">${opts}</optgroup>`;
            }).join('');
            html += `
                <div class="pool-add-bet">
                    <h4 style="margin:14px 0 6px;">Add a bet</h4>
                    <p class="pool-admin-help" style="margin:0 0 6px;">Pick a bet template from the catalog below. ${bankrollMode === 'allocate' ? 'Allocation' : 'Fixed-stake'} pool — only compatible bets shown.</p>
                    <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                        <select id="pool-add-bet-select" style="flex:1; min-width:240px;">
                            <option value="">— pick a bet type —</option>
                            ${optionGroups}
                        </select>
                        <button type="button" id="pool-add-bet-btn" class="pool-secondary-btn">Add Bet</button>
                    </div>
                    <p id="pool-add-bet-desc" class="pool-admin-help" style="margin-top:6px; min-height:16px;"></p>
                    <p id="pool-add-bet-msg" class="pool-admin-help"></p>
                </div>
            `;
        }
        container.innerHTML = html;

        // Wire remove buttons
        container.querySelectorAll('.pool-remove-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const qid = btn.getAttribute('data-question-id');
                if (!confirm(`Remove this bet ("${qid}") from the event?`)) return;
                const next = (currentPoolEvent.poolConfig.questions || []).filter(q => q.id !== qid);
                await savePoolConfig({ questions: next });
                renderQuestions();
                renderResultsForm();
            });
        });

        // Wire Add Bet picker
        const select = document.getElementById('pool-add-bet-select');
        const addBtn = document.getElementById('pool-add-bet-btn');
        const desc = document.getElementById('pool-add-bet-desc');
        const msg = document.getElementById('pool-add-bet-msg');
        if (select && desc) {
            select.addEventListener('change', () => {
                const b = catalog.find(b => b.id === select.value);
                desc.textContent = b ? b.description : '';
            });
        }
        if (addBtn) {
            addBtn.addEventListener('click', async () => {
                const sel = select.value;
                if (!sel) { msg.textContent = 'Pick a bet type first.'; msg.style.color = 'red'; return; }
                const b = catalog.find(b => b.id === sel);
                if (!b) return;
                if (usedIds.has(b.template.id)) {
                    msg.textContent = `Already have a bet with id "${b.template.id}". Remove that one first to add this template.`;
                    msg.style.color = 'red';
                    return;
                }
                const next = (currentPoolEvent.poolConfig.questions || []).slice();
                next.push(JSON.parse(JSON.stringify(b.template))); // deep clone
                await savePoolConfig({ questions: next });
                msg.textContent = `Added "${b.catalogLabel}".`;
                msg.style.color = 'green';
                renderQuestions();
                renderResultsForm();
            });
        }

        // Wire (legacy) "Reset to defaults" button — keeps Derby reset for backward compat
        const resetBtn = document.getElementById('pool-reset-questions');
        if (resetBtn && !resetBtn.dataset.wired) {
            resetBtn.dataset.wired = '1';
            resetBtn.addEventListener('click', async () => {
                const mode = (currentPoolEvent.poolConfig.bankrollMode === 'allocate') ? 'Preakness' : 'Derby';
                const defaults = (mode === 'Preakness')
                    ? window.PoolConfig.defaultPreaknessQuestions()
                    : window.PoolConfig.defaultDerbyQuestions();
                if (!confirm(`Reset questions to ${mode} defaults? This overwrites the current bet list.`)) return;
                await savePoolConfig({ questions: defaults });
                renderQuestions();
                renderResultsForm();
            });
        }
    }

    // ----- Entries -----
    async function renderEntries() {
        const container = document.getElementById('pool-entries-list');
        if (!container || !currentPoolEvent) return;
        container.innerHTML = 'Loading entries...';
        try {
            const snap = await db.collection(currentPoolEvent.collectionName)
                .orderBy('timestamp', 'desc')
                .get();
            lastEntryCount = snap.size;
            updatePotDisplay();
            if (snap.empty) {
                container.innerHTML = '<p class="pool-admin-help">No entries yet.</p>';
                return;
            }
            const contestants = currentPoolEvent.poolConfig.contestants || [];
            const contestantsById = {};
            contestants.forEach(c => { contestantsById[Number(c.id)] = c; });

            const mutedNorm = (currentPoolEvent.poolConfig.mutedPhones || [])
                .map(p => String(p).replace(/\D/g, '').slice(-10));
            const rows = snap.docs.map(doc => {
                const data = doc.data();
                const picks = data.picks || {};
                const locks = data.locks || [];
                const phoneNorm = String(data.phone || '').replace(/\D/g, '').slice(-10);
                const isMuted = phoneNorm && mutedNorm.includes(phoneNorm);
                const pickSummary = Object.entries(picks).map(([qid, pick]) => {
                    const stake = window.PoolConfig.getPickStake(pick);
                    const stakeStr = (stake !== null && stake > 0) ? ` $${stake.toLocaleString()}` : '';
                    return `<span class="pool-pick-chip">${escapeHtml(qid)}: ${formatPick(pick, contestantsById)}${stakeStr}${locks.includes(qid) ? ' 🔒' : ''}</span>`;
                }).join(' ');
                return `
                    <tr>
                        <td>${escapeHtml(data.name || 'Unknown')}${isMuted ? ' <span class="pool-muted-badge" title="Muted this event via SMS">🔇 muted</span>' : ''}</td>
                        <td>${escapeHtml(data.phone || '')}</td>
                        <td>${pickSummary}</td>
                        <td><button data-entry-id="${doc.id}" class="pool-remove-btn">×</button></td>
                    </tr>
                `;
            });
            container.innerHTML = '<table class="pool-table"><thead><tr><th>Name</th><th>Phone</th><th>Picks</th><th></th></tr></thead><tbody>'
                + rows.join('') + '</tbody></table>';

            container.querySelectorAll('.pool-remove-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Delete this entry?')) return;
                    await db.collection(currentPoolEvent.collectionName).doc(btn.getAttribute('data-entry-id')).delete();
                    renderEntries();
                    renderStandings();
                });
            });
        } catch (err) {
            console.error('Error loading entries:', err);
            container.innerHTML = '<p style="color:red;">Error loading entries.</p>';
        }
    }

    function formatPick(pick, contestantsById) {
        // Allocation-mode picks are wrapped as { value, stake } — unwrap to the
        // underlying selection before formatting (otherwise we render "[object Object]").
        const value = window.PoolConfig.getPickValue(pick);
        if (Array.isArray(value)) {
            return value.map(p => formatPick(p, contestantsById)).join('-');
        }
        const c = contestantsById[Number(value)];
        if (c) return `#${c.id} ${escapeHtml(c.name)}`;
        return escapeHtml(String(value));
    }

    // ----- Results form -----
    function renderResultsForm() {
        const form = document.getElementById('pool-results-form');
        if (!form) return;
        const questions = currentPoolEvent.poolConfig.questions || [];
        const contestants = currentPoolEvent.poolConfig.contestants || [];
        const results = currentPoolEvent.poolConfig.results || {};

        if (contestants.length === 0) {
            form.innerHTML = '<p class="pool-admin-help">Add horses before entering results.</p>';
            return;
        }

        const contestantOptions = contestants.map(c =>
            `<option value="${c.id}">#${c.id} ${escapeHtml(c.name)}</option>`
        ).join('');

        const isAlloc = window.PoolConfig && window.PoolConfig.isAllocationMode(currentPoolEvent.poolConfig);

        const inputs = questions.map(q => {
            const v = results[q.id];
            // In allocation mode, the position-derived kinds read from poolConfig.fullFinish.
            // Don't render a separate input for them — admin enters fullFinish below.
            if (isAlloc && (q.kind === 'orderedTriple' || q.kind === 'unorderedTriple' || q.kind === 'orderedPair' || q.kind === 'pickInTopN' || q.kind === 'pickContestant' || q.kind === 'pickLongshot' || q.kind === 'autoProp')) {
                return '';
            }
            switch (q.kind) {
                case 'pickContestant':
                    return `
                        <div class="pool-result-row">
                            <label>${escapeHtml(q.label)}</label>
                            <select data-result-key="${q.id}" data-kind="single">
                                <option value="">— select —</option>
                                ${contestants.map(c => `<option value="${c.id}" ${Number(v) === Number(c.id) ? 'selected' : ''}>#${c.id} ${escapeHtml(c.name)}</option>`).join('')}
                            </select>
                        </div>`;
                case 'orderedTriple':
                case 'unorderedTriple':
                    return `
                        <div class="pool-result-row">
                            <label>${escapeHtml(q.label)}</label>
                            <div class="pool-triple">
                                ${[0, 1, 2].map(i => `
                                    <select data-result-key="${q.id}" data-kind="triple" data-index="${i}">
                                        <option value="">${i + 1}${['st','nd','rd'][i]}</option>
                                        ${contestants.map(c => `<option value="${c.id}" ${Array.isArray(v) && Number(v[i]) === Number(c.id) ? 'selected' : ''}>#${c.id} ${escapeHtml(c.name)}</option>`).join('')}
                                    </select>
                                `).join('')}
                            </div>
                        </div>`;
                case 'overUnder':
                    return `
                        <div class="pool-result-row">
                            <label>${escapeHtml(q.label)}${q.line ? ' (' + escapeHtml(q.line) + ')' : ''}</label>
                            <select data-result-key="${q.id}" data-kind="single">
                                <option value="">—</option>
                                <option value="over" ${v === 'over' ? 'selected' : ''}>Over</option>
                                <option value="under" ${v === 'under' ? 'selected' : ''}>Under</option>
                            </select>
                        </div>`;
                case 'yesNo':
                    return `
                        <div class="pool-result-row">
                            <label>${escapeHtml(q.label)}</label>
                            <select data-result-key="${q.id}" data-kind="single">
                                <option value="">—</option>
                                <option value="yes" ${v === 'yes' ? 'selected' : ''}>Yes</option>
                                <option value="no" ${v === 'no' ? 'selected' : ''}>No</option>
                            </select>
                        </div>`;
                case 'pickLongshot':
                    return ''; // handled by box3 / orderedTriple
                default:
                    return '';
            }
        }).filter(Boolean).join('');

        const allocHelp = isAlloc
            ? '<p class="pool-admin-help">In allocation mode, position-based results (Top 5, Trifecta, Exacta, Long Shot) are derived from the full finish order entered below — only enter props/over-under here.</p>'
            : '';

        // Tiebreaker results inputs (e.g., winning jockey age)
        const tbQs = (currentPoolEvent.poolConfig.tiebreakerQuestions || []);
        const tbResults = (currentPoolEvent.poolConfig.tiebreakerResults || {});
        const tbHtml = tbQs.length > 0 ? `
            <div style="margin-top:14px; padding-top:10px; border-top:1px dashed #ddd;">
                <p class="pool-admin-help" style="margin:0 0 6px;">Tiebreakers (used only if multiple players tie on bankroll):</p>
                ${tbQs.map(tq => {
                    const v = tbResults[tq.key];
                    const valAttr = (v !== undefined && v !== null && v !== '') ? `value="${v}"` : '';
                    const minAttr = (tq.min !== undefined) ? `min="${tq.min}"` : '';
                    const maxAttr = (tq.max !== undefined) ? `max="${tq.max}"` : '';
                    return `
                        <div class="pool-result-row">
                            <label>${escapeHtml(tq.label)}</label>
                            <input type="number" data-tiebreaker-key="${escapeHtml(tq.key)}" ${minAttr} ${maxAttr} ${valAttr} style="max-width:140px;" />
                        </div>`;
                }).join('')}
            </div>
        ` : '';

        form.innerHTML = allocHelp + inputs + tbHtml + `
            <div style="margin-top:12px;">
                <button type="submit" class="pool-primary-btn">Save Results &amp; Compute Standings</button>
                <button type="button" id="pool-clear-results" class="pool-secondary-btn" style="margin-left:8px;">Clear Results</button>
                ${isAlloc ? '' : '<small class="pool-admin-help" style="margin-left:10px;">Top-3 box doubles as the longshot lookup.</small>'}
            </div>
        `;

        const clearBtn = document.getElementById('pool-clear-results');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                if (!confirm('Clear results? This re-opens the pool form for guests (until close time).')) return;
                await savePoolConfig({ results: null });
                renderResultsForm();
                renderStandings();
                alert('Results cleared.');
            });
        }

        // Full finish order entry
        const finishInput = document.getElementById('pool-full-finish-input');
        const finishMsg = document.getElementById('pool-finish-msg');
        if (finishInput && currentPoolEvent.poolConfig.fullFinish) {
            finishInput.value = (currentPoolEvent.poolConfig.fullFinish || []).join(', ');
        }
        const prefillBtn = document.getElementById('pool-prefill-finish-btn');
        if (prefillBtn && !prefillBtn.dataset.wired) {
            prefillBtn.dataset.wired = '1';
            prefillBtn.addEventListener('click', () => {
                const results = currentPoolEvent.poolConfig.results || {};
                const top3 = [results.win, results.place, results.show].filter(v => v != null && v !== '');
                if (top3.length === 0) {
                    finishMsg.textContent = 'No win/place/show results entered yet.';
                    finishMsg.style.color = 'red';
                    return;
                }
                const existing = (finishInput.value.trim()) ? finishInput.value.split(/\s*[,\n]\s*/).map(s => parseInt(s, 10)).filter(Number.isFinite) : [];
                if (existing.length > 0 && !confirm('Replace current finish order with top-3 prefill plus what you add after?')) return;
                finishInput.value = top3.join(', ') + ', ';
                finishInput.focus();
                finishInput.setSelectionRange(finishInput.value.length, finishInput.value.length);
                finishMsg.textContent = `Prefilled top 3. Add the rest after the comma.`;
                finishMsg.style.color = '#666';
            });
        }

        // Auto-save on blur/change (no separate Save button). Validation errors block the
        // save and show inline; a clean parse persists and re-sorts standings.
        if (finishInput && !finishInput.dataset.wired) {
            finishInput.dataset.wired = '1';
            finishInput.addEventListener('change', async () => {
                const raw = finishInput.value.trim();
                if (!raw) {
                    if (currentPoolEvent.poolConfig.fullFinish == null) { finishMsg.textContent = ''; return; }
                    if (!confirm('Clear the full finish order?')) {
                        finishInput.value = (currentPoolEvent.poolConfig.fullFinish || []).join(', ');
                        return;
                    }
                    await savePoolConfig({ fullFinish: null });
                    finishMsg.textContent = '✓ Cleared.';
                    finishMsg.style.color = '#666';
                    renderStandings();
                    return;
                }
                const ids = raw.split(/\s*[,\n]\s*/).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0);
                if (ids.length === 0) {
                    finishMsg.textContent = 'No valid horse numbers parsed.';
                    finishMsg.style.color = 'red';
                    return;
                }
                // Validate against contestants
                const contestantIds = new Set((currentPoolEvent.poolConfig.contestants || []).map(c => Number(c.id)));
                const unknown = ids.filter(id => !contestantIds.has(id));
                if (unknown.length) {
                    finishMsg.textContent = `Unknown horse #s: ${unknown.join(', ')}. Add them to Horses or fix typos.`;
                    finishMsg.style.color = 'red';
                    return;
                }
                const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
                if (dupes.length) {
                    finishMsg.textContent = `Duplicate horse #s: ${[...new Set(dupes)].join(', ')}.`;
                    finishMsg.style.color = 'red';
                    return;
                }
                await savePoolConfig({ fullFinish: ids });
                finishMsg.textContent = `✓ Saved ${ids.length} positions. Standings re-sorted with new tiebreaker.`;
                finishMsg.style.color = 'green';
                renderStandings();
            });
        }

        if (!form.dataset.wired) {
            form.dataset.wired = '1';
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const newResults = {};
                form.querySelectorAll('[data-result-key]').forEach(el => {
                    const key = el.getAttribute('data-result-key');
                    const kind = el.getAttribute('data-kind');
                    if (kind === 'triple') {
                        const idx = parseInt(el.getAttribute('data-index'), 10);
                        if (!newResults[key]) newResults[key] = [null, null, null];
                        newResults[key][idx] = el.value ? Number(el.value) : null;
                    } else {
                        // single
                        newResults[key] = el.value === '' ? null : (isNaN(Number(el.value)) ? el.value : Number(el.value));
                    }
                });

                // Cross-populate longshot result from any triple (uses the first triple found).
                const tripleQ = (currentPoolEvent.poolConfig.questions || []).find(q => q.kind === 'orderedTriple' || q.kind === 'unorderedTriple');
                if (tripleQ && Array.isArray(newResults[tripleQ.id])) {
                    (currentPoolEvent.poolConfig.questions || []).forEach(q => {
                        if (q.kind === 'pickLongshot') {
                            newResults[q.id] = newResults[tripleQ.id].filter(v => v != null);
                        }
                    });
                }

                // Reject empty/all-null results so we don't accidentally lock the pool form.
                const hasAny = Object.values(newResults).some(v => {
                    if (v === null || v === undefined || v === '') return false;
                    if (Array.isArray(v)) return v.some(x => x !== null && x !== undefined && x !== '');
                    return true;
                });
                if (!hasAny) {
                    alert('No results filled in. Pick at least one winner before saving (or use Clear Results to reset).');
                    return;
                }

                // Tiebreaker results
                const newTbResults = {};
                form.querySelectorAll('[data-tiebreaker-key]').forEach(el => {
                    const key = el.getAttribute('data-tiebreaker-key');
                    const raw = el.value;
                    if (raw === '' || raw === null) {
                        newTbResults[key] = null;
                    } else {
                        const n = Number(raw);
                        newTbResults[key] = isFinite(n) ? n : raw;
                    }
                });

                await savePoolConfig({ results: newResults, tiebreakerResults: newTbResults });
                renderStandings();
                alert('Results saved. Standings updated.');
            });
        }
    }

    // ----- Standings -----
    async function renderStandings() {
        const container = document.getElementById('pool-standings');
        if (!container || !currentPoolEvent) return;
        const results = currentPoolEvent.poolConfig.results;
        if (!results) {
            container.innerHTML = '<p class="pool-admin-help">Results not entered yet.</p>';
            return;
        }
        try {
            const snap = await db.collection(currentPoolEvent.collectionName)
                .orderBy('timestamp', 'desc')
                .get();
            const contestants = currentPoolEvent.poolConfig.contestants || [];
            const PC = window.PoolConfig;
            const isAlloc = PC.isAllocationMode(currentPoolEvent.poolConfig);
            const ranked = snap.docs.map(doc => {
                const entry = doc.data();
                const score = PC.scoreSlip(currentPoolEvent.poolConfig, entry, contestants);
                const tieBreak = PC.triCloseness(entry, currentPoolEvent.poolConfig);
                const winStake = isAlloc ? PC.totalWinningStake(entry, currentPoolEvent.poolConfig, contestants) : 0;
                const tbCloseness = PC.tiebreakerCloseness ? PC.tiebreakerCloseness(entry, currentPoolEvent.poolConfig) : null;
                return { name: entry.name || 'Unknown', phone: entry.phone, score, tieBreak, winStake, tbCloseness };
            }).sort((a, b) => {
                if (b.score.bankroll !== a.score.bankroll) return b.score.bankroll - a.score.bankroll;
                if (isAlloc) {
                    // Allocation cascade: winning stake → trifecta position error → tiebreaker closeness → alphabetical
                    if (b.winStake !== a.winStake) return b.winStake - a.winStake;
                    if (a.tieBreak && b.tieBreak && a.tieBreak.tier1 !== b.tieBreak.tier1) return a.tieBreak.tier1 - b.tieBreak.tier1;
                    if (a.tbCloseness !== null && b.tbCloseness !== null && a.tbCloseness !== b.tbCloseness) {
                        return a.tbCloseness - b.tbCloseness; // lower = closer = wins
                    }
                    return a.name.localeCompare(b.name);
                }
                // Fixed-stake tiebreaker: trifecta-closeness ladder, then numeric tiebreaker
                if (a.tieBreak.tier1 !== b.tieBreak.tier1) return a.tieBreak.tier1 - b.tieBreak.tier1;
                if (b.tieBreak.tier2 !== a.tieBreak.tier2) return b.tieBreak.tier2 - a.tieBreak.tier2;
                if (a.tieBreak.tier3 !== b.tieBreak.tier3) return a.tieBreak.tier3 - b.tieBreak.tier3;
                if (a.tbCloseness !== null && b.tbCloseness !== null && a.tbCloseness !== b.tbCloseness) {
                    return a.tbCloseness - b.tbCloseness;
                }
                return 0;
            });

            if (ranked.length === 0) {
                container.innerHTML = '<p class="pool-admin-help">No entries to score.</p>';
                return;
            }

            const tbQs = currentPoolEvent.poolConfig.tiebreakerQuestions || [];
            const tbResults = currentPoolEvent.poolConfig.tiebreakerResults || {};
            const tbHasResults = tbQs.some(q => tbResults[q.key] !== null && tbResults[q.key] !== undefined && tbResults[q.key] !== '');
            const tbColHeader = tbQs.length > 0 ? `<th>${tbQs.length === 1 ? escapeHtml(tbQs[0].label.split('(')[0].trim()) : 'TB closeness'}</th>` : '';
            const tbColCell = (r) => {
                if (tbQs.length === 0) return '';
                if (!tbHasResults || r.tbCloseness === null || r.tbCloseness === Infinity) return '<td>—</td>';
                return `<td>${r.tbCloseness}</td>`;
            };

            let tieHelp, tieHeader, tieCell;
            if (isAlloc) {
                tieHelp = tbQs.length > 0
                    ? 'Allocation cascade: bankroll → total $ on winning bets → trifecta position error → tiebreaker closeness → split pot / coin flip.'
                    : 'Allocation cascade: bankroll → total $ on winning bets → trifecta position error → split pot / coin flip.';
                tieHeader = '<th>Winning stake</th><th>Tri err</th>' + tbColHeader;
                tieCell = (r) => `<td>$${(r.winStake || 0).toLocaleString()}</td><td>${(r.tieBreak && typeof r.tieBreak.tier1 === 'number') ? r.tieBreak.tier1 : '—'}</td>` + tbColCell(r);
            } else {
                const useFull = ranked.length > 0 && ranked[0].tieBreak.usedFullFinish;
                tieHelp = useFull
                    ? 'Cascade: bankroll → tri positional error (lower) → exact hits (higher) → exacta error (lower) → coin flip.'
                    : 'Cascade: bankroll → set match → exact match → coin flip. Add full finish order below for granular tiebreaker.';
                tieHeader = (useFull
                    ? '<th>Tri err</th><th>Exact</th><th>Exacta err</th>'
                    : '<th>Tri match</th>') + tbColHeader;
                tieCell = (r) => {
                    const t = r.tieBreak;
                    const base = useFull
                        ? `<td>${t.tier1}</td><td>${t.tier2}/3</td><td>${t.tier3}</td>`
                        : `<td>${t.setMatch}/3 set, ${t.exactMatch}/3 exact</td>`;
                    return base + tbColCell(r);
                };
            }
            container.innerHTML = '<h4 style="margin-bottom:8px;">Standings</h4>'
                + `<p class="pool-admin-help" style="margin:0 0 8px;">${tieHelp}</p>`
                + `<table class="pool-table"><thead><tr><th>#</th><th>Name</th><th>Bankroll</th>${isAlloc ? '' : '<th>Parlay</th>'}${tieHeader}</tr></thead><tbody>`
                + ranked.map((r, i) => `
                    <tr>
                        <td>${i + 1}</td>
                        <td>${escapeHtml(r.name)}</td>
                        <td><strong>$${r.score.bankroll.toLocaleString()}</strong></td>
                        ${isAlloc ? '' : `<td>${r.score.parlay.attempted ? (r.score.parlay.hit ? `✓ +$${r.score.parlay.bonus}` : '✗') : ''}</td>`}
                        ${tieCell(r)}
                    </tr>
                `).join('') + '</tbody></table>';
        } catch (err) {
            console.error('Error rendering standings:', err);
            container.innerHTML = '<p style="color:red;">Error computing standings.</p>';
        }
    }

    // Normalize a single odds string into canonical fractional form ("X/Y").
    // Accepts: "6/1", "5-2", "EVEN", "6.0" (decimal where .0 means whole odds), "2.5" (= 5/2).
    // Returns null if unparseable.
    function normalizeOddsString(input) {
        if (input === null || input === undefined) return null;
        const s = String(input).trim().replace(/\s+/g, '');
        if (!s || s === '—' || s === '-') return null;
        if (/^even/i.test(s)) return '1/1';
        if (/^\d+[\/\-]\d+$/.test(s)) return s.replace('-', '/');
        if (/^\d+(\.\d+)?$/.test(s)) {
            // Decimal odds: 6.0 → 6/1, 2.5 → 5/2, 14.0 → 14/1
            const dec = parseFloat(s);
            if (Number.isInteger(dec)) return dec + '/1';
            // Reduce X.Y to fraction. Use 100 as denominator base, then GCD-reduce.
            const num = Math.round(dec * 100);
            const den = 100;
            const g = (function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); })(num, den);
            return (num / g) + '/' + (den / g);
        }
        return null;
    }

    // Fallback parser for unstructured / concatenated input (e.g. webpage copy-paste with no delimiters).
    // Looks for sequences of: digits (post#) + uppercase letter (name start) + ... + X/Y (odds) + optional SCRATCHED.
    // Always returns odds-only mode. Used when no commas/tabs/pipes/newlines are present in the input.
    function parseSmashedOddsBlob(raw) {
        const errors = [];
        const rows = [];
        const skipped = [];
        // Pattern: (post#)(letter)(name+jockey+trainer, no slashes)(numerator)/(denominator)(optional SCRATCHED)
        // Non-greedy on denominator + lookahead so we don't eat digits from the next post# entry.
        // Lookahead: end of string, OR a non-digit (whitespace/SCRATCHED), OR digits followed by uppercase (next post + name).
        const re = /(\d+)[A-Z][^\/]*?(\d+)\/(\d+?)(?=$|\D|\d+[A-Z])(\s*scratched)?/gi;
        let m;
        const seen = new Set();
        while ((m = re.exec(raw)) !== null) {
            const id = parseInt(m[1], 10);
            const num = parseInt(m[2], 10);
            const den = parseInt(m[3], 10);
            const isScratched = !!m[4];
            if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(num) || !Number.isFinite(den) || den === 0) continue;
            if (seen.has(id)) continue; // first match wins per id
            seen.add(id);
            if (isScratched) {
                skipped.push(`#${id} (scratched)`);
                continue;
            }
            const odds = `${num}/${den}`;
            const isLongshot = (num / den) >= 15;
            rows.push({ id, odds, isLongshot });
        }
        return { rows, errors, skipped, mode: 'odds-only' };
    }

    // CSV parser: header-aware. Maps columns by name (post, name/horse, odds, longshot, status).
    // Modes:
    //   'full' — full import; rows include name (required)
    //   'odds-only' — minimal Post + Odds only; merges into existing horses by id
    // Skips rows where Status contains SCRATCHED. Auto-flags longshots at 15:1+ if no longshot column.
    function parseContestantCsv(raw) {
        // First: detect concatenated/unstructured paste (no delimiters at all).
        // If there are no commas, tabs, pipes, or newlines, fall back to smart regex extraction.
        if (!/[,\t|\n]/.test(raw)) {
            return parseSmashedOddsBlob(raw);
        }
        const errors = [];
        const rows = [];
        const skipped = [];
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return { rows, errors, skipped, mode: 'full' };

        const splitRow = (line) => line.split(/\s*[,\t|]\s*/);
        const headerCells = splitRow(lines[0]).map(h => h.toLowerCase().trim());

        // Detect header by checking for known column names
        const knownCols = ['post', 'position', 'pos', '#', 'name', 'horse', 'contestant', 'odds', 'morning line odds', 'status', 'longshot', 'long', 'ls'];
        const looksLikeHeader = headerCells.some(c => knownCols.includes(c));

        // Build column map — prefer exact matches over fuzzy so 'Odds' wins over 'OddsDecimal'
        let cols;
        if (looksLikeHeader) {
            cols = {};
            // First pass: exact matches
            headerCells.forEach((h, i) => {
                if (h === 'post' || h === 'position' || h === 'pos' || h === '#') cols.id = i;
                else if (h === 'name' || h === 'horse' || h === 'contestant') cols.name = i;
                else if (h === 'odds') cols.odds = i;
                else if (h === 'status') cols.status = i;
                else if (h === 'longshot' || h === 'long' || h === 'ls') cols.longshot = i;
            });
            // Second pass: fuzzy fallbacks (only if exact match didn't fill the slot)
            headerCells.forEach((h, i) => {
                if (cols.odds === undefined && /odds/.test(h)) cols.odds = i;
            });
            if (cols.id === undefined || cols.odds === undefined) {
                errors.push('Header detected but missing required columns. Need at least position and odds.');
                return { rows, errors, skipped, mode: 'full' };
            }
        } else {
            // No header — try to auto-detect the odds column by scanning for X/Y patterns.
            // Handles cases like "Post,Horse,Jockey,Trainer,Odds" data where the user pasted
            // without the header line: column 4 contains odds, not column 2 (the jockey).
            const firstRowCells = splitRow(lines[0]);
            const oddsRe = /^\s*\d+\s*[\/\-]\s*\d+\s*$/;
            if (firstRowCells.length === 2) {
                cols = { id: 0, odds: 1 };
            } else {
                // Scan from the rightmost column leftward; first column where the first 3 data
                // rows all match the X/Y odds pattern wins. (Names/jockeys never look like odds.)
                let oddsCol = -1;
                const sample = lines.slice(0, Math.min(3, lines.length));
                for (let c = firstRowCells.length - 1; c >= 1; c--) {
                    if (sample.every(line => oddsRe.test(splitRow(line)[c] || ''))) {
                        oddsCol = c;
                        break;
                    }
                }
                if (oddsCol >= 2) {
                    // 5-col format with odds at the end (Post, Horse, Jockey, Trainer, Odds)
                    cols = { id: 0, name: 1, odds: oddsCol };
                } else {
                    // Default 3-col layout (Post, Horse, Odds[, Longshot])
                    cols = { id: 0, name: 1, odds: 2, longshot: 3 };
                }
            }
        }

        // Mode: odds-only when name column is absent
        const mode = (cols.name === undefined) ? 'odds-only' : 'full';
        const dataLines = looksLikeHeader ? lines.slice(1) : lines;

        dataLines.forEach((line, i) => {
            const cells = splitRow(line);
            const lineNum = i + (looksLikeHeader ? 2 : 1);

            const status = cols.status !== undefined ? (cells[cols.status] || '').trim() : '';
            if (/scratched/i.test(status)) {
                skipped.push(`#${cells[cols.id]} (scratched)`);
                return;
            }

            const id = parseInt(cells[cols.id], 10);
            const odds = (cells[cols.odds] || '').trim();
            const name = cols.name !== undefined ? (cells[cols.name] || '').trim() : '';
            const longshotCell = cols.longshot !== undefined ? (cells[cols.longshot] || '').toLowerCase().trim() : '';

            if (!Number.isFinite(id) || id <= 0) {
                errors.push(`Line ${lineNum}: bad position "${cells[cols.id]}"`);
                return;
            }
            if (mode === 'full' && !name) {
                errors.push(`Line ${lineNum}: missing name`);
                return;
            }
            const normalizedOdds = normalizeOddsString(odds);
            if (!normalizedOdds) {
                errors.push(`Line ${lineNum}: bad odds "${odds}" (expected 8/1, 5-2, EVEN, or decimal like 6.0 / 2.5)`);
                return;
            }
            // Always recompute longshot from new odds unless explicit column was provided
            let isLongshot;
            if (longshotCell) {
                isLongshot = ['yes', 'y', 'true', '1', 'longshot', 'long', 'ls'].includes(longshotCell);
            } else {
                const m = normalizedOdds.match(/^(\d+)\/(\d+)$/);
                isLongshot = m ? (parseInt(m[1], 10) / parseInt(m[2], 10)) >= 15 : false;
            }
            const row = { id, odds: normalizedOdds, isLongshot };
            if (mode === 'full') row.name = name;
            rows.push(row);
        });

        return { rows, errors, skipped, mode };
    }

    // ----- Utils -----
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ----- Bootstrap -----
    document.addEventListener('DOMContentLoaded', () => {
        // Wait for admin auth/init to complete; the sidebar link existence is the marker.
        const tryInit = () => {
            if (document.querySelector('.sidebar-link[data-panel="pool"]')) {
                initializePoolAdmin();
            } else {
                setTimeout(tryInit, 250);
            }
        };
        tryInit();
    });
})();
