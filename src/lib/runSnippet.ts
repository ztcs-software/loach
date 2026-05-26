/**
 * Shared snippet-expansion path. Used by every entry point that primes the
 * composer with a snippet body (Snippets Library tile, search-bar hit,
 * `/snippet` slash command) so substitution + the fill-blanks dialog stay
 * consistent across them.
 *
 * The function never *creates* a chat — caller decides whether to spin up
 * a new session first. It only resolves variables and calls
 * `primeComposer` once the prompt is ready (which may be after the user
 * fills in prompt-on-use placeholders via the modal).
 */

import { useSettingsStore } from "@/stores/settingsStore";
import { useSnippetVarStore } from "@/stores/snippetVarStore";
import { useUIStore } from "@/stores/uiStore";
import { logger } from "@/lib/logger";
import { expandKnownVars } from "@/lib/snippetVars";
import type { Attachment, Snippet } from "@/types";

/** Decode a snippet's stored attachments JSON. Returns an empty list on a
 *  null / malformed blob so a corrupt row doesn't tank the snippet run —
 *  the body still primes the composer, just without the attachments. */
function parseSnippetAttachments(json: string | null): Attachment[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Attachment[]) : [];
  } catch (e) {
    logger.warn("snippet attachments_json was malformed; dropping", e);
    return [];
  }
}

/**
 * Substitute variables in `snippet.prompt` and prime the composer with the
 * result. When the snippet has unresolved `{{VAR}}` placeholders, opens the
 * fill-blanks dialog first and primes after the user submits. Cancelling
 * the dialog is a no-op — the composer stays as it was.
 *
 * @returns A promise that resolves once the composer has been primed (or
 *          the user cancelled the fill dialog).
 */
export function expandAndPrimeSnippet(snippet: Snippet): Promise<void> {
  return new Promise((resolve) => {
    const globals = useSnippetVarStore.getState().variables;
    const userName = useSettingsStore.getState().user_name ?? "";
    const { resolved, unresolved } = expandKnownVars(
      snippet.prompt,
      globals,
      userName,
    );

    // Forward the snippet's stored attachments to the composer so files
    // saved with the snippet ride along on the run. Decoded once here so
    // both the resolved-immediately path and the post-fill-dialog path
    // hand the same list to `primeComposer`.
    const attachments = parseSnippetAttachments(snippet.attachments_json);

    const prime = (text: string) => {
      useUIStore.getState().primeComposer(text, attachments);
    };

    if (unresolved.length === 0) {
      prime(resolved);
      resolve();
      return;
    }

    // Need user input. Pull recall asynchronously, then hand control to
    // the fill dialog. Recall is best-effort — if the load fails the
    // dialog opens with empty inputs.
    const varStore = useSnippetVarStore.getState();
    void varStore.loadFillValues(snippet.id).then((recall) => {
      useSnippetVarStore.getState().setPendingFill({
        snippetId: snippet.id,
        snippetTitle: snippet.title,
        partiallyResolved: resolved,
        unresolved,
        recall,
        onSubmit: (finalPrompt, values) => {
          prime(finalPrompt);
          // Remember the values for next time. Fire-and-forget — the
          // save path swallows errors with a warning log.
          void useSnippetVarStore
            .getState()
            .saveFillValues(snippet.id, values);
          resolve();
        },
        onCancel: () => resolve(),
      });
    });
  });
}
