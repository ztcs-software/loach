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
   needs to be active; on Linux, the `ollama` service must be started.
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
**Pull a model**, type a tag (for example `llama3.1:8b`), and wait for the
download to finish. The list refreshes automatically.

---

## 2. Sending and receiving messages

### My new message is stuck on "waiting"

**Problem.** You sent a prompt in one chat but it shows a spinner without
streaming anything.

**Solution.** Loach runs **one generation at a time across all chats**.
If another chat is busy, your message is parked in a FIFO queue.

- Wait for the current generation to finish, or
- Open the busy chat and click **Respond now** in the header of the chat
  you want answered first. This cancels the current runner and starts
  yours.

### The reply stopped halfway and shows an error

**Problem.** A streaming reply was cancelled or errored, and the bubble
ends with a red error line.

**Solution.** Whatever streamed before the failure is kept — open the
message menu and use **Copy raw** if you want to preserve it. To get a
full answer, send the same prompt again, or click **Regenerate** if it's
visible. If errors repeat, see the connection or VRAM sections below.

### I see no "thinking" trace even though the model supports reasoning

**Problem.** A reasoning model is selected but no thinking block appears
above the answer.

**Solution.**

1. Open the **Parameters** sidebar and confirm the **Thinking** toggle is
   on for this chat.
2. Make sure the model actually advertises the `thinking` capability — the
   tile in the Models tab shows a "thinking" badge if it does. Many tags
   of the same base model differ on this.
3. Thinking is **Ollama-only**. OpenAI providers ignore the toggle even
   when it's on.

### Tokens-per-second or token count chip is missing

**Problem.** Some replies show a metrics chip; others don't.

**Solution.** Metrics are shown when the provider reports them. Most
OpenAI-compatible proxies omit the timing fields, so chats against those
backends will only show the token counts (or nothing).

### Replies are off-topic, repetitive, or too short

**Problem.** The model is technically responding but the quality is poor.

**Solution.** Open the **Parameters** sidebar:

- Lower **temperature** for more focused answers, raise it for more variety.
- Raise **max tokens** if the answer keeps cutting off.
- Raise **num_ctx** if the model is forgetting earlier turns. Higher
  num_ctx uses more VRAM.
- Increase **repeat_penalty** (try 1.1–1.3) if the model loops.
- Click **Reset to defaults** in the panel header to discard per-chat
  overrides and fall back to the model's defaults.

---

## 3. Performance and VRAM

### Ollama crashes with "out of memory" or the model fails to load

**Problem.** A pull works but loading or chatting fails with a CUDA / VRAM
error.

**Solution.**

1. Turn on **Low VRAM mode** in the Parameters sidebar (or globally in
   **Settings → General**). This forces smaller batches and a leaner KV
   cache.
2. Lower **num_ctx** in the same panel — a smaller context window uses
   dramatically less VRAM.
3. Lower the **GPU layer count** to push more of the model onto CPU/RAM
   at the cost of speed.
4. Pick a smaller quantization (for example `q4_K_M` instead of `q8_0`)
   or a smaller parameter size.

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
launch, turn on **Settings → General → Default model preload**. The first
chat will start fast, at the cost of pinning VRAM as soon as Loach opens.

---

## 4. Attachments

### "File too large" when dropping a file

**Problem.** The composer refuses the file.

**Solution.** There's a **20 MB** cap per file. Split large logs, or paste
the relevant section as text instead.

### The PDF came in empty or with garbled text

**Problem.** The model says it can't see the document, even though you
attached a PDF.

**Solution.** Loach extracts text from PDFs, but **scanned PDFs** (image
pages with no text layer) have no text to extract. Run the PDF through an
OCR tool first, or paste the relevant pages as plain text.

### The DOCX won't attach

**Problem.** The file picker rejects the document.

**Solution.** Only `.docx` is supported, not legacy `.doc`. Open the file
in Word or LibreOffice and **Save As → Word Document (.docx)**.

### A long document shows a "content truncated" footer

**Problem.** A long PDF or text file was attached but only part of it
reached the model.

**Solution.** Per-file cap is **200,000 characters**; total inlined content
per message is **500,000 characters**. Either:

- Trim the document to the parts you actually need, or
- Send several focused messages, each with a different excerpt.

### Images don't seem to be working

**Problem.** You attached a PNG/JPEG but the model can't describe it.

**Solution.** The model needs **vision capability**. In the Models tab,
the tile shows a "vision" badge when supported. Switch to a vision-capable
model (Llava, Llama 3.2 Vision, GPT-4o, etc.) and re-send.

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

### "URL blocked" for `localhost`, `192.168.x`, or my office VPN

**Problem.** Loach refuses to fetch an internal URL.

**Solution.** This is intentional. The SSRF guard rejects any URL whose
resolved IP lands on loopback, link-local, or private RFC1918 ranges, even
if the hostname looks public but resolves there via DNS. To share internal
content with a model, copy the page text and paste it into the chat
instead.

