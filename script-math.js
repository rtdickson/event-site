// How-the-math-works page: handles password gate + dynamic worked example for ?event=ID

console.log('script-math.js loaded');

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function loadWorkedExample() {
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get('event');
    if (!eventId) return;

    const section = document.getElementById('math-worked-example');
    const content = document.getElementById('math-worked-content');
    if (!section || !content) return;

    try {
        const eventDoc = await db.collection('events').doc(eventId).get();
        if (!eventDoc.exists) return;
        const eventData = eventDoc.data();
        if (eventData.type !== 'pool' && eventData.type !== 'virtual') return;
        const config = eventData.poolConfig;
        if (!config || !config.results) return;

        section.style.display = 'block';
        content.innerHTML = 'Loading entries…';

        const entriesSnap = await db.collection(eventData.collectionName).get();
        const contestants = config.contestants || [];

        const ranked = entriesSnap.docs.map(doc => {
            const data = doc.data();
            const score = window.PoolConfig.scoreSlip(config, data, contestants);
            const tieBreak = window.PoolConfig.triCloseness(data, config);
            return { name: data.name || 'Unknown', picks: data.picks || {}, score, tieBreak };
        }).sort((a, b) => {
            if (b.score.bankroll !== a.score.bankroll) return b.score.bankroll - a.score.bankroll;
            if (a.tieBreak.tier1 !== b.tieBreak.tier1) return a.tieBreak.tier1 - b.tieBreak.tier1;
            if (b.tieBreak.tier2 !== a.tieBreak.tier2) return b.tieBreak.tier2 - a.tieBreak.tier2;
            if (a.tieBreak.tier3 !== b.tieBreak.tier3) return a.tieBreak.tier3 - b.tieBreak.tier3;
            return 0;
        });

        // Group by bankroll, find tied groups
        const byBankroll = {};
        ranked.forEach(r => {
            const k = r.score.bankroll;
            if (!byBankroll[k]) byBankroll[k] = [];
            byBankroll[k].push(r);
        });
        const tiedGroups = Object.entries(byBankroll)
            .filter(([_, list]) => list.length >= 2)
            .sort((a, b) => Number(b[0]) - Number(a[0]));

        const useFull = ranked.length > 0 && ranked[0].tieBreak.usedFullFinish;
        const fullFinish = config.fullFinish || [];
        const horseLabel = (id) => {
            const c = contestants.find(c => Number(c.id) === Number(id));
            return c ? `#${c.id} ${c.name}` : `#${id}`;
        };

        let html = `<p>Pool: <strong>${escapeHtml(eventData.name)}</strong>. Default stake: $${(config.defaultStake || 10).toLocaleString()}.</p>`;

        // Show actual race results for context
        if (useFull && fullFinish.length > 0) {
            const top5 = fullFinish.slice(0, 5).map((id, i) => `${i+1}. ${horseLabel(id)}`).join(' · ');
            html += `<p class="math-results-strip"><strong>Final order (top 5):</strong> ${escapeHtml(top5)}</p>`;
        } else if (config.results) {
            const winId = config.results.win;
            const placeId = config.results.place;
            const showId = config.results.show;
            html += `<p class="math-results-strip"><strong>Top 3:</strong> 1. ${escapeHtml(horseLabel(winId))} · 2. ${escapeHtml(horseLabel(placeId))} · 3. ${escapeHtml(horseLabel(showId))}</p>`;
            html += `<p class="math-note">Full finish order not entered yet — using set/exact-match fallback for tiebreakers.</p>`;
        }

        if (tiedGroups.length === 0) {
            html += `<p>No bankroll ties to break in this pool — every player landed at a unique bankroll.</p>`;
        } else {
            tiedGroups.forEach(([bankroll, group]) => {
                const isWinningGroup = group[0] === ranked[0];
                html += `<div class="math-tied-group ${isWinningGroup ? 'math-tied-winning' : ''}">`;
                html += `<h4>${isWinningGroup ? '🏆 ' : ''}${group.length}-way tie at $${Number(bankroll).toLocaleString()}</h4>`;

                if (useFull) {
                    html += renderFullFinishGroup(group, fullFinish, contestants);
                } else {
                    html += renderLegacyGroup(group, config, contestants);
                }
                html += `</div>`;
            });
        }

        content.innerHTML = html;
    } catch (err) {
        console.error('Worked example error:', err);
        content.innerHTML = `<p style="color:red;">Could not load worked example: ${escapeHtml(err.message)}</p>`;
    }
}

