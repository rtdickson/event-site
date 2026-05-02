// Event list page: shows active + upcoming events as clickable cards.
// Past events are hidden from guests but remain in Firestore (admin reference).

console.log('script-index.js loaded');

function eventDate(data) {
    if (data.dateRaw) return new Date(data.dateRaw);
    if (data.date) {
        const d = new Date(data.date.split(' at ')[0]);
        if (!isNaN(d.getTime())) return d;
    }
    return null;
}

function isUpcoming(data) {
    const d = eventDate(data);
    if (!d) return true; // if date can't be parsed, show it (don't accidentally hide)
    // Treat the entire event day as "still upcoming" so day-of guests see it
    const endOfEventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    return endOfEventDay.getTime() > Date.now();
}

const RECENT_RESULTS_DAYS = 14;

function isRecentResult(data) {
    const d = eventDate(data);
    if (!d) return false;
    const endOfEventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    const now = Date.now();
    if (endOfEventDay.getTime() >= now) return false; // still upcoming
    const cutoff = endOfEventDay.getTime() + RECENT_RESULTS_DAYS * 24 * 60 * 60 * 1000;
    if (now > cutoff) return false; // too old
    // Pool: only show if results are entered (something to celebrate)
    if (data.type === 'pool' || data.type === 'virtual') {
        const results = data.poolConfig && data.poolConfig.results;
        if (!results) return false;
        const hasAny = Object.values(results).some(v => {
            if (v === null || v === undefined || v === '') return false;
            if (Array.isArray(v)) return v.some(x => x != null && x !== '');
            return true;
        });
        return hasAny;
    }
    // Gatherings: show in recent for the window regardless
    return true;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fallbackImage(data) {
    if (data.imageUrl) return data.imageUrl;
    if (data.type === 'pool') return 'images/kdimage.png';
    return 'images/event1.jpg';
}

function typeBadge(data) {
    if (data.type === 'pool') return '<span class="event-type-badge pool">Pool</span>';
    return '<span class="event-type-badge gathering">Gathering</span>';
}

async function loadEventList() {
    try {
        const snapshot = await db.collection('events').orderBy('createdAt', 'desc').get();
        const loadingEl = document.getElementById('events-loading');
        const noneEl = document.getElementById('no-events');
        const container = document.getElementById('events-list-container');

        if (loadingEl) loadingEl.style.display = 'none';

        const upcoming = [];
        const recent = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (isUpcoming(data)) upcoming.push({ id: doc.id, data });
            else if (isRecentResult(data)) recent.push({ id: doc.id, data });
        });

        // Upcoming sort: active first, then by event date ascending
        upcoming.sort((a, b) => {
            if (a.data.isActive && !b.data.isActive) return -1;
            if (!a.data.isActive && b.data.isActive) return 1;
            const da = eventDate(a.data);
            const db_ = eventDate(b.data);
            if (da && db_) return da.getTime() - db_.getTime();
            return 0;
        });
        // Recent sort: most recent first
        recent.sort((a, b) => (eventDate(b.data) || 0) - (eventDate(a.data) || 0));

        if (upcoming.length === 0 && recent.length === 0) {
            if (noneEl) noneEl.style.display = 'block';
            return;
        }

        // Look up winner for each recent pool entry (parallel)
        const winnersByEventId = {};
        await Promise.all(recent.map(async ({ id, data }) => {
            if ((data.type === 'pool' || data.type === 'virtual') && data.collectionName) {
                try {
                    const entriesSnap = await db.collection(data.collectionName).get();
                    if (entriesSnap.empty) return;
                    const config = data.poolConfig || {};
                    const contestants = config.contestants || [];
                    let bestEntry = null;
                    let bestScore = null;
                    let bestTie = null;
                    entriesSnap.forEach(eDoc => {
                        const e = eDoc.data();
                        const sc = window.PoolConfig.scoreSlip(config, e, contestants);
                        const tb = window.PoolConfig.triCloseness(e, config);
                        if (!bestScore
                            || sc.bankroll > bestScore.bankroll
                            || (sc.bankroll === bestScore.bankroll && tb.setMatch > bestTie.setMatch)
                            || (sc.bankroll === bestScore.bankroll && tb.setMatch === bestTie.setMatch && tb.exactMatch > bestTie.exactMatch)) {
                            bestEntry = e;
                            bestScore = sc;
                            bestTie = tb;
                        }
                    });
                    if (bestEntry) {
                        winnersByEventId[id] = { name: bestEntry.name || 'Unknown', bankroll: bestScore.bankroll };
                    }
                } catch (err) {
                    console.warn('Winner lookup failed for', id, err);
                }
            }
        }));

        let html = '';
        if (upcoming.length > 0) {
            html += '<h2 class="events-section-heading">Upcoming Events</h2>';
            html += '<div class="events-grid">' + upcoming.map(({ id, data }) => renderEventCard(id, data)).join('') + '</div>';
        }
        if (recent.length > 0) {
            html += '<h2 class="events-section-heading events-section-recent">Recent Results</h2>';
            html += '<div class="events-grid">' + recent.map(({ id, data }) => renderEventCard(id, data, winnersByEventId[id])).join('') + '</div>';
        }
        container.innerHTML = html;
    } catch (err) {
        console.error('Error loading event list:', err);
        const loadingEl = document.getElementById('events-loading');
        if (loadingEl) {
            loadingEl.textContent = 'Error loading events. Please refresh.';
            loadingEl.style.color = 'red';
        }
    }
}