### A URL fetch silently produces a "fetch failed" stub

**Problem.** The model is told a URL was attempted but no content came
back.

**Solution.** The fetch hit a limit:

- **30 s total timeout** or **10 s connect timeout**,
- **5 MB body cap**,
- A non-2xx HTTP response.

Try the URL in a browser. If it works there but not in Loach, the page is
likely slow, large, or blocks non-browser user agents.

### MCP "Test connection" fails

**Problem.** An MCP server is configured but the test button reports an
error.

**Solution.**

1. Confirm the URL is the **Streamable-HTTP** endpoint. Loach does not
   support stdio or SSE MCP transports.
2. If the server requires auth, add an `Authorization` header in the
   server's row.
3. Check that the response body fits under **4 MiB** — misconfigured
   servers that dump full schemas can exceed this.
4. Per-request timeout is **30 s**.

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

### Reference files won't add to a Space

**Problem.** Adding a file to a Space fails or silently does nothing.

**Solution.** Per-Space cap is **200 MB** total across all files. Remove
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

**Solution.** There is **no recovery path**. The lock blob is hashed with
Argon2id and stored in the OS credential store; Loach cannot read or
decrypt it back. Your options are:

- Try the optional hint shown on the lock screen (if you set one).
- **Factory reset** the install — this wipes every chat, Space, snippet,
  and setting. On Windows that means removing the app's data directory and
  reinstalling; on Linux, deleting the app-data folder under your home
  directory.

Set a hint when you create a lock — it's stored alongside in plain text
for exactly this case.

### "Too many attempts" — the unlock button is greyed out

**Problem.** After several wrong PINs, the unlock command refuses to run.

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

---

## 8. Models editor

### "Save as…" rejects my Modelfile

**Problem.** Saving a derived model fails with a validation error.

**Solution.** The editor refuses Modelfiles that could smuggle extra
directives.

- The **base tag** must only contain letters, digits, `.`, `_`, `/`, or
  `-`. No spaces, no quotes.
- The **SYSTEM** and **TEMPLATE** bodies cannot contain `"""`. If you need
  a triple-quote in your system prompt, rephrase.
- "Save as…" always writes a **new** model. To replace one, save under a
  new name and then delete the old one.

### A model pull is stuck

**Problem.** The progress chip is hanging at the same percentage.

**Solution.**

1. Click **Cancel** on the progress chip and start the pull again.
2. Confirm Ollama is still reachable (the Providers panel will go red if
   it isn't).
3. Check disk space on the drive Ollama uses for its model cache.

### Can't delete a model

**Problem.** Delete fails or the button is greyed out.

**Solution.** Switch every chat off this model first (open them and pick
a different one from the model dropdown), then retry. Ollama refuses to
delete a model that's currently loaded.

---

## 9. Updates

### No "Install update" button on Linux

**Problem.** You're on Linux and the Updates panel only shows a link to
GitHub releases.

**Solution.** This is expected for **`.deb`** and **`.rpm`** installs —
the Tauri updater can only patch AppImage installs on Linux. Your
package manager owns updates instead. To get in-app updates, install the
AppImage build from the releases page.

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
by **Settings → Data → Export everything**. Single-chat exports (the
per-chat **Export** menu) are not import sources; they're for sharing or
archiving outside the app.

### "Wipe user data" didn't remove my OpenAI key

**Problem.** After wiping, your OpenAI key is still configured.

**Solution.** By design. **Wipe user data** removes chats, Spaces,
snippets, MCP servers, and memories but keeps app settings and your
stored API key. To clear everything, including the key, use **Factory
reset** instead.

---

## 11. Appearance and window

### Aurora theme tears or stutters

**Problem.** The animated background pulses or drops frames.

**Solution.** Switch to the **Solid** theme in **Settings → Appearance**.
Aurora relies on GPU compositing; integrated GPUs and remote desktop
sessions don't always cope.

### Font size change didn't fully apply

**Problem.** Some text scaled, some didn't.

**Solution.** A few elements (the title bar, native dialogs) follow the
OS font scale, not Loach's. Adjust your system display scaling alongside
the in-app setting if you need everything uniform.

---

## 12. Search palette

### Cmd/Ctrl+K does nothing

**Problem.** The shortcut doesn't open the global search.

**Solution.** The palette is suppressed while the **onboarding wizard**
or the **lock screen** owns the window. Finish onboarding or unlock the
app first.

---

## 13. Platform

### macOS

**Problem.** There's no macOS build.

**Solution.** macOS is not currently supported. The codebase is Tauri 2
and portable in principle, but no builds, signing, or test coverage exist
for macOS yet.

### Windows: "Credential Manager access denied"

**Problem.** Saving keys or app-lock credentials fails on a managed
Windows machine.

**Solution.** Some corporate group policies block apps from writing to
Credential Manager. Loach cannot store secrets without it. Ask your IT
admin to allow Credential Manager writes for the Loach process, or use
a personal machine.
