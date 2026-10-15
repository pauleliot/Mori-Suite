/**
 * Ongaku - ExtendScript Premiere Pro (2020 -> 2026+)
 * Import des morceaux, placement sur la timeline, marqueurs de beats.
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

$.Ongaku = (function () {
    var BIN_NAME = 'Ongaku';
    var MARKER_PREFIX = 'Ongaku';
    var T = {
        noProject: 'Aucun projet ouvert',
        noSeq: 'Aucune s\u00e9quence active',
        noTrack: 'Aucune piste audio libre \u00e0 la t\u00eate de lecture',
        selectClip: 'S\u00e9lectionnez le clip musical dans la timeline (ou utilisez le mode \u00ab T\u00eate de lecture \u00bb)',
        playhead: 't\u00eate de lecture',
        notFound: 'Fichier introuvable : ',
        importFail: 'Import impossible : '
    };

    function ok(o) { o = o || {}; o.success = true; return JSON.stringify(o); }
    function fail(msg) { return JSON.stringify({ success: false, error: String(msg) }); }
    function errText(e) { return (e && e.message ? e.message : String(e)) + (e && e.line ? ' (ligne ' + e.line + ')' : ''); }

    function normPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

    function findItemByPath(item, target) {
        if (!item) return null;
        if (item.type === ProjectItemType.BIN || item.type === ProjectItemType.ROOT) {
            for (var i = 0; i < item.children.numItems; i++) {
                var found = findItemByPath(item.children[i], target);
                if (found) return found;
            }
            return null;
        }
        try {
            if (normPath(item.getMediaPath()) === target) return item;
        } catch (e) {}
        return null;
    }

    /**
     * Chutier de categorie a la racine du projet : on reutilise un chutier dont le nom contient
     * "sfx" (ex. 02_SFX) ou "musique"/"music" (ex. 01_Musique) ; sinon on le cree (binName du panneau :
     * meme nom que le dossier disque). Sans categorie : chutier "Ongaku".
     */
    function getBin(cat, binName) {
        var root = app.project.rootItem, i, c, n;
        for (i = 0; i < root.children.numItems; i++) {
            c = root.children[i];
            if (c.type !== ProjectItemType.BIN) continue;
            n = String(c.name).toLowerCase();
            if (cat === 'sfx' && n.indexOf('sfx') >= 0) return c;
            if (cat === 'music' && (n.indexOf('musique') >= 0 || n.indexOf('music') >= 0)) return c;
            if (!cat && c.name === BIN_NAME) return c;
        }
        return root.createBin(binName || (cat === 'sfx' ? 'SFX' : cat === 'music' ? 'Musique' : BIN_NAME));
    }

    /** Importe (ou retrouve) le fichier dans le chutier de sa categorie */
    function importFile(path, cat, binName) {
        var target = normPath(path);
        var existing = findItemByPath(app.project.rootItem, target);
        if (existing) return existing;
        var f = new File(path);
        if (!f.exists) throw new Error(T.notFound + path);
        var bin = getBin(cat, binName);
        app.project.importFiles([f.fsName], true, bin, false);
        var item = findItemByPath(bin, target) || findItemByPath(app.project.rootItem, target);
        if (!item) throw new Error(T.importFail + path);
        return item;
    }

    function trackIsFree(track, start, end) {
        for (var i = 0; i < track.clips.numItems; i++) {
            var c = track.clips[i];
            if (c.start.seconds < end - 0.001 && c.end.seconds > start + 0.001) return false;
        }
        return true;
    }

    /**
     * Points d'entree / sortie d'un element de projet. Selon la version de Premiere, setInPoint attend
     * des secondes ou des ticks (chaine) : on essaie les deux et on verifie avec getInPoint.
     */
    function setPoint(item, which, s) {
        var TPS = 254016000000;
        var setFn = which === 'in' ? 'setInPoint' : 'setOutPoint', getFn = which === 'in' ? 'getInPoint' : 'getOutPoint';
        var tries = [s, String(Math.round(s * TPS))];
        for (var i = 0; i < tries.length; i++) {
            try {
                item[setFn](tries[i], 4); // 4 = audio + video
                if (Math.abs(item[getFn]().seconds - s) < 0.02) return true;
            } catch (e) {}
        }
        return false;
    }
    function setInOut(item, a, b) {
        // ordre : la sortie d'abord si la nouvelle entree depasse l'ancienne sortie
        var okOut = setPoint(item, 'out', b);
        var okIn = setPoint(item, 'in', a);
        if (!okOut) okOut = setPoint(item, 'out', b);
        return okIn && okOut;
    }

    function isLocked(track) { try { return track.isLocked(); } catch (e) { return false; } }

    /** Piste ciblee si libre, sinon premiere piste audio libre ; ajoute une piste si besoin */
    function pickAudioTrack(seq, start, end) {
        var tracks = seq.audioTracks, i;
        for (i = 0; i < tracks.numTracks; i++) {
            try { if (tracks[i].isTargeted() && !isLocked(tracks[i]) && trackIsFree(tracks[i], start, end)) return tracks[i]; } catch (e) {}
        }
        for (i = 0; i < tracks.numTracks; i++) {
            if (!isLocked(tracks[i]) && trackIsFree(tracks[i], start, end)) return tracks[i];
        }
        // Aucune piste libre : on en ajoute une (API QE, non documentee)
        try {
            app.enableQE();
            var before = seq.audioTracks.numTracks;
            qe.project.getActiveSequence().addTracks(0, 0, 1, 1, before, 0, 0);
            if (seq.audioTracks.numTracks > before) return seq.audioTracks[seq.audioTracks.numTracks - 1];
        } catch (e3) {}
        return null;
    }

    return {
        ping: function () {
            return ok({ project: !!app.project, sequence: !!(app.project && app.project.activeSequence), version: app.version });
        },

        importOnly: function (path, cat, binName) {
            try {
                if (!app.project) return fail(T.noProject);
                var item = importFile(path, cat, binName);
                return ok({ name: item.name });
            } catch (e) { return fail(errText(e)); }
        },

        /** Place le fichier a la tete de lecture de la sequence active */
        insertAtPlayhead: function (path, duration, inSec, outSec, cat, binName) {
            try {
                if (!app.project) return fail(T.noProject);
                var seq = app.project.activeSequence;
                if (!seq) return fail(T.noSeq);
                var item = importFile(path, cat, binName);
                var pos = seq.getPlayerPosition().seconds;
                var hasIO = inSec !== undefined && inSec !== null && outSec !== undefined && outSec !== null && Number(outSec) > Number(inSec);
                var dur = hasIO ? Number(outSec) - Number(inSec) : (Number(duration) || 1);
                var track = pickAudioTrack(seq, pos, pos + dur);
                if (!track) return fail(T.noTrack);

                if (!hasIO) {
                    track.overwriteClip(item, pos);
                    return ok({ track: track.name, at: pos });
                }
                // In / Out du panneau : points d'entree / sortie du clip source le temps de l'insertion,
                // puis on remet ceux d'origine (le clip du chutier reste intact)
                var prevIn = null, prevOut = null;
                try { prevIn = item.getInPoint().seconds; prevOut = item.getOutPoint().seconds; } catch (e0) {}
                if (!setInOut(item, Number(inSec), Number(outSec))) return fail('Impossible d\'appliquer In / Out au clip ' + item.name);
                track.overwriteClip(item, pos);
                if (prevIn !== null && prevOut !== null && prevOut > prevIn) setInOut(item, prevIn, prevOut);
                return ok({ track: track.name, at: pos, trimmed: true });
            } catch (e) { return fail(errText(e)); }
        },

        /**
         * Pose des marqueurs de sequence.
         * beatsJson : [{t: secondes dans le morceau, down: bool}]
         * mode 'clip' : aligne sur le clip audio selectionne ; 'playhead' : debut de region a la tete de lecture.
         */
        addBeatMarkers: function (beatsJson, mode, regionStart, colorIndex, label) {
            try {
                if (!app.project) return fail(T.noProject);
                var seq = app.project.activeSequence;
                if (!seq) return fail(T.noSeq);
                var beats = eval('(' + beatsJson + ')');
                var offset, inPt = -1e9, outPt = 1e9, where = T.playhead;

                if (mode === 'clip') {
                    var sel = seq.getSelection();
                    var clip = null, i;
                    for (i = 0; sel && i < sel.length; i++) {
                        if (sel[i].mediaType === 'Audio') { clip = sel[i]; break; }
                    }
                    if (!clip && sel && sel.length) clip = sel[0];
                    if (!clip) return fail(T.selectClip);
                    offset = clip.start.seconds - clip.inPoint.seconds;
                    inPt = clip.inPoint.seconds;
                    outPt = clip.outPoint.seconds;
                    where = 'clip \u00ab ' + clip.name + ' \u00bb';
                } else {
                    offset = seq.getPlayerPosition().seconds - (Number(regionStart) || 0);
                    inPt = Number(regionStart) || 0;
                }

                var color = Number(colorIndex) || 0, count = 0;
                for (var b = 0; b < beats.length; b++) {
                    var t = beats[b].t;
                    if (t < inPt - 0.0005 || t > outPt + 0.0005) continue;
                    var m = seq.markers.createMarker(offset + t);
                    m.name = MARKER_PREFIX + (beats[b].down ? ' \u25cf' : '') + (label ? ' ' + label : '');
                    try { m.setColorByIndex(beats[b].down ? color : (color + 1) % 8); } catch (e1) {}
                    count++;
                }
                return ok({ count: count, where: where });
            } catch (e) { return fail(errText(e)); }
        },

        clearBeatMarkers: function () {
            try {
                var seq = app.project && app.project.activeSequence;
                if (!seq) return fail(T.noSeq);
                var toRemove = [];
                var m = seq.markers.getFirstMarker();
                while (m) {
                    if (String(m.name).indexOf(MARKER_PREFIX) === 0) toRemove.push(m);
                    m = seq.markers.getNextMarker(m);
                }
                for (var i = 0; i < toRemove.length; i++) seq.markers.deleteMarker(toRemove[i]);
                return ok({ count: toRemove.length });
            } catch (e) { return fail(errText(e)); }
        },

        /**
         * Marqueurs de CLIP (sur l'element de projet) : visibles sur toutes les occurrences du clip
         * dans la timeline et solidaires du clip. beatsJson : [{t: secondes dans le fichier, down: bool}]
         * Les anciens marqueurs Ongaku du clip sont remplaces.
         */
        addClipMarkers: function (path, beatsJson, colorIndex, label, cat, binName) {
            try {
                if (!app.project) return fail(T.noProject);
                var item = importFile(path, cat, binName);
                var markers = item.getMarkers();
                if (!markers) return fail('Marqueurs de clip indisponibles pour ' + item.name);
                var removed = removeOngakuMarkers(markers);
                var beats = eval('(' + beatsJson + ')');
                var color = Number(colorIndex) || 0, count = 0;
                for (var b = 0; b < beats.length; b++) {
                    var m = markers.createMarker(beats[b].t);
                    m.name = MARKER_PREFIX + (beats[b].down ? ' \u25cf' : '') + (label ? ' ' + label : '');
                    try { m.setColorByIndex(beats[b].down ? color : (color + 1) % 8); } catch (e1) {}
                    count++;
                }
                return ok({ count: count, removed: removed, name: item.name });
            } catch (e) { return fail(errText(e)); }
        },

        /**
         * Clip audio de la timeline a retravailler : le clip audio selectionne, sinon celui sous la tete
         * de lecture (pistes ciblees d'abord). Renvoie son fichier, sa piste et ses points (secondes).
         */
        getTimelineAudioClip: function (mode) {
            try {
                // mode 'selection' (surveillance du panneau) : uniquement la selection, rien = { none: true }
                var watch = mode === 'selection';
                if (!app.project) return watch ? ok({ none: true }) : fail(T.noProject);
                var seq = app.project.activeSequence;
                if (!seq) return watch ? ok({ none: true }) : fail(T.noSeq);
                var found = watch ? selectedAudioClip(seq) : (selectedAudioClip(seq) || audioClipUnderPlayhead(seq));
                var playhead = seq.getPlayerPosition().seconds;
                if (!found && watch) return ok({ none: true, playhead: playhead });
                if (!found) return fail('Aucun clip audio s\u00e9lectionn\u00e9 ni sous la t\u00eate de lecture');
                var c = found.clip, path = '';
                try { path = c.projectItem.getMediaPath(); } catch (e0) {}
                if (!path) return watch ? ok({ none: true }) : fail('Le clip \u00ab ' + c.name + ' \u00bb n\'est pas un fichier audio');
                var speed = 1;
                try { speed = c.getSpeed(); } catch (e1) {}
                return ok({
                    path: path, name: c.name, trackIndex: found.index, track: seq.audioTracks[found.index].name,
                    start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds, outPoint: c.outPoint.seconds,
                    speed: speed, how: found.how, nodeId: c.nodeId ? String(c.nodeId) : '', playhead: playhead
                });
            } catch (e) { return fail(errText(e)); }
        },

        /**
         * Remplace le clip d'origine (piste trackIndex, debut oldStart, fichier oldPath) par le rendu newPath
         * pose a newStart. Si la queue du rendu deborde sur un clip suivant de la meme piste, le rendu va
         * sur une piste libre (rien n'est ecrase) et l'original est retire.
         */
        replaceTimelineClip: function (trackIndex, oldStart, oldPath, newPath, newStart, newDuration, cat, binName) {
            try {
                if (!app.project) return fail(T.noProject);
                var seq = app.project.activeSequence;
                if (!seq) return fail(T.noSeq);
                var track = seq.audioTracks[Number(trackIndex)];
                if (!track) return fail('Piste audio introuvable');
                var target = normPath(oldPath), old = null, i;
                for (i = 0; i < track.clips.numItems; i++) {
                    var c = track.clips[i], p = '';
                    try { p = normPath(c.projectItem.getMediaPath()); } catch (e0) {}
                    if (Math.abs(c.start.seconds - Number(oldStart)) < 0.01 && p === target) { old = c; break; }
                }
                if (!old) return fail('Le clip d\'origine a \u00e9t\u00e9 d\u00e9plac\u00e9 ou supprim\u00e9 : rechargez-le avec \u00ab Utiliser le clip de la timeline \u00bb');
                var item = importFile(newPath, cat, binName);
                var start = Math.max(0, Number(newStart)), end = start + (Number(newDuration) || 1);
                // la piste d'origine est-elle libre (en dehors du clip remplace) sur toute la duree du rendu ?
                var free = true;
                for (i = 0; i < track.clips.numItems; i++) {
                    var o = track.clips[i];
                    if (o === old || (Math.abs(o.start.seconds - old.start.seconds) < 0.001 && o.name === old.name)) continue;
                    if (o.start.seconds < end - 0.001 && o.end.seconds > start + 0.001) { free = false; break; }
                }
                old.remove(false, false);
                var dest = free && !isLocked(track) ? track : pickAudioTrack(seq, start, end);
                if (!dest) return fail(T.noTrack);
                dest.overwriteClip(item, start);
                return ok({ track: dest.name, sameTrack: dest === track, at: start });
            } catch (e) { return fail(errText(e)); }
        },

        clearClipMarkers: function (path) {
            try {
                if (!app.project) return fail(T.noProject);
                var item = findItemByPath(app.project.rootItem, normPath(path));
                if (!item) return ok({ count: 0 });
                var markers = item.getMarkers();
                return ok({ count: markers ? removeOngakuMarkers(markers) : 0 });
            } catch (e) { return fail(errText(e)); }
        }
    };

    /** Index de piste audio d'un element de timeline (nodeId si disponible, sinon debut + nom) */
    function audioTrackIndexOf(seq, clip) {
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var clips = seq.audioTracks[t].clips;
            for (var j = 0; j < clips.numItems; j++) {
                var c = clips[j];
                var same = (c.nodeId && clip.nodeId) ? c.nodeId === clip.nodeId
                    : (Math.abs(c.start.seconds - clip.start.seconds) < 0.001 && c.name === clip.name);
                if (same) return t;
            }
        }
        return -1;
    }
    function selectedAudioClip(seq) {
        var sel = null;
        try { sel = seq.getSelection(); } catch (e) {}
        for (var i = 0; sel && i < sel.length; i++) {
            if (sel[i].mediaType !== 'Audio') continue;
            var idx = audioTrackIndexOf(seq, sel[i]);
            if (idx >= 0) return { clip: seq.audioTracks[idx].clips[indexInTrack(seq.audioTracks[idx], sel[i])], index: idx, how: 'selection' };
        }
        return null;
    }
    function indexInTrack(track, clip) {
        for (var j = 0; j < track.clips.numItems; j++) {
            var c = track.clips[j];
            if ((c.nodeId && clip.nodeId) ? c.nodeId === clip.nodeId : (Math.abs(c.start.seconds - clip.start.seconds) < 0.001 && c.name === clip.name)) return j;
        }
        return 0;
    }
    function audioClipUnderPlayhead(seq) {
        var pos = seq.getPlayerPosition().seconds, t, j, pass;
        // 1er passage : pistes ciblees ; 2e : toutes les pistes, de A1 vers le bas
        for (pass = 0; pass < 2; pass++) {
            for (t = 0; t < seq.audioTracks.numTracks; t++) {
                var tr = seq.audioTracks[t], targeted = false;
                try { targeted = tr.isTargeted(); } catch (e) {}
                if (pass === 0 && !targeted) continue;
                for (j = 0; j < tr.clips.numItems; j++) {
                    var c = tr.clips[j];
                    if (c.start.seconds <= pos + 0.001 && c.end.seconds > pos + 0.001) return { clip: c, index: t, how: 'playhead' };
                }
            }
        }
        return null;
    }

    function removeOngakuMarkers(markers) {
        var toRemove = [], m = markers.getFirstMarker();
        while (m) {
            if (String(m.name).indexOf(MARKER_PREFIX) === 0) toRemove.push(m);
            m = markers.getNextMarker(m);
        }
        for (var i = 0; i < toRemove.length; i++) markers.deleteMarker(toRemove[i]);
        return toRemove.length;
    }
})();
