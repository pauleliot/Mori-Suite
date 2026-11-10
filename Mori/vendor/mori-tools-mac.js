/**
 * Mori — remise à niveau des outils de bin/mac sur macOS, sans relancer l'installeur.
 *
 * La mise à jour intégrée (suite-update.js) ne touche jamais à bin/ : un Mac mis à jour par le bandeau gardait
 * les outils posés par un ancien installeur. Au démarrage du panneau (une fois, en arrière-plan) :
 *   - yt-dlp en fichier unique (yt-dlp_macos) : il se décompresse à chaque lancement et macOS revérifie alors ses
 *     bibliothèques, ~10 s par recherche, aperçu ou téléchargement. Remplacé par la version dossier
 *     (yt-dlp_macos.zip) dans bin/mac/yt-dlp_macos ; bin/mac/yt-dlp devient un script qui la lance.
 *   - FFmpeg, ffprobe et Deno en version Intel sur un Mac Apple Silicon (Rosetta) : remplacés par la version arm64.
 * Mêmes sources que « Installer Mori.command ». Chaque archive est contrôlée par l'empreinte SHA-256 publiée à
 * côté d'elle ; l'outil en place n'est remplacé (par renommage) qu'une fois le nouveau vérifié. Rien n'est fait
 * si les outils sont déjà bons, hors macOS, ou pour un outil du système (Homebrew…).
 * Journal : ~/Library/Logs/Mori-outils.log. Autonome : ni dépendance ni interface.
 */
