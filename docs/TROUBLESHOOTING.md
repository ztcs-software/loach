# Loach — Troubleshooting

Common problems and how to fix them. Each entry follows the same shape:
a short description of what you're seeing, then what to do about it.

If your problem isn't here, the app version and a description of the steps
that reproduce it are usually enough to file a useful bug report.

---

## 1. Providers and connections

### Ollama is installed but Loach can't see it

**Problem.** The Providers panel says Ollama isn't reachable, or the model
dropdown is empty even though `ollama list` works in a terminal.

**Solution.**

1. Make sure `ollama serve` is running. On Windows, the Ollama tray icon
   needs to be active; on Linux, the `ollama` service must be started; on
   macOS, launch the Ollama menu-bar app or run `ollama serve` from a
   terminal.
2. Open **Settings → Providers → Ollama** and check the **Base URL**.
   The default is `http://localhost:11434`. If you run Ollama on another
   machine or a custom port, change it here.
3. Click **Refresh** in the Models tab. The list re-queries Ollama's
   `/api/tags` endpoint.
4. If Ollama runs on another host, make sure its firewall allows inbound
   connections on the chosen port and that `OLLAMA_HOST=0.0.0.0` is set on
   the server side (Ollama binds to localhost by default).

### OpenAI says "invalid key" or returns 401

**Problem.** You added an OpenAI key but every request fails with 401.

**Solution.**

1. Re-enter the key in **Settings → Providers → OpenAI**. Keys are stored
   in the operating system's credential store, not on disk, so a copy-paste
   that picked up a trailing space will silently fail.
2. Confirm the key is active on your OpenAI dashboard and has not been
   rotated.
3. If you're using a custom OpenAI-compatible endpoint (vLLM, LM Studio,
   LiteLLM, OpenRouter, Groq), make sure the **Base URL** ends with `/v1`
   and that the endpoint accepts the same `Authorization: Bearer …` header
   the real OpenAI API uses.

### Key won't save on Linux

**Problem.** The OpenAI key field clears every time you reopen Settings, or
saving the key throws an error.

**Solution.** Loach uses the system Secret Service to store secrets. On
minimal Linux installs (server-style, some tiling window managers) there is
no Secret Service running.

1. Install and start **gnome-keyring** or **KWallet** — whichever fits your
   desktop environment.
2. Make sure a login session is unlocked so the keyring is available to
   user processes.
3. Restart Loach and re-enter the key.

### Models list shows no models

**Problem.** Ollama is reachable but the list is empty.

**Solution.** You haven't pulled any models yet. In the **Models** tab, click
**Pull model**, type a tag (for example `llama3.1:8b`), and wait for the
download to finish. The list refreshes automatically.

---

## 2. Sending and receiving messages

### My new message is stuck on "waiting"

**Problem.** You sent a prompt in one chat but it shows a spinner without
streaming anything.

**Solution.** Loach runs **one generation at a time across all chats**.
If another chat is busy, your message is parked in a FIFO queue.

- Wait for the current generation to finish, or
- Open the chat that's waiting: its transcript shows a **Waiting for other
  chats to finish…** banner with **Respond now**. That cancels the current
  runner and starts yours.

### The reply stopped halfway and shows an error

**Problem.** A streaming reply was cancelled or errored, and the bubble
ends with a red error line.

**Solution.** Whatever streamed before the failure is kept — open the
message's `…` menu and use **Copy message** if you want to preserve it. To get a
full answer, send the same prompt again, or click **Regenerate** if it's
visible. If errors repeat, see the connection or VRAM sections below.

### I see no "thinking" trace even though the model supports reasoning

**Problem.** A reasoning model is selected but no thinking block appears
above the answer.

**Solution.**

1. Open the **Parameters** sidebar and confirm the **Thinking** toggle is
   on for this chat.
2. Make sure the model actually advertises the `thinking` capability — when
   it doesn't, the Thinking row in the Parameters sidebar is disabled with
   "This model doesn't support a thinking step". Many tags of the same base
   model differ on this.
