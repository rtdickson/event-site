// Pool admin panel: contestants, questions, entries, results, standings.
// Operates on the active pool event (or most recent if none active).

(function () {
    'use strict';

    let currentPoolEventId = null;
    let currentPoolEvent = null;
    const NOTIFY_URL = 'https://us-central1-piveevents.cloudfunctions.net/sendNotification';

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
            empty.style.display = 'none';
            content.style.display = 'block';
            renderAll();
        } catch (err) {
            console.error('Error loading pool admin:', err);
        }
    }

    async function findPoolEvent() {
        // Prefer active pool event; fall back to most recent pool event.
        let snap = await db.collection('events')
            .where('type', '==', 'pool')
            .where('isActive', '==', true)
            .limit(1)
            .get();
        if (!snap.empty) return snap.docs[0];

        snap = await db.collection('events')
            .where('type', '==', 'pool')
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();
        if (!snap.empty) return snap.docs[0];

        return null;
    }

    // ----- Persistence -----
    async function savePoolConfig(patch) {
        if (!currentPoolEventId) return;
        Object.assign(currentPoolEvent.poolConfig, patch);
        await db.collection('events').doc(currentPoolEventId).update({
            poolConfig: currentPoolEvent.poolConfig
        });
    }

    // ----- Render orchestrator -----
    function renderAll() {
        renderHeader();
        renderContestants();
        renderQuestions();
        renderEntries();
        renderResultsForm();
        renderStandings();
        renderBroadcast();
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
        header.innerHTML = `
            <div><strong>${escapeHtml(currentPoolEvent.name)}</strong>
                ${currentPoolEvent.isActive ? '<span class="pool-badge">ACTIVE</span>' : ''}
            </div>
            <div class="pool-admin-meta">
                Closes: ${escapeHtml(closesText)}
                &middot; Stake: $${currentPoolEvent.poolConfig.defaultStake || 10}
            </div>
        `;
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

        // CSV file → textarea, then auto-import (idempotent)
        const fileInput = document.getElementById('pool-csv-file');
        if (fileInput && !fileInput.dataset.wired) {
            fileInput.dataset.wired = '1';
            fileInput.addEventListener('change', () => {
                const f = fileInput.files && fileInput.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    document.getElementById('pool-csv-input').value = e.target.result || '';
                    // Auto-trigger import — user explicitly chose this file
                    const btn = document.getElementById('pool-csv-import-btn');
                    if (btn) btn.click();
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
                let summary = `Imported ${importedCount} contestant${importedCount === 1 ? '' : 's'}.`;
                if (skipped.length) summary += ` Skipped duplicate IDs: ${skipped.join(', ')}.`;
                if (parsed.skipped && parsed.skipped.length) summary += ` Skipped from CSV: ${parsed.skipped.join(', ')}.`;
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
        if (questions.length === 0) {
            container.innerHTML = '<p class="pool-admin-help">No questions. Click "Reset to Derby defaults".</p>';
        } else {
            container.innerHTML = '<table class="pool-table"><thead><tr><th>Label</th><th>Kind</th><th>Stake</th><th>Payoff</th><th></th></tr></thead><tbody>'
                + questions.map(q => {
                    const payoffText = q.kind === 'pickContestant' ? `odds × $${q.stake}`
                        : q.kind === 'overUnder' || q.kind === 'yesNo' ? `even ($${q.stake})`
                        : `$${q.payoff || ''} flat`;
                    return `
                        <tr>
                            <td>${escapeHtml(q.label)}${q.lockable ? ' <span class="pool-tag">lockable</span>' : ''}</td>
                            <td>${escapeHtml(q.kind)}</td>
                            <td>$${q.stake}</td>
                            <td>${payoffText}</td>
                            <td><button data-question-id="${q.id}" class="pool-remove-btn">×</button></td>
                        </tr>
                    `;
                }).join('') + '</tbody></table>';
            container.querySelectorAll('.pool-remove-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const qid = btn.getAttribute('data-question-id');
                    if (!confirm(`Remove question "${qid}"?`)) return;
                    const next = (currentPoolEvent.poolConfig.questions || []).filter(q => q.id !== qid);
                    await savePoolConfig({ questions: next });
                    renderQuestions();
                    renderResultsForm();
                });
            });
        }

        const resetBtn = document.getElementById('pool-reset-questions');
        if (resetBtn && !resetBtn.dataset.wired) {
            resetBtn.dataset.wired = '1';
            resetBtn.addEventListener('click', async () => {
                if (!confirm('Reset questions to Derby defaults? This will overwrite the current question list.')) return;
                await savePoolConfig({ questions: window.PoolConfig.defaultDerbyQuestions() });
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
            if (snap.empty) {
                container.innerHTML = '<p class="pool-admin-help">No entries yet.</p>';
                return;
            }
            const contestants = currentPoolEvent.poolConfig.contestants || [];
            const contestantsById = {};
            contestants.forEach(c => { contestantsById[Number(c.id)] = c; });

            const rows = snap.docs.map(doc => {
                const data = doc.data();
                const picks = data.picks || {};
                const locks = data.locks || [];
                const pickSummary = Object.entries(picks).map(([qid, pick]) => {
                    return `<span class="pool-pick-chip">${escapeHtml(qid)}: ${formatPick(pick, contestantsById)}${locks.includes(qid) ? ' 🔒' : ''}</span>`;
                }).join(' ');
                return `
                    <tr>
                        <td>${escapeHtml(data.name || 'Unknown')}</td>
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
        if (Array.isArray(pick)) {
            return pick.map(p => formatPick(p, contestantsById)).join('-');
        }
        const c = contestantsById[Number(pick)];
        if (c) return `#${c.id} ${escapeHtml(c.name)}`;
        return escapeHtml(String(pick));
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

        const inputs = questions.map(q => {
            const v = results[q.id];
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
                            <label>${escapeHtml(q.label)}</label>
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
                    // Result for longshot is the top-3 array, same as box. Display once.
                    // Use box3's result if it exists; otherwise let admin enter top-3 here.
                    return ''; // handled by box3 / orderedTriple — pickLongshot reads top-3 result
                default:
                    return '';
            }
        }).filter(Boolean).join('');

        form.innerHTML = inputs + `
            <div style="margin-top:12px;">
                <button type="submit" class="pool-primary-btn">Save Results &amp; Compute Standings</button>
                <button type="button" id="pool-clear-results" class="pool-secondary-btn" style="margin-left:8px;">Clear Results</button>
                <small class="pool-admin-help" style="margin-left:10px;">Top-3 box doubles as the longshot lookup.</small>
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

                await savePoolConfig({ results: newResults });
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
            const ranked = snap.docs.map(doc => {
                const entry = doc.data();
                const score = window.PoolConfig.scoreSlip(currentPoolEvent.poolConfig, entry, contestants);
                return { name: entry.name || 'Unknown', phone: entry.phone, score };
            }).sort((a, b) => b.score.bankroll - a.score.bankroll);

            if (ranked.length === 0) {
                container.innerHTML = '<p class="pool-admin-help">No entries to score.</p>';
                return;
            }

            container.innerHTML = '<h4 style="margin-bottom:8px;">Standings</h4><table class="pool-table"><thead><tr><th>#</th><th>Name</th><th>Bankroll</th><th>Parlay</th></tr></thead><tbody>'
                + ranked.map((r, i) => `
                    <tr>
                        <td>${i + 1}</td>
                        <td>${escapeHtml(r.name)}</td>
                        <td><strong>$${r.score.bankroll}</strong></td>
                        <td>${r.score.parlay.attempted ? (r.score.parlay.hit ? `✓ +$${r.score.parlay.bonus}` : '✗') : ''}</td>
                    </tr>
                `).join('') + '</tbody></table>';
        } catch (err) {
            console.error('Error rendering standings:', err);
            container.innerHTML = '<p style="color:red;">Error computing standings.</p>';
        }
    }

    // CSV parser: header-aware. Maps columns by name (post, name/horse, odds, longshot, status).
    // Skips rows where Status contains SCRATCHED. Auto-flags longshots at 15:1+ if no longshot column.
    function parseContestantCsv(raw) {
        const errors = [];
        const rows = [];
        const skipped = [];
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return { rows, errors, skipped };

        const splitRow = (line) => line.split(/\s*[,\t|]\s*/);
        const headerCells = splitRow(lines[0]).map(h => h.toLowerCase().trim());

        // Detect header by checking for known column names
        const knownCols = ['post', 'position', 'pos', 'name', 'horse', 'odds', 'morning line odds', 'status', 'longshot'];
        const looksLikeHeader = headerCells.some(c => knownCols.includes(c));

        // Build column map
        let cols;
        if (looksLikeHeader) {
            cols = {};
            headerCells.forEach((h, i) => {
                if (h === 'post' || h === 'position' || h === 'pos' || h === '#') cols.id = i;
                else if (h === 'name' || h === 'horse' || h === 'contestant') cols.name = i;
                else if (h === 'odds' || /odds/.test(h)) cols.odds = i;
                else if (h === 'status') cols.status = i;
                else if (h === 'longshot' || h === 'long' || h === 'ls') cols.longshot = i;
            });
            if (cols.id === undefined || cols.name === undefined || cols.odds === undefined) {
                errors.push('Header detected but missing required columns. Need at least position, name/horse, odds.');
                return { rows, errors, skipped };
            }
        } else {
            cols = { id: 0, name: 1, odds: 2, longshot: 3 };
        }

        const dataLines = looksLikeHeader ? lines.slice(1) : lines;

        dataLines.forEach((line, i) => {
            const cells = splitRow(line);
            const lineNum = i + (looksLikeHeader ? 2 : 1);

            const status = cols.status !== undefined ? (cells[cols.status] || '').trim() : '';
            if (/scratched/i.test(status)) {
                skipped.push(`#${cells[cols.id]} ${cells[cols.name]} (scratched)`);
                return;
            }

            const id = parseInt(cells[cols.id], 10);
            const name = (cells[cols.name] || '').trim();
            const odds = (cells[cols.odds] || '').trim();
            const longshotCell = cols.longshot !== undefined ? (cells[cols.longshot] || '').toLowerCase().trim() : '';

            if (!Number.isFinite(id) || id <= 0) {
                errors.push(`Line ${lineNum}: bad position "${cells[cols.id]}"`);
                return;
            }
            if (!name) {
                errors.push(`Line ${lineNum}: missing name`);
                return;
            }
            if (!/^\d+\s*[\/\-]\s*\d+$/i.test(odds) && !/^even/i.test(odds)) {
                errors.push(`Line ${lineNum}: bad odds "${odds}" (expected like 8/1 or 5-2)`);
                return;
            }

            // Normalize odds to slash form
            const normalizedOdds = odds.replace(/\s+/g, '').replace('-', '/');
            // Auto-flag longshot: explicit column wins; else compute from odds (15:1+)
            let isLongshot;
            if (longshotCell) {
                isLongshot = ['yes', 'y', 'true', '1', 'longshot', 'long', 'ls'].includes(longshotCell);
            } else {
                const m = normalizedOdds.match(/^(\d+)\/(\d+)$/);
                isLongshot = m ? (parseInt(m[1], 10) / parseInt(m[2], 10)) >= 15 : false;
            }
            rows.push({ id, name, odds: normalizedOdds, isLongshot });
        });

        return { rows, errors, skipped };
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