function renderFullFinishGroup(group, fullFinish, contestants) {
    const posByHorse = {};
    fullFinish.forEach((id, idx) => { posByHorse[Number(id)] = idx + 1; });
    const horseLabel = (id) => {
        const c = contestants.find(c => Number(c.id) === Number(id));
        return c ? `#${c.id} ${c.name}` : `#${id}`;
    };

    let out = '<table class="math-tied-table"><thead><tr><th>Player</th><th>Tri pick</th><th>Slot 1 err</th><th>Slot 2 err</th><th>Slot 3 err</th><th>Tier 1 (sum)</th><th>Tier 2 (exact)</th><th>Tier 3 (exacta)</th></tr></thead><tbody>';
    group.forEach((r, idx) => {
        const tri = r.picks.tri || [];
        const errors = tri.map((id, slotIdx) => {
            const predictedSlot = slotIdx + 1;
            const actualPos = posByHorse[Number(id)];
            return actualPos === undefined ? 20 : Math.abs(predictedSlot - actualPos);
        });
        const tier1 = errors.reduce((a, b) => a + b, 0);
        const tier2 = tri.reduce((acc, id, slotIdx) => acc + (posByHorse[Number(id)] === slotIdx + 1 ? 1 : 0), 0);
        const tier3 = errors.slice(0, 2).reduce((a, b) => a + b, 0);
        const triCells = tri.map((id, slotIdx) => {
            const actualPos = posByHorse[Number(id)];
            const isExact = actualPos === slotIdx + 1;
            return `${horseLabel(id)} <small>(actual ${actualPos === undefined ? 'DNF' : 'pos ' + actualPos})</small> <strong${isExact ? ' style="color:#2e7d32"' : ''}>err ${errors[slotIdx]}</strong>`;
        });
        out += `<tr ${idx === 0 ? 'class="math-tier-winner"' : ''}>
            <td>${escapeHtml(r.name)}${idx === 0 ? ' 🏆' : ''}</td>
            <td>${tri.map(horseLabel).join(' / ')}</td>
            <td>${errors[0] !== undefined ? errors[0] : '—'}</td>
            <td>${errors[1] !== undefined ? errors[1] : '—'}</td>
            <td>${errors[2] !== undefined ? errors[2] : '—'}</td>
            <td><strong>${tier1}</strong></td>
            <td>${tier2}/3</td>
            <td>${tier3}</td>
        </tr>`;
    });
    out += '</tbody></table>';

    // Resolution narrative
    const w = group[0].tieBreak;
    const r2 = group[1].tieBreak;
    let resolved = '';
    if (w.tier1 !== r2.tier1) resolved = `Resolved on <strong>Tier 1</strong>: ${escapeHtml(group[0].name)} has tri error ${w.tier1}, lower than next-best ${r2.tier1}.`;
    else if (w.tier2 !== r2.tier2) resolved = `Tier 1 tied at ${w.tier1}. Resolved on <strong>Tier 2</strong>: ${escapeHtml(group[0].name)} got ${w.tier2}/3 exact vs ${r2.tier2}/3.`;
    else if (w.tier3 !== r2.tier3) resolved = `Tiers 1 & 2 tied. Resolved on <strong>Tier 3</strong> (exacta): ${escapeHtml(group[0].name)} has exacta error ${w.tier3}, lower than ${r2.tier3}.`;
    else resolved = `<strong style="color:#b71c1c;">Coin flip required</strong> — all three tiers tied.`;
    out += `<p class="math-resolution">${resolved}</p>`;
    return out;
}

