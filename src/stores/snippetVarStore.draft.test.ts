// The variable editor's unsaved fields outlive the app lock (F9-04).
//
// The lock unmounts the editor but leaves `dialogTarget` set, so it came
// back on unlock seeded from the saved variable: what was typed was gone.

import { describe, expect, it } from "vitest";
import type { SnippetVariable } from "@/types";
import { useSnippetVarStore } from "./snippetVarStore";

const variable = { id: "v1", key: "NAME", value: "Ada", description: null } as SnippetVariable;
const store = () => useSnippetVarStore.getState();

describe("the variable editor's draft", () => {
  it("is kept when the same variable's editor opens again, and only then", () => {
    store().openDialog(variable);
    useSnippetVarStore.setState({ draft: { target: variable, key: "NAME", value: "Grace", description: "" } });

    store().openDialog(variable);
    expect(store().draft?.value).toBe("Grace");

    store().openDialog("new");
    expect(store().draft).toBeNull();
  });

  it("is dropped on close", () => {
    store().openDialog("new");
    useSnippetVarStore.setState({ draft: { target: "new", key: "X", value: "1", description: "" } });
    store().closeDialog();
    expect(store().draft).toBeNull();
    expect(store().dialogTarget).toBeNull();
  });
});
