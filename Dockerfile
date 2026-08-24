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
# target/ directory.

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH

# Tauri's Linux system deps — the same set release.yml installs — plus the
# build toolchain and the few utilities the AppImage bundler shells out to
# (file, wget, xz).
#
# The base image stays on 22.04 while CI runs 24.04 ON PURPOSE: an AppImage
# is only portable down to the glibc it was linked against, so building on
# the older base widens the range of distros the local artifact runs on.
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

# Same trick for cargo: copy just the manifests + capabilities + build.rs
# and stub out both `lib.rs` and `main.rs` so `cargo fetch` can resolve
# the dependency graph into a cacheable layer. The Cargo.toml declares
# both a `[lib]` target (`loach_lib`) and an auto-detected binary
# (`src/main.rs` calls into it), so we need stubs for both — otherwise
# `cargo fetch` errors with "can't find `loach_lib`" or "no targets
# specified". `tauri-build` runs as a build script and needs the
# capability JSON files present too, even at fetch time.
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
# `--bundles` flag is passed through `npm run tauri -- build` cleanly and
# the post-build copy runs in the same layer.
CMD ["sh", "-c", "npm run tauri -- build --bundles deb,appimage && mkdir -p /out && cp -r src-tauri/target/release/bundle/. /out/"]
