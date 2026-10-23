#!/usr/bin/env bash
# Starts ProteinPaint on the discrete NVIDIA GPU (PRIME render offload). On a hybrid
# laptop Chromium otherwise picks the integrated Intel GPU.
#
# Chromium on Linux reaches the GPU through ANGLE. On its default GLX backend the
# NVIDIA driver rejects the X visual chosen for the Intel screen ("Invalid visual ID")
# and the GPU process falls back to software — no WebGL. The working path is EGL:
# NVIDIA's EGL vendor library + ANGLE on gl-egl (set in electron/main.cjs when
# PP_GPU=nvidia).
# Usage: ./scripts/launch.sh            (production build in dist/)
#        PP_DEV_URL=http://localhost:5199 ./scripts/launch.sh   (used by npm run dev)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLCHAIN="$HERE/../.toolchain/env.sh"
[ -f "$TOOLCHAIN" ] && source "$TOOLCHAIN"

if command -v nvidia-smi >/dev/null 2>&1 && [ "${PP_IGPU:-0}" != "1" ]; then
    NV_EGL=/usr/share/glvnd/egl_vendor.d/10_nvidia.json
    if [ -f "$NV_EGL" ]; then
        export __NV_PRIME_RENDER_OFFLOAD=1
        export __EGL_VENDOR_LIBRARY_FILENAMES="$NV_EGL"
        export PP_GPU=nvidia
    fi
fi

exec "$HERE/node_modules/electron/dist/electron" "$HERE" "$@"
