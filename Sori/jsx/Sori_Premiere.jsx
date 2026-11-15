/**
 * Sori - ExtendScript Premiere Pro (2022 -> 2026+)
 * Lit les proprietes animees du clip selectionne et pose les images cles calculees par le panneau.
 *
 * Premiere n'expose pas les poignees de Bezier des images cles en script : la courbe est donc posee en
 * images cles lineaires entre deux cles d'origine, qui ne sont jamais modifiees.
 *
 * IMPORTANT : ce fichier doit rester 100 % ASCII (ExtendScript le lit sans BOM) :
 * les accents des messages sont ecrits en \uXXXX.
 */
#target premierepro

if (typeof JSON !== 'object') { JSON = {}; }
if (typeof JSON.stringify !== 'function') {
    JSON.stringify = function (v) {
        var t = typeof v;
        if (v === null || v === undefined || t === 'function') return 'null';
        if (t === 'number') return isFinite(v) ? String(v) : 'null';
        if (t === 'boolean') return String(v);
        if (t === 'string') {
            return '"' + v.replace(/[\\"\x00-\x1f]/g, function (c) {
                var m = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
                return m[c] || ('\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
            }) + '"';
        }
        var out = [], i, k;
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) out.push(JSON.stringify(v[i]));
            return '[' + out.join(',') + ']';
        }
        for (k in v) {
            if (v.hasOwnProperty(k) && typeof v[k] !== 'function' && v[k] !== undefined) out.push(JSON.stringify(String(k)) + ':' + JSON.stringify(v[k]));
        }
        return '{' + out.join(',') + '}';
    };
}