function renderLegacyGroup(group, config, contestants) {
    let out = '<table class="math-tied-table"><thead><tr><th>Player</th><th>Tri pick</th><th>Set match</th><th>Exact match</th></tr></thead><tbody>';
    const horseLabel = (id) => {
        const c = contestants.find(c => Number(c.id) === Number(id));
        return c ? `#${c.id} ${c.name}` : `#${id}`;
    };
    group.forEach((r, idx) => {
        const tri = r.picks.tri || [];
        out += `<tr ${idx === 0 ? 'class="math-tier-winner"' : ''}>
            <td>${escapeHtml(r.name)}${idx === 0 ? ' 🏆' : ''}</td>
            <td>${tri.map(horseLabel).join(' / ')}</td>
            <td>${r.tieBreak.setMatch}/3</td>
            <td>${r.tieBreak.exactMatch}/3</td>
        </tr>`;
    });
    out += '</tbody></table>';
    out += '<p class="math-note">Using fallback math — admin hasn\'t entered the full finish order yet. Once entered, the granular ladder (positional error → exacta error) is shown.</p>';
    return out;
}

async function loadFormatText() {
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get('event');
    if (!eventId) return;

    const el = document.getElementById('math-format-text');
    if (!el) return;

    try {
        const eventDoc = await db.collection('events').doc(eventId).get();
        if (!eventDoc.exists) return;
        const eventData = eventDoc.data();
        const config = eventData.poolConfig;
        if (!config || !window.PoolConfig || !window.PoolConfig.isAllocationMode(config)) return;

        const bankroll = config.bankrollAmount || 5000;
        const constraints = config.allocationConstraints || {};
        const min = constraints.min || 250;
        const max = constraints.max || 2000;
        const numBets = (config.questions || []).length || 6;
        const fmt = (n) => '$' + Number(n).toLocaleString();
        const betWord = numBets === 1 ? 'bet' : 'bets';
        const countWord = numBets === 1 ? 'one' : numBets === 2 ? 'two' : numBets === 3 ? 'three' : numBets === 4 ? 'four' : numBets === 5 ? 'five' : numBets === 6 ? 'six' : String(numBets);

        el.innerHTML = `Every player gets a bankroll of <strong>${fmt(bankroll)}</strong> to allocate across <strong>${numBets} ${betWord}</strong>. Each bet must be <strong>between ${fmt(min)} and ${fmt(max)}</strong> and the ${countWord} must <strong>sum to exactly ${fmt(bankroll)}</strong>. Use the +/− buttons on the public page to adjust.`;
    } catch (err) {
        console.error('Format text load error:', err);
    }
}

function initializePage() {
    loadFormatText();
    loadWorkedExample();
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.auth && window.auth.isAuthenticated()) {
        document.getElementById('password-prompt').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
        initializePage();
    } else {
        document.getElementById('password-prompt').style.display = 'block';
        const passwordInput = document.getElementById('password-input');
        if (passwordInput) {
            passwordInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handlePasswordSubmit(); });
            passwordInput.focus();
        }
        const submitButton = document.querySelector('#password-prompt button');
        if (submitButton) submitButton.onclick = handlePasswordSubmit;
    }
});

async function handlePasswordSubmit() {
    const passwordInput = document.getElementById('password-input');
    const errorEl = document.getElementById('password-error');
    const submitButton = document.querySelector('#password-prompt button');
    if (!passwordInput || !passwordInput.value) { errorEl.textContent = 'Enter a password.'; return; }
    submitButton.disabled = true;
    submitButton.textContent = 'Verifying...';
    try {
        const isValid = await window.auth.login(passwordInput.value, 'guest');
        if (isValid) {
            document.getElementById('password-prompt').style.display = 'none';
            document.getElementById('main-content').style.display = 'block';
            initializePage();
        } else {
            errorEl.textContent = 'Incorrect password.';
            passwordInput.value = '';
        }
    } catch (e) { errorEl.textContent = 'Auth failed.'; }
    finally { submitButton.disabled = false; submitButton.textContent = 'Submit'; }
}
