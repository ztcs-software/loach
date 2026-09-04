# Reproducible Linux build of Loach (.deb + AppImage).
#
# This image only *builds* Loach — it does not run it. Tauri needs a desktop
# session, and the artifacts are meant to be installed on a Linux host.
# Windows artifacts come from the GitHub Actions matrix (release.yml), not
# from this image; cross-compiling Tauri to Windows from Linux is fragile
# enough that we deliberately don't try it here.
#
# Usage (PowerShell):
#   docker build -t loach-build .
#   docker run --rm -v ${PWD}/dist-linux:/out loach-build
#   # .deb  -> dist-linux/deb/
#   # AppImage -> dist-linux/appimage/
#
# The container's CMD copies the bundle tree to /out at the end of the build
# so the host volume receives only the finished artifacts, not the full
# target/ directory. The artifacts are unsigned (no updater .sig files) —
# see the CMD comment for how to sign a local build.

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH

# Tauri's Linux system deps — the same link-time set release.yml installs —
# plus the build toolchain and the few utilities the AppImage bundler shells
# out to (file, wget, xz). release.yml additionally installs `rpm` (no rpm
# bundle here) and `desktop-file-utils` (appimagetool ships its own static
# desktop-file-validate, so it is belt-and-braces there).
#
# 22.04 ON PURPOSE, and it is what release.yml builds in too (an
# `ubuntu:22.04` container on the 24.04 runner): an AppImage is only
# portable down to the glibc it was linked against, so building on the
# older base keeps the artifact running on Ubuntu 22.04 / Debian 12.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl ca-certificates git pkg-config \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
      libssl-dev libgtk-3-dev libsoup-3.0-dev \
      patchelf file wget xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Node 22, matching `node-version` in ci.yml / release.yml. Vite 8 needs
# 20.19+ or 22.12+, so 20.x from NodeSource is no longer a safe floor.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Pinned to the toolchain CI uses (dtolnay/rust-toolchain@1.88.0) rather than
# `stable`, for the same reason CI pins it: a surprise rustc release shouldn't
# be able to break a build that worked yesterday. Minimal profile — the build
# image has no use for rustfmt/clippy. Keep in step with `rust-version` in
# src-tauri/Cargo.toml.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain 1.88.0 --profile minimal

WORKDIR /src

# Warm the npm cache layer before bringing in source so editing a .tsx file
# doesn't re-download node_modules.
COPY package.json package-lock.json ./
RUN npm ci

# Same trick for cargo: copy the manifests (plus build.rs and the
# capabilities, which `COPY . .` brings in anyway) and stub out `lib.rs`
# and `main.rs` so `cargo fetch` can resolve the dependency graph into a
# cacheable layer. Cargo refuses to parse a manifest whose declared `[lib]`
# target (`loach_lib`) has no source file, so the lib stub is required.
# Nothing compiles at fetch time — build scripts included — so the stubs'
# contents don't matter.
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs ./src-tauri/
COPY src-tauri/capabilities ./src-tauri/capabilities
RUN mkdir -p src-tauri/src \
 && echo "pub fn run() {}" > src-tauri/src/lib.rs \
 && echo "fn main() { loach_lib::run(); }" > src-tauri/src/main.rs \
 && (cd src-tauri && cargo fetch) \
 && rm -rf src-tauri/src

# Real source.
COPY . .

# Build both bundles, then stage the output tree under /out so the host
# volume mount picks up only the finished installers. Using `sh -c` so the
# flags are passed through `npm run tauri -- build` cleanly and the
# post-build copy runs in the same layer.
#
# `--no-sign`: tauri.conf.json enables updater artifacts, so without it the
# CLI demands TAURI_SIGNING_PRIVATE_KEY *after* bundling and the whole
# build is lost with nothing copied to /out. Signed artifacts are
# release.yml's job. To sign a local build anyway, drop the flag and pass
# both TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD via
# `docker run -e` (without the password the CLI prompts interactively).
CMD ["sh", "-c", "npm run tauri -- build --no-sign --bundles deb,appimage && mkdir -p /out && cp -r src-tauri/target/release/bundle/. /out/"]
