import { test, expect, describe } from "bun:test"
import { parseDialog } from "./dialogs"
import { unstyle } from "./command-menu"
import { herdrScreen } from "./herdr"
import { isModelPicker } from "./model-control"

// Claude Code 2.1.310, a few seconds after a /model pick or cancel: the
// picker panel's top rule carries the effort badge inline
// ("▔▔▔…▔ ◐ medium · /effort ▔"), and the screen above it holds the earlier
// "❯ /model" prompts. Captured verbatim off a throwaway herdr pane (herdr
// 0.9.5, `pane read --source visible --format ansi`, blank rows dropped),
// 2026-10-26. Reading that rule as text opened the dialog at the top of the
// screen: title "▐▛███▛█ Claude Code", every old "❯ /model" a cursor row, and
// /api/model/open answered not_a_picker (then other_dialog) on a picker that
// was on screen.
const PICKER_AFTER_PICK: string = "\u001b[0m\u001b[38;2;215;119;87m ▐\u001b[0m\u001b[38;2;215;119;87m\u001b[48;2;0;0;0m▛███▛█   \u001b[0m\u001b[1mClaude Code \u001b[0m\u001b[38;2;153;153;153mv2.1.310\u001b[0m\n\u001b[0m\u001b[38;2;215;119;87m▝▜\u001b[0m\u001b[38;2;215;119;87m\u001b[48;2;0;0;0m█████\u001b[0m\u001b[38;2;215;119;87m█▀  \u001b[0m\u001b[38;2;153;153;153mOpus 5.5 · Claude Max\u001b[0m\n\u001b[0m\u001b[38;2;215;119;87m ▝▝   ▝▝   \u001b[0m\u001b[38;2;153;153;153m/private/tmp/x\u001b[0m\n\u001b[0m\u001b[38;2;153;153;153m\u001b[48;2;55;55;55m❯\u001b[0m\u001b[48;2;55;55;55m \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;55;55;55m/model\u001b[0m\u001b[48;2;55;55;55m                                                                                                                                                 \u001b[0m\n\u001b[0m\u001b[38;2;153;153;153m  ⎿  \u001b[0mSet model to \u001b[0m\u001b[38;2;177;185;249mOpus 5.5 (default) \u001b[0mfor this session only\n\u001b[0m\u001b[38;2;153;153;153m\u001b[48;2;55;55;55m❯\u001b[0m\u001b[48;2;55;55;55m \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;55;55;55m/model\u001b[0m\u001b[48;2;55;55;55m                                                                                                                                                 \u001b[0m\n\u001b[0m\u001b[38;2;153;153;153m  ⎿  \u001b[0mSet model to \u001b[0m\u001b[38;2;177;185;249mOpus 5.5 (default) \u001b[0mand saved as your default for new sessions\n\u001b[0m\u001b[38;2;153;153;153m\u001b[48;2;55;55;55m❯\u001b[0m\u001b[48;2;55;55;55m \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;55;55;55m/model\u001b[0m\u001b[48;2;55;55;55m \u001b[0m\n\u001b[0m\u001b[38;2;153;153;153m  ⎿  \u001b[0mKept model as \u001b[0m\u001b[38;2;177;185;249mOpus 5.5 (default)\u001b[0m\n\u001b[0m\u001b[38;2;153;153;153m\u001b[48;2;55;55;55m❯\u001b[0m\u001b[48;2;55;55;55m \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;55;55;55m/model\u001b[0m\u001b[48;2;55;55;55m \u001b[0m\n\u001b[0m\u001b[38;2;153;153;153m  ⎿  \u001b[0mKept model as \u001b[0m\u001b[38;2;177;185;249mOpus 5.5 (default)\u001b[0m\n\u001b[0m\u001b[38;2;153;153;153m\u001b[48;2;55;55;55m❯\u001b[0m\u001b[48;2;55;55;55m \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;55;55;55m/model\u001b[0m\u001b[48;2;55;55;55m \u001b[0m\n\u001b[0m\u001b[38;2;153;153;153m  ⎿  \u001b[0mKept model as \u001b[0m\u001b[38;2;177;185;249mOpus 5.5 (default)\u001b[0m\n\u001b[0m\u001b[38;2;177;185;249m▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ \u001b[0m\u001b[38;2;153;153;153m◐ medium · /effort\u001b[0m\u001b[38;2;177;185;249m ▔\u001b[0m\n   \u001b[0m\u001b[1m\u001b[38;2;177;185;249mSelect model\u001b[0m\n   \u001b[0m\u001b[38;2;153;153;153mSwitch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.\u001b[0m\n   \u001b[0m\u001b[38;2;177;185;249m❯ \u001b[0m\u001b[38;2;153;153;153m1.  \u001b[0m\u001b[38;2;78;186;101mDefault (recommended) ✔  \u001b[0m\u001b[38;2;215;119;87mOpus 5.5\u001b[0m\u001b[38;2;153;153;153m · Best for everyday, complex tasks\u001b[0m\n     \u001b[0m\u001b[38;2;153;153;153m2.  \u001b[0mOpus 5.5                 \u001b[0m\u001b[38;2;153;153;153mFor complex work and everyday tasks\u001b[0m\n     \u001b[0m\u001b[38;2;153;153;153m3.  \u001b[0mFable 5.1                \u001b[0m\u001b[38;2;153;153;153mFor your toughest challenges\u001b[0m\n     \u001b[0m\u001b[38;2;153;153;153m4.  \u001b[0mSonnet 5.5               \u001b[0m\u001b[38;2;153;153;153mMost efficient for simpler tasks\u001b[0m\n     \u001b[0m\u001b[38;2;153;153;153m5.  \u001b[0mHaiku 5.5                \u001b[0m\u001b[38;2;153;153;153mFastest for quick answers\u001b[0m\n     \u001b[0m\u001b[38;2;153;153;153m6.  \u001b[0mHaiku 4.5                \u001b[0m\u001b[38;2;153;153;153mFastest for quick answers\u001b[0m\n     \u001b[0m\u001b[38;2;153;153;153m7.  \u001b[0mSonnet 5                 \u001b[0m\u001b[38;2;153;153;153mEfficient for routine tasks\u001b[0m\n     \u001b[0m\u001b[38;2;153;153;153m8.  \u001b[0mOpus 5                   \u001b[0m\u001b[38;2;153;153;153mBest for everyday, complex tasks\u001b[0m\n     \u001b[0m\u001b[38;2;153;153;153m9.  \u001b[0mFable 5                  \u001b[0m\u001b[38;2;153;153;153mMost capable for your hardest and longest-running tasks\u001b[0m\n   \u001b[0m\u001b[38;2;153;153;153m↓\u001b[0m \u001b[0m\u001b[38;2;153;153;153m10. \u001b[0mOpus 4.8                 \u001b[0m\u001b[38;2;153;153;153mBest for everyday, complex tasks\u001b[0m\n      \u001b[0m\u001b[38;2;153;153;153m… +3 models\u001b[0m\n   \u001b[0m\u001b[38;2;215;119;87m◐\u001b[0m\u001b[38;2;153;153;153m Medium effort (default)\u001b[0m\u001b[38;2;80;80;80m ←/→ to adjust\u001b[0m\n   \u001b[0m\u001b[38;2;153;153;153mEnter to set as default · s to use this session only · Esc to cancel\u001b[0m"

describe("a dialog rule with an inline label still opens the dialog", () => {
  test("the model picker parses as the picker, not as the whole screen", () => {
    const d = parseDialog(unstyle(herdrScreen(PICKER_AFTER_PICK)))
    expect(d?.title).toBe("Select model")
    expect(isModelPicker(d)).toBe(true)
    expect(d?.items).toHaveLength(10)
    expect(d?.items[0]?.text).toContain("Default (recommended)")
    expect(d?.items[0]?.selected).toBe(true)
    expect(d?.items.some((it) => it.text === "/model")).toBe(false)
  })

  test("a plain rule is still a rule", () => {
    const pane = [
      "❯ /model",
      "  ⎿  Kept model as Opus 5.5 (default)",
      "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
      "   Select model",
      "   ❯ 1.  Default (recommended) ✔  Opus 5.5",
      "     2.  Opus 5.5                 For complex work",
      "   Enter to set as default · s to use this session only · Esc to cancel",
    ].join("\n")
    expect(parseDialog(pane)?.title).toBe("Select model")
  })
})
