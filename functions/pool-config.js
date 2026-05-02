// Pool event schema, scoring, and payoff helpers.
// Pure functions — usable from client (browser) and server (Cloud Function) alike.
// No Firebase, no DOM. Just data in, data out.

(function (root) {
    'use strict';

    // ----- Question kinds -----
    // Each kind defines: how it renders, how a pick is shaped, how it scores,
    // and how its payoff is calculated.
    const QUESTION_KINDS = {
        pickContestant: {
            label: 'Pick a contestant',
            // pick: contestant id (number)
            // result key on results: question.resultKey ('win'|'place'|'show')
        },
        orderedTriple: {
            label: 'Pick 1-2-3 in order',
            // pick: [id, id, id]
        },
        unorderedTriple: {
            label: 'Pick top 3 (any order)',
            // pick: [id, id, id]
        },
        pickLongshot: {
            label: 'Pick a longshot to finish top 3',
            // pick: contestant id (must be flagged isLongshot)
        },
        overUnder: {
            label: 'Over/Under',
            // pick: 'over' | 'under'
            // result: 'over' | 'under'
        },
        yesNo: {
            label: 'Yes/No',
            // pick: 'yes' | 'no'
            // result: 'yes' | 'no'
        }
    };

    // ----- Defaults -----
    const DEFAULT_STAKE = 10;
    const DEFAULT_PARLAY_LIMIT = 3;
    // Multipliers for flat-payoff kinds: payoff = stake * multiplier.
    // (Originally these were hardcoded $-amounts at $10 stake; multipliers let stakes scale.)
    const DEFAULT_PAYOFF_MULTIPLIERS = {
        orderedTriple: 50,    // $10 stake -> $500 trifecta
        unorderedTriple: 10,  // $10 stake -> $100 box
        pickLongshot: 5       // $10 stake -> $50 longshot bonus
    };
    // Legacy fallback if old `payoff` field is present (back when stake was $10 baseline)
    const LEGACY_BASELINE_STAKE = 10;

    // ----- Odds parsing -----
    // Accepts '8/1', '8-1', '5/2', 'EVEN', '1/1'. Returns { num, den, decimal }
    // where decimal is the multiplier on stake for profit (8/1 -> 8).
    function parseOdds(oddsString) {
        if (!oddsString) return { num: 1, den: 1, decimal: 1 };
        const s = String(oddsString).trim().toLowerCase();
        if (s === 'even' || s === 'evens') return { num: 1, den: 1, decimal: 1 };
        const m = s.match(/^(\d+)\s*[\/\-]\s*(\d+)$/);
        if (!m) return { num: 1, den: 1, decimal: 1 };
        const num = parseInt(m[1], 10);
        const den = parseInt(m[2], 10) || 1;
        return { num, den, decimal: num / den };
    }

    // ----- Default Derby question set -----
    // No hardcoded `stake` — questions inherit from poolConfig.defaultStake at scoring time.
    // payoffMultiplier scales the flat-payoff questions with stake.
    function defaultDerbyQuestions() {
        return [
            { id: 'win',      kind: 'pickContestant',  label: 'Pick the Winner',                 lockable: true, resultKey: 'win' },
            { id: 'place',    kind: 'pickContestant',  label: 'Finishes 2nd',                    lockable: true, resultKey: 'place' },
            { id: 'show',     kind: 'pickContestant',  label: 'Finishes 3rd',                    lockable: true, resultKey: 'show' },
            { id: 'tri',      kind: 'orderedTriple',   label: 'Trifecta (1-2-3 in order)',       payoffMultiplier: 50 },
            { id: 'box3',     kind: 'unorderedTriple', label: 'Top-3 Box (any order)',           payoffMultiplier: 10 },
            { id: 'longshot', kind: 'pickLongshot',    label: 'Longshot to finish top 3',        payoffMultiplier: 5 },
            { id: 'time',     kind: 'overUnder',       label: 'Winning time over/under 2:02',    line: '2:02' },
            { id: 'fav',      kind: 'yesNo',           label: 'Will the favorite finish top 3?'  }
        ];
    }

    // ----- Stake/payoff helpers -----
    function effectiveStake(question, poolConfig) {
        // Per-question custom stake wins; otherwise use pool default.
        if (question && question.stake !== undefined && question.stake !== null) return question.stake;
        return (poolConfig && poolConfig.defaultStake) || DEFAULT_STAKE;
    }

    // Returns the payoff if this question hits, given the effective stake and (for pickContestant) odds.
    function payoffIfHit(question, stake, oddsDecimal) {
        switch (question.kind) {
            case 'pickContestant':
                return Math.round(stake * (oddsDecimal || 0));
            case 'overUnder':
            case 'yesNo':
                return stake;
            case 'orderedTriple':
            case 'unorderedTriple':
            case 'pickLongshot': {
                if (question.payoffMultiplier !== undefined) return Math.round(stake * question.payoffMultiplier);
                // Legacy: convert old fixed `payoff` (was set at $10 baseline) to scale with stake
                if (question.payoff !== undefined) return Math.round(question.payoff * (stake / LEGACY_BASELINE_STAKE));
                return Math.round(stake * (DEFAULT_PAYOFF_MULTIPLIERS[question.kind] || 1));
            }
            default:
                return 0;
        }
    }

    // ----- Scoring -----
    // Returns { hit: bool, payoff: number } for a single question.
    // `pick` is whatever the user submitted; may be undefined (no answer).
    // `results` is the admin-entered results object (keys per question).
    // `contestants` lookup map: { [id]: contestantObject }
    function scoreQuestion(question, pick, results, contestantsById, poolConfig) {
        const stake = effectiveStake(question, poolConfig);
        const miss = { hit: false, payoff: 0 };

        if (pick === undefined || pick === null) return miss;
        if (!results || results[question.id] === undefined) return miss;

        const result = results[question.id];

        switch (question.kind) {
            case 'pickContestant': {
                if (Number(pick) !== Number(result)) return miss;
                const contestant = contestantsById[Number(pick)];
                const odds = parseOdds(contestant && contestant.odds);
                return { hit: true, payoff: payoffIfHit(question, stake, odds.decimal) };
            }

            case 'orderedTriple': {
                if (!Array.isArray(pick) || pick.length !== 3) return miss;
                if (!Array.isArray(result) || result.length !== 3) return miss;
                const allMatch = pick.every((id, i) => Number(id) === Number(result[i]));
                if (!allMatch) return miss;
                return { hit: true, payoff: payoffIfHit(question, stake) };
            }

            case 'unorderedTriple': {
                if (!Array.isArray(pick) || pick.length !== 3) return miss;
                if (!Array.isArray(result) || result.length !== 3) return miss;
                const pickSet = new Set(pick.map(Number));
                const resultSet = new Set(result.map(Number));
                if (pickSet.size !== 3 || resultSet.size !== 3) return miss;
                for (const id of pickSet) if (!resultSet.has(id)) return miss;
                return { hit: true, payoff: payoffIfHit(question, stake) };
            }

            case 'pickLongshot': {
                if (!Array.isArray(result)) return miss;
                const found = result.some(id => Number(id) === Number(pick));
                if (!found) return miss;
                return { hit: true, payoff: payoffIfHit(question, stake) };
            }

            case 'overUnder':
            case 'yesNo': {
                if (String(pick).toLowerCase() !== String(result).toLowerCase()) return miss;
                return { hit: true, payoff: stake };
            }

            default:
                return miss;
        }
    }

    // ----- Slip scoring (full entry) -----
    // entry: { picks: { [questionId]: pick }, locks: [questionId, ...] }
    // Returns:
    //   {
    //     perQuestion: [{ questionId, hit, payoff }],
    //     parlay: { attempted: bool, hit: bool, bonus: number, legs: [{questionId, odds}] },
    //     bankroll: number   // total winnings
    //   }
    function scoreSlip(poolConfig, entry, contestants) {
        const contestantsById = {};
        (contestants || []).forEach(c => { contestantsById[Number(c.id)] = c; });

        const results = (poolConfig && poolConfig.results) || null;
        const picks = (entry && entry.picks) || {};
        const locks = Array.isArray(entry && entry.locks) ? entry.locks : [];
        const questions = (poolConfig && poolConfig.questions) || [];
        const questionsById = {};
        questions.forEach(q => { questionsById[q.id] = q; });

        const perQuestion = questions.map(q => {
            const { hit, payoff } = scoreQuestion(q, picks[q.id], results, contestantsById, poolConfig);
            return { questionId: q.id, hit, payoff };
        });

        // Parlay: only lockable questions (single-pick contestant ones) count.
        const parlayLegs = [];
        let parlayHitAll = locks.length >= 2;
        for (const qid of locks) {
            const q = questionsById[qid];
            if (!q || !q.lockable) { parlayHitAll = false; continue; }
            const pq = perQuestion.find(p => p.questionId === qid);
            if (!pq || !pq.hit) { parlayHitAll = false; }
            const contestant = contestantsById[Number(picks[qid])];
            const odds = parseOdds(contestant && contestant.odds);
            parlayLegs.push({ questionId: qid, odds: odds });
        }

        let parlayBonus = 0;
        if (parlayHitAll && results) {
            const stake = effectiveStake(questionsById[locks[0]], poolConfig);
            const product = parlayLegs.reduce((acc, leg) => acc * leg.odds.decimal, 1);
            parlayBonus = Math.round(stake * product);
        }

        const bankroll = perQuestion.reduce((sum, p) => sum + p.payoff, 0) + parlayBonus;

        return {
            perQuestion,
            parlay: {
                attempted: locks.length >= 2,
                hit: parlayHitAll && !!results,
                bonus: parlayBonus,
                legs: parlayLegs
            },
            bankroll
        };
    }

    // ----- Implied probability + slip odds (rough, for fun) -----
    // Win probability from morning-line odds: 1 / (decimal + 1) where decimal = num/den
    function impliedWinProbability(contestant) {
        if (!contestant) return 0;
        const odds = parseOdds(contestant.odds);
        return 1 / (odds.decimal + 1);
    }

    // Combined slip probability across all answered questions.
    // Approximations (NOT real horse-racing math — fine for fun stats):
    //  - Place: 2x P(win), capped 0.5
    //  - Show:  3x P(win), capped 0.65
    //  - Trifecta exact: P(a_win) * P(b_win) * P(c_win) — undercount but in the right ballpark
    //  - Top-3 box: 6x ordered triple
    //  - Longshot top-3: 3x P(win), capped 0.65
    //  - O/U, Yes/No: 0.5
    function slipProbability(entry, poolConfig, contestants) {
        const cById = {};
        (contestants || []).forEach(c => { cById[Number(c.id)] = c; });
        const picks = (entry && entry.picks) || {};
        const questions = (poolConfig && poolConfig.questions) || [];

        let p = 1;
        let counted = 0;
        for (const q of questions) {
            const v = picks[q.id];
            if (v === null || v === undefined || v === '') continue;
            if (Array.isArray(v) && v.some(x => x == null || x === '')) continue;

            switch (q.kind) {
                case 'pickContestant': {
                    const c = cById[Number(v)];
                    const pwin = impliedWinProbability(c);
                    if (q.id === 'win' || q.resultKey === 'win') p *= pwin;
                    else if (q.id === 'place' || q.resultKey === 'place') p *= Math.min(0.5, pwin * 2);
                    else if (q.id === 'show' || q.resultKey === 'show') p *= Math.min(0.65, pwin * 3);
                    else p *= pwin;
                    counted++;
                    break;
                }
                case 'pickLongshot': {
                    const c = cById[Number(v)];
                    const pwin = impliedWinProbability(c);
                    p *= Math.min(0.65, pwin * 3);
                    counted++;
                    break;
                }
                case 'orderedTriple': {
                    const prod = v.reduce((acc, id) => acc * impliedWinProbability(cById[Number(id)]), 1);
                    p *= prod;
                    counted++;
                    break;
                }
                case 'unorderedTriple': {
                    const prod = v.reduce((acc, id) => acc * impliedWinProbability(cById[Number(id)]), 1);
                    p *= Math.min(1, prod * 6); // 6 orderings
                    counted++;
                    break;
                }
                case 'overUnder':
                case 'yesNo':
                    p *= 0.5;
                    counted++;
                    break;
            }
        }
        return counted === 0 ? 0 : p;
    }

    // Convert probability to "N to 1 against" odds string.
    function impliedOddsAgainst(probability) {
        if (!probability || probability <= 0) return Infinity;
        const odds = (1 / probability) - 1;
        return odds;
    }

    function formatOddsAgainst(probability) {
        const o = impliedOddsAgainst(probability);
        if (!isFinite(o) || isNaN(o)) return '∞';
        if (o < 1) {
            // Better than even — rare for a full slip
            return '1 to ' + (Math.round(1 / o)).toLocaleString();
        }
        return Math.round(o).toLocaleString() + ' to 1';
    }

    // ----- Tiebreaker: how close was an entry's trifecta to the actual top 3? -----
    // Returns { setMatch, exactMatch } where:
    //   setMatch — count of picked horses that finished in the actual top 3 (any order), 0-3
    //   exactMatch — count of picked horses in the exact correct finish position, 0-3
    // Used as secondary sort keys when bankrolls tie.
    function triCloseness(entry, poolConfig) {
        const result = { setMatch: 0, exactMatch: 0 };
        if (!entry || !poolConfig) return result;
        const picks = entry.picks || {};
        const questions = poolConfig.questions || [];
        const results = poolConfig.results || {};

        // Find the trifecta question
        const triQ = questions.find(q => q.kind === 'orderedTriple' || q.kind === 'unorderedTriple');
        if (!triQ) return result;

        const triPick = picks[triQ.id];
        const triResult = results[triQ.id];
        if (!Array.isArray(triPick) || !Array.isArray(triResult)) return result;

        const pickIds = triPick.map(Number).filter(n => !isNaN(n));
        const resultIds = triResult.map(Number).filter(n => !isNaN(n));
        const resultSet = new Set(resultIds);

        for (let i = 0; i < pickIds.length; i++) {
            if (resultSet.has(pickIds[i])) result.setMatch++;
            if (resultIds[i] !== undefined && pickIds[i] === resultIds[i]) result.exactMatch++;
        }
        return result;
    }

    // ----- Real-money simulation: "if we'd actually wagered" -----
    // Returns { wagered, expectedReturn, ev, returned, net } for an entry.
    //   wagered: sum of stakes across answered questions (incl. parlay legs once)
    //   expectedReturn: sum of P(hit) × payoff for each pick (rough)
    //   ev: expectedReturn - wagered (always negative-ish for honest odds)
    //   returned: actual payout if results are in (else null)
    //   net: returned - wagered (else null)
    function computePnL(entry, poolConfig, contestants) {
        const cById = {};
        (contestants || []).forEach(c => { cById[Number(c.id)] = c; });
        const picks = (entry && entry.picks) || {};
        const locks = (entry && entry.locks) || [];
        const questions = (poolConfig && poolConfig.questions) || [];

        let wagered = 0;
        let expectedReturn = 0;

        for (const q of questions) {
            const v = picks[q.id];
            if (v === null || v === undefined || v === '') continue;
            if (Array.isArray(v) && v.some(x => x == null || x === '')) continue;

            const stake = effectiveStake(q, poolConfig);
            wagered += stake;

            let pHit = 0;
            let payoff = 0;
            switch (q.kind) {
                case 'pickContestant': {
                    const c = cById[Number(v)];
                    const odds = parseOdds(c && c.odds);
                    pHit = 1 / (odds.decimal + 1);
                    if (q.id === 'place' || q.resultKey === 'place') pHit = Math.min(0.5, pHit * 2);
                    else if (q.id === 'show' || q.resultKey === 'show') pHit = Math.min(0.65, pHit * 3);
                    payoff = payoffIfHit(q, stake, odds.decimal);
                    break;
                }
                case 'pickLongshot': {
                    const c = cById[Number(v)];
                    pHit = Math.min(0.65, (1 / (parseOdds(c && c.odds).decimal + 1)) * 3);
                    payoff = payoffIfHit(q, stake);
                    break;
                }
                case 'orderedTriple': {
                    pHit = v.reduce((acc, id) => acc * (1 / (parseOdds((cById[Number(id)] || {}).odds).decimal + 1)), 1);
                    payoff = payoffIfHit(q, stake);
                    break;
                }
                case 'unorderedTriple': {
                    pHit = Math.min(1, 6 * v.reduce((acc, id) => acc * (1 / (parseOdds((cById[Number(id)] || {}).odds).decimal + 1)), 1));
                    payoff = payoffIfHit(q, stake);
                    break;
                }
                case 'overUnder':
                case 'yesNo':
                    pHit = 0.5;
                    payoff = stake;
                    break;
            }
            expectedReturn += pHit * payoff;
        }

        // Parlay leg: extra stake at risk for the bonus (modeled as +stake wagered, +parlay-bonus expected return weighted by joint prob)
        if (locks.length >= 2) {
            const validLockedQs = locks.map(qid => questions.find(q => q.id === qid)).filter(q => q && q.lockable);
            if (validLockedQs.length === locks.length) {
                const stake = effectiveStake(validLockedQs[0], poolConfig);
                wagered += stake; // additional stake on the parlay
                const jointProb = locks.reduce((acc, qid) => {
                    const c = cById[Number(picks[qid])];
                    return acc * (1 / (parseOdds(c && c.odds).decimal + 1));
                }, 1);
                const product = locks.reduce((acc, qid) => {
                    const c = cById[Number(picks[qid])];
                    return acc * parseOdds(c && c.odds).decimal;
                }, 1);
                expectedReturn += jointProb * Math.round(stake * product);
            }
        }

        const ev = expectedReturn - wagered;

        // Actual returned/net only if results are in
        let returned = null;
        let net = null;
        if (poolConfig && poolConfig.results) {
            const score = scoreSlip(poolConfig, entry, contestants);
            returned = score.bankroll;
            net = returned - wagered;
        }

        return { wagered, expectedReturn: Math.round(expectedReturn), ev: Math.round(ev), returned, net };
    }

    // ----- "Max possible" — used as the carrot on the form -----
    // For each question with a pick, what's the payoff if it hits?
    function maxPossiblePayoff(poolConfig, entry, contestants) {
        const contestantsById = {};
        (contestants || []).forEach(c => { contestantsById[Number(c.id)] = c; });
        const picks = (entry && entry.picks) || {};
        const locks = Array.isArray(entry && entry.locks) ? entry.locks : [];
        const questions = (poolConfig && poolConfig.questions) || [];
        const questionsById = {};
        questions.forEach(q => { questionsById[q.id] = q; });

        let total = 0;
        for (const q of questions) {
            const pick = picks[q.id];
            if (pick === undefined || pick === null || pick === '') continue;
            if (Array.isArray(pick) && (pick.length === 0 || pick.some(v => v === '' || v == null))) continue;
            const stake = effectiveStake(q, poolConfig);
            if (q.kind === 'pickContestant') {
                const c = contestantsById[Number(pick)];
                total += payoffIfHit(q, stake, parseOdds(c && c.odds).decimal);
            } else if (q.kind === 'overUnder' || q.kind === 'yesNo') {
                total += stake;
            } else {
                total += payoffIfHit(q, stake);
            }
        }

        // Parlay potential (assumes all locked legs hit)
        if (locks.length >= 2) {
            const validLegs = locks
                .map(qid => questionsById[qid])
                .filter(q => q && q.lockable);
            if (validLegs.length === locks.length) {
                const stake = effectiveStake(validLegs[0], poolConfig);
                const product = locks.reduce((acc, qid) => {
                    const c = contestantsById[Number(picks[qid])];
                    return acc * parseOdds(c && c.odds).decimal;
                }, 1);
                total += Math.round(stake * product);
            }
        }

        return total;
    }

    // ----- Lock validation -----
    function canLock(question) {
        return !!(question && question.lockable);
    }

    function isPoolOpen(poolConfig, now) {
        if (!poolConfig) return false;
        const closesAt = poolConfig.closesAt;
        if (!closesAt) return true;
        const closesMs = closesAt.toMillis ? closesAt.toMillis()
                       : closesAt.seconds ? closesAt.seconds * 1000
                       : new Date(closesAt).getTime();
        return (now || Date.now()) < closesMs;
    }

    // ----- Export -----
    const api = {
        QUESTION_KINDS,
        DEFAULT_STAKE,
        DEFAULT_PARLAY_LIMIT,
        DEFAULT_PAYOFF_MULTIPLIERS,
        parseOdds,
        defaultDerbyQuestions,
        effectiveStake,
        payoffIfHit,
        scoreQuestion,
        scoreSlip,
        maxPossiblePayoff,
        impliedWinProbability,
        slipProbability,
        impliedOddsAgainst,
        formatOddsAgainst,
        computePnL,
        triCloseness,
        canLock,
        isPoolOpen
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.PoolConfig = api;
    }
})(typeof window !== 'undefined' ? window : this);