3. Thinking is **Ollama-only**. OpenAI providers ignore the toggle even
   when it's on.

### A formula shows as raw TeX instead of rendering

**Problem.** The reply contains `\frac{a}{b}` or similar and you see the
source, not typeset math.

**Solution.** Which case it is:

- **Broken TeX renders as its own source** on purpose, with the parse
  error on hover — that keeps a half-typed formula quiet while it streams
  rather than flashing an error. Hover it to see what KaTeX objected to.
- **`$…$` didn't typeset.** Single dollars are treated as currency unless
  the span reads as math: it has to hug both delimiters, stay on one line,
  not follow a word character, and not be chased by a digit. "$5 and $10"
  and "US$5" stay prose by design. Ask the model for `$$…$$`, `\(…\)` or
  a ```` ```math ```` fence if you need the ambiguous case.
- **Nothing renders at all.** Math is on with no setting to find, so this
  is more likely a delimiter the model didn't emit — check the raw text
  via **Copy message**.

### The metrics chip's numbers don't match my provider

**Problem.** The token count or tokens/sec under a reply doesn't line up
with what the backend or your provider's dashboard reports.

**Solution.** The chip appears once a reply finishes and counts
**completion tokens only**. Ollama reports the count itself; OpenAI-compatible
endpoints only do so when they send a `usage` block — most proxies don't,
in which case Loach counts streamed chunks as an approximation. The rate
falls back to wall-clock timing when the backend reports none, so it
includes any queueing or model-load time.

### Replies are off-topic, repetitive, or too short

**Problem.** The model is technically responding but the quality is poor.

**Solution.** Open the **Parameters** sidebar:

- Lower **temperature** for more focused answers, raise it for more variety.
- Raise **max tokens** if the answer keeps cutting off.
- Raise **num_ctx** if the model is forgetting earlier turns. Higher
  num_ctx uses more VRAM.
- Increase **repeat_penalty** (try 1.1–1.3) if the model loops.
- Click **Reset to defaults** (or **Reset to model defaults**) at the bottom
  of the panel to discard per-chat overrides and fall back to the model's
  defaults.

---

## 3. Performance and VRAM

### Ollama crashes with "out of memory" or the model fails to load

**Problem.** A pull works but loading or chatting fails with a CUDA / VRAM
error.

**Solution.**

1. Turn on **Low VRAM** in the Parameters sidebar (or globally with
   **Settings → Features → Low VRAM mode**). This forces smaller batches
   and a leaner KV cache.
2. Lower **Context Length** in the same panel — a smaller context window
   uses dramatically less VRAM.
3. Lower the **GPU layer count** (Advanced view) to push more of the model
   onto CPU/RAM at the cost of speed.
4. Pick a smaller quantization (for example `q4_K_M` instead of `q8_0`)
   or a smaller parameter size.

### Onboarding sized my machine wrong

**Problem.** The model recommendation calls a model too big (or too small)
for what your hardware actually manages, or names a constraint you don't
recognise.

**Solution.** The card names the number it used — "Based on 8 GB VRAM ·
NVIDIA GeForce RTX 4060", or a RAM figure when there's no usable GPU
reading. Which one you get:

- **Windows** reads dedicated video memory directly, for any vendor.
- **Linux** reads `nvidia-smi`, then the amdgpu sysfs node. **Intel Arc
  isn't covered** and falls back to system RAM, which under-reports what
  the card can do — pick a larger variant by hand if you have one.
- **macOS** deliberately uses system RAM: Apple Silicon shares it with the
  GPU, so a separate figure would double-count.
- Adapters under 1 GB — and, on Windows, any adapter that reports unified
  memory — are treated as integrated graphics and ignored, since they
  carve out system RAM the RAM path already counts.

Any probe that fails falls back to RAM. Nothing here restricts you — every
catalog entry stays pullable, and the custom-tag field takes any tag at
all. The badges are advice, except **Not enough disk space**, which does
disable that row's Pull button.

If a model marked **Runs slowly** feels fine in practice, that's the
expected direction of error for a rough estimate — Ollama publishes no
runtime memory figures to size against.

### The UI feels sluggish

**Problem.** Scrolling, typing, or window resizing is choppy.

**Solution.**

- In **Settings → Appearance**, switch the theme from **Aurora** to
  **Solid**. Aurora's animated gradient is heavy on weak GPUs.
- Close very long chats while testing — extremely long transcripts cost
  more to re-render on every token.

### The first reply takes forever, even on a fast model

**Problem.** Sending the first prompt of the day takes 10+ seconds before
streaming starts; subsequent replies are instant.

**Solution.** Ollama loads the model into VRAM on first use. To preload at
launch, turn on **Preload on startup** under **Settings → General → Default
model**. The first
chat will start fast, at the cost of pinning VRAM as soon as Loach opens.

### Making Ollama generate faster

**Problem.** Generation is slower than you'd expect, or you want to squeeze
more tokens/sec out of your hardware.

**Solution.** These are environment variables on the **Ollama server** (not
Loach settings) — set them where `ollama serve` runs, then restart it. As of
Ollama 0.5+:

- **`OLLAMA_FLASH_ATTENTION=1`** — enables flash attention, which lowers memory
  bandwidth and usually speeds up generation, especially at longer contexts.
  Newer builds enable it by default for some models on the new engine; setting
  it explicitly is harmless.
- **`OLLAMA_KV_CACHE_TYPE=q8_0`** — quantizes the KV cache to 8-bit, roughly
  halving its memory so you can run a bigger context (or a bigger model) in the
  same VRAM. Only takes effect **with flash attention enabled**. `q4_0` is
  smaller but lossier; `f16` (the default) is highest quality.
- **`OLLAMA_KEEP_ALIVE=30m`** (or `-1` for "until unloaded") — how long Ollama
  keeps a model resident after a request, so a reply after a pause skips the
  cold reload. Loach also exposes this under **Settings → Features → Keep
  model loaded** (5 min, 30 min, 1 hour, Always), which is sent with every
  request and overrides the env default.
- **`OLLAMA_NUM_PARALLEL=1`** — caps concurrent requests per model. The default
  splits VRAM across parallel slots; pinning it to 1 gives a single chat the
  whole budget (and the largest usable context).
- **`OLLAMA_MAX_LOADED_MODELS=1`** — keeps only one model resident at a time.
  Useful on a single-GPU machine where a second model would evict the first or
  spill to system RAM.

Setting environment variables for Ollama: on Windows, use **System Properties →
Environment Variables** (or `setx OLLAMA_FLASH_ATTENTION 1`) and restart the
Ollama tray app. On Linux with systemd, `systemctl edit ollama` (add an
`[Service]` block of `Environment="OLLAMA_…=…"` lines) then
`systemctl restart ollama`. On macOS, `launchctl setenv OLLAMA_FLASH_ATTENTION 1`
and relaunch the Ollama app.

---

## 4. Attachments

### "… is larger than 20 MB" when dropping a file

**Problem.** The composer refuses the file with that message under the
input.

**Solution.** There's a **20 MB** cap per file. Split large logs, or paste
the relevant section as text instead.

### The PDF came in empty or with garbled text

**Problem.** The model says it can't see the document, even though you
attached a PDF.

**Solution.** Loach extracts text from PDFs, but **scanned PDFs** (image
pages with no text layer) have no text to extract. Run the PDF through an
OCR tool first, or paste the relevant pages as plain text.

### The model can't read my Word document

**Problem.** A `.doc` file attached, but the model says it only knows the
file's name.

**Solution.** Only `.docx` is extracted, not legacy `.doc`. A `.doc` still
attaches, but as an opaque file the model is told about by name. Open the
file in Word or LibreOffice and **Save As → Word Document (.docx)**.

### A long document's chip says "truncated"

**Problem.** A long PDF or text file was attached, its chip carries a
**truncated** pill, and only part of it reached the model.

**Solution.** Per-file cap is **200,000 characters**; total inlined content
per message is **500,000 characters**. Either:

- Trim the document to the parts you actually need, or
- Send several focused messages, each with a different excerpt.

### Images don't seem to be working

**Problem.** You attached a PNG/JPEG but the model can't describe it.

**Solution.** The model needs **vision capability** — check the model's
page on the Ollama library or the capabilities line of `ollama show`.
Switch to a vision-capable model (Llava, Llama 3.2 Vision, GPT-4o, etc.)
and re-send.

---

## 5. Web fetch and MCP

### Pasted URL is ignored

**Problem.** Your prompt has a link but the model only sees the bare URL,
not the page content.

**Solution.**

1. Web fetch is **off by default**. Turn it on in **Settings → Tools →
   Web fetch**.
2. Only `http://` and `https://` URLs are fetched.
3. Up to **5 URLs per message** are followed. Extras are ignored.