$.Sori = (function () {
    var TICKS = 254016000000;
    var LINEAR = 0; // KF_Interp_Mode_Linear
    var T = {
        noProject: 'Aucun projet ouvert',
        noSeq: 'Aucune s\u00e9quence active',
        noSel: 'S\u00e9lectionnez un ou plusieurs clips vid\u00e9o dans la timeline',
        noTransform: 'Effet Transformation introuvable dans Premiere',
        clipGone: 'Clip introuvable (s\u00e9lection modifi\u00e9e ?)'
    };

    function ok(o) { o = o || {}; o.success = true; return JSON.stringify(o); }
    function fail(msg) { return JSON.stringify({ success: false, error: String(msg) }); }
    function errText(e) { return (e && e.message ? e.message : String(e)) + (e && e.line ? ' (ligne ' + e.line + ')' : ''); }

    function seqOrNull() {
        if (!app.project) return null;
        return app.project.activeSequence || null;
    }

    function mkTime(ticks) { var t = new Time(); t.ticks = String(Math.round(Number(ticks))); return t; }
    function ticksOf(t) {
        if (t === null || t === undefined) return 0;
        if (typeof t === 'number') return Math.round(t * TICKS);
        return Number(t.ticks);
    }

    // ---------- Composants & parametres ----------
    function findComp(item, matchName, re) {
        var comps = item.components, i, c;
        for (i = 0; i < comps.numItems; i++) { c = comps[i]; if (c && c.matchName === matchName) return c; }
        if (re) for (i = 0; i < comps.numItems; i++) { c = comps[i]; if (c && re.test(String(c.displayName))) return c; }
        return null;
    }
    function motionComp(item) { return findComp(item, 'AE.ADBE Motion', /^(motion|trajectoire|mouvement)$/i); }

    function compList(item) {
        var out = [];
        try { for (var i = 0; i < item.components.numItems; i++) { var c = item.components[i]; out.push(String(c.displayName) + ' [' + String(c.matchName) + ']'); } } catch (e) {}
        return out.join(', ');
    }
    /** Relit le clip dans la sequence (objet frais : la liste des effets est a jour apres un ajout QE) */
    function freshItem(seq, entry) {
        try {
            var clips = seq.videoTracks[entry.track].clips;
            for (var i = 0; i < clips.numItems; i++) if (String(clips[i].nodeId) === entry.id) return clips[i];
        } catch (e) {}
        return entry.item;
    }

    // Trajectoire : 0 Position, 1 Echelle, 2 Largeur d'echelle, 3 Echelle uniforme, 4 Rotation, 5 Point d'ancrage
    var MOTION_IDX = { position: 0, scale: 1, scaleWidth: 2, uniform: 3, rotation: 4 };
    function motionParam(item, key) {
        var c = motionComp(item);
        return c && MOTION_IDX[key] < c.properties.numItems ? c.properties[MOTION_IDX[key]] : null;
    }

    /**
     * Nom de parametre simplifie : minuscules, sans accents (y compris les accents "combinants" que Premiere
     * peut renvoyer), ponctuation remplacee par des espaces. "Hauteur d'echelle" -> "hauteur d echelle".
     */
    function norm(s) {
        s = String(s || '').toLowerCase().replace(/[\u0300-\u036f]/g, '');
        var map = { a: /[\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5]/g, e: /[\u00e8\u00e9\u00ea\u00eb]/g, i: /[\u00ec\u00ed\u00ee\u00ef]/g,
            o: /[\u00f2\u00f3\u00f4\u00f5\u00f6]/g, u: /[\u00f9\u00fa\u00fb\u00fc]/g, c: /\u00e7/g, n: /\u00f1/g, ss: /\u00df/g };
        for (var k in map) if (map.hasOwnProperty(k)) s = s.replace(map[k], k);
        return s.replace(/[^a-z0-9]+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    // ---------- Selection ----------
    /**
     * Clips video selectionnes. Lus directement sur la selection (type et piste du clip), sans parcourir
     * toute la sequence : cette lecture a lieu plusieurs fois par seconde.
     */
    function selectedVideo(seq) {
        var sel = seq.getSelection(), out = [];
        for (var i = 0; i < sel.length; i++) {
            var it = sel[i];
            if (!it) continue;
            try { if (it.mediaType !== undefined && String(it.mediaType) !== 'Video') continue; } catch (e) {}
            var id = '', track = -1;
            try { id = String(it.nodeId); } catch (e2) {}
            try { track = Number(it.parentTrackIndex); } catch (e3) {}
            if (id) out.push({ item: it, id: id, track: track });
        }
        return out;
    }

    /** Tous les clips video de la sequence, par nodeId */
    function allVideo(seq) {
        var out = {}, tracks = seq.videoTracks;
        for (var t = 0; t < tracks.numTracks; t++) {
            var clips = tracks[t].clips;
            for (var c = 0; c < clips.numItems; c++) {
                try { out[String(clips[c].nodeId)] = { item: clips[c], id: String(clips[c].nodeId), track: t }; } catch (e) {}
            }
        }
        return out;
    }

    // ---------- Effet ajoute par l'acces QE ----------
    function qeItemFor(seq, entry) {
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        if (!qs) return null;
        var qt = qs.getVideoTrackAt(entry.track);
        var start = ticksOf(entry.item.start), name = String(entry.item.name), byName = null;
        for (var i = 0; i < qt.numItems; i++) {
            var qi = qt.getItemAt(i);
            if (!qi || qi.type === 'Empty') continue;
            var qs0 = null;
            try { qs0 = Number(qi.start.ticks); } catch (e) {}
            if (qs0 === start) return qi;
            if (!byName && String(qi.name) === name) byName = qi;
        }
        return byName;
    }

    // ---------- Flou directionnel (imitation de flou de mouvement) ----------
    var BLUR_RE = /^(directional blur|flou directionnel|richtungsunscharfe|gerichteter weichzeichner|sfocatura direzionale|controllo sfocatura direzionale|desenfoque direccional)$/;
    function isBlurComp(c) {
        var mn = '', dn = '';
        try { mn = String(c.matchName); } catch (e) {}
        try { dn = String(c.displayName); } catch (e2) {}
        return /motion blur|directional/i.test(mn) || BLUR_RE.test(norm(dn));
    }
    function blurComp(item) {
        var cs = item.components;
        for (var i = 0; i < cs.numItems; i++) if (isBlurComp(cs[i])) return cs[i];
        return null;
    }
    /** Numeros des parametres de direction et de quantite du flou (par nom, sinon l'ordre de l'effet classique : 0 et 1) */
    function blurIdx(comp) {
        var out = { dir: -1, len: -1 }, ps = comp.properties;
        for (var i = 0; i < ps.numItems; i++) {
            var n = '';
            try { n = norm(ps[i].displayName); } catch (e) {}
            // Flou directionnel classique : Direction / Longueur du flou ; celui de Premiere 2025 (Impact) : Angle / Quantite
            if (out.dir < 0 && /^(direction|richtung|direzione|direccion|angle|winkel|angolo|angulo)$/.test(n)) out.dir = i;
            else if (out.len < 0 && /^(blur length|longueur du flou|longueur de flou|lange|unscharfelange|lunghezza sfocatura|longitud de desenfoque|amount|quantite|betrag|menge|quantita|cantidad)$/.test(n)) out.len = i;
        }
        if (out.dir < 0) out.dir = 0;
        if (out.len < 0 || out.len === out.dir) out.len = out.dir === 1 ? 0 : 1;
        return out;
    }
    function blurNames(seen) {
        app.enableQE();
        var out = [], add = function (n) { for (var k = 0; k < out.length; k++) if (out[k] === n) return; out.push(n); };
        try {
            var list = qe.project.getVideoEffectList(), j, n;
            if (typeof list === 'string') list = list.split(/[,\n;]/);
            for (j = 0; j < list.length; j++) {
                n = String(list[j]).replace(/^\s+|\s+$/g, '');
                if (/blur|flou|weichzeichner|unsch|sfocatura|desenfoque/i.test(n)) seen.push(n);
                if (BLUR_RE.test(norm(n))) add(n);
            }
        } catch (e) {}
        var usual = ['Directional Blur', 'Flou directionnel', 'Richtungsunsch\u00e4rfe', 'Sfocatura direzionale', 'Desenfoque direccional'];
        for (var i = 0; i < usual.length; i++) add(usual[i]);
        return out;
    }
    function ensureBlur(seq, entry) {
        var bc = blurComp(entry.item);
        if (bc) return bc;
        var qi = qeItemFor(seq, entry);
        if (!qi) throw new Error(T.clipGone);
        var seen = [], names = blurNames(seen), tries = [];
        // chaque nom est essaye, et l'ajout verifie sur le clip : un nom inconnu ne fait rien sans erreur
        for (var i = 0; i < names.length && !bc; i++) {
            var fx = null, before = freshItem(seq, entry).components.numItems;
            try { fx = qe.project.getVideoEffectByName(names[i]); } catch (e1) {}
            if (!fx) { tries.push(names[i] + ' : inconnu'); continue; }
            try { qi.addVideoEffect(fx); } catch (e2) { tries.push(names[i] + ' : ' + errText(e2)); continue; }
            try { $.sleep(40); } catch (e3) {}
            entry.item = freshItem(seq, entry);
            bc = blurComp(entry.item);
            if (!bc && entry.item.components.numItems > before) bc = entry.item.components[entry.item.components.numItems - 1];
            if (!bc) tries.push(names[i] + ' : rien ajout\u00e9');
        }
        if (!bc) {
            throw new Error('Effet Flou directionnel introuvable. Essais : ' + tries.join(', ') +
                '. Effets de flou de Premiere : ' + (seen.length ? seen.join(', ') : 'aucun') + '. Effets du clip : ' + compList(entry.item));
        }
        return bc;
    }
    /**
     * Cles [[ticks, v]] sur un parametre du flou (les autres cles du parametre sont retirees) ; liste vide :
     * parametre fixe a 0 (aucun flou). Chaque cle est ecrite a part : une cle refusee par Premiere n'empeche
     * pas les suivantes, et l'erreur est signalee avec le nom du parametre.
     */
    function writeBlur(param, keys, label, errors) {
        if (!param) { errors.push(label + ' : param\u00e8tre introuvable'); return 0; }
        if (!keys || !keys.length) {
            try { if (param.isTimeVarying()) param.setTimeVarying(false); } catch (e) {}
            try { param.setValue(0, true); } catch (e2) {}
            return 0;
        }
        try { if (!param.isTimeVarying()) param.setTimeVarying(true); } catch (e3) { errors.push(label + ' : ' + errText(e3)); return 0; }
        var wanted = {}, bad = 0, firstErr = '', i;
        // plusieurs facons d'ecrire une cle selon les effets / versions de Premiere : la premiere qui marche est gardee
        var ways = [
            function (tm, v) { param.addKey(tm); param.setValueAtKey(tm, v, true); },
            function (tm, v) { param.addKey(tm); param.setValueAtKey(tm, v); },
            function (tm, v) { param.addKey(tm.seconds); param.setValueAtKey(tm.seconds, v, true); },
            function (tm, v) { param.addKey(tm.seconds); param.setValueAtKey(tm.seconds, v); },
            function (tm, v) { param.addKey(tm); param.setValueAtKey(tm, [v], true); }
        ], way = -1;
        for (i = 0; i < keys.length; i++) {
            var t = mkTime(keys[i][0]), v = Number(keys[i][1]), done = false, w;
            if (way >= 0) { try { ways[way](t, v); done = true; } catch (e5) { if (!firstErr) firstErr = errText(e5); } }
            for (w = 0; w < ways.length && !done; w++) {
                try { ways[w](t, v); done = true; way = w; } catch (e8) { if (!firstErr) firstErr = 'essai ' + (w + 1) + ' : ' + errText(e8); }
            }
            if (!done) { bad++; continue; }
            wanted[String(ticksOf(t))] = true;
            try { param.setInterpolationTypeAtKey(t, LINEAR, true); } catch (e4) {}
        }
        var existing = null;
        try { existing = param.getKeys(); } catch (e6) {}
        // rien n'a pu etre ecrit : les anciennes cles sont laissees telles quelles
        for (i = (existing && bad < keys.length ? existing.length : 0) - 1; i >= 0; i--) {
            var old = typeof existing[i] === 'number' ? mkTime(existing[i] * TICKS) : existing[i];
            if (!wanted[String(ticksOf(old))]) { try { param.removeKey(old); } catch (e7) {} }
        }
        if (bad) {
            // diagnostic : de quel parametre il s'agit et ce que Premiere en dit
            var d = [];
            try { d.push('"' + String(param.displayName) + '"'); } catch (x1) {}
            try { var gv = param.getValue(); d.push('valeur ' + (gv && typeof gv === 'object' ? '[' + gv.length + ' nombres]' : typeof gv + ' ' + String(gv))); } catch (x2) { d.push('valeur illisible'); }
            try { d.push(param.isTimeVarying() ? 'anim\u00e9' : 'non anim\u00e9'); } catch (x3) {}
            try { d.push((existing ? existing.length : 0) + ' cl\u00e9s'); } catch (x4) {}
            try { d.push('cl\u00e9 \u00e0 ' + Math.round(keys[0][0] / Number(TICKS / 1000)) + ' ms = ' + keys[0][1]); } catch (x5) {}
            try { d.push('cl\u00e9 cr\u00e9\u00e9e : ' + (param.keyExistsAtTime(mkTime(keys[0][0])) ? 'oui' : 'non')); } catch (x6) {}
            errors.push(label + ' : ' + bad + '/' + keys.length + ' cl\u00e9s refus\u00e9es (' + firstErr + ') ; ' + d.join(', '));
        }
        return keys.length - bad;
    }

    // ---------- Sori 2 : toutes les proprietes animees du clip, cles ajoutees entre deux cles ----------
    /** Valeur exploitable par une courbe : nombre, ou couple [x, y] (position, point d'ancrage) ; sinon null */
    function curveValue(v) {
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (v && typeof v === 'object' && v.length === 2) {
            var a = Number(v[0]), b = Number(v[1]);
            return isFinite(a) && isFinite(b) ? [a, b] : null;
        }
        return null;
    }

    /**
     * 1er clip video selectionne : chaque parametre anime (2 cles au moins) de chaque effet, avec ses cles.
     * force : relecture complete ; have : numero (stamp) de la derniere lecture recue par le panneau.
     * ci / pi = numeros de l'effet et du parametre ; match = matchName de l'effet (verifie a l'ecriture).
     */
    var scanCache = null, scanCount = 0, scanStamp = 0;
    function scan(force, have) {
        try {
            var seq = seqOrNull();
            if (!seq) return ok({ seq: null, clip: null, props: [], total: 0 });
            var info = {
                name: String(seq.name), ticksPerFrame: Number(seq.timebase), playhead: ticksOf(seq.getPlayerPosition()),
                width: Number(seq.frameSizeHorizontal), height: Number(seq.frameSizeVertical)
            };
            var list = selectedVideo(seq);
            if (!list.length) { scanCache = null; return ok({ seq: info, clip: null, props: [], total: 0 }); }
            var it = list[0].item, comps = it.components, found = [], sig = String(list[0].id), ci, pi, k;
            // signature legere (temps des cles, sans les valeurs) : rien n'a bouge -> la derniere lecture est reprise
            for (ci = 0; ci < comps.numItems; ci++) {
                var ps = comps[ci].properties;
                for (pi = 0; pi < ps.numItems; pi++) {
                    var ks = null;
                    try { if (!ps[pi].isTimeVarying()) continue; ks = ps[pi].getKeys(); } catch (e) { continue; }
                    if (!ks || ks.length < 2) continue;
                    var sum = 0;
                    for (k = 0; k < ks.length; k++) sum += (typeof ks[k] === 'number' ? ks[k] * TICKS : Number(ks[k].ticks)) / 1e6;
                    sig += '|' + ci + '.' + pi + ':' + ks.length + ':' + Math.round(sum);
                    found.push({ ci: ci, pi: pi, ks: ks });
                }
            }
            var clip = { id: list[0].id, name: String(it.name), start: ticksOf(it.start), end: ticksOf(it.end), inPoint: ticksOf(it.inPoint) };
            scanCount++;
            // une lecture complete de temps en temps : une valeur de cle retouchee ne change pas la signature
            if (!force && scanCache && scanCache.sig === sig && scanCount % 5 !== 0) {
                // le panneau a deja cette lecture (meme numero) : seuls la sequence et le clip sont renvoyes
                if (have === scanCache.stamp) return ok({ seq: info, total: list.length, clip: clip, stamp: scanCache.stamp, same: true });
                return ok({ seq: info, total: list.length, props: scanCache.props, clip: clip, motion: scanCache.motion, stamp: scanCache.stamp });
            }
            var props = [];
            for (var f = 0; f < found.length; f++) {
                var comp = comps[found[f].ci], param = comp.properties[found[f].pi], keys = [], good = true;
                for (k = 0; k < found[f].ks.length && good; k++) {
                    var t = typeof found[f].ks[k] === 'number' ? mkTime(found[f].ks[k] * TICKS) : found[f].ks[k], v = null;
                    try { v = curveValue(param.getValueAtKey(t)); } catch (e2) {}
                    if (v === null) good = false; else keys.push({ t: ticksOf(t), v: v });
                }
                if (!good) continue;
                var p = { ci: found[f].ci, pi: found[f].pi, match: String(comp.matchName), comp: String(comp.displayName), name: String(param.displayName || ''), keys: keys };
                if (isBlurComp(comp)) { var bi = blurIdx(comp); p.role = found[f].pi === bi.dir ? 'dir' : found[f].pi === bi.len ? 'len' : 'fx'; }
                props.push(p);
            }
            // echelle et rotation de la Trajectoire : le flou est applique avant elles
            var motion = { scale: 100, rotation: 0 };
            try { var sv = Number(motionParam(it, 'scale').getValue()); if (isFinite(sv) && sv > 0) motion.scale = sv; } catch (e3) {}
            try { var rv = Number(motionParam(it, 'rotation').getValue()); if (isFinite(rv)) motion.rotation = rv; } catch (e4) {}
            scanCache = { sig: sig, props: props, motion: motion, stamp: ++scanStamp };
            return ok({ seq: info, total: list.length, props: props, clip: clip, motion: motion, stamp: scanStamp });
        } catch (e5) { return fail(errText(e5)); }
    }

    /**
     * plan = { id, ops: [{ ci, pi, match, t0, t1, keys: [[ticks, v]] }], blur?: { add, dir: [[ticks, v]], len: [[ticks, v]] } }
     * blur : cles du Flou directionnel, remplacees en entier (add : l'effet est ajoute s'il manque).
     * Pour chaque parametre : les cles strictement entre t0 et t1 sont retirees, puis keys sont posees (lineaires).
     * Les deux cles d'origine (t0, t1) ne sont jamais touchees.
     */
    function bake(planJson) {
        try {
            var plan = eval('(' + planJson + ')');
            var seq = seqOrNull();
            if (!seq) return fail(T.noSeq);
            var entry = allVideo(seq)[String(plan.id)];
            if (!entry) return fail(T.clipGone);
            var comps = entry.item.components, written = 0, removed = 0, errors = [], margin = Number(seq.timebase) / 4;
            for (var i = 0; i < plan.ops.length; i++) {
                var op = plan.ops[i];
                try {
                    var comp = comps[op.ci];
                    if (!comp || String(comp.matchName) !== op.match) { errors.push('Effet d\u00e9plac\u00e9 ou supprim\u00e9'); continue; }
                    var param = comp.properties[op.pi];
                    var ks = param.getKeys() || [], k;
                    for (k = ks.length - 1; k >= 0; k--) {
                        var old = typeof ks[k] === 'number' ? mkTime(ks[k] * TICKS) : ks[k], ot = ticksOf(old);
                        if (ot > op.t0 + margin && ot < op.t1 - margin) { try { param.removeKey(old); removed++; } catch (e0) {} }
                    }
                    for (k = 0; k < op.keys.length; k++) {
                        var t = mkTime(op.keys[k][0]);
                        param.addKey(t);
                        // updateUI = true a chaque ecriture : sinon l'interface et l'historique d'annulation de Premiere
                        // se desynchronisent, et un Ctrl+Z peut faire planter Premiere
                        param.setValueAtKey(t, op.keys[k][1], true);
                        try { param.setInterpolationTypeAtKey(t, LINEAR, true); } catch (e1) {}
                        written++;
                    }
                } catch (e2) { errors.push((op.name || 'Propri\u00e9t\u00e9') + ' : ' + errText(e2)); }
            }
            var blurInfo = null;
            if (plan.blur) {
                try {
                    var bc = plan.blur.add ? ensureBlur(seq, entry) : blurComp(entry.item);
                    if (bc) {
                        var bi = blurIdx(bc), before = errors.length;
                        blurInfo = { effect: String(bc.displayName), len: 0, dir: 0 };
                        blurInfo.len = writeBlur(bc.properties[bi.len], plan.blur.len, 'Flou (longueur)', errors);
                        blurInfo.dir = writeBlur(bc.properties[bi.dir], plan.blur.dir, 'Flou (direction)', errors);
                        if (errors.length > before) {
                            // effet et parametres reellement vises
                            var pn = [];
                            for (var q = 0; q < bc.properties.numItems; q++) { try { pn.push(q + ' ' + String(bc.properties[q].displayName)); } catch (ep) { pn.push(q + ' ?'); } }
                            errors.push('Effet : ' + String(bc.displayName) + ' [' + String(bc.matchName) + '], longueur n\u00b0 ' + bi.len + ', direction n\u00b0 ' + bi.dir + ', param\u00e8tres : ' + pn.join(' / '));
                        }
                    }
                } catch (eb) { errors.push('Flou : ' + errText(eb)); }
            }
            scanCache = null;
            return ok({ keys: written, removed: removed, errors: errors, blur: blurInfo });
        } catch (e3) { return fail(errText(e3)); }
    }

    // rev : a augmenter a chaque modification, le panneau recharge alors ce fichier sans redemarrer Premiere
    return { rev: 20, scan: scan, bake: bake };
})();
