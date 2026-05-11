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

# Tauri's Linux system deps — same set release.yml installs on ubuntu-22.04 —
# plus the build toolchain and the few utilities the AppImage bundler shells
# out to (file, wget, xz).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl ca-certificates git pkg-config \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
      libssl-dev libgtk-3-dev libsoup-3.0-dev \
      patchelf file wget xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Node 20 to match setup-node@v4 in CI.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Rust stable, minimal profile (we don't need rustfmt/clippy in the build image).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal

WORKDIR /src

# Warm the npm cache layer before bringing in source so editing a .tsx file
# doesn't re-download node_modules.
COPY package.json package-lock.json ./
RUN npm ci

# Same trick for cargo: copy just the manifests and a stub main.rs so
# `cargo fetch` can resolve and download the dependency graph into a
# cacheable layer.
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/
RUN mkdir -p src-tauri/src \
 && echo "fn main() {}" > src-tauri/src/main.rs \
 && (cd src-tauri && cargo fetch) \
 && rm -rf src-tauri/src

# Real source.
COPY . .

# Build both bundles, then stage the output tree under /out so the host
# volume mount picks up only the finished installers. Using `sh -c` so the
# `--bundles` flag is passed through `npm run tauri -- build` cleanly and
# the post-build copy runs in the same layer.
CMD ["sh", "-c", "npm run tauri -- build --bundles deb,appimage && mkdir -p /out && cp -r src-tauri/target/release/bundle/. /out/"]
