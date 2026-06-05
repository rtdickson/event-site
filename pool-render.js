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
                if (window.PoolConfig.isAllocationMode(activeEvent.poolConfig)) {
                    renderAllocationForm();
                } else {
                    renderForm();
                }
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
                const tieBreak = hasResults ? window.PoolConfig.triCloseness(data, config) : null;
                return { data, displayName, score, max, slipProb, tieBreak };
            });
            const isAlloc = window.PoolConfig.isAllocationMode(config);
            // Compute winning stake for allocation tiebreaker
            if (isAlloc && hasResults) {
                ranked.forEach(r => {
                    r.winStake = window.PoolConfig.totalWinningStake(r.data, config, contestants);
                });
            }
            // Sort cascade (with results):
            //   Bankroll desc, then:
            //   - Allocation mode: winning stake desc, then name alphabetical
            //   - Fixed mode: tri positional error → exact hits → exacta error → coin flip
            ranked.sort((a, b) => {
                if (hasResults) {
                    if (b.score.bankroll !== a.score.bankroll) return b.score.bankroll - a.score.bankroll;
                    if (isAlloc) {
                        // Allocation cascade: winning stake → trifecta position error → alphabetical
                        if ((b.winStake || 0) !== (a.winStake || 0)) return (b.winStake || 0) - (a.winStake || 0);
                        if (a.tieBreak && b.tieBreak && a.tieBreak.tier1 !== b.tieBreak.tier1) return a.tieBreak.tier1 - b.tieBreak.tier1;
                        return a.displayName.localeCompare(b.displayName);
                    }
                    if (a.tieBreak.tier1 !== b.tieBreak.tier1) return a.tieBreak.tier1 - b.tieBreak.tier1;
                    if (b.tieBreak.tier2 !== a.tieBreak.tier2) return b.tieBreak.tier2 - a.tieBreak.tier2;
                    if (a.tieBreak.tier3 !== b.tieBreak.tier3) return a.tieBreak.tier3 - b.tieBreak.tier3;
                    return 0; // coin flip territory
                }
                return (b.max || 0) - (a.max || 0);
            });

            // Total potential purse across all entries (pre-results only)
            const totalPurse = hasResults ? null : ranked.reduce((s, r) => s + (r.max || 0), 0);

            // Mark entries tied with at least one other (same bankroll), so we can show tiebreaker math inline
            const tiedIndexes = new Set();
            if (hasResults) {
                for (let i = 0; i < ranked.length; i++) {
                    for (let j = 0; j < ranked.length; j++) {
                        if (i !== j && ranked[i].score.bankroll === ranked[j].score.bankroll) {
                            tiedIndexes.add(i);
                            break;
                        }
                    }
                }
            }

            const rows = ranked.map(({ data, displayName, score, max, slipProb, tieBreak }, i) => {
                const hasLocks = Array.isArray(data.locks) && data.locks.length >= 2;
                // Allocation pools: the slip probability is a rough heuristic for gradient bets,
                // so hide the "odds N to 1" line on those — the per-bet detail tells a cleaner story.
                const isAllocMode = window.PoolConfig.isAllocationMode(config);
                const oddsStr = (!hasResults && slipProb && !isAllocMode)
                    ? `<div class="pool-entry-odds">odds ${window.PoolConfig.formatOddsAgainst(slipProb)}</div>`
                    : '';
                const amountStr = hasResults
                    ? `<strong>$${score.bankroll.toLocaleString()}</strong>`
                    : `<span class="pool-max-cell">$${max.toLocaleString()}</span>${oddsStr}`;
                const detail = renderEntryDetail(data, config, contestantsById, score);

                // Single 🏆 only for the actual winner; tied entries get a 'tied' badge instead of medals
                const tiedWithAbove = hasResults && i > 0 && ranked[i-1].score.bankroll === score.bankroll;
                const winnerBadge = hasResults && i === 0 ? '<span class="pool-winner-marker">🏆</span>' : '';
                const tiedBadge = tiedWithAbove ? '<span class="pool-tied-badge">tied</span>' : '';

                return `
                    <details class="pool-entry-row${i === 0 && hasResults ? ' pool-entry-winner' : ''}${tiedWithAbove ? ' pool-entry-tied' : ''}">
                        <summary>
                            <span class="pool-entry-name">${winnerBadge}<strong>${escapeHtml(displayName)}</strong>${tiedBadge}${hasLocks ? ' <span class="pool-tag">parlay</span>' : ''}</span>
                            <span class="pool-entry-amount">${amountStr}</span>
                            <span class="pool-entry-toggle">▾</span>
                        </summary>
                        <div class="pool-entry-detail">${detail}</div>
                    </details>
                `;
            }).join('');

            const tiebreakerNote = (hasResults && tiedIndexes.size > 0)
                ? `<p class="pool-tiebreak-note">⚖️ Ties broken by trifecta closeness: most picked horses in the actual top 3 (set match) wins; if still tied, most horses in correct finishing position (exact match) wins.</p>`
                : '';

            const headerLabel = hasResults ? 'Bankroll' : 'Potential purse';
            const totalLine = (!hasResults && totalPurse > 0)
                ? `<div class="pool-total-purse">Combined potential purse across ${ranked.length} ${ranked.length === 1 ? 'player' : 'players'}: <strong>$${totalPurse.toLocaleString()}</strong></div>`
                : '';
            const winnerBanner = hasResults && ranked.length > 0
                ? renderWinnerBanner(ranked[0], config, contestantsById)
                : '';

            const auditBadge = renderAuditBadge();
            const mathLink = hasResults
                ? `<p class="pool-math-link"><a href="how-the-math-works.html?event=${activeEvent._id || ''}">📐 How is this calculated? See the math →</a></p>`
                : '';
            const tieAnalysis = (hasResults && tiedIndexes.has(0))
                ? renderTieAnalysis(ranked)
                : '';

            container.innerHTML = `
                ${tieAnalysis}
                ${winnerBanner}
                <h3 class="pool-entries-heading">${hasResults ? 'Standings' : 'Entries so far'} (${snap.size})</h3>
                ${totalLine}
                <div class="pool-entries-header-row">
                    <span>Name</span>
                    <span>${headerLabel}</span>
                </div>
                <div class="pool-entries-list">${rows}</div>
                ${hasResults ? '' : '<p class="pool-fineprint" style="margin-top:8px;">Tap a name to see their picks. Potential purse = what each player would win if every pick on their slip hits. Odds are rough — derived from morning-line probabilities.</p>'}
                ${mathLink}
                ${auditBadge}
            `;
            wireAuditBadge();
        } catch (err) {
            console.error('Error loading entries:', err);
            container.innerHTML = '<p style="color:red;">Could not load entries.</p>';
        }
    }

    function renderAuditBadge() {
        const seal = activeEvent && activeEvent.auditSeal;
        if (!seal || !seal.hash) return '';
        const sealedDisplay = seal.sealedAtIso
            ? new Date(seal.sealedAtIso).toLocaleString()
            : (seal.sealedAt && seal.sealedAt.toDate ? seal.sealedAt.toDate().toLocaleString() : 'unknown');
        const short = window.PoolAudit ? window.PoolAudit.shortHash(seal.hash) : seal.hash.slice(0, 16);
        return `
            <div class="pool-audit-badge" id="pool-audit-badge">
                <div class="pool-audit-line">
                    🔒 <strong>Audited by Claude</strong> — ${seal.entryCount} entries sealed at ${escapeHtml(sealedDisplay)}
                </div>
                <div class="pool-audit-hash-line">
                    SHA-256 <code>${escapeHtml(short)}</code>
                    · <a href="${escapeHtml(seal.url)}" target="_blank" rel="noopener">snapshot</a>
                    · <button type="button" class="pool-audit-verify-btn" id="pool-audit-verify-btn">Verify integrity</button>
                </div>
                <div class="pool-audit-result" id="pool-audit-result"></div>
            </div>
        `;
    }

    function wireAuditBadge() {
        const btn = document.getElementById('pool-audit-verify-btn');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            const result = document.getElementById('pool-audit-result');
            btn.disabled = true;
            const orig = btn.textContent;
            btn.textContent = 'Verifying…';
            try {
                const v = await window.PoolAudit.verifySeal(activeEvent);
                result.className = 'pool-audit-result ' + (v.ok ? 'ok' : 'fail');
                result.textContent = v.message;
            } catch (e) {
                result.className = 'pool-audit-result fail';
                result.textContent = 'Verification error: ' + e.message;
            } finally {
                btn.disabled = false;
                btn.textContent = orig;
            }
        });
    }

    // Tie analysis — sits ABOVE the winner banner when the top spot was decided by tiebreaker.
    // Spells out the cascade in plain language so the math is visible up front.
    function renderTieAnalysis(ranked) {
        const winnerBankroll = ranked[0].score.bankroll;
        const tiedAtTop = ranked.filter(r => r.score.bankroll === winnerBankroll);
        if (tiedAtTop.length < 2) return '';

        const winner = tiedAtTop[0];
        const runnerUp = tiedAtTop[1];
        const isAlloc = window.PoolConfig.isAllocationMode(activeEvent.poolConfig);

        // Allocation pools: winning-stake → trifecta position error → coin flip / split pot
        if (isAlloc) {
            let resolvedBy = '';
            let coinFlip = false;
            const wTri = winner.tieBreak ? winner.tieBreak.tier1 : null;
            const rTri = runnerUp.tieBreak ? runnerUp.tieBreak.tier1 : null;
            if ((winner.winStake || 0) !== (runnerUp.winStake || 0)) {
                resolvedBy = `more total $ staked on winning bets ($${(winner.winStake || 0).toLocaleString()} vs $${(runnerUp.winStake || 0).toLocaleString()})`;
            } else if (wTri !== null && rTri !== null && wTri !== rTri) {
                resolvedBy = `lower trifecta position-error (${wTri} vs ${rTri})`;
            } else {
                coinFlip = true;
            }
            const tiedRows = tiedAtTop.map((r, i) => {
                const isWinner = i === 0 && !coinFlip;
                const marker = coinFlip ? '🪙' : (isWinner ? '🏆' : '·');
                const tri = (r.tieBreak && typeof r.tieBreak.tier1 === 'number') ? r.tieBreak.tier1 : null;
                const triStr = tri !== null ? ` · tri err ${tri}` : '';
                return `<li class="${isWinner ? 'pool-tie-winner-row' : ''}">
                    <span class="pool-tie-rank">${marker}</span>
                    <span class="pool-tie-name">${escapeHtml(r.displayName)}${isWinner ? '' : ' <span class="pool-tied-badge">tied</span>'}</span>
                    <span class="pool-tie-score">$${(r.winStake || 0).toLocaleString()} winning${triStr}</span>
                </li>`;
            }).join('');
            const headerText = coinFlip
                ? `🪙 ${tiedAtTop.length}-way tie at $${winnerBankroll.toLocaleString()} — coin flip / split pot`
                : `⚖️ ${tiedAtTop.length}-way tie at $${winnerBankroll.toLocaleString()}`;
            const explainerText = coinFlip
                ? `<strong>Split the pot or coin flip.</strong> All three tiebreakers (bankroll, winning stake, trifecta error) tied between ${escapeHtml(tiedAtTop.map(r => r.displayName).join(', '))}. Admin makes the call.`
                : `Tiebreaker: <strong>${escapeHtml(winner.displayName)} wins</strong> with ${resolvedBy}.`;
            return `
                <div class="pool-tie-analysis ${coinFlip ? 'pool-tie-coinflip' : ''}">
                    <div class="pool-tie-header">${headerText}</div>
                    <p class="pool-tie-explainer">${explainerText}</p>
                    <ul class="pool-tie-table">${tiedRows}</ul>
                    <p class="pool-tie-fineprint">
                        Allocation cascade: bankroll → total $ on winning bets → trifecta position error → split pot / coin flip.
                    </p>
                </div>
            `;
        }

        // Fixed-mode (Derby) trifecta-closeness cascade — original logic preserved
        const wTie = winner.tieBreak;
        const rTie = runnerUp.tieBreak;
        const useFull = wTie.usedFullFinish;

        let resolvedBy = '';
        let coinFlip = false;
        if (useFull) {
            if (wTie.tier1 !== rTie.tier1) {
                resolvedBy = `lowest trifecta position-error (${wTie.tier1} vs ${rTie.tier1})`;
            } else if (wTie.tier2 !== rTie.tier2) {
                resolvedBy = `most exact position hits (${wTie.tier2}/3 vs ${rTie.tier2}/3)`;
            } else if (wTie.tier3 !== rTie.tier3) {
                resolvedBy = `closest exacta — first 2 picks (${wTie.tier3} vs ${rTie.tier3})`;
            } else {
                resolvedBy = `every tier still tied — coin flip required`;
                coinFlip = true;
            }
        } else {
            if (wTie.setMatch !== rTie.setMatch) resolvedBy = `more right horses in the trifecta (${wTie.setMatch}/3 vs ${rTie.setMatch}/3)`;
            else if (wTie.exactMatch !== rTie.exactMatch) resolvedBy = `more horses in their correct position (${wTie.exactMatch}/3 vs ${rTie.exactMatch}/3)`;
            else { resolvedBy = `still tied — coin flip required`; coinFlip = true; }
        }

        const scoreCell = (t) => useFull
            ? `tri err ${t.tier1} · exacta err ${t.tier3} · ${t.tier2}/3 exact`
            : `${t.setMatch}/3 set · ${t.exactMatch}/3 exact`;

        const tiedRows = tiedAtTop.map((r, i) => {
            const isWinner = i === 0 && !coinFlip;
            const marker = coinFlip ? '🪙' : (isWinner ? '🏆' : '·');
            return `<li class="${isWinner ? 'pool-tie-winner-row' : ''}">
                <span class="pool-tie-rank">${marker}</span>
                <span class="pool-tie-name">${escapeHtml(r.displayName)}${isWinner ? '' : ' <span class="pool-tied-badge">tied</span>'}</span>
                <span class="pool-tie-score">${scoreCell(r.tieBreak)}</span>
            </li>`;
        }).join('');

        const fineprint = useFull
            ? `Cascade: bankroll → tri positional error (sum of |slot − actual finish position|, scratched = 20) → exact position hits → exacta error (first 2 picks only) → coin flip.`
            : `Cascade: bankroll → set match → exact match → coin flip. <em>Add the full finish order in admin to use the more granular tiebreaker.</em>`;

        return `
            <div class="pool-tie-analysis ${coinFlip ? 'pool-tie-coinflip' : ''}">
                <div class="pool-tie-header">${coinFlip ? '🪙' : '⚖️'} ${tiedAtTop.length}-way tie at $${winnerBankroll.toLocaleString()}</div>
                <p class="pool-tie-explainer">
                    ${coinFlip
                        ? `<strong>Coin flip required</strong> — ${escapeHtml(tiedAtTop.map(r => r.displayName).join(', '))} all tie on every tiebreaker tier.`
                        : `Tiebreaker: <strong>${escapeHtml(winner.displayName)} wins</strong> with ${resolvedBy}.`}
                </p>
                <ul class="pool-tie-table">${tiedRows}</ul>
                <p class="pool-tie-fineprint">${fineprint}</p>
            </div>
        `;
    }

    // Big celebratory banner shown above the standings once results are in.
    function renderWinnerBanner(winner, config, contestantsById) {
        const results = config.results || {};
        const questions = config.questions || [];

        // Find win/place/show contestant ids from the results
        const winQ = questions.find(q => q.kind === 'pickContestant' && (q.id === 'win' || q.resultKey === 'win'));
        const placeQ = questions.find(q => q.kind === 'pickContestant' && (q.id === 'place' || q.resultKey === 'place'));
        const showQ = questions.find(q => q.kind === 'pickContestant' && (q.id === 'show' || q.resultKey === 'show'));

        const horseLabel = (id) => {
            const c = contestantsById[Number(id)];
            return c ? `#${c.id} ${escapeHtml(c.name)}` : `#${id}`;
        };

        const winId = winQ ? results[winQ.id] : null;
        const placeId = placeQ ? results[placeQ.id] : null;
        const showId = showQ ? results[showQ.id] : null;

        const resultsLine = (winId || placeId || showId)
            ? `<div class="pool-winner-results">
                ${winId ? `<span><span class="pool-result-pos">1st</span> ${horseLabel(winId)}</span>` : ''}
                ${placeId ? `<span><span class="pool-result-pos">2nd</span> ${horseLabel(placeId)}</span>` : ''}
                ${showId ? `<span><span class="pool-result-pos">3rd</span> ${horseLabel(showId)}</span>` : ''}
              </div>`
            : '';

        // "Why they won" — only show if there was a tie at the top
        let whyLine = '';
        if (winner.tieBreak) {
            const wt = winner.tieBreak;
            // Only show if winner has any trifecta hits worth bragging about, or there was a tie
            // (we only enter this banner code if there's a winner, and we'll render whyLine
            // unconditionally if score.bankroll > 0 to give credit; tie analysis already explains the cascade above)
            if (wt.setMatch > 0 || wt.exactMatch > 0) {
                whyLine = `<div class="pool-winner-why">
                    Trifecta picks: <strong>${wt.setMatch}/3 right horses, ${wt.exactMatch}/3 in correct position</strong>
                </div>`;
            }
        }

        return `
            <div class="pool-winner-banner">
                <div class="pool-winner-trophy">🏆</div>
                <div class="pool-winner-text">
                    <div class="pool-winner-label">${escapeHtml(activeEvent.name)} Winner</div>
                    <div class="pool-winner-name">${escapeHtml(winner.displayName)}</div>
                    <div class="pool-winner-bankroll">Bankroll: <strong>$${winner.score.bankroll.toLocaleString()}</strong></div>
                    ${whyLine}
                </div>
                ${resultsLine}
            </div>
        `;
    }

    function renderEntryDetail(data, config, contestantsById, score) {
        const picks = data.picks || {};
        const locks = data.locks || [];
        const questions = config.questions || [];
        const hasResults = !!score;
        const isAlloc = window.PoolConfig.isAllocationMode(config);

        const lines = questions.map(q => {
            const rawPick = picks[q.id];
            const pickValue = window.PoolConfig.getPickValue(rawPick);
            const stake = window.PoolConfig.getPickStake(rawPick);
            const hasPick = pickValue !== null && pickValue !== undefined && pickValue !== '' &&
                (!Array.isArray(pickValue) || pickValue.some(x => x != null && x !== ''));
            // autoProp shows even with no pick value, as long as a stake was placed
            const isAutoProp = q.kind === 'autoProp';
            if (!isAutoProp && !hasPick) return '';
            if (isAutoProp && (stake === null || stake <= 0) && !isAlloc) return '';

            const lock = locks.includes(q.id) ? ' 🔒' : '';
            const pickStr = isAutoProp
                ? '(auto-prop)'
                : formatPickValue(q, rawPick, contestantsById);

            // Allocation mode: show stake + potential/actual payoff
            // Fixed mode: just show pick + payoff (current behavior)
            if (isAlloc) {
                const stakeNum = stake || 0;
                const mult = q.payoffMultiplier;
                let amountStr = '';
                if (hasResults) {
                    const pq = score.perQuestion.find(p => p.questionId === q.id);
                    if (pq && pq.hit) {
                        amountStr = `<span class="pool-detail-payoff hit">$${stakeNum.toLocaleString()} → +$${pq.payoff.toLocaleString()}</span>`;
                    } else {
                        amountStr = `<span class="pool-detail-payoff miss">$${stakeNum.toLocaleString()} → $0</span>`;
                    }
                } else {
                    // Pre-race: show stake → potential
                    let potential;
                    if (q.kind === 'pickInTopN' && q.pickN && q.pickN > 1) {
                        // Gradient: best-case = all N picks hit
                        const ids = Array.isArray(pickValue) ? pickValue.filter(v => v != null).map(Number) : [];
                        const uniq = Array.from(new Set(ids));
                        const oddsSum = uniq.reduce((s, id) => s + window.PoolConfig.parseOdds((contestantsById[id] || {}).odds).decimal, 0);
                        potential = stakeNum * (uniq.length + oddsSum) + stakeNum;
                    } else if (q.kind === 'unorderedTriple' && q.scoring === 'gradientOdds') {
                        const ids = Array.isArray(pickValue) ? pickValue.filter(v => v != null).map(Number) : [];
                        const uniq = Array.from(new Set(ids));
                        const oddsSum = uniq.reduce((s, id) => s + window.PoolConfig.parseOdds((contestantsById[id] || {}).odds).decimal, 0);
                        potential = stakeNum * (uniq.length + oddsSum) + stakeNum;
                    } else {
                        potential = stakeNum * (mult || 1) + stakeNum;
                    }
                    amountStr = `<span class="pool-detail-stake">$${stakeNum.toLocaleString()}</span> <span class="pool-detail-potential">→ $${potential.toLocaleString()}</span>`;
                }
                return `<li class="pool-detail-alloc">
                    <div class="pool-detail-alloc-head">
                        <span class="pool-detail-label">${escapeHtml(q.label)}${lock}</span>
                        <span class="pool-detail-value">${amountStr}</span>
                    </div>
                    ${pickStr ? `<div class="pool-detail-alloc-pick">${escapeHtml(pickStr)}</div>` : ''}
                </li>`;
            }

            // Fixed-mode (Derby) format
            let resultStr = '';
            if (hasResults) {
                const pq = score.perQuestion.find(p => p.questionId === q.id);
                if (pq && pq.hit) resultStr = ` <span class="pool-detail-payoff hit">+$${pq.payoff}</span>`;
                else if (pq) resultStr = ` <span class="pool-detail-payoff miss">—</span>`;
            }
            return `<li><span class="pool-detail-label">${escapeHtml(q.label)}${lock}</span><span class="pool-detail-value">${escapeHtml(pickStr)}${resultStr}</span></li>`;
        }).filter(Boolean);

        let parlayLine = '';
        if (locks.length >= 2 && !isAlloc) {
            if (hasResults) {
                const p = score.parlay;
                parlayLine = `<li class="pool-detail-parlay"><span class="pool-detail-label">Parlay (${locks.length} legs)</span><span class="pool-detail-value">${p.hit ? `<span class="pool-detail-payoff hit">+$${p.bonus}</span>` : `<span class="pool-detail-payoff miss">missed</span>`}</span></li>`;
            } else {
                parlayLine = `<li class="pool-detail-parlay"><span class="pool-detail-label">Parlay (${locks.length} legs locked)</span><span class="pool-detail-value">all-or-nothing bonus</span></li>`;
            }
        }

        // Tiebreaker rows (allocation pools) — show guess and closeness if results in
        let tiebreakerLines = '';
        const tbQs = (config.tiebreakerQuestions || []);
        const tbResults = config.tiebreakerResults || {};
        const tbGuesses = (data.tiebreakers || {});
        if (isAlloc && tbQs.length > 0) {
            tiebreakerLines = tbQs.map(tq => {
                const g = tbGuesses[tq.key];
                const r = tbResults[tq.key];
                const hasGuess = g !== undefined && g !== null && g !== '';
                const hasResult = r !== undefined && r !== null && r !== '';
                const diff = (hasGuess && hasResult) ? Math.abs(Number(g) - Number(r)) : null;
                const right = !hasGuess ? '<span class="pool-detail-payoff miss">—</span>'
                    : hasResult ? `<span>guess <strong>${escapeHtml(String(g))}</strong> · actual <strong>${escapeHtml(String(r))}</strong> · off by ${diff}</span>`
                    : `<span>guess <strong>${escapeHtml(String(g))}</strong></span>`;
                return `<li class="pool-detail-tiebreaker">
                    <span class="pool-detail-label">Tiebreaker — ${escapeHtml(tq.label)}</span>
                    <span class="pool-detail-value">${right}</span>
                </li>`;
            }).join('');
        }

        // Allocation pool footer: total stake + bankroll total
        let footerLine = '';
        if (isAlloc) {
            const totalStake = questions.reduce((s, q) => {
                const st = window.PoolConfig.getPickStake(picks[q.id]);
                return s + (st || 0);
            }, 0);
            if (hasResults) {
                footerLine = `<li class="pool-detail-footer"><span class="pool-detail-label">Final bankroll</span><span class="pool-detail-value"><strong>$${score.bankroll.toLocaleString()}</strong></span></li>`;
            } else {
                footerLine = `<li class="pool-detail-footer"><span class="pool-detail-label">Total allocated</span><span class="pool-detail-value">$${totalStake.toLocaleString()}</span></li>`;
            }
        }

        return `<ul class="pool-detail-list">${lines.join('')}${parlayLine}${tiebreakerLines}${footerLine}</ul>`;
    }

    function formatPickValue(q, rawV, contestantsById) {
        // Unwrap allocation-mode { value, stake } if needed
        const v = (rawV && typeof rawV === 'object' && !Array.isArray(rawV) && 'value' in rawV) ? rawV.value : rawV;
        if (Array.isArray(v)) {
            return v.filter(x => x != null).map(id => {
                const c = contestantsById[Number(id)];
                return c ? `#${c.id} ${c.name}` : `#${id}`;
            }).join(' · ');
        }
        if (q.kind === 'pickContestant' || q.kind === 'pickLongshot' || q.kind === 'pickInTopN') {
            const c = contestantsById[Number(v)];
            return c ? `#${c.id} ${c.name}` : `#${v}`;
        }
        if (q.kind === 'autoProp') {
            return '(prop bet)';
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
                    locks: Array.isArray(found.data.locks) ? found.data.locks.slice() : [],
                    tiebreakers: (found.data.tiebreakers && typeof found.data.tiebreakers === 'object') ? Object.assign({}, found.data.tiebreakers) : {}
                };
                if (contactName) currentEntry.name = contactName; // prefer contact name
                if (window.PoolConfig.isAllocationMode(activeEvent.poolConfig)) {
                    renderAllocationForm();
                } else {
                    renderForm();
                }
                msg.textContent = `Welcome back. Loaded your existing slip — edit and submit to update.`;
                msg.style.color = 'green';
                const submitBtn = document.getElementById('pool-submit');
                if (submitBtn && !window.PoolConfig.isAllocationMode(activeEvent.poolConfig)) {
                    submitBtn.textContent = 'Update picks';
                }
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

    // ----- Allocation-mode form (Preakness) -----
    // Mobile-first plus/minus cards. One card per bet. Persistent header with remaining balance.
    // Submit disabled until allocation is exactly $bankrollAmount and all picks are valid.
    function renderAllocationForm() {
        const container = document.getElementById('pool-questions');
        if (!container) return;
        const config = activeEvent.poolConfig;
        const contestants = config.contestants || [];
        const questions = config.questions || [];
        const constraints = config.allocationConstraints || { min: 250, max: 2000, increment: 100 };
        const bankroll = config.bankrollAmount || 0;

        // Ensure each pick has a stake — start at the minimum (e.g. $250) so the bankroll
        // begins fully allocated and players adjust UP from there.
        const initialStake = constraints.min || 0;
        for (const q of questions) {
            const raw = currentEntry.picks[q.id];
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                currentEntry.picks[q.id] = { value: getInitialPickValue(q), stake: initialStake };
            }
        }

        // Replace the summary line with allocation-specific UI
        const summaryEl = document.querySelector('.pool-summary');
        if (summaryEl) summaryEl.style.display = 'none';

        // Header: remaining + progress bar (sticky at top of form)
        const headerHtml = `
            <div class="pool-alloc-header" id="pool-alloc-header">
                <div class="pool-alloc-remaining">
                    <span id="pool-alloc-remaining-amt">$${bankroll.toLocaleString()}</span> remaining
                </div>
                <div class="pool-alloc-progress">
                    <div class="pool-alloc-progress-fill" id="pool-alloc-progress-fill" style="width:0%"></div>
                </div>
                <div class="pool-alloc-help">$${constraints.min} min / $${constraints.max.toLocaleString()} max per bet. Total must be exactly $${bankroll.toLocaleString()}.</div>
            </div>
        `;

        const cards = questions.map(q => renderAllocCard(q, contestants, constraints)).join('');
        const tiebreakerHtml = renderTiebreakerSection(config);
        container.innerHTML = headerHtml + `<div class="pool-alloc-cards">${cards}</div>` + tiebreakerHtml;

        wireAllocCards(constraints, bankroll);
        wireTiebreakerInputs(config);

        // Update submit button text for allocation mode
        const submitBtn = document.getElementById('pool-submit');
        if (submitBtn) {
            submitBtn.classList.add('pool-alloc-submit');
            submitBtn.textContent = 'Lock In My Bets — $0 / $' + bankroll.toLocaleString();
        }

        // Hydrate from currentEntry
        document.getElementById('pool-name').value = currentEntry.name || '';
        document.getElementById('pool-phone').value = currentEntry.phone || '';
        const phoneInput = document.getElementById('pool-phone');
        phoneInput.addEventListener('blur', onPhoneEntered);

        updateAllocSummary(constraints, bankroll);
    }

    function renderTiebreakerSection(config) {
        const qs = (config && config.tiebreakerQuestions) || [];
        if (qs.length === 0) return '';
        if (!currentEntry.tiebreakers) currentEntry.tiebreakers = {};

        const rows = qs.map(q => {
            const cur = currentEntry.tiebreakers[q.key];
            const valAttr = (cur !== undefined && cur !== null && cur !== '') ? `value="${escapeHtml(String(cur))}"` : '';
            const minAttr = (q.min !== undefined) ? `min="${q.min}"` : '';
            const maxAttr = (q.max !== undefined) ? `max="${q.max}"` : '';
            const ph = q.placeholder ? `placeholder="${escapeHtml(q.placeholder)}"` : '';
            return `
                <div class="pool-tiebreaker-row">
                    <label class="pool-tiebreaker-label" for="pool-tb-${escapeHtml(q.key)}">${escapeHtml(q.label)}</label>
                    <input type="number" inputmode="numeric"
                        id="pool-tb-${escapeHtml(q.key)}"
                        data-tb-key="${escapeHtml(q.key)}"
                        ${minAttr} ${maxAttr} ${ph} ${valAttr}
                        class="pool-tiebreaker-input" required />
                    ${q.help ? `<small class="pool-tiebreaker-help">${escapeHtml(q.help)}</small>` : ''}
                </div>
            `;
        }).join('');

        return `
            <div class="pool-tiebreaker-section">
                <h4 class="pool-tiebreaker-title">Tiebreaker</h4>
                <p class="pool-tiebreaker-intro">Used if multiple players tie on bankroll. No stake, no payoff — closest guess wins the tie.</p>
                ${rows}
            </div>
        `;
    }

    function wireTiebreakerInputs(config) {
        const qs = (config && config.tiebreakerQuestions) || [];
        if (qs.length === 0) return;
        if (!currentEntry.tiebreakers) currentEntry.tiebreakers = {};
        qs.forEach(q => {
            const el = document.getElementById('pool-tb-' + q.key);
            if (!el) return;
            const handler = () => {
                const raw = el.value;
                if (raw === '' || raw === null) {
                    delete currentEntry.tiebreakers[q.key];
                } else {
                    const n = Number(raw);
                    currentEntry.tiebreakers[q.key] = isFinite(n) ? n : raw;
                }
            };
            el.addEventListener('input', handler);
            el.addEventListener('change', handler);
        });
    }

    function getInitialPickValue(q) {
        switch (q.kind) {
            case 'orderedTriple':
            case 'unorderedTriple': return [null, null, null];
            case 'orderedPair':     return [null, null];
            case 'autoProp':        return null;
            case 'pickInTopN':      return (q.pickN && q.pickN > 1) ? Array(q.pickN).fill(null) : null;
            default:                return null;
        }
    }

    function renderAllocCard(q, contestants, constraints) {
        const pick = currentEntry.picks[q.id] || { value: null, stake: 0 };
        const stake = pick.stake || 0;
        const v = pick.value;
        const mult = q.payoffMultiplier || 1;
        let pickUI = '';

        switch (q.kind) {
            case 'pickInTopN': {
                // Default to gradient (5 picks) in allocation pools if pickN wasn't set on the saved
                // question — covers events created before the gradient Top 5 change landed.
                const isAlloc = window.PoolConfig.isAllocationMode(activeEvent.poolConfig);
                const pickN = q.pickN || (isAlloc ? 5 : 1);
                if (pickN === 1) {
                    pickUI = `<label class="pool-alloc-pick-label">Pick a horse to finish in the top ${q.topN || 5}</label>
                        <select data-pick-key="${q.id}">
                            <option value="">— pick —</option>
                            ${contestants.map(c => optionFor(c, v)).join('')}
                        </select>`;
                } else {
                    pickUI = `<label class="pool-alloc-pick-label">Pick ${pickN} horses for the top ${q.topN || 5} (any order)</label>
                        <div class="pool-alloc-multi">
                            ${Array.from({ length: pickN }, (_, i) => {
                                const cur = Array.isArray(v) ? v[i] : null;
                                return `<select data-pick-key="${q.id}" data-pick-index="${i}">
                                    <option value="">Horse ${i + 1}</option>
                                    ${contestants.map(c => optionFor(c, cur)).join('')}
                                </select>`;
                            }).join('')}
                        </div>`;
                }
                break;
            }
            case 'overUnder':
                pickUI = `<label class="pool-alloc-pick-label">${q.line ? 'Over/Under ' + escapeHtml(q.line) : 'Over/Under'}</label>
                    <div class="pool-alloc-toggle">
                        <button type="button" class="pool-alloc-toggle-btn ${v === 'over' ? 'active' : ''}" data-pick-key="${q.id}" data-value="over">Over</button>
                        <button type="button" class="pool-alloc-toggle-btn ${v === 'under' ? 'active' : ''}" data-pick-key="${q.id}" data-value="under">Under</button>
                    </div>`;
                break;
            case 'yesNo': {
                // Plain yes/no prop. The player is NOT picking a horse — for "favorite finishes
                // top 3?" style bets the favorite is fixed by the field odds, so we surface it as
                // context and only ask Yes/No.
                const favNote = q.id === 'fav' ? favoriteNote(contestants) : '';
                pickUI = `<label class="pool-alloc-pick-label">Yes or No</label>
                    ${favNote ? `<div class="pool-alloc-prop-desc">${favNote}</div>` : ''}
                    <div class="pool-alloc-toggle">
                        <button type="button" class="pool-alloc-toggle-btn ${v === 'yes' ? 'active' : ''}" data-pick-key="${q.id}" data-value="yes">Yes</button>
                        <button type="button" class="pool-alloc-toggle-btn ${v === 'no' ? 'active' : ''}" data-pick-key="${q.id}" data-value="no">No</button>
                    </div>`;
                break;
            }
            case 'orderedPair':
                pickUI = `<label class="pool-alloc-pick-label">Pick 1st &amp; 2nd</label>
                    <div class="pool-alloc-triple">
                        ${[0,1].map(i => `<select data-pick-key="${q.id}" data-pick-index="${i}">
                            <option value="">${['1st','2nd'][i]}</option>
                            ${contestants.map(c => optionFor(c, Array.isArray(v) ? v[i] : null)).join('')}
                        </select>`).join('')}
                    </div>`;
                break;
            case 'orderedTriple':
                pickUI = `<label class="pool-alloc-pick-label">Pick 1st, 2nd, 3rd</label>
                    <div class="pool-alloc-triple">
                        ${[0,1,2].map(i => `<select data-pick-key="${q.id}" data-pick-index="${i}">
                            <option value="">${['1st','2nd','3rd'][i]}</option>
                            ${contestants.map(c => optionFor(c, Array.isArray(v) ? v[i] : null)).join('')}
                        </select>`).join('')}
                    </div>`;
                break;
            case 'unorderedTriple': {
                // Pick 3 horses in any order — same UI as orderedTriple but labeled differently
                const labelText = q.id === 'box3' ? 'Pick 3 horses for top 3 (any order)' : 'Pick 3 (any order)';
                pickUI = `<label class="pool-alloc-pick-label">${labelText}</label>
                    <div class="pool-alloc-triple">
                        ${[0,1,2].map(i => `<select data-pick-key="${q.id}" data-pick-index="${i}">
                            <option value="">Pick ${i + 1}</option>
                            ${contestants.map(c => optionFor(c, Array.isArray(v) ? v[i] : null)).join('')}
                        </select>`).join('')}
                    </div>`;
                break;
            }
            case 'pickContestant': {
                // Single horse pick (Win / Place / Show in fixed-mode; can also appear in allocation
                // pools if admin added Win/Place/Show from the catalog)
                const slotLabel = q.resultKey === 'win' ? 'Pick the winner'
                                : q.resultKey === 'place' ? 'Pick to finish 2nd'
                                : q.resultKey === 'show' ? 'Pick to finish 3rd'
                                : 'Pick a horse';
                pickUI = `<label class="pool-alloc-pick-label">${slotLabel}</label>
                    <select data-pick-key="${q.id}">
                        <option value="">— pick —</option>
                        ${contestants.map(c => optionFor(c, v)).join('')}
                    </select>`;
                break;
            }
            case 'pickLongshot': {
                const longshots = contestants.filter(c => c.isLongshot);
                if (longshots.length === 0) {
                    pickUI = `<label class="pool-alloc-pick-label">Pick a longshot to finish top 3</label>
                        <em style="color:#888; display:block; padding:6px 0;">No longshots (15:1+) flagged in the field yet.</em>`;
                } else {
                    pickUI = `<label class="pool-alloc-pick-label">Pick a longshot (15:1+) to finish top 3</label>
                        <select data-pick-key="${q.id}">
                            <option value="">— pick —</option>
                            ${longshots.map(c => optionFor(c, v)).join('')}
                        </select>`;
                }
                break;
            }
            case 'autoProp':
                pickUI = `<div class="pool-alloc-prop-desc">No pick — bet auto-hits if any 15:1+ longshot finishes in the top 3.</div>`;
                break;
            default:
                pickUI = '';
        }

        return `
            <div class="pool-alloc-card" data-q="${q.id}" id="pool-alloc-card-${q.id}">
                <div class="pool-alloc-card-head">
                    <div class="pool-alloc-card-title">${escapeHtml(q.label)}</div>
                    <div class="pool-alloc-card-mult">${mult}×</div>
                </div>
                ${pickUI}
                <div class="pool-alloc-stake-row">
                    <button type="button" class="pool-alloc-step pool-alloc-minus" data-q="${q.id}" aria-label="Decrease by $${constraints.increment}">−</button>
                    <div class="pool-alloc-amount" id="pool-alloc-amount-${q.id}">$${stake.toLocaleString()}</div>
                    <button type="button" class="pool-alloc-step pool-alloc-plus" data-q="${q.id}" aria-label="Increase by $${constraints.increment}">+</button>
                </div>
                <div class="pool-alloc-purse" id="pool-alloc-purse-${q.id}"></div>
                <div class="pool-alloc-status" id="pool-alloc-status-${q.id}"></div>
            </div>
        `;
    }

    function wireAllocCards(constraints, bankroll) {
        const container = document.getElementById('pool-questions');
        if (!container) return;

        // Pick value change (selects + toggles)
        container.querySelectorAll('[data-pick-key]').forEach(el => {
            const eventName = el.tagName === 'BUTTON' ? 'click' : 'change';
            el.addEventListener(eventName, () => {
                const key = el.getAttribute('data-pick-key');
                const idx = el.getAttribute('data-pick-index');
                const value = el.value !== undefined && el.value !== '' ? parseValue(el.value)
                            : el.getAttribute('data-value');
                if (!currentEntry.picks[key] || typeof currentEntry.picks[key] !== 'object' || Array.isArray(currentEntry.picks[key])) {
                    currentEntry.picks[key] = { value: getInitialPickValue(getQuestionById(key)), stake: 0 };
                }
                if (idx !== null && idx !== undefined) {
                    if (!Array.isArray(currentEntry.picks[key].value)) {
                        currentEntry.picks[key].value = getInitialPickValue(getQuestionById(key));
                    }
                    currentEntry.picks[key].value[parseInt(idx, 10)] = parseValue(el.value);
                } else if (el.tagName === 'BUTTON') {
                    // toggle button — set value to data-value, mark active state
                    currentEntry.picks[key].value = value;
                    container.querySelectorAll(`.pool-alloc-toggle-btn[data-pick-key="${key}"]`).forEach(b => {
                        b.classList.toggle('active', b.getAttribute('data-value') === String(value));
                    });
                } else {
                    currentEntry.picks[key].value = value;
                }
                updateAllocSummary(constraints, bankroll);
            });
        });

        // Plus / minus buttons
        container.querySelectorAll('.pool-alloc-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const qid = btn.getAttribute('data-q');
                const direction = btn.classList.contains('pool-alloc-plus') ? 1 : -1;
                stepStake(qid, direction, constraints, bankroll);
            });
        });
    }

    function getQuestionById(qid) {
        return (activeEvent.poolConfig.questions || []).find(q => q.id === qid) || {};
    }

    function stepStake(qid, direction, constraints, bankroll) {
        const pick = currentEntry.picks[qid];
        const cur = (pick && pick.stake) || 0;
        const increment = constraints.increment || 100;
        const max = constraints.max || bankroll;
        const proposed = cur + (direction * increment);

        if (proposed < 0) return;
        if (proposed > max) {
            flashCard(qid, 'over-max');
            return;
        }

        // Compute total if we apply this change
        const allocated = totalAllocated() - cur + proposed;
        if (allocated > bankroll) {
            flashCard(qid, 'over-bankroll');
            return;
        }

        currentEntry.picks[qid].stake = proposed;
        document.getElementById('pool-alloc-amount-' + qid).textContent = '$' + proposed.toLocaleString();
        updateAllocSummary(constraints, bankroll);
    }

    function flashCard(qid, reason) {
        const card = document.getElementById('pool-alloc-card-' + qid);
        const header = document.getElementById('pool-alloc-header');
        const target = reason === 'over-bankroll' ? header : card;
        if (!target) return;
        target.classList.add('flash-red');
        setTimeout(() => target.classList.remove('flash-red'), 320);
    }

    function totalAllocated() {
        const questions = activeEvent.poolConfig.questions || [];
        return questions.reduce((sum, q) => {
            const p = currentEntry.picks[q.id];
            return sum + ((p && p.stake) || 0);
        }, 0);
    }

    function pickHasRequiredValue(q) {
        // autoProp doesn't require a value
        if (q.kind === 'autoProp') return true;
        const v = currentEntry.picks[q.id] && currentEntry.picks[q.id].value;
        if (v === null || v === undefined || v === '') return false;
        if (Array.isArray(v)) return v.every(x => x !== null && x !== undefined && x !== '');
        return true;
    }

    function updateAllocSummary(constraints, bankroll) {
        const allocated = totalAllocated();
        const remaining = bankroll - allocated;
        const remainingEl = document.getElementById('pool-alloc-remaining-amt');
        if (remainingEl) remainingEl.textContent = '$' + remaining.toLocaleString();
        const fill = document.getElementById('pool-alloc-progress-fill');
        if (fill) fill.style.width = Math.max(0, Math.min(100, (allocated / bankroll) * 100)) + '%';

        // Per-card status + potential purse
        const questions = activeEvent.poolConfig.questions || [];
        questions.forEach(q => {
            const card = document.getElementById('pool-alloc-card-' + q.id);
            const status = document.getElementById('pool-alloc-status-' + q.id);
            const purse = document.getElementById('pool-alloc-purse-' + q.id);
            if (!card || !status) return;
            const stake = (currentEntry.picks[q.id] && currentEntry.picks[q.id].stake) || 0;
            const hasPick = pickHasRequiredValue(q);

            // Potential purse: (stake × multiplier) + stake — what this bet pays if it hits.
            // Special-case longshot with position-scaled odds: show range based on picked horse's odds.
            if (purse) {
                if (stake <= 0) {
                    purse.textContent = '';
                } else if (q.kind === 'pickLongshot' && q.scoring === 'positionScaledOdds') {
                    const pickV = window.PoolConfig.getPickValue(currentEntry.picks[q.id]);
                    if (pickV) {
                        const contestants = activeEvent.poolConfig.contestants || [];
                        const c = contestants.find(c => Number(c.id) === Number(pickV));
                        if (c) {
                            const oddsDec = window.PoolConfig.parseOdds(c.odds).decimal;
                            const ifWin = Math.round(stake * oddsDec + stake);
                            const if2nd = Math.round(stake * (oddsDec / 2) + stake);
                            const if3rd = Math.round(stake * (oddsDec / 3) + stake);
                            purse.innerHTML = `If wins: <strong>$${ifWin.toLocaleString()}</strong> · 2nd: $${if2nd.toLocaleString()} · 3rd: $${if3rd.toLocaleString()}`;
                        } else {
                            purse.textContent = 'Pick a longshot to see payout';
                        }
                    } else {
                        purse.textContent = 'Pick a longshot to see payout';
                    }
                } else if (q.kind === 'pickInTopN' && q.pickN && q.pickN > 1) {
                    // Gradient — variable on which horses hit; show all-hit max as the headline
                    const pickV = window.PoolConfig.getPickValue(currentEntry.picks[q.id]);
                    if (Array.isArray(pickV)) {
                        const contestants = activeEvent.poolConfig.contestants || [];
                        const cById = {}; contestants.forEach(c => cById[Number(c.id)] = c);
                        const oddsSum = pickV.filter(v => v != null).reduce((s, id) => s + window.PoolConfig.parseOdds((cById[Number(id)] || {}).odds).decimal, 0);
                        const filled = pickV.filter(v => v != null).length;
                        if (filled > 0) {
                            const max = Math.round(stake * (filled + oddsSum) + stake);
                            purse.textContent = `If all picks land: $${max.toLocaleString()}`;
                        } else {
                            purse.textContent = '';
                        }
                    } else {
                        purse.textContent = '';
                    }
                } else {
                    const mult = q.payoffMultiplier || 1;
                    const potential = stake * mult + stake;
                    purse.textContent = `If this hits: $${potential.toLocaleString()}`;
                }
            }

            card.classList.remove('pool-alloc-card-under', 'pool-alloc-card-ok', 'pool-alloc-card-max', 'pool-alloc-card-needpick');
            if (stake < constraints.min) {
                card.classList.add('pool-alloc-card-under');
                status.textContent = `Need at least $${constraints.min}`;
            } else if (!hasPick) {
                card.classList.add('pool-alloc-card-needpick');
                const needsChoice = q.kind === 'yesNo' || q.kind === 'overUnder';
                status.textContent = needsChoice ? 'Choose an option before locking in' : 'Pick a horse before locking in';
            } else if (stake >= constraints.max) {
                card.classList.add('pool-alloc-card-max');
                status.textContent = `Maxed at $${constraints.max.toLocaleString()}`;
            } else {
                card.classList.add('pool-alloc-card-ok');
                status.textContent = `✓ Locked in $${stake.toLocaleString()}`;
            }
        });

        // Submit button
        const submitBtn = document.getElementById('pool-submit');
        if (submitBtn) {
            submitBtn.textContent = 'Lock In My Bets — $' + allocated.toLocaleString() + ' / $' + bankroll.toLocaleString();
            const valid = window.PoolConfig.validateAllocation(currentEntry.picks, activeEvent.poolConfig);
            const allPicked = questions.every(pickHasRequiredValue);
            submitBtn.disabled = !(valid.ok && allPicked);
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

    // Identify the favorite(s) — the contestant(s) with the shortest (lowest-decimal) odds.
    // Returns a human-readable note for display next to a "favorite finishes top 3?" prop.
    function favoriteNote(contestants) {
        const withOdds = (contestants || []).filter(c => c && c.odds != null && c.odds !== '');
        if (!withOdds.length) return 'Set the field odds to determine the favorite.';
        let min = Infinity;
        withOdds.forEach(c => {
            const d = window.PoolConfig.parseOdds(c.odds).decimal;
            if (d < min) min = d;
        });
        const favs = withOdds.filter(c => window.PoolConfig.parseOdds(c.odds).decimal === min);
        const fmt = c => `#${c.id} ${escapeHtml(c.name)} (${escapeHtml(c.odds)})`;
        if (favs.length === 1) return `Favorite by the odds: <strong>${fmt(favs[0])}</strong>`;
        return `Co-favorites by the odds: ${favs.map(fmt).join(', ')}`;
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
        const GRACE_MS = 60 * 1000;
        const update = () => {
            const ms = closesAt.toDate().getTime() + GRACE_MS - Date.now();
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
        currentEntry = { name: '', phone: '', picks: {}, locks: [], tiebreakers: {} };
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

        // Allocation mode: validate bankroll spend + required picks before save
        if (window.PoolConfig.isAllocationMode(activeEvent.poolConfig)) {
            const v = window.PoolConfig.validateAllocation(currentEntry.picks, activeEvent.poolConfig);
            if (!v.ok) {
                flashMessage(v.errors[0], 'red');
                return;
            }
            const allPicked = (activeEvent.poolConfig.questions || []).every(pickHasRequiredValue);
            if (!allPicked) {
                flashMessage('Make a pick for every bet before locking in.', 'red');
                return;
            }

            // Tiebreaker fields are required (every player must guess so the cascade works)
            const tbQs = activeEvent.poolConfig.tiebreakerQuestions || [];
            const tbs = currentEntry.tiebreakers || {};
            for (const tq of tbQs) {
                const v = tbs[tq.key];
                if (v === null || v === undefined || v === '' || !isFinite(Number(v))) {
                    flashMessage(`Enter a number for "${tq.label}" (tiebreaker).`, 'red');
                    return;
                }
            }
        }

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
                tiebreakers: currentEntry.tiebreakers || {},
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

            // Upsert into contacts so this phone shows up by name everywhere (SAY, broadcasts, etc.)
            // Don't overwrite an existing real name — only fill in if missing/Unknown.
            try {
                const phoneNorm = normalizePhone(phone);
                const contactsSnap = await db.collection('contacts').get();
                let existingContact = null;
                contactsSnap.forEach(doc => {
                    if (existingContact) return;
                    if (normalizePhone(doc.data().phone) === phoneNorm) {
                        existingContact = { id: doc.id, data: doc.data() };
                    }
                });
                if (!existingContact) {
                    await db.collection('contacts').add({
                        name: name,
                        phone: phone,
                        timestamp: firebase.firestore.FieldValue.serverTimestamp()
                    });
                } else {
                    const existingName = (existingContact.data.name || '').trim();
                    const isPlaceholder = !existingName || /^unknown/i.test(existingName);
                    if (isPlaceholder && name) {
                        await db.collection('contacts').doc(existingContact.id).update({ name });
                    }
                }
                // Refresh local contacts cache so the entries table updates immediately
                contactsByPhone[phoneNorm] = name;
            } catch (err) {
                console.warn('Contact upsert failed (non-fatal):', err);
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
