import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";
import { useChatStore } from "./chatStore";

/**
 * Onboarding controller. Holds the step index plus a small bag of "draft"
 * fields the wizard collects before committing them to settings on
 * `complete()` — keeping the settings store untouched until the very end
 * means a mid-wizard X press doesn't permanently mutate the user's
 * config beyond `onboarding_completed`.
 *
 * The visibility of the wizard is gated externally (`App.tsx`) on the
 * `onboarding_completed` setting; this store doesn't try to mirror that
 * — it just owns the wizard's transient state.
 */

export type OnboardingStep =
  | "welcome"
  | "name"
  | "provider"
  | "prompt"
  | "features"
  | "final";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  "welcome",
  "name",
  "provider",
  "prompt",
  "features",
  "final",
];

interface OnboardingState {
  step: OnboardingStep;
  /** True when the user pressed X / Esc on the provider step and is being
   *  asked to confirm. Cleared by either confirming (closes wizard) or
   *  cancelling (keeps wizard open on the same step). */
  confirmingClose: boolean;

  goNext: () => void;
  goBack: () => void;
  goTo: (step: OnboardingStep) => void;
  setConfirmingClose: (v: boolean) => void;

  /** Mark onboarding finished in settings. Idempotent. */
  complete: () => Promise<void>;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  step: "welcome",
  confirmingClose: false,

  goNext: () => {
    const i = ONBOARDING_STEPS.indexOf(get().step);
    const next = ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)];
    set({ step: next, confirmingClose: false });
  },

  goBack: () => {
    const i = ONBOARDING_STEPS.indexOf(get().step);
    const prev = ONBOARDING_STEPS[Math.max(i - 1, 0)];
    set({ step: prev, confirmingClose: false });
  },

  goTo: (step) => set({ step, confirmingClose: false }),

  setConfirmingClose: (v) => set({ confirmingClose: v }),

  complete: async () => {
    await useSettingsStore.getState().update("onboarding_completed", true);
    // chatStore.hydrate() skips creating a "New chat" while onboarding
    // is pending. Whichever way the wizard ends (finish or cancel),
    // top it up here so the app always has exactly one empty chat
    // ready. newSession() collapses any duplicate empties, so this is
    // safe to call unconditionally.
    await useChatStore.getState().newSession({ spaceId: null });
  },
}));
