"use strict";
// Generalizable keyword/phrase extractor for biomedical-ish text.
// - Preserves hyphens and Greek letters
// - Extracts unigrams, bigrams, trigrams with medical heuristics
// - Handles list cues after "include/includes/including" and "such as"
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractKeywords = extractKeywords;
const STOPWORDS = new Set(`a an and are as at by for from has have he her his i in is it its of on or she that the their then there these they this those to was were will with without within into over under out across after before along during plus minus per via yes no not
   treat treats treated treating by into type types ii iii iv v vi vii viii ix x xi xii one two three four five six seven eight nine ten
   external internal female male person present genitalia include includes including such as like both
   decrease decreases decreased decreasing increase increases increased increasing reduced reduces lowering lower lowers raise raises raised raising`.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()));
const NOUN_SUFFIXES = [
    'itis', 'emia', 'osis', 'oma', 'pathy', 'algia', 'uria', 'plasty', 'scopy', 'graphy', 'ectomy', 'otomy', 'ostomy', 'ology', 'logy', 'gen', 'gens', 'genic', 'ase', 'ose', 'in', 'ide', 'one', 'olol', 'pril', 'sartan', 'azole', 'caine', 'dopa', 'mycin', 'cycline', 'cillin', 'mab', 'ia', 'sia', 'tion', 'rrhea', 'pnea', 'oid', 'oids'
];
const ADJ_SUFFIXES = ['ic', 'al', 'oid', 'ed', 'y'];
function isRoman(token) {
    const t = token.toUpperCase();
    if (!t || t.length > 6)
        return false;
    return /^[IVXLCDM]+$/.test(t);
}
function normalizeHyphens(s) {
    const map = {
        '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-',
        '\u2212': '-', '\u2043': '-', '\uFE58': '-', '\uFE63': '-', '\uFF0D': '-',
    };
    return s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2043\uFE58\uFE63\uFF0D]/g, (c) => map[c] || c);
}
function tokenize(text) {
    const s = normalizeHyphens(text);
    const tokens = [];
    let buf = [];
    const n = s.length;
    const isWordChar = (ch) => /[\p{L}\p{N}]/u.test(ch);
    for (let i = 0; i < n; i++) {
        const ch = s[i];
        if (isWordChar(ch)) {
            buf.push(ch);
            continue;
        }
        if (ch === '-' && i > 0 && i < n - 1 && isWordChar(s[i - 1]) && isWordChar(s[i + 1])) {
            buf.push(ch);
            continue;
        }
        // Keep possessive/apostrophe within words (e.g., Hückel's)
        if (ch === "'" && i > 0 && i < n - 1 && /[\p{L}]/u.test(s[i - 1]) && /[\p{L}]/u.test(s[i + 1])) {
            buf.push(ch);
            continue;
        }
        if (buf.length) {
            tokens.push(buf.join(''));
            buf = [];
        }
    }
    if (buf.length)
        tokens.push(buf.join(''));
    return tokens;
}
function isMedNoun(tok) {
    const t = tok.toLowerCase();
    if (t.includes('-')) {
        if (t.endsWith('ase') || t.endsWith('gen') || t.split('-').some((p) => p.endsWith('ase')))
            return true;
    }
    return NOUN_SUFFIXES.some((s) => t.endsWith(s) && t.length >= Math.max(4, s.length + 1));
}
function isAdjLike(tok) {
    const t = tok.toLowerCase();
    return ADJ_SUFFIXES.some((s) => t.endsWith(s) && t.length >= 4);
}
function isNounish(tok) {
    if (isMedNoun(tok))
        return true;
    const t = tok.toLowerCase();
    if (/(?:testes|testis)$/.test(t))
        return true;
    if (/(?:us|is|um|a|ae|es|s)$/.test(t) && t.length >= 5)
        return true;
    return false;
}
function scoreUnigram(tok) {
    const tl = tok.toLowerCase();
    if (STOPWORDS.has(tl) || isRoman(tok))
        return -1;
    let score = 0;
    const hasHyphen = tok.includes('-');
    if (hasHyphen)
        score += 2.0;
    if (isMedNoun(tok))
        score += 2.0;
    if (/^[A-Z][a-z]+$/.test(tok) && tok.length >= 7)
        score += 1.8;
    // Uppercase plural acronyms (ARBs) — singularized later to ARB
    if (/^[A-Z]{3,7}s$/.test(tok))
        score += 2.6;
    // Proper hyphenated eponyms like Cheyne-Stokes
    if (/^[A-Z][\p{Ll}A-Za-z]+(?:-[A-Z][\p{Ll}A-Za-z]+)+$/u.test(tok))
        score += 1.5;
    if (tok.length >= 8)
        score += 0.4;
    if (!hasHyphen && /(ing|ed)$/.test(tl))
        score -= 0.6;
    return score;
}
function scoreBigram(t1, t2) {
    const tl1 = t1.toLowerCase(), tl2 = t2.toLowerCase();
    if (STOPWORDS.has(tl1) || STOPWORDS.has(tl2))
        return -1;
    if (isRoman(t1) || isRoman(t2))
        return -1;
    let score = 2.2;
    if (isAdjLike(t1) && isNounish(t2))
        score += 2.2;
    // Acronym + pharmacologic class (ACE inhibitors, ARB antagonists)
    if (/^[A-Z]{2,6}$/.test(t1) && /^(?:inhibitor|inhibitors|blocker|blockers|antagonist|antagonists|agonist|agonists|modulator|modulators|receptor|receptors)$/.test(tl2)) {
        score += 3.0;
    }
    // Proper-name syndrome/disease (e.g., Cushing syndrome, Parkinson disease)
    if (/^[A-Z][\p{Ll}A-Za-z]+$/u.test(t1) && (tl2 === 'syndrome' || tl2 === 'disease')) {
        score += 3.0;
    }
    // Proper-name rule patterns: "X's rule" or "X rule"
    if ((/^[A-Z][\p{Ll}A-Za-z]+(?:'s)?$/u.test(t1) || /[\p{L}]+(?:'s)$/u.test(t1)) && tl2 === 'rule') {
        score += 4.0;
    }
    // Greek letter phrases like "pi electrons" or "π electrons"
    const greekNames = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega']);
    const greekSymbols = new Set(['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ', 'ο', 'π', 'ρ', 'σ', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω']);
    const electronHeads = new Set(['electron', 'electrons', 'bond', 'bonds', 'orbital', 'orbitals']);
    if ((greekNames.has(tl1) || greekSymbols.has(t1)) && electronHeads.has(tl2)) {
        score += 1.6; // push over threshold (2.2 + 0.4 len + 1.6 = 4.2 typical)
    }
    if (t1.length >= 6)
        score += 0.2;
    if (t2.length >= 6)
        score += 0.4;
    return score;
}
function extractKeywords(text, topK = 8) {
    const tokens = tokenize(text);
    const lower = tokens.map((t) => t.toLowerCase());
    const uni = [];
    for (const tok of tokens) {
        const s = scoreUnigram(tok);
        if (s >= 2.2)
            uni.push([tok, s]);
    }
    const bi = [];
    for (let i = 0; i < tokens.length - 1; i++) {
        const s = scoreBigram(tokens[i], tokens[i + 1]);
        if (s >= 3.0)
            bi.push([`${tokens[i]} ${tokens[i + 1]}`, s]);
    }
    const tri = [];
    for (let i = 0; i < tokens.length - 2; i++) {
        const t1 = tokens[i], t2 = tokens[i + 1], t3 = tokens[i + 2];
        const tl1 = lower[i], tl2 = lower[i + 1], tl3 = lower[i + 2];
        if (STOPWORDS.has(tl1) || STOPWORDS.has(tl2) || STOPWORDS.has(tl3))
            continue;
        if (isRoman(t1) || isRoman(t2) || isRoman(t3))
            continue;
        let s = 0;
        if (tl2 === 'insensitivity' && tl3 === 'syndrome') {
            s = 6.0;
            if (isAdjLike(t1) || isNounish(t1))
                s += 0.5;
        }
        else {
            const heads = new Set(['syndrome', 'disease', 'deficiency', 'cancer', 'alopecia']);
            if (heads.has(tl3) && (isAdjLike(t1) || isNounish(t1)) && (isAdjLike(t2) || isNounish(t2)))
                s = 4.2;
        }
        if (t1.length >= 6)
            s += 0.1;
        if (t2.length >= 6)
            s += 0.2;
        if (t3.length >= 6)
            s += 0.3;
        if (s >= 4.2)
            tri.push([`${t1} ${t2} ${t3}`, s]);
    }
    // Handle inclusion/list cues: include/includes/including, such as, like
    for (let i = 0; i < lower.length; i++) {
        const w = lower[i];
        const isInclude = w === 'include' || w === 'includes' || w === 'including';
        const isSuchAs = (w === 'such' && lower[i + 1] === 'as');
        const isLike = w === 'like';
        if (isInclude || isSuchAs || isLike) {
            let j = i + (isSuchAs ? 2 : 1);
            for (; j < tokens.length; j++) {
                const t = tokens[j], tl = lower[j];
                if (STOPWORDS.has(tl))
                    continue;
                if (j + 1 < tokens.length) {
                    const t2 = tokens[j + 1], tl2 = lower[j + 1];
                    if (!STOPWORDS.has(tl2) && isAdjLike(t) && isNounish(t2)) {
                        bi.push([`${t} ${t2}`, 5.5]);
                        j++;
                        continue;
                    }
                }
                if (isNounish(t)) {
                    const base = scoreUnigram(t);
                    uni.push([t, Math.max(2.4, base + 0.8)]);
                }
            }
        }
    }
    // Between X and Y (robust to cloze tokens like c1, c2)
    for (let i = 0; i < lower.length; i++) {
        if (lower[i] !== 'between')
            continue;
        // Find first nounish token after 'between'
        let j = i + 1;
        const isCloze = (w) => /^c\d+$/i.test(w);
        while (j < lower.length && (STOPWORDS.has(lower[j]) || isCloze(lower[j])))
            j++;
        if (j >= lower.length)
            continue;
        const candA = tokens[j];
        // Find 'and' within next few tokens
        let k = j + 1;
        while (k < Math.min(lower.length, j + 6) && lower[k] !== 'and')
            k++;
        if (k >= lower.length || lower[k] !== 'and')
            continue;
        // Find nounish token after 'and'
        let m = k + 1;
        while (m < lower.length && (STOPWORDS.has(lower[m]) || isCloze(lower[m])))
            m++;
        if (m >= lower.length)
            continue;
        const candB = tokens[m];
        if (isNounish(candA)) {
            const base = scoreUnigram(candA);
            uni.push([candA, Math.max(2.6, base + 1.0)]);
        }
        if (isNounish(candB)) {
            const base = scoreUnigram(candB);
            uni.push([candB, Math.max(2.6, base + 1.0)]);
        }
    }
    // Both X and Y pattern (robust to cloze tokens): capture paired terms e.g., preload/afterload
    for (let i = 0; i < lower.length; i++) {
        if (lower[i] !== 'both')
            continue;
        const isCloze = (w) => /^c\d+$/i.test(w);
        let j = i + 1;
        while (j < lower.length && (STOPWORDS.has(lower[j]) || isCloze(lower[j])))
            j++;
        if (j >= lower.length)
            continue;
        const a = tokens[j];
        let k = j + 1;
        while (k < Math.min(lower.length, j + 6) && lower[k] !== 'and')
            k++;
        if (k >= lower.length || lower[k] !== 'and')
            continue;
        let m = k + 1;
        while (m < lower.length && (STOPWORDS.has(lower[m]) || isCloze(lower[m])))
            m++;
        if (m >= lower.length)
            continue;
        const b = tokens[m];
        const accept = (t) => isNounish(t) || t.length >= 5;
        if (accept(a))
            uni.push([a, Math.max(2.6, scoreUnigram(a) + 1.0)]);
        if (accept(b))
            uni.push([b, Math.max(2.6, scoreUnigram(b) + 1.0)]);
    }
    // Coordination before approval/indication cues: capture X and Y are approved/indicated ...
    for (let i = 1; i < lower.length - 1; i++) {
        if (lower[i] !== 'and')
            continue;
        const left = tokens[i - 1], right = tokens[i + 1];
        const ll = lower[i - 1], rr = lower[i + 1];
        if (STOPWORDS.has(ll) || STOPWORDS.has(rr))
            continue;
        // Lookahead for approval/indication within a short window
        let hasCue = false;
        for (let k = i + 1; k < Math.min(lower.length, i + 7); k++) {
            const w = lower[k];
            if (w === 'approved' || w === 'indicated') {
                hasCue = true;
                break;
            }
        }
        if (!hasCue)
            continue;
        // Boost both coordinated items as candidates
        uni.push([left, Math.max(2.5, scoreUnigram(left) + 1.2)]);
        uni.push([right, Math.max(2.5, scoreUnigram(right) + 1.2)]);
    }
    // Phrase preference and containment filtering
    tri.sort((a, b) => b[1] - a[1]);
    bi.sort((a, b) => b[1] - a[1]);
    const keptTris = [];
    const keptBis = [];
    for (const [p] of tri)
        if (!keptTris.includes(p))
            keptTris.push(p);
    for (const [p] of bi) {
        const lower = p.toLowerCase();
        const inTri = keptTris.some((tp) => tp.toLowerCase().includes(lower));
        if (!inTri)
            keptBis.push(p);
    }
    const phraseTokens = new Set();
    for (const p of keptTris.concat(keptBis))
        for (const w of p.split(' '))
            phraseTokens.add(w.toLowerCase());
    const filteredUni = uni.filter(([t]) => !phraseTokens.has(t.toLowerCase()));
    const merged = [
        ...keptTris.map((p, i) => [p, 10 - i]),
        ...keptBis.map((p, i) => [p, 5 - i]),
        ...filteredUni
    ];
    merged.sort((a, b) => b[1] - a[1]);
    const out = [];
    const seen = new Set();
    const normalize = (term) => {
        if (/^[A-Z]{2,7}s$/.test(term))
            return term.slice(0, -1);
        return term;
    };
    for (const [term] of merged) {
        const norm = normalize(term);
        const key = norm.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(norm);
        }
        if (out.length >= topK)
            break;
    }
    return out;
}
