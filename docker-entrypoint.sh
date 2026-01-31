#!/bin/sh
set -e

# Eliminar archivos de bloqueo que Chromium deja en el perfil para evitar
# el error "The profile appears to be in use by another Chromium process"
if [ -d "/usr/src/app/sessions" ]; then
  find /usr/src/app/sessions -type f \( -name 'SingletonLock' -o -name 'SingletonSocket' -o -name 'DevToolsActivePort' \) -print -exec rm -f {} \; || true
  # También eliminar archivos temporales de bloqueo a nivel de carpeta
  find /usr/src/app/sessions -type f -name 'LOCK' -print -exec rm -f {} \; || true
fi

exec node server.js
