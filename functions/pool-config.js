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
        },
        // ----- Added for Preakness 2026 (allocation-style pool) -----
        pickInTopN: {
            label: 'Pick a horse to finish in top N',
            // pick: contestant id (number)
            // hits if pick is in first N of poolConfig.fullFinish (where N = question.topN)
        },
        orderedPair: {
            label: 'Pick 1-2 in order',
            // pick: [id, id]
            // hits if pick === poolConfig.fullFinish.slice(0,2) exactly (or results[qid] if set)
        },
        autoProp: {
            label: 'Auto-resolved prop (no pick)',
            // pick: null (player just stakes money on the bet)
            // hits per question.autoComputeFrom:
            //   'longshotQualifiers' — hits if any horse in poolConfig.longshotQualifiers finishes in top 3
            // Or explicit results[qid] = 'yes'|'no' if no autoCompute set.
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

    // ----- Default Preakness question set -----
    // Used by allocation-mode pools. Players allocate from a $5,000 bankroll across these 5 bets.
    // Payoff formula in allocation mode: if hit, payout = (stake * payoffMultiplier) + stake. If miss, payout = 0.
    function defaultPreaknessQuestions() {
        return [
            // Top 5: gradient scoring — pick 5 horses; multiplier = (# in actual top 5) + (sum of their odds)
            { id: 'top5',     kind: 'pickInTopN',     label: 'Top 5 Finishers (pick 5)',  topN: 5, pickN: 5, scoring: 'gradientOdds' },
            { id: 'timeou',   kind: 'overUnder',      label: 'Winning time over/under',   line: '1:58.00', payoffMultiplier: 2 },
            { id: 'tri',      kind: 'orderedTriple',  label: 'Trifecta (1-2-3 in order)', payoffMultiplier: 4 },
            { id: 'exacta',   kind: 'orderedPair',    label: 'Exacta (1-2 in order)',     payoffMultiplier: 5 },
            { id: 'longshot', kind: 'autoProp',       label: 'Long Shot Top 3 (15:1+ horse in top 3)', autoComputeFrom: 'longshotQualifiers', payoffMultiplier: 6 }
        ];
    }

    // ----- Allocation-mode helpers -----
    // In allocation mode, each pick is stored as `{ value, stake }` instead of just a raw value.
    // These helpers handle both shapes so legacy Derby entries still work.
    function isAllocationMode(poolConfig) {
        return !!(poolConfig && poolConfig.bankrollMode === 'allocate');
    }

    function getPickValue(rawPick) {
        if (rawPick !== null && rawPick !== undefined && typeof rawPick === 'object' && !Array.isArray(rawPick) && 'value' in rawPick) {
            return rawPick.value;
        }
        return rawPick;
    }

    function getPickStake(rawPick) {
        if (rawPick !== null && rawPick !== undefined && typeof rawPick === 'object' && !Array.isArray(rawPick) && 'stake' in rawPick) {
            const n = Number(rawPick.stake);
            return isFinite(n) ? n : 0;
        }
        return null; // signal "use fixed-stake helper instead"
    }

    // Validates an allocation map against the pool's bankroll constraints.
    // Returns { ok, allocated, remaining, errors: [string] }
    function validateAllocation(picks, poolConfig) {
        const bankroll = (poolConfig && poolConfig.bankrollAmount) || 0;
        const constraints = (poolConfig && poolConfig.allocationConstraints) || {};
        const min = constraints.min || 0;
        const max = constraints.max || bankroll;
        const increment = constraints.increment || 1;
        const questions = (poolConfig && poolConfig.questions) || [];

        const errors = [];
        let allocated = 0;
        for (const q of questions) {
            const stake = getPickStake(picks[q.id]);
            const s = (stake === null) ? 0 : stake;
            allocated += s;
            if (s < min) errors.push(`${q.label}: $${s} below the $${min} minimum`);
            if (s > max) errors.push(`${q.label}: $${s} over the $${max} maximum`);
            if (s % increment !== 0) errors.push(`${q.label}: $${s} not on $${increment} increment`);
        }
        if (allocated !== bankroll) {
            errors.push(`Total allocated $${allocated}, need exactly $${bankroll}`);
        }
        return {
            ok: errors.length === 0,
            allocated,
            remaining: bankroll - allocated,
            errors
        };
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
    // Derive the result for a question from the pool config.
    // In allocation-mode pools, admin enters poolConfig.fullFinish and longshotQualifiers;
    // most question results are derived from those. Explicit results[qid] always wins.
    function deriveQuestionResult(question, poolConfig) {
        const results = (poolConfig && poolConfig.results) || {};
        const explicit = results[question.id];
        if (explicit !== undefined && explicit !== null && explicit !== '') return explicit;

        const fullFinish = Array.isArray(poolConfig && poolConfig.fullFinish) ? poolConfig.fullFinish : null;
        const qualifiers = Array.isArray(poolConfig && poolConfig.longshotQualifiers) ? poolConfig.longshotQualifiers : [];

        switch (question.kind) {
            case 'pickContestant':
                if (!fullFinish) return undefined;
                if (question.resultKey === 'win') return fullFinish[0];
                if (question.resultKey === 'place') return fullFinish[1];
                if (question.resultKey === 'show') return fullFinish[2];
                return undefined;
            case 'pickInTopN':
                if (!fullFinish) return undefined;
                return fullFinish.slice(0, question.topN || 5);
            case 'orderedTriple':
                if (!fullFinish) return undefined;
                return fullFinish.slice(0, 3);
            case 'unorderedTriple':
                if (!fullFinish) return undefined;
                return fullFinish.slice(0, 3);
            case 'orderedPair':
                if (!fullFinish) return undefined;
                return fullFinish.slice(0, 2);
            case 'pickLongshot':
                if (!fullFinish) return undefined;
                return fullFinish.slice(0, 3);
            case 'autoProp':
                if (question.autoComputeFrom === 'longshotQualifiers') {
                    if (!fullFinish || !qualifiers.length) return undefined;
                    const top3 = fullFinish.slice(0, 3).map(Number);
                    return qualifiers.some(id => top3.includes(Number(id))) ? 'yes' : 'no';
                }
                return undefined;
            default:
                return undefined;
        }
    }

    // Allocation-mode payoff: (stake * multiplier) + stake (i.e., returns stake plus profit)
    // Fixed-mode payoff: stake * multiplier (profit only)
    function payoffForHit(question, stake, oddsDecimal, poolConfig) {
        const alloc = isAllocationMode(poolConfig);
        const mult = question.payoffMultiplier;
        if (alloc) {
            // Use payoffMultiplier; for pickContestant in allocation mode you'd typically set a multiplier too.
            // Falls back to oddsDecimal if no multiplier and a pickContestant question.
            const m = (mult !== undefined && mult !== null) ? mult : (oddsDecimal || 0);
            return Math.round(stake * m + stake);
        }
        // Fixed mode (Derby behavior)
        return payoffIfHit(question, stake, oddsDecimal);
    }

    function scoreQuestion(question, rawPick, results, contestantsById, poolConfig) {
        const alloc = isAllocationMode(poolConfig);
        const pickValue = getPickValue(rawPick);
        const allocStake = getPickStake(rawPick);
        // Stake source: allocation mode uses the per-pick stake; else effectiveStake.
        const stake = (alloc && allocStake !== null) ? allocStake : effectiveStake(question, poolConfig);
        const miss = { hit: false, payoff: 0 };

        if (pickValue === undefined || pickValue === null || pickValue === '') {
            // autoProp has no pick — needs special handling (still scoreable based on stake alone)
            if (question.kind !== 'autoProp') return miss;
        }

        // For autoProp, a player participates if they staked >0 on it; pick value is irrelevant.
        if (question.kind === 'autoProp') {
            if (alloc && stake <= 0) return miss;
            const result = deriveQuestionResult(question, poolConfig);
            if (result === undefined) return miss;
            const hit = String(result).toLowerCase() === 'yes' || result === true;
            if (!hit) return miss;
            return { hit: true, payoff: payoffForHit(question, stake, 0, poolConfig) };
        }

        const result = deriveQuestionResult(question, poolConfig);
        if (result === undefined) return miss;

        switch (question.kind) {
            case 'pickContestant': {
                if (Number(pickValue) !== Number(result)) return miss;
                const contestant = contestantsById[Number(pickValue)];
                const odds = parseOdds(contestant && contestant.odds);
                return { hit: true, payoff: payoffForHit(question, stake, odds.decimal, poolConfig) };
            }

            case 'pickInTopN': {
                if (!Array.isArray(result)) return miss;
                const pickN = question.pickN || 1;

                if (pickN === 1) {
                    // Single-pick: hit if pickValue is anywhere in the top-N
                    const found = result.some(id => Number(id) === Number(pickValue));
                    if (!found) return miss;
                    return { hit: true, payoff: payoffForHit(question, stake, 0, poolConfig) };
                }

                // Multi-pick gradient: count how many of N picks are in actual top N.
                // Multiplier = hitCount + sum(decimal_odds of hit horses). Payoff = stake × mult + stake.
                // Zero hits = $0 (full loss).
                const picksArr = Array.isArray(pickValue) ? pickValue : [pickValue];
                const cleanPicks = picksArr.filter(v => v !== null && v !== undefined && v !== '');
                if (cleanPicks.length === 0) return miss;
                // Dedupe so picking the same horse twice doesn't double-count
                const uniquePicks = Array.from(new Set(cleanPicks.map(Number)));
                let hitCount = 0;
                let oddsSum = 0;
                const resultIds = result.map(Number);
                uniquePicks.forEach(horseId => {
                    if (resultIds.includes(Number(horseId))) {
                        hitCount++;
                        const c = contestantsById[Number(horseId)];
                        oddsSum += parseOdds(c && c.odds).decimal;
                    }
                });
                if (hitCount === 0) return miss;
                const mult = hitCount + oddsSum;
                return { hit: true, payoff: Math.round(stake * mult + stake) };
            }

            case 'orderedPair': {
                if (!Array.isArray(pickValue) || pickValue.length !== 2) return miss;
                if (!Array.isArray(result) || result.length < 2) return miss;
                if (Number(pickValue[0]) !== Number(result[0])) return miss;
                if (Number(pickValue[1]) !== Number(result[1])) return miss;
                return { hit: true, payoff: payoffForHit(question, stake, 0, poolConfig) };
            }

            case 'orderedTriple': {
                if (!Array.isArray(pickValue) || pickValue.length !== 3) return miss;
                if (!Array.isArray(result) || result.length < 3) return miss;
                const allMatch = pickValue.every((id, i) => Number(id) === Number(result[i]));
                if (!allMatch) return miss;
                return { hit: true, payoff: payoffForHit(question, stake, 0, poolConfig) };
            }

            case 'unorderedTriple': {
                if (!Array.isArray(pickValue) || pickValue.length !== 3) return miss;
                if (!Array.isArray(result) || result.length < 3) return miss;
                const pickSet = new Set(pickValue.map(Number));
                const resultSet = new Set(result.slice(0, 3).map(Number));
                if (pickSet.size !== 3 || resultSet.size !== 3) return miss;
                for (const id of pickSet) if (!resultSet.has(id)) return miss;
                return { hit: true, payoff: payoffForHit(question, stake, 0, poolConfig) };
            }

            case 'pickLongshot': {
                if (!Array.isArray(result)) return miss;
                const found = result.some(id => Number(id) === Number(pickValue));
                if (!found) return miss;
                return { hit: true, payoff: payoffForHit(question, stake, 0, poolConfig) };
            }

            case 'overUnder':
            case 'yesNo': {
                if (String(pickValue).toLowerCase() !== String(result).toLowerCase()) return miss;
                if (alloc) return { hit: true, payoff: payoffForHit(question, stake, 0, poolConfig) };
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

    // ----- Tiebreaker for allocation-mode pools -----
    // Returns the total dollars staked on bets that hit.
    // Used as the secondary sort key when two players have the same final bankroll.
    function totalWinningStake(entry, poolConfig, contestants) {
        if (!entry || !poolConfig) return 0;
        const contestantsById = {};
        (contestants || []).forEach(c => { contestantsById[Number(c.id)] = c; });
        const picks = entry.picks || {};
        let total = 0;
        for (const q of (poolConfig.questions || [])) {
            const sq = scoreQuestion(q, picks[q.id], poolConfig.results || {}, contestantsById, poolConfig);
            if (sq.hit) {
                const stake = getPickStake(picks[q.id]);
                total += (stake === null) ? effectiveStake(q, poolConfig) : stake;
            }
        }
        return total;
    }

    // ----- Tiebreaker ladder (when bankrolls tie) -----
    // Computes 4-tier tiebreaker scores. Sort cascade:
    //   bankroll desc → tier1 asc → tier2 desc → tier3 asc → coin flip
    //
    // Tier 1 (positionError):  Sum of |predicted_slot - actual_finish_pos| across all 3 trifecta picks.
    //                          Scratched/missing horses get a SCRATCH_PENALTY of 20. LOWER wins.
    // Tier 2 (exactHits):      Count of picks where predicted slot === actual finish position. HIGHER wins.
    // Tier 3 (exactaError):    Same as Tier 1 but only for first two trifecta picks (1st + 2nd). LOWER wins.
    // Tier 4: coin flip — surfaced to admin if all three tiers tie.
    //
    // Falls back to legacy setMatch/exactMatch if poolConfig.fullFinish isn't set yet.
    const TIE_SCRATCH_PENALTY = 20;

    function triCloseness(entry, poolConfig) {
        const out = {
            // Legacy fields (kept for backward compat with admin standings table)
            setMatch: 0,
            exactMatch: 0,
            // New ladder fields
            tier1: Infinity,
            tier2: 0,
            tier3: Infinity,
            usedFullFinish: false
        };
        if (!entry || !poolConfig) return out;
        const picks = entry.picks || {};
        const questions = poolConfig.questions || [];
        const results = poolConfig.results || {};

        const triQ = questions.find(q => q.kind === 'orderedTriple');
        if (!triQ) return out;
        const triPick = picks[triQ.id];
        if (!Array.isArray(triPick)) return out;
        const pickIds = triPick.map(Number);

        // --- New ladder math (uses fullFinish if available) ---
        const fullFinish = Array.isArray(poolConfig.fullFinish) ? poolConfig.fullFinish.map(Number) : null;
        if (fullFinish && fullFinish.length > 0) {
            out.usedFullFinish = true;
            const posByHorse = {};
            fullFinish.forEach((id, idx) => { posByHorse[id] = idx + 1; }); // 1-indexed

            let posErrorSum = 0;
            let exactaErrorSum = 0;
            let exactHits = 0;
            for (let slotIdx = 0; slotIdx < pickIds.length; slotIdx++) {
                const horse = pickIds[slotIdx];
                const predictedSlot = slotIdx + 1;
                const actualPos = posByHorse[horse];
                const err = (actualPos === undefined) ? TIE_SCRATCH_PENALTY : Math.abs(predictedSlot - actualPos);
                posErrorSum += err;
                if (slotIdx < 2) exactaErrorSum += err;
                if (actualPos === predictedSlot) exactHits++;
            }
            out.tier1 = posErrorSum;
            out.tier2 = exactHits;
            out.tier3 = exactaErrorSum;
        }

        // --- Legacy math (always computed for backward compat / display) ---
        const triResult = results[triQ.id];
        if (Array.isArray(triResult)) {
            const resultIds = triResult.map(Number).filter(n => !isNaN(n));
            const resultSet = new Set(resultIds);
            for (let i = 0; i < pickIds.length; i++) {
                if (resultSet.has(pickIds[i])) out.setMatch++;
                if (resultIds[i] !== undefined && pickIds[i] === resultIds[i]) out.exactMatch++;
            }
            // If fullFinish wasn't set, fall back to legacy for tier2 too
            if (!out.usedFullFinish) {
                out.tier2 = out.exactMatch;
            }
        }

        return out;
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

    // 60-second grace period after configured close — so a "6:00pm close" gives
    // the full 6:00 minute (locks at 6:00:59.999) rather than the instant 6:00:00 hits.
    const CLOSE_GRACE_MS = 60 * 1000;

    function isPoolOpen(poolConfig, now) {
        if (!poolConfig) return false;
        const closesAt = poolConfig.closesAt;
        if (!closesAt) return true;
        const closesMs = closesAt.toMillis ? closesAt.toMillis()
                       : closesAt.seconds ? closesAt.seconds * 1000
                       : new Date(closesAt).getTime();
        return (now || Date.now()) < closesMs + CLOSE_GRACE_MS;
    }

    // ----- Export -----
    const api = {
        QUESTION_KINDS,
        DEFAULT_STAKE,
        DEFAULT_PARLAY_LIMIT,
        DEFAULT_PAYOFF_MULTIPLIERS,
        parseOdds,
        defaultDerbyQuestions,
        defaultPreaknessQuestions,
        isAllocationMode,
        getPickValue,
        getPickStake,
        validateAllocation,
        effectiveStake,
        payoffIfHit,
        payoffForHit,
        deriveQuestionResult,
        scoreQuestion,
        scoreSlip,
        maxPossiblePayoff,
        impliedWinProbability,
        slipProbability,
        impliedOddsAgainst,
        formatOddsAgainst,
        computePnL,
        triCloseness,
        totalWinningStake,
        canLock,
        isPoolOpen
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.PoolConfig = api;
    }
})(typeof window !== 'undefined' ? window : this);
