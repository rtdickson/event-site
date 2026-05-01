// Public pool page: entries table is the primary view; the pick form is a
// secondary action revealed on demand. Phone is the identity key — entering it
// auto-loads the user's existing slip (if any) and looks up their name from contacts.

(function (root) {
    'use strict';

    let activeEvent = null;
    let collectionName = null;
    let currentEntry = { name: '', phone: '', picks: {}, locks: [] };
    let existingEntryId = null;
    let mode = 'edit'; // 'edit' | 'view-locked' | 'view-results'
    let contactsByPhone = {}; // normalized phone → contact name

    const NOTIFY_URL = 'https://us-central1-piveevents.cloudfunctions.net/sendNotification';

    function renderPoolForm(eventData) {
        activeEvent = eventData;
        collectionName = eventData.collectionName;
        const container = document.getElementById('pool-section');
        if (!container) return;
        container.style.display = 'block';

        const config = eventData.poolConfig || {};
        const open = window.PoolConfig.isPoolOpen(config);
        const hasResults = hasAnyResults(config.results);

        if (hasResults) mode = 'view-results';
        else if (!open) mode = 'view-locked';
        else mode = 'edit';

        if (!config.contestants || config.contestants.length === 0) {
            container.innerHTML = `
                <div class="pool-card">
                    <h2>${escapeHtml(eventData.name)}</h2>
                    <p>The field hasn't been posted yet. Check back closer to post time.</p>
                </div>`;
            return;
        }

        renderShell(container);
        loadContactsThenEntries();
        if (mode === 'edit') {
            renderCountdown();
        }
    }

    function renderShell(container) {
        const closesAt = activeEvent.poolConfig.closesAt;
        const closesText = closesAt && closesAt.toDate
            ? closesAt.toDate().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
            : '';

        const ctaLabel = mode === 'view-results' ? 'View standings'
                        : mode === 'view-locked' ? 'Picks locked'
                        : 'Submit or update my picks';

        container.innerHTML = `
            <div class="pool-card">
                <div class="pool-header">
                    <h2>${escapeHtml(activeEvent.name)}</h2>
                    <div class="pool-countdown" id="pool-countdown"></div>
                </div>

                <div class="pool-entries-public" id="pool-entries-public">Loading entries…</div>

                <div class="pool-cta-row">
                    <button type="button" id="pool-show-form-btn" class="pool-primary-btn" ${mode !== 'edit' ? 'disabled' : ''}>
                        ${ctaLabel}
                    </button>
                    <p class="pool-fineprint">${closesText && mode === 'edit' ? 'Picks lock ' + escapeHtml(closesText) : ''}</p>
                </div>

                <div id="pool-form-wrap" style="display:none;">
                    <form id="pool-form">
                        <div class="pool-identity">
                            <label for="pool-phone">Your phone (use this to come back &amp; edit)</label>
                            <input type="tel" id="pool-phone" placeholder="e.g. 6135551234" required />
                            <label for="pool-name">Name</label>
                            <input type="text" id="pool-name" required />
                            <p id="pool-identity-msg" class="pool-fineprint"></p>
                        </div>

                        <div id="pool-questions"></div>

                        <div class="pool-summary">
                            <div class="pool-max">Potential purse: <strong id="pool-max-amount">$0</strong></div>
                        </div>

                        <button type="submit" id="pool-submit" class="pool-primary-btn">Submit picks</button>
                        <button type="button" id="pool-cancel" class="pool-secondary-btn" style="margin-left:8px;">Cancel</button>
                        <p id="pool-form-msg"></p>
                    </form>
                </div>
            </div>
        `;

        const showBtn = document.getElementById('pool-show-form-btn');
        if (showBtn) {
            showBtn.addEventListener('click', () => {
                if (mode !== 'edit') return;
                document.getElementById('pool-form-wrap').style.display = 'block';
                renderForm();
                document.getElementById('pool-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
                document.getElementById('pool-phone').focus();
            });
        }

        const cancelBtn = document.getElementById('pool-cancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                document.getElementById('pool-form-wrap').style.display = 'none';
                resetCurrentEntry();
            });
        }

        const form = document.getElementById('pool-form');
        if (form) form.addEventListener('submit', onSubmit);
    }

    // ----- Contacts (for name lookup) -----
    async function loadContactsThenEntries() {
        try {
            const snap = await db.collection('contacts').get();
            contactsByPhone = {};
            snap.forEach(doc => {
                const d = doc.data();
                const norm = normalizePhone(d.phone);
                if (norm) contactsByPhone[norm] = d.name;
            });
        } catch (err) {
            console.warn('Could not load contacts:', err);
        }
        renderEntries();
    }

    function normalizePhone(p) {
        if (!p) return '';
        const digits = String(p).replace(/\D/g, '');
        if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
        return digits;
    }

    function nameForPhone(phone, fallback) {
        const norm = normalizePhone(phone);
        return contactsByPhone[norm] || fallback || 'Unknown';
    }

    // ----- Entries table (primary view) -----
    async function renderEntries() {
        const container = document.getElementById('pool-entries-public');
        if (!container) return;
        try {
            const snap = await db.collection(collectionName)
                .orderBy('timestamp', 'desc')
                .get();

            if (snap.empty) {
                container.innerHTML = `
                    <div class="pool-empty-entries">
                        <p><strong>No entries yet.</strong> Be the first to lock in your picks.</p>
                    </div>`;
                return;
            }

            const config = activeEvent.poolConfig;
            const contestants = config.contestants || [];
            const contestantsById = {};
            contestants.forEach(c => { contestantsById[Number(c.id)] = c; });
            const hasResults = hasAnyResults(config.results);

            const ranked = snap.docs.map(doc => {
                const data = doc.data();
                const displayName = nameForPhone(data.phone, data.name);
                const score = hasResults ? window.PoolConfig.scoreSlip(config, data, contestants) : null;
                const max = hasResults ? null : window.PoolConfig.maxPossiblePayoff(config, data, contestants);
                const slipProb = hasResults ? null : window.PoolConfig.slipProbability(data, config, contestants);
                return { data, displayName, score, max, slipProb };
            });
            // Sort by bankroll descending if results, else by max descending
            ranked.sort((a, b) => {
                const av = a.score ? a.score.bankroll : a.max;
                const bv = b.score ? b.score.bankroll : b.max;
                return (bv || 0) - (av || 0);
            });

            // Total potential purse across all entries (pre-results only)
            const totalPurse = hasResults ? null : ranked.reduce((s, r) => s + (r.max || 0), 0);

            const rows = ranked.map(({ data, displayName, score, max, slipProb }, i) => {
                const hasLocks = Array.isArray(data.locks) && data.locks.length >= 2;
                const oddsStr = (!hasResults && slipProb)
                    ? `<div class="pool-entry-odds">odds ${window.PoolConfig.formatOddsAgainst(slipProb)}</div>`
                    : '';
                const amountStr = hasResults
                    ? `<strong>$${score.bankroll.toLocaleString()}</strong>`
                    : `<span class="pool-max-cell">$${max.toLocaleString()}</span>${oddsStr}`;
                const detail = renderEntryDetail(data, config, contestantsById, score);
                const rankBadge = hasResults && i < 3 ? `<span class="pool-rank-badge rank-${i+1}">${['🥇','🥈','🥉'][i]}</span>` : '';
                return `
                    <details class="pool-entry-row">
                        <summary>
                            <span class="pool-entry-name">${rankBadge}<strong>${escapeHtml(displayName)}</strong>${hasLocks ? ' <span class="pool-tag">parlay</span>' : ''}</span>
                            <span class="pool-entry-amount">${amountStr}</span>
                            <span class="pool-entry-toggle">▾</span>
                        </summary>
                        <div class="pool-entry-detail">${detail}</div>
                    </details>
                `;
            }).join('');

            const headerLabel = hasResults ? 'Bankroll' : 'Potential purse';
            const totalLine = (!hasResults && totalPurse > 0)
                ? `<div class="pool-total-purse">Combined potential purse across ${ranked.length} ${ranked.length === 1 ? 'player' : 'players'}: <strong>$${totalPurse.toLocaleString()}</strong></div>`
                : '';

            container.innerHTML = `
                <h3 class="pool-entries-heading">${hasResults ? 'Standings' : 'Entries so far'} (${snap.size})</h3>
                ${totalLine}
                <div class="pool-entries-header-row">
                    <span>Name</span>
                    <span>${headerLabel}</span>
                </div>
                <div class="pool-entries-list">${rows}</div>
                ${hasResults ? '' : '<p class="pool-fineprint" style="margin-top:8px;">Tap a name to see their picks. Potential purse = what each player would win if every pick on their slip hits. Odds are rough — derived from morning-line probabilities.</p>'}
            `;
        } catch (err) {
            console.error('Error loading entries:', err);
            container.innerHTML = '<p style="color:red;">Could not load entries.</p>';
        }
    }

    function renderEntryDetail(data, config, contestantsById, score) {
        const picks = data.picks || {};
        const locks = data.locks || [];
        const questions = config.questions || [];
        const hasResults = !!score;

        const lines = questions.map(q => {
            const v = picks[q.id];
            if (v === undefined || v === null || v === '') return '';
            const lock = locks.includes(q.id) ? ' 🔒' : '';
            const pickStr = formatPickValue(q, v, contestantsById);
            let resultStr = '';
            if (hasResults) {
                const pq = score.perQuestion.find(p => p.questionId === q.id);
                if (pq && pq.hit) resultStr = ` <span class="pool-detail-payoff hit">+$${pq.payoff}</span>`;
                else if (pq) resultStr = ` <span class="pool-detail-payoff miss">—</span>`;
            }
            return `<li><span class="pool-detail-label">${escapeHtml(q.label)}${lock}</span><span class="pool-detail-value">${escapeHtml(pickStr)}${resultStr}</span></li>`;
        }).filter(Boolean);

        let parlayLine = '';
        if (locks.length >= 2) {
            if (hasResults) {
                const p = score.parlay;
                parlayLine = `<li class="pool-detail-parlay"><span class="pool-detail-label">Parlay (${locks.length} legs)</span><span class="pool-detail-value">${p.hit ? `<span class="pool-detail-payoff hit">+$${p.bonus}</span>` : `<span class="pool-detail-payoff miss">missed</span>`}</span></li>`;
            } else {
                parlayLine = `<li class="pool-detail-parlay"><span class="pool-detail-label">Parlay (${locks.length} legs locked)</span><span class="pool-detail-value">all-or-nothing bonus</span></li>`;
            }
        }

        return `<ul class="pool-detail-list">${lines.join('')}${parlayLine}</ul>`;
    }

    function formatPickValue(q, v, contestantsById) {
        if (Array.isArray(v)) {
            return v.filter(x => x != null).map(id => {
                const c = contestantsById[Number(id)];
                return c ? `#${c.id} ${c.name}` : `#${id}`;
            }).join(' · ');
        }
        if (q.kind === 'pickContestant' || q.kind === 'pickLongshot') {
            const c = contestantsById[Number(v)];
            return c ? `#${c.id} ${c.name}` : `#${v}`;
        }
        return String(v);
    }

    function renderPickSummary(data, config, contestantsById) {
        const picks = data.picks || {};
        const locks = data.locks || [];
        const questions = config.questions || [];
        // Show only single-contestant picks in the summary chip (W/P/S, longshot).
        // Trifecta/box collapsed into a "Tri" chip if filled.
        const chips = [];
        questions.forEach(q => {
            const v = picks[q.id];
            if (v === undefined || v === null || v === '') return;
            const lock = locks.includes(q.id) ? '🔒' : '';
            switch (q.kind) {
                case 'pickContestant':
                case 'pickLongshot': {
                    const c = contestantsById[Number(v)];
                    const label = q.id === 'win' ? 'W' : q.id === 'place' ? 'P' : q.id === 'show' ? 'S' : q.label.split(' ')[0];
                    chips.push(`<span class="pool-pick-chip">${escapeHtml(label)}${lock}: #${v} ${escapeHtml(c ? c.name : '?')}</span>`);
                    break;
                }
                case 'orderedTriple':
                case 'unorderedTriple': {
                    if (Array.isArray(v) && v.some(x => x != null)) {
                        const ids = v.filter(x => x != null).join('-');
                        chips.push(`<span class="pool-pick-chip">${q.kind === 'orderedTriple' ? 'Tri' : 'Box'}: ${escapeHtml(ids)}</span>`);
                    }
                    break;
                }
                case 'overUnder':
                case 'yesNo':
                    chips.push(`<span class="pool-pick-chip pool-pick-chip-prop">${escapeHtml(String(v))}</span>`);
                    break;
            }
        });
        return chips.join(' ');
    }

    // ----- Form -----
    function renderForm() {
        const container = document.getElementById('pool-questions');
        if (!container) return;
        const config = activeEvent.poolConfig;
        const contestants = config.contestants || [];
        const questions = config.questions || [];

        container.innerHTML = questions.map(q => renderQuestion(q, contestants)).join('');

        container.querySelectorAll('[data-pick-key]').forEach(el => {
            el.addEventListener('change', () => {
                const key = el.getAttribute('data-pick-key');
                const idx = el.getAttribute('data-pick-index');
                if (idx !== null && idx !== undefined) {
                    if (!Array.isArray(currentEntry.picks[key])) currentEntry.picks[key] = [];
                    currentEntry.picks[key][parseInt(idx, 10)] = parseValue(el.value);
                } else {
                    currentEntry.picks[key] = parseValue(el.value);
                }
                updateMaxPayoff();
            });
        });

        container.querySelectorAll('.pool-lock-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const qid = btn.getAttribute('data-question-id');
                const idx = currentEntry.locks.indexOf(qid);
                if (idx >= 0) {
                    currentEntry.locks.splice(idx, 1);
                    btn.classList.remove('locked');
                } else {
                    if (currentEntry.locks.length >= 3) {
                        flashMessage('You can lock at most 3 picks for the parlay.');
                        return;
                    }
                    currentEntry.locks.push(qid);
                    btn.classList.add('locked');
                }
                updateMaxPayoff();
            });
        });

        document.getElementById('pool-name').value = currentEntry.name || '';
        document.getElementById('pool-phone').value = currentEntry.phone || '';

        // Auto-lookup on phone change/blur — fetch existing slip + contact name
        const phoneInput = document.getElementById('pool-phone');
        phoneInput.addEventListener('blur', onPhoneEntered);

        updateMaxPayoff();
    }

    async function onPhoneEntered() {
        const phoneInput = document.getElementById('pool-phone');
        const nameInput = document.getElementById('pool-name');
        const msg = document.getElementById('pool-identity-msg');
        const phoneRaw = phoneInput.value.trim();
        if (!phoneRaw) return;

        currentEntry.phone = phoneRaw;
        const norm = normalizePhone(phoneRaw);

        // Contact name lookup
        const contactName = contactsByPhone[norm];
        if (contactName && !nameInput.value.trim()) {
            nameInput.value = contactName;
            currentEntry.name = contactName;
        }

        // Existing slip lookup (forgiving phone match)
        try {
            const all = await db.collection(collectionName).get();
            let found = null;
            all.forEach(doc => {
                if (found) return;
                const d = doc.data();
                if (normalizePhone(d.phone) === norm) found = { id: doc.id, data: d };
            });
            if (found) {
                existingEntryId = found.id;
                currentEntry = {
                    name: found.data.name || contactName || '',
                    phone: found.data.phone || phoneRaw,
                    picks: found.data.picks || {},
                    locks: Array.isArray(found.data.locks) ? found.data.locks.slice() : []
                };
                if (contactName) currentEntry.name = contactName; // prefer contact name
                renderForm();
                msg.textContent = `Welcome back. Loaded your existing slip — edit and submit to update.`;
                msg.style.color = 'green';
                document.getElementById('pool-submit').textContent = 'Update picks';
            } else {
                existingEntryId = null;
                msg.textContent = contactName ? `Hi ${contactName} — fill in your picks below.` : '';
                msg.style.color = '#666';
                document.getElementById('pool-submit').textContent = 'Submit picks';
            }
        } catch (err) {
            console.error('Phone lookup error:', err);
        }
    }

    function renderQuestion(q, contestants) {
        const lockBtn = q.lockable ? `
            <button type="button" class="pool-lock-btn ${currentEntry.locks.includes(q.id) ? 'locked' : ''}"
                data-question-id="${q.id}" title="Lock this pick into your parlay">🔒</button>` : '';
        const help = renderQuestionHelp(q);

        let body = '';
        switch (q.kind) {
            case 'pickContestant':
                body = `<select data-pick-key="${q.id}">
                    <option value="">— pick —</option>
                    ${contestants.map(c => optionFor(c, currentEntry.picks[q.id])).join('')}
                </select>`;
                break;
            case 'pickLongshot':
                const longshots = contestants.filter(c => c.isLongshot);
                if (longshots.length === 0) {
                    body = '<em style="color:#888;">No longshots flagged in the field.</em>';
                } else {
                    body = `<select data-pick-key="${q.id}">
                        <option value="">— pick —</option>
                        ${longshots.map(c => optionFor(c, currentEntry.picks[q.id])).join('')}
                    </select>`;
                }
                break;
            case 'orderedTriple':
            case 'unorderedTriple':
                body = '<div class="pool-triple">'
                    + [0, 1, 2].map(i => {
                        const cur = Array.isArray(currentEntry.picks[q.id]) ? currentEntry.picks[q.id][i] : null;
                        const labels = q.kind === 'orderedTriple' ? ['1st','2nd','3rd'] : ['Pick','Pick','Pick'];
                        return `<select data-pick-key="${q.id}" data-pick-index="${i}">
                            <option value="">${labels[i]}</option>
                            ${contestants.map(c => optionFor(c, cur)).join('')}
                        </select>`;
                    }).join('')
                    + '</div>';
                break;
            case 'overUnder':
                body = `<div class="pool-radio">
                    ${radioFor(q.id, 'over', 'Over ' + (q.line || ''), currentEntry.picks[q.id])}
                    ${radioFor(q.id, 'under', 'Under ' + (q.line || ''), currentEntry.picks[q.id])}
                </div>`;
                break;
            case 'yesNo':
                body = `<div class="pool-radio">
                    ${radioFor(q.id, 'yes', 'Yes', currentEntry.picks[q.id])}
                    ${radioFor(q.id, 'no', 'No', currentEntry.picks[q.id])}
                </div>`;
                break;
        }

        return `
            <div class="pool-question">
                <div class="pool-question-head">
                    <label>${escapeHtml(q.label)}</label>
                    <span class="pool-question-meta">${help}</span>
                    ${lockBtn}
                </div>
                ${body}
            </div>
        `;
    }

    function renderQuestionHelp(q) {
        const stake = window.PoolConfig.effectiveStake(q, activeEvent.poolConfig);
        const flatPayoff = window.PoolConfig.payoffIfHit(q, stake);
        switch (q.kind) {
            case 'pickContestant': return `$${stake} → odds-based payoff`;
            case 'orderedTriple':  return `$${stake} → $${flatPayoff.toLocaleString()} if exact`;
            case 'unorderedTriple':return `$${stake} → $${flatPayoff.toLocaleString()} if all 3 in top 3`;
            case 'pickLongshot':   return `$${stake} → $${flatPayoff.toLocaleString()} if top 3`;
            case 'overUnder':
            case 'yesNo':          return `$${stake} even money`;
            default: return '';
        }
    }

    function optionFor(contestant, currentValue) {
        const sel = Number(currentValue) === Number(contestant.id) ? 'selected' : '';
        return `<option value="${contestant.id}" ${sel}>#${contestant.id} ${escapeHtml(contestant.name)} (${escapeHtml(contestant.odds)})</option>`;
    }

    function radioFor(qid, value, label, currentValue) {
        const id = `pool-${qid}-${value}`;
        const sel = currentValue === value ? 'checked' : '';
        return `
            <label for="${id}" class="pool-radio-label">
                <input type="radio" id="${id}" name="pool-${qid}" value="${value}" data-pick-key="${qid}" ${sel} />
                ${escapeHtml(label)}
            </label>`;
    }

    function parseValue(v) {
        if (v === '' || v == null) return null;
        if (!isNaN(Number(v))) return Number(v);
        return v;
    }

    function updateMaxPayoff() {
        const max = window.PoolConfig.maxPossiblePayoff(activeEvent.poolConfig, currentEntry, activeEvent.poolConfig.contestants);
        const el = document.getElementById('pool-max-amount');
        if (el) el.textContent = '$' + max.toLocaleString();
    }

    function renderCountdown() {
        const el = document.getElementById('pool-countdown');
        if (!el) return;
        const closesAt = activeEvent.poolConfig.closesAt;
        if (!closesAt || !closesAt.toDate) return;
        const update = () => {
            const ms = closesAt.toDate().getTime() - Date.now();
            if (ms <= 0) {
                el.textContent = 'Picks locked';
                el.classList.add('locked');
                if (mode === 'edit') {
                    mode = 'view-locked';
                    const showBtn = document.getElementById('pool-show-form-btn');
                    if (showBtn) {
                        showBtn.disabled = true;
                        showBtn.textContent = 'Picks locked';
                    }
                }
                return;
            }
            const s = Math.floor(ms / 1000);
            const d = Math.floor(s / 86400);
            const h = Math.floor((s % 86400) / 3600);
            const m = Math.floor((s % 3600) / 60);
            const parts = [];
            if (d) parts.push(d + 'd');
            if (h || d) parts.push(h + 'h');
            parts.push(m + 'm');
            el.textContent = 'Closes in ' + parts.join(' ');
        };
        update();
        setInterval(update, 30000);
    }

    function resetCurrentEntry() {
        currentEntry = { name: '', phone: '', picks: {}, locks: [] };
        existingEntryId = null;
    }

    async function onSubmit(e) {
        e.preventDefault();
        if (mode !== 'edit') return;

        if (!window.PoolConfig.isPoolOpen(activeEvent.poolConfig)) {
            flashMessage('Picks are locked.', 'red');
            return;
        }

        const name = document.getElementById('pool-name').value.trim();
        const phone = document.getElementById('pool-phone').value.trim();
        if (!name || !phone) {
            flashMessage('Name and phone are required.', 'red');
            return;
        }
        currentEntry.name = name;
        currentEntry.phone = phone;

        // Capture state before save for notification
        const isNewEntry = !existingEntryId;
        let previousWinPick = null;
        if (existingEntryId) {
            try {
                const prev = await db.collection(collectionName).doc(existingEntryId).get();
                if (prev.exists) previousWinPick = (prev.data().picks || {}).win || null;
            } catch (err) { console.warn('Could not fetch previous entry:', err); }
        }

        const submitBtn = document.getElementById('pool-submit');
        const original = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';

        try {
            const payload = {
                name: currentEntry.name,
                phone: currentEntry.phone,
                picks: currentEntry.picks,
                locks: currentEntry.locks,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            };

            if (existingEntryId) {
                await db.collection(collectionName).doc(existingEntryId).update(payload);
            } else {
                // Forgiving dedup by normalized phone
                const norm = normalizePhone(phone);
                const all = await db.collection(collectionName).get();
                let dupId = null;
                all.forEach(doc => {
                    if (dupId) return;
                    if (normalizePhone(doc.data().phone) === norm) dupId = doc.id;
                });
                if (dupId) {
                    existingEntryId = dupId;
                    await db.collection(collectionName).doc(existingEntryId).update(payload);
                } else {
                    const ref = await db.collection(collectionName).add(payload);
                    existingEntryId = ref.id;
                }
            }
            flashMessage('Picks saved! Good luck.', 'green');
            submitBtn.textContent = 'Update picks';

            // Fire-and-forget SMS notifications. Don't block on failure.
            const summary = buildPickSummary();
            const eventId = activeEvent._id;
            if (eventId) {
                fetch(NOTIFY_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'entry-submitted',
                        eventId,
                        playerName: name,
                        playerPhone: phone,
                        pickSummary: summary,
                        winnerPick: currentEntry.picks.win || null,
                        winnerChanged: previousWinPick !== currentEntry.picks.win,
                        isNewEntry
                    })
                }).catch(e => console.warn('Notification failed:', e));
            }

            // Refresh entries table and collapse the form
            await renderEntries();
            setTimeout(() => {
                document.getElementById('pool-form-wrap').style.display = 'none';
                document.getElementById('pool-entries-public').scrollIntoView({ behavior: 'smooth' });
            }, 1200);
        } catch (err) {
            console.error('Submit error:', err);
            flashMessage('Could not save picks. Try again.', 'red');
            submitBtn.textContent = original;
        } finally {
            submitBtn.disabled = false;
        }
    }

    function flashMessage(text, color) {
        const el = document.getElementById('pool-form-msg');
        if (!el) return;
        el.textContent = text;
        el.style.color = color || '#333';
        if (color === 'green') {
            setTimeout(() => { el.textContent = ''; }, 4000);
        }
    }

    function buildPickSummary() {
        const config = activeEvent.poolConfig || {};
        const contestants = config.contestants || [];
        const cById = {};
        contestants.forEach(c => { cById[Number(c.id)] = c; });
        const winId = currentEntry.picks.win;
        const win = cById[Number(winId)];
        const parts = [];
        if (win) parts.push(`Win: #${win.id} ${win.name}`);
        const lockCount = (currentEntry.locks || []).length;
        if (lockCount >= 2) parts.push(`${lockCount}-leg parlay`);
        return parts.join(' · ');
    }

    function hasAnyResults(results) {
        if (!results || typeof results !== 'object') return false;
        return Object.values(results).some(v => {
            if (v === null || v === undefined || v === '') return false;
            if (Array.isArray(v)) return v.some(x => x !== null && x !== undefined && x !== '');
            return true;
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    root.PoolRender = { renderPoolForm };
})(typeof window !== 'undefined' ? window : this);