(function () {
  'use strict';
  var node = window.cep_node;
  if (!node || typeof node.require !== 'function' || !node.process || node.process.platform !== 'darwin') return;
  var fs = node.require('fs'), path = node.require('path'), https = node.require('https'), crypto = node.require('crypto'),
    cp = node.require('child_process');
  var env = node.process.env || {};
  var DIR = decodeURIComponent(location.pathname).replace(/\/[^\/]*$/, '');
  var BIN = path.join(DIR, 'bin', 'mac');
  var LOCK = path.join(BIN, '.maj-outils');
  var YT = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
  var DENO = 'https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip';
  var FFMPEG = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/';

  function log(text) {
    try { fs.appendFileSync(path.join(env.HOME || '', 'Library', 'Logs', 'Mori-outils.log'), new Date().toISOString() + '  ' + text + '\n'); } catch (e) {}
  }
  /** Nature d'un fichier de bin/mac : 'absent', 'script', 'arm64', 'intel', 'universel' ou 'autre' */
  function kind(file) {
    var fd, b = node.Buffer.alloc(8), n = 0;
    try { fd = fs.openSync(file, 'r'); n = fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd); } catch (e) { return 'absent'; }
    if (n < 8) return 'autre';
    if (b[0] === 0x23 && b[1] === 0x21) return 'script'; // #!
    var magic = b.readUInt32BE(0);
    if (magic === 0xcafebabe || magic === 0xcafebabf) return 'universel';
    if (magic === 0xcffaedfe) { var cpu = b.readUInt32LE(4); return cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'intel' : 'autre'; }
    return 'autre';
  }
  function appleSilicon() {
    try { return String(cp.execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', timeout: 5000 })).trim() === '1'; } catch (e) { return false; }
  }
  function rm(p) {
    try {
      if (fs.lstatSync(p).isDirectory()) { fs.readdirSync(p).forEach(function (n) { rm(path.join(p, n)); }); fs.rmdirSync(p); }
      else fs.unlinkSync(p);
    } catch (e) {}
  }

  /** Télécharge url (https seulement, redirections suivies) dans toFile, ou en texte ; résout { url finale, text } */
  function get(url, toFile, hops) {
    return new Promise(function (resolve, reject) {
      if ((hops || 0) > 6) return reject(new Error('trop de redirections'));
      if (!/^https:\/\//.test(url)) return reject(new Error('adresse non sécurisée'));
      var rq = https.get(url, { headers: { 'User-Agent': 'Mori-outils' }, timeout: 60000 }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), toFile, (hops || 0) + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        if (toFile) {
          var out = fs.createWriteStream(toFile);
          res.pipe(out);
          res.on('error', reject);
          out.on('finish', function () { out.close(function () { resolve({ url: url }); }); });
          out.on('error', reject);
        } else {
          var chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () { resolve({ url: url, text: node.Buffer.concat(chunks).toString('utf8') }); });
        }
      });
      rq.on('timeout', function () { rq.destroy(new Error('délai dépassé')); });
      rq.on('error', reject);
    });
  }
  function sha256(file) {
    return new Promise(function (resolve, reject) {
      var h = crypto.createHash('sha256'), s = fs.createReadStream(file);
      s.on('data', function (c) { h.update(c); });
      s.on('end', function () { resolve(h.digest('hex')); });
      s.on('error', reject);
    });
  }
  /** Empreinte attendue de name dans une liste « <sha256>  <nom> » (une ou plusieurs lignes) */
  function expected(sums, name) {
    var lines = String(sums).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(lines[i].trim());
      if (m && m[2].trim() === name) return m[1].toLowerCase();
    }
    return '';
  }
  function unzip(zip, dest) {
    return new Promise(function (resolve, reject) {
      var ch = cp.spawn('/usr/bin/ditto', ['-x', '-k', zip, dest]);
      ch.on('error', reject);
      ch.on('close', function (code) { if (code === 0) resolve(dest); else reject(new Error('archive illisible')); });
    });
  }
  /**
   * Télécharge l'archive zipUrl, contrôle son empreinte (sumsFor(url finale) → { url, name } de la liste
   * d'empreintes), la décompresse dans un dossier temporaire de bin/mac (même disque : le renommage final est
   * immédiat) et résout ce dossier.
   */
  function fetchZip(zipUrl, sumsFor, label) {
    var tag = label + '-' + Date.now(), zip = path.join(BIN, '.maj-' + tag + '.zip'), dir = path.join(BIN, '.maj-' + tag);
    return get(zipUrl, zip).then(function (r) {
      var s = sumsFor(r.url);
      return get(s.url).then(function (sums) {
        var want = expected(sums.text, s.name);
        if (!want) throw new Error('empreinte de ' + s.name + ' introuvable');
        return sha256(zip).then(function (got) { if (got !== want) throw new Error('empreinte différente pour ' + s.name); });
      });
    }).then(function () { return unzip(zip, dir); }).then(function () { rm(zip); return dir; }, function (e) { rm(zip); rm(dir); throw e; });
  }

  // ==================== yt-dlp : fichier unique → version dossier ====================
  function upgradeYtdlp() {
    var launcher = path.join(BIN, 'yt-dlp'), folder = path.join(BIN, 'yt-dlp_macos');
    var k = kind(launcher);
    if (k !== 'arm64' && k !== 'intel' && k !== 'universel') return Promise.resolve(false); // absent, ou déjà le script
    log('yt-dlp : fichier unique (lent à démarrer), passage à la version dossier…');
    return fetchZip(YT + 'yt-dlp_macos.zip', function () { return { url: YT + 'SHA2-256SUMS', name: 'yt-dlp_macos.zip' }; }, 'yt-dlp').then(function (dir) {
      var exe = path.join(dir, 'yt-dlp_macos');
      if (kind(exe) === 'absent') { rm(dir); throw new Error('archive yt-dlp inattendue'); }
      fs.chmodSync(exe, 493); // 0755
      rm(folder);
      fs.renameSync(dir, folder);
      var tmp = launcher + '.nouveau';
      fs.writeFileSync(tmp, '#!/bin/sh\n# Mori : lance yt-dlp en version dossier (démarrage rapide sur macOS)\nexec "$(dirname "$0")/yt-dlp_macos/yt-dlp_macos" "$@"\n');
      fs.chmodSync(tmp, 493);
      fs.renameSync(tmp, launcher);
      // premier lancement (~10 s) : macOS vérifie une fois pour toutes les bibliothèques, autant le faire maintenant
      return new Promise(function (resolve) {
        cp.execFile(launcher, ['--version'], { timeout: 120000 }, function (err, out) {
          log(err ? 'yt-dlp installé, premier lancement en échec : ' + (err.message || err) : 'yt-dlp ' + String(out).trim() + ' en version dossier');
          resolve(true);
        });
      });
    });
  }

  // ==================== outils Intel → arm64 (Apple Silicon) ====================
  /** Remplace BIN/<name> par le binaire <name> de l'archive, s'il est bien arm64 */
  function swap(dir, name) {
    var fresh = path.join(dir, name);
    var k = kind(fresh);
    if (k !== 'arm64' && k !== 'universel') throw new Error(name + ' téléchargé : architecture inattendue (' + k + ')');
    fs.chmodSync(fresh, 493);
    fs.renameSync(fresh, path.join(BIN, name));
  }
  function upgradeIntel() {
    var jobs = Promise.resolve(false), changed = false;
    ['ffmpeg', 'ffprobe'].forEach(function (tool) {
      if (kind(path.join(BIN, tool)) !== 'intel') return;
      jobs = jobs.then(function () {
        log(tool + ' : version Intel, passage à la version Apple Silicon…');
        // l'empreinte est publiée à côté de l'archive, à son adresse définitive (après redirection)
        return fetchZip(FFMPEG + tool + '.zip', function (finalUrl) { return { url: finalUrl + '.sha256', name: tool + '.zip' }; }, tool);
      }).then(function (dir) { try { swap(dir, tool); } finally { rm(dir); } changed = true; log(tool + ' en version Apple Silicon'); });
    });
    if (kind(path.join(BIN, 'deno')) === 'intel') {
      jobs = jobs.then(function () {
        log('Deno : version Intel, passage à la version Apple Silicon…');
        return fetchZip(DENO, function () { return { url: DENO + '.sha256sum', name: 'deno-aarch64-apple-darwin.zip' }; }, 'deno');
      }).then(function (dir) { try { swap(dir, 'deno'); } finally { rm(dir); } changed = true; log('Deno en version Apple Silicon'); });
    }
    return jobs.then(function () { return changed; });
  }

  function run() {
    if (!fs.existsSync(BIN)) return Promise.resolve(false);
    // une seule remise à niveau à la fois (plusieurs fenêtres de Premiere, panneau rechargé) ; verrou périmé après 30 min
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs < 30 * 60 * 1000) return Promise.resolve(false);
    } catch (e) {}
    var needYt = ['arm64', 'intel', 'universel'].indexOf(kind(path.join(BIN, 'yt-dlp'))) >= 0;
    var needArm = appleSilicon() && ['ffmpeg', 'ffprobe', 'deno'].some(function (t) { return kind(path.join(BIN, t)) === 'intel'; });
    if (!needYt && !needArm) return Promise.resolve(false);
    try { fs.writeFileSync(LOCK, String(Date.now())); } catch (e) { return Promise.resolve(false); }
    // restes d'une tentative interrompue
    try { fs.readdirSync(BIN).forEach(function (n) { if (/^\.maj-.+/.test(n) && n !== '.maj-outils') rm(path.join(BIN, n)); }); } catch (e) {}
    var done = function (v) { rm(LOCK); return v; };
    return (needYt ? upgradeYtdlp() : Promise.resolve(false))
      .catch(function (e) { log('yt-dlp : remise à niveau impossible (' + (e.message || e) + '), version actuelle conservée'); })
      .then(function () { return needArm ? upgradeIntel() : false; })
      .catch(function (e) { log('outils Apple Silicon : remise à niveau impossible (' + (e.message || e) + '), versions actuelles conservées'); })
      .then(done, done);
  }

  window.MoriToolsMac = { run: run, kind: kind };
  var me = document.currentScript || {};
  if (!(me.dataset && me.dataset.manual)) setTimeout(run, 12000);
})();