### "Refusing to fetch …" for `localhost`, `192.168.x`, or my office VPN

**Problem.** Loach refuses to fetch an internal URL.

**Solution.** This is intentional. The SSRF guard rejects any URL whose
resolved IP lands on loopback, link-local, or private RFC1918 ranges, even
if the hostname looks public but resolves there via DNS. To share internal
content with a model, copy the page text and paste it into the chat
instead.

### A URL fetch silently produces a "Failed to fetch" stub

**Problem.** The model is told a URL was attempted but no content came
back.

**Solution.** The fetch hit a limit:

- **30 s total timeout** or **10 s connect timeout**,
- **5 MB body cap**,
- A non-2xx HTTP response.

Try the URL in a browser. If it works there but not in Loach, the page is
likely slow, large, or blocks non-browser user agents.

### MCP "Test connection" fails (HTTP)

**Problem.** An HTTP MCP server is configured but the test button reports
an error.

**Solution.**

1. Confirm the URL is the **Streamable-HTTP** endpoint. Loach does not
   support the legacy two-endpoint SSE transport. If the server is
   distributed as a command to run (`npx …`, `uvx …`), add it as a
   **Local process (stdio)** server instead.
2. If the server requires auth, add an `Authorization` header in the
   server's row.
3. Check that the response body fits under **4 MiB** — misconfigured
   servers that dump full schemas can exceed this.
