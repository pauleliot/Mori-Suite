/**
 * Mori — yt-dlp rapide sous Windows, sans relancer l'installeur.
 *
 * yt-dlp.exe « en un seul fichier » (celui de l'installeur, de winget…) se décompresse dans un dossier temporaire à
 * chaque lancement, que l'antivirus réanalyse : 4 à 10 s avant chaque recherche, analyse ou téléchargement. La version
 * « dossier » (yt-dlp_win.zip, même éditeur, même version) démarre en ~0,5 s. Au démarrage du panneau (une fois, en
 * arrière-plan) elle est installée dans bin/win/yt-dlp_win ; le panneau l'utilise alors à la place de l'autre.
 * Même source que l'installeur (Releases GitHub de yt-dlp). L'archive est contrôlée par l'empreinte SHA-256 publiée
 * à côté d'elle ; la copie en place n'est remplacée (par renommage) qu'une fois la nouvelle vérifiée. Rien n'est
 * fait hors Windows, ou si la version dossier est déjà là.
 * Journal : %TEMP%\Mori-outils.log. Autonome : ni dépendance ni interface. Voir aussi mori-tools-mac.js.
 */
(function () {
  'use strict';
  var node = window.cep_node;
  if (!node || typeof node.require !== 'function' || !node.process || node.process.platform !== 'win32') return;
  var fs = node.require('fs'), path = node.require('path'), os = node.require('os'), https = node.require('https'),
    crypto = node.require('crypto'), cp = node.require('child_process');
  var env = node.process.env || {};
  var DIR = decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/[^\/]*$/, '');
  var BIN = path.join(DIR, 'bin', 'win');
  var FOLDER = path.join(BIN, 'yt-dlp_win'), EXE = path.join(FOLDER, 'yt-dlp.exe'), SINGLE = path.join(BIN, 'yt-dlp.exe');
  var LOCK = path.join(BIN, '.maj-outils');
  var YT = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

  function log(text) {
    try { fs.appendFileSync(path.join(os.tmpdir(), 'Mori-outils.log'), new Date().toISOString() + '  ' + text + '\n'); } catch (e) {}
  }
  function rm(p) {
    try {
      if (fs.lstatSync(p).isDirectory()) { fs.readdirSync(p).forEach(function (n) { rm(path.join(p, n)); }); fs.rmdirSync(p); }
      else fs.unlinkSync(p);
    } catch (e) {}
  }
  function locked() {
    try { return Date.now() - fs.statSync(LOCK).mtimeMs < 30 * 60 * 1000; } catch (e) { return false; }
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
  /** Empreinte attendue de name dans une liste « <sha256>  <nom> » */
  function expected(sums, name) {
    var lines = String(sums).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(lines[i].trim());
      if (m && m[2].trim() === name) return m[1].toLowerCase();
    }
    return '';
  }
  function spawnOk(bin, args) {
    return new Promise(function (resolve, reject) {
      var ch;
      try { ch = cp.spawn(bin, args, { windowsHide: true, stdio: 'ignore' }); } catch (e) { return reject(e); }
      ch.on('error', reject);
      ch.on('close', function (code) { if (code === 0) resolve(); else reject(new Error('code ' + code)); });
    });
  }
  /** tar.exe de Windows 10/11 (lit les zip, rapide) ; sinon PowerShell */
  function unzip(zip, dest) {
    fs.mkdirSync(dest, { recursive: true });
    var tar = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return spawnOk(tar, ['-xf', zip, '-C', dest]).catch(function () {
      return spawnOk('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + dest + '" -Force']);
    }).catch(function () { throw new Error('archive illisible'); });
  }
  function version(exe) {
    return new Promise(function (resolve) {
      cp.execFile(exe, ['--version'], { timeout: 120000, windowsHide: true }, function (err, out) { resolve(err ? '' : String(out).trim()); });
    });
  }

  /** Télécharge la dernière version dossier, la vérifie, la met en place et la lance une fois ; résout sa version */
  function installYtdlp() {
    var tag = 'yt-dlp-' + Date.now(), zip = path.join(BIN, '.maj-' + tag + '.zip'), dir = path.join(BIN, '.maj-' + tag);
    var old = FOLDER + '.ancien-' + Date.now();
    fs.mkdirSync(BIN, { recursive: true });
    return get(YT + 'yt-dlp_win.zip', zip).then(function () {
      return get(YT + 'SHA2-256SUMS');
    }).then(function (sums) {
      var want = expected(sums.text, 'yt-dlp_win.zip');
      if (!want) throw new Error('empreinte de yt-dlp_win.zip introuvable');
      return sha256(zip).then(function (got) { if (got !== want) throw new Error('empreinte différente pour yt-dlp_win.zip'); });
    }).then(function () {
      return unzip(zip, dir);
    }).then(function () {
      if (!fs.existsSync(path.join(dir, 'yt-dlp.exe'))) throw new Error('archive yt-dlp inattendue');
      // la copie en place est écartée par renommage : impossible si yt-dlp tourne, et rien n'est alors changé
      var had = fs.existsSync(FOLDER);
      if (had) {
        try { fs.renameSync(FOLDER, old); } catch (e) { throw new Error('yt-dlp est en cours d\'utilisation : réessayez dans un instant'); }
      }
      try { fs.renameSync(dir, FOLDER); } catch (e) {
        if (had) { try { fs.renameSync(old, FOLDER); } catch (e2) {} }
        throw e;
      }
      rm(old);
      rm(zip);
      // premier lancement : l'antivirus analyse les fichiers une fois pour toutes, autant le faire maintenant
      return version(EXE);
    }).then(function (v) {
      log(v ? 'yt-dlp ' + v + ' en version dossier' : 'yt-dlp installé, premier lancement en échec');
      // l'ancien fichier unique de l'installeur ne sert plus
      if (v) rm(SINGLE);
      try { window.dispatchEvent(new Event('mori-tools-changed')); } catch (e) {}
      return v;
    }, function (e) { rm(zip); rm(dir); throw e; });
  }

  /** Le yt-dlp utilisé par le panneau est-il la copie de Mori (version dossier) ? Sinon, ce module n'y touche pas */
  function ownsYtdlp(file) {
    try { return fs.realpathSync(String(file)).toLowerCase() === fs.realpathSync(EXE).toLowerCase(); } catch (e) { return false; }
  }

  /**
   * Bouton « Mettre à jour yt-dlp » : la version dossier n'a pas de mise à jour intégrée (-U). La dernière version
   * publiée se lit dans l'adresse où mène …/releases/latest ; si elle diffère, l'archive est retéléchargée.
   * Résout { updated, version }.
   */
  function updateYtdlp() {
    if (locked()) return Promise.reject(new Error('une remise à niveau des outils est déjà en cours'));
    try { fs.writeFileSync(LOCK, String(Date.now())); } catch (e) {}
    var unlock = function () { rm(LOCK); };
    var job = version(EXE).then(function (current) {
      return get('https://github.com/yt-dlp/yt-dlp/releases/latest').then(function (r) {
        var latest = decodeURIComponent(r.url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || '');
        if (current && latest && latest === current) return { updated: false, version: current };
        log('yt-dlp : mise à jour ' + (current || '?') + ' → ' + (latest || 'dernière version') + '…');
        return installYtdlp().then(function (v) { return { updated: true, version: v || latest }; });
      });
    });
    job.then(unlock, unlock);
    return job;
  }

  function run() {
    if (fs.existsSync(EXE) || locked()) return Promise.resolve(false);
    try { fs.mkdirSync(BIN, { recursive: true }); fs.writeFileSync(LOCK, String(Date.now())); } catch (e) { return Promise.resolve(false); }
    // restes d'une tentative interrompue
    try {
      fs.readdirSync(BIN).forEach(function (n) {
        if ((/^\.maj-.+/.test(n) && n !== '.maj-outils') || /^yt-dlp_win\.ancien-/.test(n)) rm(path.join(BIN, n));
      });
    } catch (e) {}
    log('yt-dlp : passage à la version dossier (démarrage rapide)…');
    var done = function (v) { rm(LOCK); return v; };
    return installYtdlp().then(function () { return true; }, function (e) {
      log('yt-dlp : installation de la version dossier impossible (' + (e.message || e) + '), version actuelle conservée');
      return false;
    }).then(done, done);
  }

  window.MoriToolsWin = { run: run, updateYtdlp: updateYtdlp, ownsYtdlp: ownsYtdlp, exe: EXE };
  var me = document.currentScript || {};
  if (!(me.dataset && me.dataset.manual)) setTimeout(run, 12000);
})();
