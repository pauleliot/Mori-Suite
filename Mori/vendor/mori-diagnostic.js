/**
 * Mori : rapport de diagnostic (Réglages > Configuration > « Créer un rapport de diagnostic »).
 *
 * Écrit sur le Bureau un fichier texte « Mori-diagnostic-<date>.txt » à envoyer tel quel : système, Premiere, dossiers
 * d'extensions, état de la console d'effets et de son raccourci, fin des journaux (installation, raccourci, CEP),
 * dernières erreurs du panneau. Rien n'est envoyé nulle part ; le contenu du projet n'est pas lu ; le dossier personnel
 * est remplacé par « ~ » dans les chemins.
 */
(function () {
  'use strict';
  if (window.MoriDiagnostic) return;

  // dernières erreurs du panneau, gardées dès le chargement
  var errors = [];
  function keep(text) {
    errors.push(new Date().toISOString() + '  ' + String(text).slice(0, 400));
    if (errors.length > 25) errors.shift();
  }
  window.addEventListener('error', function (e) {
    keep((e.message || 'erreur') + (e.filename ? '  (' + String(e.filename).replace(/^.*\//, '') + ':' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    keep('promesse rejetée : ' + ((e.reason && (e.reason.message || e.reason)) || ''));
  });

  var IDS = /mori|cypher|cutflow/i;

  function run() {
    var node = window.cep_node;
    if (!node || typeof node.require !== 'function') return Promise.reject(new Error('disponible seulement dans Premiere Pro'));
    var fs = node.require('fs'), path = node.require('path'), os = node.require('os'), cp = node.require('child_process');
    var proc = node.process, mac = proc.platform === 'darwin', win = proc.platform === 'win32';
    var cep = window.__adobe_cep__ || null;
    var home = os.homedir();
    var DIR = decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/[^\/]*$/, '');
    var out = [];

    function section(title) { out.push('', '==================== ' + title + ' ===================='); }
    function line(label, value) { out.push(label + ' : ' + (value === undefined || value === null || value === '' ? '(vide)' : value)); }
    function attempt(fn, fallback) { try { return fn(); } catch (e) { return fallback === undefined ? '(indisponible : ' + (e.message || e) + ')' : fallback; } }
    function sh(cmd) {
      return attempt(function () {
        return String(cp.execSync(cmd, { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
      }, '(indisponible)');
    }
    // lignes sans intérêt du journal de CEP (extensions d'autres éditeurs, télémétrie d'Adobe)
    var NOISE = /is not supported for this host|Headlights service/;
    function tail(file, n) {
      try {
        var st = fs.statSync(file), size = Math.min(st.size, 60000), buf = node.Buffer.alloc(size), fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, size, st.size - size);
        fs.closeSync(fd);
        var lines = buf.toString('utf8').split(/\r?\n/).filter(function (l) { return l.trim() && !NOISE.test(l); });
        out.push('--- ' + file + '  (' + st.size + ' octets, modifié ' + st.mtime.toISOString() + ')');
        lines.slice(-n).forEach(function (l) { out.push('    ' + l.slice(0, 500)); });
      } catch (e) {
        out.push('--- ' + file + ' : absent');
      }
    }
    function manifestVersion(dir) {
      return attempt(function () { return /ExtensionBundleVersion="([^"]+)"/.exec(fs.readFileSync(path.join(dir, 'CSXS', 'manifest.xml'), 'utf8'))[1]; }, '?');
    }
    function listExtensions(root) {
      try {
        var names = fs.readdirSync(root), ours = names.filter(function (n) {
          return (IDS.test(n) || /^(ongaku|sori|kiru)$/i.test(n)) && fs.existsSync(path.join(root, n, 'CSXS', 'manifest.xml'));
        });
        out.push(root + ' : ' + names.length + ' élément(s)');
        ours.forEach(function (n) { out.push('    ' + n + '  (version ' + manifestVersion(path.join(root, n)) + ')'); });
        if (!ours.length) out.push('    aucun panneau de la suite');
      } catch (e) {
        out.push(root + ' : absent');
      }
    }
    function evalScript(script, ms) {
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () { if (!done) { done = true; resolve('(pas de réponse en ' + ms + ' ms)'); } }, ms);
        try {
          cep.evalScript(script, function (r) { if (!done) { done = true; clearTimeout(timer); resolve(String(r)); } });
        } catch (e) { clearTimeout(timer); resolve('(erreur : ' + e + ')'); }
      });
    }
    function send(type, data) {
      var appId = 'PPRO', ext = '';
      try { appId = JSON.parse(cep.getHostEnvironment()).appId || appId; } catch (e) {}
      try { ext = cep.getExtensionId(); } catch (e) {}
      cep.dispatchEvent({ type: type, scope: 'APPLICATION', appId: appId, extensionId: ext, data: data || '' });
    }
    function dataOf(ev) {
      try { var d = typeof ev === 'string' ? JSON.parse(ev) : ev; return d && d.data !== undefined ? d.data : d; } catch (e) { return ''; }
    }
    /** État de la console d'effets : elle répond si sa page est chargée ; sinon on demande son préchargement */
    function consoleState() {
      return new Promise(function (resolve) {
        if (!cep || !cep.addEventListener) return resolve(['pont CEP absent']);
        var got = [], t0 = Date.now(), pong = false, loaded = false;
        var onPong = function (ev) { pong = true; var d = dataOf(ev); got.push('réponse en ' + (Date.now() - t0) + ' ms : ' + (typeof d === 'string' ? d : JSON.stringify(d))); };
        var onReady = function (ev) { loaded = true; got.push('page de la console chargée (« ' + dataOf(ev) + ' ») ' + (Date.now() - t0) + ' ms après la demande'); };
        cep.addEventListener('com.mori.console.pong', onPong);
        cep.addEventListener('com.mori.console.ready', onReady);
        var finish = function () {
          try { cep.removeEventListener('com.mori.console.pong', onPong); cep.removeEventListener('com.mori.console.ready', onReady); } catch (e) {}
          resolve(got);
        };
        send('com.mori.console.ping');
        setTimeout(function () {
          if (pong) return finish();
          got.push('aucune réponse : la console n\'est pas chargée (pas préchargée, ou version d\'avant la 2.12.3)');
          got.push('demande de préchargement envoyée…');
          send('com.mori.console.prewarm');
          setTimeout(function () {
            if (!loaded) got.push('la console ne s\'est pas chargée en 5 s (Premiere pas redémarré depuis la mise à jour ?)');
            else send('com.mori.console.ping');
            setTimeout(finish, loaded ? 1200 : 0);
          }, 5000);
        }, 1500);
      });
    }

    // ---------- contenu ----------
    out.push('Rapport de diagnostic Mori');
    out.push('Créé le ' + new Date().toString());

    section('Mori');
    line('Version', manifestVersion(DIR));
    line('Dossier du panneau', DIR);
    line('Copie de développement (.debug)', attempt(function () { return fs.existsSync(path.join(DIR, '.debug')) ? 'oui' : 'non'; }));
    line('Fichiers', ['app.js', 'console.html', 'hotkey.html', 'vendor/mori-console.js', 'vendor/mori-hotkey.js', 'tools/mori-hotkey-mac.js', 'tools/mori-hotkey.ps1'].map(function (f) {
      return f + ' ' + attempt(function () { return fs.statSync(path.join(DIR, f)).size + ' o'; }, 'ABSENT');
    }).join(' · '));
    line('Console dans le manifeste', attempt(function () {
      var m = fs.readFileSync(path.join(DIR, 'CSXS', 'manifest.xml'), 'utf8'), part = m.slice(m.lastIndexOf('com.mori.studio.console'));
      return 'AutoVisible=' + ((/<AutoVisible>(\w+)</.exec(part) || [])[1] || '?') + ', préchargement ' + (/com\.mori\.console\.prewarm/.test(part) ? 'prévu' : 'absent');
    }));
    line('Outils téléchargés (bin)', attempt(function () { return fs.readdirSync(path.join(DIR, 'bin')).join(', '); }, 'aucun'));
    line('Apparence partagée', attempt(function () {
      var shared = window.SuiteTheme && window.SuiteTheme.read();
      return shared ? JSON.stringify({ theme: shared.theme, font: attempt(function () { return window.SuiteTheme.font().id; }, '?') }) : 'non lue';
    }));

    section('Système');
    line('Plateforme', proc.platform + ' ' + os.release() + ' (' + os.arch() + ')');
    if (mac) line('macOS', sh('sw_vers -productVersion') + ' · ' + sh('sysctl -n machdep.cpu.brand_string'));
    else line('Processeur', attempt(function () { return os.cpus()[0].model; }));
    line('Mémoire', Math.round(os.totalmem() / 1073741824) + ' Go (libre ' + Math.round(os.freemem() / 1073741824) + ' Go)');
    line('Langue', navigator.language);
    line('Navigateur CEP', navigator.userAgent);
    line('Écran', screen.width + '×' + screen.height + ' · densité ' + window.devicePixelRatio + ' · panneau ' + window.innerWidth + '×' + window.innerHeight);

    section('Premiere et CEP');
    line('Hôte', attempt(function () {
      var h = JSON.parse(cep.getHostEnvironment());
      return h.appName + ' ' + h.appVersion + ' · langue ' + h.appLocale + ' · interface ' + h.appUILocale;
    }));
    line('Version de CEP', attempt(function () { var v = JSON.parse(cep.getCurrentApiVersion()); return v.major + '.' + v.minor + '.' + v.micro; }));
    line('Identifiant de cette fenêtre', attempt(function () { return cep.getExtensionId(); }));
    line('Node', proc.version);
    if (mac) line('PlayerDebugMode', ['11', '12', '13'].map(function (n) { return 'CSXS.' + n + '=' + sh('defaults read com.adobe.CSXS.' + n + ' PlayerDebugMode 2>/dev/null || echo absent'); }).join(' · '));
    if (win) line('PlayerDebugMode', ['11', '12', '13'].map(function (n) {
      var r = sh('reg query HKCU\\Software\\Adobe\\CSXS.' + n + ' /v PlayerDebugMode');
      return 'CSXS.' + n + '=' + ((/PlayerDebugMode\s+\S+\s+(\S+)/.exec(r) || [])[1] || 'absent');
    }).join(' · '));
    if (mac) line('Quarantaine macOS sur le panneau', sh('xattr "' + DIR + '" 2>/dev/null | tr "\\n" " "') || 'aucune');

    section('Dossiers d\'extensions');
    listExtensions(path.dirname(DIR));
    listExtensions(mac ? '/Library/Application Support/Adobe/CEP/extensions' : 'C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions');
    if (win) listExtensions('C:\\Program Files\\Common Files\\Adobe\\CEP\\extensions');

    section('Raccourci de la console');
    line('Script du raccourci chargé dans cette fenêtre', window.MoriHotkey ? 'oui' : 'non');
    if (mac) {
      line('Processus du raccourci (⌥Espace)', sh('pgrep -fl "mori-hotkey-mac" || echo "aucun"'));
      line('Fenêtres CEP de Mori', sh('pgrep -fl "CEPHtmlEngine" | grep -ci "mori" || true') + ' processus');
    } else if (win) {
      line('Processus du raccourci (Ctrl+Espace)', sh('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'powershell.exe\'\\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like \'*mori-hotkey.ps1*\' } | ForEach-Object { $_.ProcessId }) -join \',\'"') || 'aucun');
    }

    var steps = Promise.resolve();
    steps = steps.then(function () {
      section('Console d\'effets');
      return consoleState().then(function (lines) { lines.forEach(function (l) { out.push(l); }); });
    }).then(function () {
      section('Premiere (script)');
      return evalScript('(function(){try{var s=app.project?app.project.activeSequence:null;var q="?";try{app.enableQE();q=(typeof qe!=="undefined"&&qe.project)?"oui":"non";}catch(e){q="erreur "+e;}' +
        'return "version "+app.version+" · projet ouvert "+(app.project&&app.project.path?"oui":"non")+" · séquence active "+(s?"oui":"non")+" · QE "+q;}catch(e){return "erreur "+e;}})()', 6000);
    }).then(function (r) {
      out.push(r);

      section('Erreurs du panneau (depuis son ouverture)');
      if (errors.length) errors.forEach(function (e) { out.push(e); }); else out.push('aucune');

      section('Réglages enregistrés (tailles seulement)');
      attempt(function () {
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); out.push(k + ' : ' + String(localStorage.getItem(k) || '').length + ' caractères'); }
      });
      line('Mise à jour', attempt(function () { var u = JSON.parse(localStorage.getItem('suite.update.mori') || '{}'); return JSON.stringify({ verifiee: u.checkedAt ? new Date(u.checkedAt).toISOString() : null, proposee: u.pending && u.pending.version, reportee: u.snooze }); }));

      section('Journaux');
      if (mac) {
        var logs = path.join(home, 'Library', 'Logs');
        tail(path.join(logs, 'Mori-raccourci.log'), 60);
        tail(path.join(logs, 'Mori-installation.log'), 80);
        tail(path.join(logs, 'Mori-installation.log.ui'), 30);
      }
      // journaux de CEP : celui de Premiere et ceux des fenêtres de Mori
      var cepDir = mac ? path.join(home, 'Library', 'Logs', 'CSXS') : os.tmpdir();
      attempt(function () {
        var files = fs.readdirSync(cepDir).filter(function (n) { return /^CEP.*PPRO.*\.log$/i.test(n) && (IDS.test(n) || /^CEP\d+-PPRO\.log$/i.test(n)); })
          .map(function (n) { var p = path.join(cepDir, n); return { p: p, m: fs.statSync(p).mtimeMs }; })
          .sort(function (a, b) { return b.m - a.m; }).slice(0, 6);
        if (!files.length) out.push('--- aucun journal CEP dans ' + cepDir);
        files.forEach(function (f) { tail(f.p, 40); });
      });

      // ---------- écriture ----------
      var text = out.join('\n');
      if (home && home.length > 3) text = text.split(home).join('~').split(home.replace(/\\/g, '/')).join('~');
      var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var name = 'Mori-diagnostic-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.txt';
      var file = null;
      [path.join(home, 'Desktop'), home, os.tmpdir()].some(function (dir) {
        try { fs.writeFileSync(path.join(dir, name), text.replace(/\n/g, os.EOL), 'utf8'); file = path.join(dir, name); return true; } catch (e) { return false; }
      });
      if (!file) throw new Error('fichier impossible à écrire');
      // montre le fichier dans le Finder / l'Explorateur
      try {
        if (mac) cp.spawn('/usr/bin/open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
        else if (win) cp.spawn('explorer.exe', ['/select,' + file], { detached: true, stdio: 'ignore' }).unref();
      } catch (e) {}
      return { file: file, text: text };
    });
    return steps;
  }

  window.MoriDiagnostic = { run: run };
})();