function renderEventCard(id, data, winner) {
    const winnerLine = winner
        ? `<p class="event-card-winner">🏆 Winner: <strong>${escapeHtml(winner.name)}</strong> — $${winner.bankroll.toLocaleString()}</p>`
        : '';
    const cta = winner
        ? 'See standings →'
        : (data.type === 'pool' || data.type === 'virtual') ? 'Make your picks →' : 'View &amp; RSVP →';
    return `
        <a href="event.html?id=${id}" class="event-card-link">
            <article class="event-card-list ${winner ? 'event-card-completed' : ''}">
                <img src="${escapeHtml(fallbackImage(data))}" alt="${escapeHtml(data.name)}" class="event-card-img" />
                <div class="event-card-body">
                    <div class="event-card-meta">
                        ${typeBadge(data)}
                        ${data.isActive && !winner ? '<span class="event-card-active">★ Active</span>' : ''}
                    </div>
                    <h3 class="event-card-title">${escapeHtml(data.name)}</h3>
                    <p class="event-card-date">${escapeHtml(data.date || '')}</p>
                    ${winnerLine}
                    ${data.description && !winner ? `<p class="event-card-desc">${escapeHtml(data.description)}</p>` : ''}
                    <span class="event-card-cta">${cta}</span>
                </div>
            </article>
        </a>
    `;
}

function initializePage() {
    loadEventList();
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
            passwordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handlePasswordSubmit();
            });
            passwordInput.focus();
        }
        const submitButton = document.querySelector('#password-prompt button');
        if (submitButton) {
            submitButton.onclick = handlePasswordSubmit;
            submitButton.removeAttribute('onclick');
        }
    }
});

async function handlePasswordSubmit() {
    const passwordInput = document.getElementById('password-input');
    const errorEl = document.getElementById('password-error');
    const submitButton = document.querySelector('#password-prompt button');

    if (!passwordInput || !passwordInput.value) {
        errorEl.textContent = 'Please enter a password.';
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Verifying...';
    errorEl.textContent = '';

    try {
        const isValid = await window.auth.login(passwordInput.value, 'guest');
        if (isValid) {
            document.getElementById('password-prompt').style.display = 'none';
            document.getElementById('main-content').style.display = 'block';
            initializePage();
        } else {
            errorEl.textContent = 'Incorrect password. Please try again.';
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (err) {
        console.error('Auth error:', err);
        errorEl.textContent = 'Authentication failed. Try again.';
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
    }
}