4. Per-request timeout is **30 s**.

### A local (stdio) MCP server won't start

**Problem.** Saving or testing a stdio server fails with "couldn't
start", "exited before replying", or a timeout.

**Solution.**

1. Read the end of the error — Loach quotes the last lines the server
   wrote to stderr (`npm ERR! 404`, a Python traceback, "command not
   found"). That is usually the whole answer.
2. Make sure the runtime the command needs is installed and on `PATH`
   for your user: Node.js for `npx`, `uv` for `uvx`. Loach launches the
   program with your normal environment; if it works in a fresh terminal
   it should work here.
3. On Windows, `npx` / `uvx` are `.cmd` shims. Loach resolves them for
   you, but a full path to the `.cmd` file also works.
4. First runs of `npx -y …` download the package. Startup is allowed
   **60 s**; a slow network can exceed that — run the command once in a
   terminal to warm the cache, then test again.
5. Put one argument per line. Don't quote arguments the way you would in
   a shell — Loach passes each line verbatim.
6. If you clicked **Cancel** on the "Run MCP server …?" system dialog,
   nothing was saved or started. Save again and choose **Start server**.

### A server imported from a backup is disabled and won't turn on

**Problem.** After **Settings → Data → Import**, a stdio MCP server shows
up switched off, and flipping the toggle opens a system dialog.

**Solution.** That is deliberate: a backup can't prove *you* configured
that command on this machine, so imported stdio servers arrive disabled
and the first enable asks you to confirm the command line. Review it and
choose **Start server** to enable the row. HTTP servers import enabled.

### The reply is stuck on "Waiting for your approval…"

**Problem.** The assistant bubble shows an approval card and nothing else
happens.

**Solution.** The model asked to run an MCP tool and Loach is waiting for
you — answer **Allow once**, **Always allow**, or **Deny** on the card. A
prompt left unanswered for 10 minutes is treated as a denial, and the
Stop button cancels the reply. To stop being asked for a server you
trust, open it in **Settings → MCP** and turn off **Ask before each tool
call**; to re-enable prompts for tools you answered "Always allow" for,
use **Ask again for all** in the same editor.

---

## 6. Spaces and memory

### Memories aren't being saved

**Problem.** You set up Space memory but nothing appears in the Memory
tab.

**Solution.**

- Memory extraction only runs **after a complete assistant reply**.
  Cancelled or errored turns are skipped.
- The toggle on the Space's Memory tab must be on.
- Each candidate fact must be **under 280 characters**. Longer "facts"
  are dropped.
- Memory uses the same provider/model the chat is using. Tiny models
  often return empty extractions; try a larger one.

### Memory captured something wrong or private

**Problem.** A bad fact landed in long-term memory.

**Solution.** Open the Space's **Memory** tab and click the row to edit or
delete it. Turning the toggle off only stops *new* writes; existing
memories still ride along until you remove them.

### Reference sources won't add to a Space

**Problem.** Adding a source to a Space fails or silently does nothing.

**Solution.** Per-Space cap is **200 MB** total across all sources. Remove
older references, or move the content into a smaller text file.

### Space instructions seem to override my custom instructions

**Problem.** Your global Custom Instructions don't appear to apply in
chats inside a Space.

**Solution.** This is by design. When a Space has its own instructions,
they replace the global ones for chats in that Space. Either clear the
Space's instructions, or repeat the relevant parts in them.

---

## 7. App lock

### I forgot my PIN or password

**Problem.** You can't unlock the app.

**Solution.** There is **no recovery path inside the app**. The lock is an
Argon2id hash in your OS credential store; Loach cannot read or reverse it,
and the in-app **Factory reset** itself asks for the credentials. Your
options are:

- Try the optional hint shown on the lock screen (if you set one).
- Remove the lock entry from the credential store by hand. Loach stores it
  under the service `dev.loach.app` with the account `app_lock`:
  - **Windows** — open **Credential Manager → Windows Credentials →
    Generic Credentials** and remove the entry whose name contains
    `dev.loach.app` and `app_lock`.
  - **Linux** — delete it in your keyring app (Passwords and Keys /
    KWalletManager), or run
    `secret-tool clear service dev.loach.app username app_lock`.
  - **macOS** — in **Keychain Access**, delete the `dev.loach.app` item
    whose account is `app_lock`.

  Your chats and settings are untouched — only the lock is gone, and Loach
  starts unlocked on the next launch.

Deleting the app-data folder does **not** help: it wipes your chats but
leaves the credential-store entry, so the lock screen comes straight back.

Set a hint when you create a lock — it's stored alongside in plain text
for exactly this case.

### "Too many failed attempts" on the lock screen

**Problem.** After several wrong PINs, every unlock attempt is refused with
a red *Too many failed attempts. Try again in N seconds* message.

**Solution.** After 5 consecutive failed attempts, Loach starts an
escalating cool-down (30 s → 60 s → 2 min … up to 2 h). Wait for the
window to expire, or **restart the app** — the counter resets on restart
and on a successful unlock.

### Changing or removing the lock asks for my current password

**Problem.** Even though the app is unlocked, changing the lock or running
a destructive command prompts for the current credentials.

**Solution.** This is intentional. Re-authentication is required for
changing or removing the lock, importing data, wiping user data, and
factory resetting, so that a compromised UI process can't quietly disable
the gate.

### Loach keeps locking itself

**Problem.** The lock screen appears mid-session, not just at launch.

**Solution.** One of the two auto-lock triggers is on. Both live in the
**Auto-lock** card in **Settings → Security**, which only appears once a
lock is configured:

- **Lock after inactivity** — set it to **Off**, or to a longer interval,
  if a 1- or 5-minute timeout is catching you while you read a long reply.
  Only typing, clicking, scrolling and touch count as activity; watching a
  reply stream does not.
- **Lock when minimized** — turn it off if you routinely minimize Loach
  while it works. Note that native save / open dialogs don't trigger it,
  so exporting or attaching a file is safe either way.

If neither is on, check you aren't hitting `Cmd/Ctrl + Shift + L`, which
locks immediately.

A reply already streaming keeps running behind the lock screen — unlocking
returns you to it with the tokens that arrived meanwhile.

### The lock fired later than the timeout I set

**Problem.** You picked 1 minute but it took closer to 75 seconds.

**Solution.** Expected. The idle deadline is re-checked periodically rather
than driven by one long timer, so the lock lands up to 15 seconds after
the interval. Erring late is deliberate: a timer that fires early on a
throttled or suspended window is the worse failure. A machine that sleeps
past the interval locks the moment it wakes.

---

## 8. Models editor

### "Save as new model" rejects my Modelfile

**Problem.** Saving a derived model fails with a validation error.

**Solution.** The editor refuses Modelfiles that could smuggle extra
directives.

- The **base tag** must only contain letters, digits, `.`, `_`, `/`, or
  `-`. No spaces, no quotes.
- The **SYSTEM** and **TEMPLATE** bodies cannot contain `"""`. If you need
  a triple-quote in your system prompt, rephrase.
- **Save as new model** always writes a **new** model. To replace one, save under a
  new name and then delete the old one.

### A model pull is stuck

**Problem.** The progress chip is hanging at the same percentage.

**Solution.**

1. Click the ✕ on the progress chip and start the pull again.
2. Confirm Ollama is still reachable — the model picker in the chat header
   shows a red status when it isn't, and **Settings → Providers → Test
   connection** checks the base URL.
3. Check disk space on the drive Ollama uses for its model cache.

### Can't delete a model

**Problem.** Delete fails with a *Couldn't delete model* toast.

**Solution.** The toast quotes Ollama's own error — Loach never blocks a
delete itself. Check that Ollama is still reachable (the chat-header model
picker shows a red status when it isn't) and that the tag matches what
`ollama list` shows, then retry from the Models tab.

---

## 9. Updates

### No "Install update" button on Linux

**Problem.** You're on Linux and the Updates panel only shows a link to
GitHub releases.

**Solution.** All three Linux formats — AppImage, `.deb` and `.rpm` —
support in-app updates, so the panel should offer one. Two things hide it:

1. **You installed v1.2.3 or earlier from a `.deb` or `.rpm`.** That
   build's check looked for an AppImage-only environment variable, so it
   reported "unsupported" on packages. Download a newer `.deb` / `.rpm`
   once from the releases page; in-app updates work from then on.
2. **You're running a development build** (`npm run tauri dev` or
   `cargo run`). Package detection reads a marker the bundler writes at
   build time (an AppImage is recognised by its runtime's environment
   variable), which dev builds don't have. Install a packaged build.

Note that updates are in-app only — there's no apt or yum repository, so
`apt upgrade` won't pick up new versions either way.

### The update asks for my password on Linux

**Problem.** Installing an update on a `.deb` / `.rpm` install pops a
system authentication prompt.

**Solution.** Expected. Replacing a package-managed install means running
`dpkg -i` / `rpm -U` as root, which Loach requests through `pkexec`
(falling back to zenity or kdialog plus `sudo`). Going around the package
manager instead would leave its database describing a version that's no
longer on disk. AppImage installs replace themselves in place and never
prompt.

### "Up to date" but I see a newer version on GitHub

**Problem.** The updater says there's nothing new even though a newer
release exists.

**Solution.** The updater only reads **published** releases, not drafts.
Wait until the release is published, or download manually from GitHub.

### Update download or signature fails

**Problem.** The update starts but errors out before installing.

**Solution.**

1. Re-run the check — transient network failures are common.
2. If the error mentions signature verification, the release is most
   likely mid-publish (assets uploaded but not yet signed). Wait a few
   minutes and retry.
3. As a fallback, download the installer for your platform directly from
   the releases page.

---

## 10. Data, import, and export

### Import won't accept my JSON file

**Problem.** "Import" rejects the file you picked.

**Solution.** Import expects a **full Loach export** — the JSON produced
by **Settings → Data → Export data**. The per-chat **Export context**
Markdown is not an import source; paste it into another chat with
**Import context** instead.

### "Remove my data" didn't remove my OpenAI key

**Problem.** After erasing, your OpenAI key is still configured.

**Solution.** By design. **Remove my data** (under **Settings → Data →
Erase & Reset**) removes chats, folders, Spaces, snippets, snippet
variables, MCP servers and memories but keeps app settings and your stored
API key. To clear everything, including the key and the app lock, use
**Factory reset** instead.

---

## 11. Appearance and window

### Aurora theme tears or stutters

**Problem.** The animated background pulses or drops frames.

**Solution.** Switch to the **Solid** theme in **Settings → Appearance**.
Aurora relies on GPU compositing; integrated GPUs and remote desktop
sessions don't always cope.

### Font size change didn't fully apply

**Problem.** Some text scaled, some didn't.

**Solution.** Native dialogs (file pickers, the MCP consent prompt) follow
the OS font scale, not Loach's; everything Loach draws itself, including
the title bar, follows the in-app setting. Adjust your system display
scaling alongside the in-app setting if you need everything uniform.

---

## 12. Search palette

### Cmd/Ctrl+K does nothing

**Problem.** The shortcut doesn't open the global search.

**Solution.** The palette is suppressed while the **onboarding wizard**
or the **lock screen** owns the window. Finish onboarding or unlock the
app first.

### Search doesn't find a phrase I know I wrote

**Problem.** You remember the wording, but the palette returns nothing —
or only chat titles.

**Solution.** Message search covers live transcripts, and deliberately
skips several things:

- **Archived chats.** The archive has no search of its own — unarchive
  the chat from **Settings → Archive** to bring it back into scope.
- **Private Chat.** It never writes to the database, so nothing from it
  is searchable by design.
- **Text inside an attachment or a fetched page.** Those bodies are
  inlined into the message but not displayed in the bubble, so a hit there
  would jump nowhere. Open the attachment instead.
- **Imported turns you hid from the transcript.** Expanding the collapsed
  card shows them, but there's no un-hide — they stay out of both this
  search and the in-chat finder. Re-import without **Hide from
  transcript** if you need them findable.
- **System notices**, which aren't conversation.

Two more things to check: the query needs at least **two characters**, and
message-search case-insensitivity is ASCII-only — a query with accented or
non-Latin characters matches transcript text at its own case but not across
cases. Try the exact casing you used.

If titles crowd out what you want, narrow with the scope dropdown or type
`in:messages` in the query — scoped to messages, transcript hits get the
whole list instead of a reserved block at the bottom.

---

## 13. Platform

### macOS: "Loach is damaged and can't be opened" on first launch

**Problem.** macOS refuses to open the app after install, showing either
*"Loach is damaged and can't be opened"* or *"Apple cannot verify Loach is
free of malware"*.

**Solution.** The macOS build is **not Apple-notarized** (we don't
subscribe to the Apple Developer Program), so Gatekeeper blocks it on
first launch. Bypass it once and the app runs normally afterwards:

- **Right-click** `Loach.app` in **Applications** → **Open** → click
  **Open** in the prompt, or
- Run `xattr -cr /Applications/Loach.app` in **Terminal** and launch
  normally.

Auto-updates flow through Loach's own Ed25519-signed updater (independent
of Apple), so this is a one-time install step. If a future update is
blocked the same way, the same workaround applies.

### macOS: Intel Mac

**Problem.** The downloaded `.dmg` won't install or run on an Intel Mac.

**Solution.** The macOS build is **Apple Silicon (M-series) only**.
Intel Macs aren't supported. Build from source if you need to run on
Intel — see the README "Build from source" section.

### Windows: "Credential Manager access denied"

**Problem.** Saving keys or app-lock credentials fails on a managed
Windows machine.

**Solution.** Some corporate group policies block apps from writing to
Credential Manager. Loach cannot store secrets without it. Ask your IT
admin to allow Credential Manager writes for the Loach process, or use
a personal machine.
