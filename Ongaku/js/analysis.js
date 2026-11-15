/**
 * Ongaku — analyse audio (Web Audio API) : forme d'onde, BPM, beats, temps forts, transitoires.
 *
 * Détection :
 *  1. décodage mono à 22,05 kHz (OfflineAudioContext) ;
 *  2. enveloppe d'attaque = flux d'énergie positif (bande grave + bande aiguë) par fenêtres de 256 éch. ;
 *  3. tempo = autocorrélation de l'enveloppe pondérée autour de 120 BPM ;
 *  4. placement des beats par programmation dynamique (Ellis 2007), qui suit les légères dérives de tempo ;
 *  5. temps forts (mesure 4/4) = phase qui concentre le plus d'énergie grave ;
 *  6. transitoires = pics de l'enveloppe au-dessus d'un seuil adaptatif.
 */
(function () {
  'use strict';

  var ANALYSIS_SR = 22050;

  /** Décode au taux demandé ; repli AIFF (non géré par Chromium) */
  // un seul contexte de décodage par fréquence : en créer un par fichier accumule des ressources audio
  var decoders = {};
  function decode(arrayBuffer, sampleRate) {
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var sr = sampleRate || ANALYSIS_SR;
    var ctx = decoders[sr] || (decoders[sr] = new Ctx(2, 1, sr));
    var head = new Uint8Array(arrayBuffer, 0, Math.min(12, arrayBuffer.byteLength));
    var isAiff = String.fromCharCode.apply(null, head.subarray(0, 4)) === 'FORM';
    if (isAiff) {
      try { return Promise.resolve(decodeAiff(arrayBuffer, ctx)); } catch (e) { return Promise.reject(e); }
    }
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  function readExtended(dv, o) {
    var exp = dv.getUint16(o) & 0x7fff, hi = dv.getUint32(o + 2), lo = dv.getUint32(o + 6);
    return (hi * Math.pow(2, 32) + lo) * Math.pow(2, exp - 16383 - 63);
  }

  function decodeAiff(ab, ctx) {
    var dv = new DataView(ab), o = 12, ch = 0, bits = 16, sr = 44100, ssnd = -1, ssndLen = 0;
    var aifc = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11)) === 'AIFC';
    var sowt = false;
    while (o + 8 <= ab.byteLength) {
      var id = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      var len = dv.getUint32(o + 4);
      if (id === 'COMM') {
        ch = dv.getUint16(o + 8); bits = dv.getUint16(o + 14); sr = readExtended(dv, o + 16);
        if (aifc) sowt = String.fromCharCode(dv.getUint8(o + 26), dv.getUint8(o + 27), dv.getUint8(o + 28), dv.getUint8(o + 29)) === 'sowt';
      } else if (id === 'SSND') { ssnd = o + 16 + dv.getUint32(o + 8); ssndLen = len - 8; }
      o += 8 + len + (len & 1);
    }
    if (!ch || ssnd < 0) throw new Error('AIFF illisible');
    var bps = bits >> 3, frames = Math.floor(ssndLen / (bps * ch));
    var buf = ctx.createBuffer(ch, frames, Math.round(sr));
    var max = Math.pow(2, bits - 1), le = sowt;
    for (var c = 0; c < ch; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < frames; i++) {
        var p = ssnd + (i * ch + c) * bps, v;
        if (bps === 2) v = dv.getInt16(p, le);
        else if (bps === 3) {
          v = le ? (dv.getUint8(p + 2) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p)
                 : (dv.getUint8(p) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p + 2);
          if (v & 0x800000) v -= 0x1000000;
        } else if (bps === 4) v = dv.getInt32(p, le);
        else v = dv.getInt8(p);
        d[i] = v / max;
      }
    }
    return buf;
  }

  /**
   * Noyau d'analyse, sans DOM : la même fonction tourne dans la page (repli) ou dans un Web Worker.
   * Elle est sérialisée telle quelle (toString) pour fabriquer le worker : ne rien y référencer d'extérieur.
   */
  function analysisCore() {
    var HOP = 256, PEAK_COUNT = 1000;

    /** Crêtes (0-255) sur PEAK_COUNT colonnes, normalisées */
    function computePeaks(mono, count) {
      count = count || PEAK_COUNT;
      var peaks = new Uint8Array(count);
      var step = mono.length / count, max = 0, i, j;
      var raw = new Float32Array(count);
      for (i = 0; i < count; i++) {
        var s = Math.floor(i * step), e = Math.min(mono.length, Math.floor((i + 1) * step));
        var m = 0, sum = 0;
        for (j = s; j < e; j++) { var v = mono[j] < 0 ? -mono[j] : mono[j]; if (v > m) m = v; sum += v * v; }
        // mélange crête / RMS : forme d'onde plus lisible (façon bibliothèques musicales)
        var rms = Math.sqrt(sum / Math.max(1, e - s));
        raw[i] = m * 0.55 + rms * 1.3;
        if (raw[i] > max) max = raw[i];
      }
      for (i = 0; i < count; i++) peaks[i] = Math.round(max > 0 ? Math.min(1, raw[i] / max) * 255 : 0);
      return peaks;
    }

    function onsetEnvelope(mono, sr) {
      var frames = Math.floor(mono.length / HOP);
      var low = new Float32Array(frames), high = new Float32Array(frames);
      // filtres un pôle : grave < ~150 Hz, aigu = différence première
      var a = Math.exp(-2 * Math.PI * 150 / sr), lp = 0, prev = 0;
      for (var f = 0; f < frames; f++) {
        var el = 0, eh = 0, base = f * HOP;
        for (var k = 0; k < HOP; k++) {
          var x = mono[base + k];
          lp = (1 - a) * x + a * lp;
          el += lp * lp;
          var d = x - prev; prev = x;
          eh += d * d;
        }
        low[f] = Math.log(1 + 1000 * el);
        high[f] = Math.log(1 + 1000 * eh);
      }
      var env = new Float32Array(frames), lowFlux = new Float32Array(frames);
      for (f = 1; f < frames; f++) {
        var dl = Math.max(0, low[f] - low[f - 1]);
        var dh = Math.max(0, high[f] - high[f - 1]);
        lowFlux[f] = dl;
        env[f] = dl * 1.4 + dh;
      }
      // retrait d'une moyenne glissante + normalisation
      var W = 16, out = new Float32Array(frames), acc = 0, i;
      for (i = 0; i < frames; i++) {
        acc += env[i];
        if (i >= W) acc -= env[i - W];
        out[i] = Math.max(0, env[i] - acc / Math.min(i + 1, W));
      }
      var mean = 0, sq = 0;
      for (i = 0; i < frames; i++) mean += out[i];
      mean /= frames || 1;
      for (i = 0; i < frames; i++) sq += (out[i] - mean) * (out[i] - mean);
      var std = Math.sqrt(sq / (frames || 1)) || 1;
      for (i = 0; i < frames; i++) out[i] /= std;
      return { env: out, lowFlux: lowFlux, fps: sr / HOP };
    }

    function estimatePeriod(env, fps) {
      var minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
      var n = Math.min(env.length, Math.floor(fps * 90)); // 90 s suffisent
      var start = Math.max(0, Math.floor((env.length - n) / 2));
      var best = -1, bestLag = Math.round(fps * 0.5), scores = [];
      for (var lag = minLag; lag <= maxLag; lag++) {
        var s = 0;
        for (var i = start; i < start + n - lag; i++) s += env[i] * env[i + lag];
        s /= (n - lag);
        var bpm = 60 * fps / lag;
        var w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
        scores[lag] = s;
        if (s * w > best) { best = s * w; bestLag = lag; }
      }
      // affinage parabolique
      var l = bestLag, y0 = scores[l - 1], y1 = scores[l], y2 = scores[l + 1];
      if (y0 !== undefined && y2 !== undefined) {
        var den = y0 - 2 * y1 + y2;
        if (den !== 0) l = bestLag + 0.5 * (y0 - y2) / den;
      }
      return l;
    }

    function trackBeats(env, period) {
      var n = env.length, alpha = 400;
      var score = new Float32Array(n), back = new Int32Array(n);
      var lo = Math.round(period / 2), hi = Math.round(period * 2);
      for (var t = 0; t < n; t++) {
        var best = 0, bi = -1;
        for (var p = t - hi; p <= t - lo; p++) {
          if (p < 0) continue;
          var dev = Math.log((t - p) / period);
          var c = score[p] - alpha * dev * dev;
          if (bi < 0 || c > best) { best = c; bi = p; }
        }
        score[t] = env[t] + (bi >= 0 ? Math.max(0, best) : 0);
        back[t] = bi >= 0 && best > 0 ? bi : -1;
      }
      // fin : meilleur score dans la dernière période
      var end = n - 1, bs = -Infinity;
      for (var e = Math.max(0, n - Math.round(period)); e < n; e++) if (score[e] > bs) { bs = score[e]; end = e; }
      var beats = [];
      for (var b = end; b >= 0; b = back[b]) { beats.push(b); if (back[b] < 0) break; }
      beats.reverse();
      // prolonge la grille vers le début si le suivi s'est arrêté trop tôt
      while (beats.length && beats[0] - period > 0) beats.unshift(Math.round(beats[0] - period));
      return beats;
    }

    function median(arr) {
      var a = arr.slice().sort(function (x, y) { return x - y; });
      return a.length ? a[Math.floor(a.length / 2)] : 0;
    }

    function pickTransients(env, fps) {
      var out = [], minGap = Math.round(fps * 0.09), last = -minGap;
      var W = Math.round(fps * 0.5);
      for (var i = 1; i < env.length - 1; i++) {
        if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
        var s = Math.max(0, i - W), e = Math.min(env.length, i + W), m = 0;
        for (var j = s; j < e; j++) m += env[j];
        m /= (e - s);
        if (env[i] > 1.6 && env[i] > m * 2.2 && i - last >= minGap) { out.push(i); last = i; }
      }
      return out;
    }

    function r3(x) { return Math.round(x * 1000) / 1000; }

    /** Analyse d'un signal mono : crêtes seules (SFX) ou crêtes + BPM + beats + transitoires */
    function analyzeMono(mono, sr, duration, peaksOnly) {
      var result = { duration: r3(duration), peaks: computePeaks(mono, PEAK_COUNT), bpm: 0, beats: [], downbeat: 0, transients: [] };
      if (peaksOnly || duration < 3) return result;
      var o = onsetEnvelope(mono, sr);
      var period = estimatePeriod(o.env, o.fps);
      var frames = trackBeats(o.env, period);
      var intervals = [];
      for (var i = 1; i < frames.length; i++) intervals.push(frames[i] - frames[i - 1]);
      // moyenne des intervalles proches de la médiane : précision sub-trame (les beats sont quantifiés à ~11 ms)
      var med = median(intervals) || period, sum = 0, cnt = 0;
      intervals.forEach(function (iv) { if (Math.abs(iv - med) <= med * 0.15) { sum += iv; cnt++; } });
      var bpm = 60 * o.fps / (cnt ? sum / cnt : med);
      if (Math.abs(bpm - Math.round(bpm)) < 0.35) bpm = Math.round(bpm); // BPM « propre » si proche d'un entier
      // temps fort : phase (0-3) dont les beats portent le plus d'attaques graves
      var phaseScore = [0, 0, 0, 0];
      frames.forEach(function (f, k) {
        var s = 0;
        for (var d = -2; d <= 2; d++) s += o.lowFlux[f + d] || 0;
        phaseScore[k % 4] += s;
      });
      result.bpm = Math.round(bpm * 10) / 10;
      result.beats = frames.map(function (f) { return r3(f / o.fps); });
      result.downbeat = phaseScore.indexOf(Math.max.apply(null, phaseScore));
      result.transients = pickTransients(o.env, o.fps).map(function (f) { return r3(f / o.fps); });
      return result;
    }

    /**
     * WAV PCM lu directement (sans décodeur) : mono décimé vers ~22 kHz par moyenne des échantillons.
     * Entiers 8 / 16 / 24 / 32 bits et flottants 32 bits. null si ce n'est pas un WAV PCM lisible ainsi.
     */
    function wavToMono(ab) {
      if (ab.byteLength < 44) return null;
      var dv = new DataView(ab), tag = function (o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); };
      if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
      var o = 12, fmt = null, dataOff = -1, dataLen = 0;
      while (o + 8 <= ab.byteLength) {
        var id = tag(o), len = dv.getUint32(o + 4, true);
        if (id === 'fmt ') {
          var code = dv.getUint16(o + 8, true);
          if (code === 0xFFFE && len >= 26) code = dv.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE : sous-format
          fmt = { code: code, ch: dv.getUint16(o + 10, true), sr: dv.getUint32(o + 12, true), align: dv.getUint16(o + 20, true), bits: dv.getUint16(o + 22, true) };
        } else if (id === 'data') { dataOff = o + 8; dataLen = Math.min(len || 0xFFFFFFFF, ab.byteLength - dataOff); break; }
        o += 8 + len + (len & 1);
      }
      if (!fmt || dataOff < 0 || !fmt.ch || !fmt.sr || !fmt.align) return null;
      var bps = fmt.bits >> 3, isFloat = fmt.code === 3;
      if (!(fmt.code === 1 || isFloat) || (isFloat && bps !== 4) || (!isFloat && [1, 2, 3, 4].indexOf(bps) < 0)) return null;
      if (fmt.align !== bps * fmt.ch) return null;
      var frames = Math.floor(dataLen / fmt.align), ch = fmt.ch;
      var dec = Math.max(1, Math.floor(fmt.sr / 22050)), n = Math.floor(frames / dec), mono = new Float32Array(n), norm = 1 / (dec * ch);
      var i, k, p, acc, cnt = dec * ch;
      if (bps === 2 && dataOff % 2 === 0) {            // cas le plus courant : lecture directe en Int16
        var i16 = new Int16Array(ab, dataOff, frames * ch), q = 0;
        for (i = 0; i < n; i++) { acc = 0; for (k = 0; k < cnt; k++) acc += i16[q++]; mono[i] = acc * norm / 32768; }
      } else {
        p = dataOff;
        for (i = 0; i < n; i++) {
          acc = 0;
          for (k = 0; k < cnt; k++) {
            if (isFloat) acc += dv.getFloat32(p, true);
            else if (bps === 2) acc += dv.getInt16(p, true) / 32768;
            else if (bps === 3) acc += (((dv.getInt8(p + 2) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p))) / 8388608;
            else if (bps === 4) acc += dv.getInt32(p, true) / 2147483648;
            else acc += (dv.getUint8(p) - 128) / 128;
            p += bps;
          }
          mono[i] = acc * norm;
        }
      }
      return { mono: mono, sr: fmt.sr / dec, duration: frames / fmt.sr };
    }

    return { analyzeMono: analyzeMono, wavToMono: wavToMono, computePeaks: computePeaks, PEAK_COUNT: PEAK_COUNT };
  }
  var core = analysisCore();

  // ---------- Web Worker : l'analyse ne fige plus l'interface ----------
  var worker = null, workerDead = false, jobs = {}, jobSeq = 0;
  function getWorker() {
    if (worker || workerDead) return worker;
    try {
      var src = 'var core=(' + analysisCore.toString() + ')();' +
        'onmessage=function(e){var m=e.data,r=null,err=null;try{' +
        'if(m.kind==="wav"){var w=core.wavToMono(m.buffer);r=w?core.analyzeMono(w.mono,w.sr,w.duration,m.peaksOnly):null;}' +
        'else r=core.analyzeMono(m.mono,m.sr,m.duration,m.peaksOnly);' +
        '}catch(x){err=String(x&&x.message||x);}' +
        'postMessage({id:m.id,result:r,error:err},r&&r.peaks?[r.peaks.buffer]:[]);};';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = function (e) {
        var j = jobs[e.data.id];
        if (!j) return;
        delete jobs[e.data.id];
        if (e.data.error) j.reject(new Error(e.data.error)); else j.resolve(e.data.result);
      };
      worker.onerror = function () { // worker indisponible (politique du navigateur…) : repli dans la page
        workerDead = true; worker = null;
        Object.keys(jobs).forEach(function (id) { var j = jobs[id]; delete jobs[id]; j.fallback(); });
      };
    } catch (e) { workerDead = true; worker = null; }
    return worker;
  }
  /** Envoie un travail au worker ; `local` le refait dans la page si le worker n'existe pas ou tombe */
  function runJob(msg, transfer, local) {
    return new Promise(function (resolve, reject) {
      var again = function () { try { resolve(local()); } catch (e) { reject(e); } };
      var w = getWorker();
      if (!w) return again();
      msg.id = ++jobSeq;
      jobs[msg.id] = { resolve: resolve, reject: reject, fallback: again };
      try { w.postMessage(msg, transfer); } catch (e) { delete jobs[msg.id]; again(); }
    });
  }

  function mixDown(buffer) {
    var n = buffer.length, ch = buffer.numberOfChannels;
    var out = new Float32Array(n);
    for (var c = 0; c < ch; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < n; i++) out[i] += d[i];
    }
    if (ch > 1) for (var j = 0; j < n; j++) out[j] /= ch;
    return out;
  }
  /** Mono pour l'analyse : sous-échantillonné ×2 au-delà de 32 kHz */
  function analysisMono(buffer) {
    var mono = mixDown(buffer);
    if (buffer.sampleRate <= 32000) return { mono: mono, sr: buffer.sampleRate };
    var half = new Float32Array(mono.length >> 1);
    for (var h = 0; h < half.length; h++) half[h] = (mono[2 * h] + mono[2 * h + 1]) * 0.5;
    return { mono: half, sr: buffer.sampleRate / 2 };
  }

  /** AudioBuffer déjà décodé → analyse dans le worker (dans la page si le worker est indisponible) */
  function analyzeBuffer(buffer, peaksOnly) {
    var m = analysisMono(buffer), duration = buffer.duration;
    // le signal est transféré au worker (plus lisible ici ensuite) : le repli le recalcule depuis le buffer
    return runJob({ kind: 'mono', mono: m.mono, sr: m.sr, duration: duration, peaksOnly: !!peaksOnly }, [m.mono.buffer], function () {
      var again = m.mono.length ? m : analysisMono(buffer);
      return core.analyzeMono(again.mono, again.sr, duration, peaksOnly);
    });
  }

  function isWav(ab) {
    if (ab.byteLength < 12) return false;
    var h = new Uint8Array(ab, 0, 12);
    return h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x41 && h[10] === 0x56 && h[11] === 0x45;
  }

  /**
   * Analyse complète d'un fichier. WAV PCM : lu directement, sans décodage ni rééchantillonnage.
   * Autres formats (MP3, M4A, FLAC, AIFF…) : décodés par le navigateur puis analysés.
   * peaksOnly (SFX) : forme d'onde et durée seulement.
   */
  function analyze(arrayBuffer, peaksOnly) {
    var viaDecoder = function (ab) { return decode(ab, ANALYSIS_SR).then(function (b) { return analyzeBuffer(b, peaksOnly); }); };
    if (!isWav(arrayBuffer)) return viaDecoder(arrayBuffer);
    if (!getWorker()) {
      var w = core.wavToMono(arrayBuffer);
      return w ? Promise.resolve(core.analyzeMono(w.mono, w.sr, w.duration, peaksOnly)) : viaDecoder(arrayBuffer);
    }
    // le worker reçoit une copie : l'original reste disponible si le WAV n'est pas du PCM simple (ADPCM, 64 bits…)
    var copy = arrayBuffer.slice(0);
    return runJob({ kind: 'wav', buffer: copy, peaksOnly: !!peaksOnly }, [copy], function () {
      var w2 = core.wavToMono(arrayBuffer);
      return w2 ? core.analyzeMono(w2.mono, w2.sr, w2.duration, peaksOnly) : null;
    }).then(function (res) { return res || viaDecoder(arrayBuffer); });
  }

  window.OngakuAnalysis = {
    analyze: analyze,
    analyzeBuffer: analyzeBuffer,
    decode: decode,
    mixDown: mixDown,
    computePeaks: core.computePeaks,
    PEAK_COUNT: core.PEAK_COUNT
  };
})();
