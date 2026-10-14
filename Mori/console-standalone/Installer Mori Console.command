#!/bin/bash
# Mori Console : installeur macOS (lancé par « Installer Mori Console.app », ou double-clic dans le Finder).
#   - autorisation des extensions non signées dans Premiere Pro (CEP 9 à 14)
#   - copie de la console dans le dossier des extensions de l'utilisateur

cd "$(dirname "$0")" || exit 1
SOURCE="$(pwd -P)"
TARGET="$HOME/Library/Application Support/Adobe/CEP/extensions/com.mori.console"

step() { printf '\n\033[36m  [%s/2] %s\033[0m\n' "$1" "$2"; }
ok()   { printf '\033[32m        OK  %s\033[0m\n' "$1"; }
info() { printf '        %s\n' "$1"; }
finish() {
  echo
  [ -n "$SUITE_AUTO" ] || read -r -p "  Appuyez sur Entrée pour fermer " _
  exit "$1"
}

[ -n "$SUITE_AUTO" ] || clear
printf '\n  Mori Console : installation dans Premiere Pro\n'
printf '  =============================================\n'

if [ -z "$SUITE_TEST" ] && pgrep -qf "Adobe Premiere Pro"; then
  printf "\n\033[33m  Premiere Pro est ouvert : fermez-le, puis relancez l'installation.\033[0m\n"
  finish 1
fi

step 1 'Autorisation de la console dans Premiere Pro'
for v in 9 10 11 12 13 14; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
ok 'extensions non signées autorisées (Premiere 2019 à 2026+)'

step 2 'Copie de la console'
if [ -d "$TARGET" ] && [ "$SOURCE" = "$(cd "$TARGET" && pwd -P)" ]; then
  ok 'console déjà en place'
else
  mkdir -p "$TARGET"
  rsync -a --delete --exclude 'installer' --exclude 'Installer Mori Console.command' ./ "$TARGET/" \
    || { printf '\033[31m        ÉCHEC  copie impossible vers %s\033[0m\n' "$TARGET"; finish 1; }
  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
  ok "copiée dans $TARGET"
fi
# Mori complet déjà là : il contient la console, Mori Console reste inactive
for m in "$HOME/Library/Application Support/Adobe/CEP/extensions"/*/CSXS/manifest.xml; do
  if grep -q 'ExtensionBundleId="com.mori.studio.panel"' "$m" 2>/dev/null; then
    info 'Mori est déjà installé et contient la console : Mori Console restera inactive.'
    break
  fi
done

printf '\n\033[32m  Installation terminée.\033[0m\n'
printf '  Ouvrez Premiere Pro : ⌥Espace ouvre la console (ou Fenêtre > Extensions > Mori Console).\n'
finish 0
