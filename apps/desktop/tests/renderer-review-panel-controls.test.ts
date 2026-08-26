import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("../src/renderer/review/ReviewPanel.tsx", import.meta.url), "utf8");
const diffRow = readFileSync(new URL("../src/renderer/review/DiffRow.tsx", import.meta.url), "utf8");
const diffFileView = readFileSync(new URL("../src/renderer/review/DiffFileView.tsx", import.meta.url), "utf8");
const documentPreview = readFileSync(new URL("../src/renderer/review/DocumentReviewPreview.tsx", import.meta.url), "utf8");
const preferences = readFileSync(new URL("../src/renderer/review/reviewPreferences.ts", import.meta.url), "utf8");
const generalSettings = readFileSync(new URL("../src/renderer/GeneralSettings.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
const motionStyles = readFileSync(new URL("../src/renderer/styles/motion-accessibility.css", import.meta.url), "utf8");
const workspaceStyles = readFileSync(new URL("../src/renderer/styles/review-workspace.css", import.meta.url), "utf8");
const diffStyles = readFileSync(new URL("../src/renderer/styles/review-diff.css", import.meta.url), "utf8");

function declarations(styles: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`));
  assert.ok(match?.groups?.body, `${selector} should be styled`);
  return match.groups.body;
}

test("the feedback button sizes to its own label", () => {
  // It sat in a two-column grid whose 42px first track was reserved for a
  // confirm button that no longer exists, so "Leave feedback" was laid out in
  // 42px: the label spilled out of its pill and across the layout control
  // beside it, which is what made the toolbar look broken.
  const controls = declarations(diffStyles, ".reviewFeedbackSelectionControls");
  assert.match(controls, /display:\s*inline-flex/);
  assert.doesNotMatch(controls, /grid-template-columns/);
  // The slot the track was holding open is gone from the markup, so its
  // styling must go too rather than wait for the next reader to trust it.
  assert.doesNotMatch(diffStyles, /reviewSelectionConfirm/);
  assert.doesNotMatch(panel, /reviewSelectionConfirm/);
});

test("arming feedback does not move the toolbar around it", () => {
  // "Leave feedback" and "Done" are different lengths, so a pill that sized to
  // its text re-centred the word and slid its neighbours along the row every
  // time the mode was toggled.
  const button = declarations(workspaceStyles, ".reviewFeedbackModeButton");
  assert.match(button, /min-width:\s*128px/);
  assert.match(button, /justify-content:\s*center/);
});

test("a file with no earlier version drops the layout toggle instead of disabling it", () => {
  // Two `disabled` buttons looked exactly like the ordinary inactive state, so
  // the control read as broken rather than as inapplicable.
  assert.match(panel, /splitFits && selectedFile\.status !== "added" \?/);
  assert.doesNotMatch(panel, /disabled=\{selectedFile\.status === "added"\}/);
  assert.doesNotMatch(panel, /A new file has no earlier version to compare against/);
});

test("nothing is inserted between the toolbar and the diff when feedback is armed", () => {
  // The banner appeared on arming and vanished on the first click, pushing the
  // diff down and then pulling it back up under the pointer.
  assert.doesNotMatch(panel, /reviewCommentingHint/);
  assert.doesNotMatch(workspaceStyles, /reviewCommentingHint/);
  assert.doesNotMatch(panel, /the feedback box opens on the first click/);
});

test("the feedback editor is docked, not floated over the line it belongs to", () => {
  // Anchored to the click, it covered the very lines being commented on and
  // opened somewhere new every time. It is now the last child of the file
  // canvas, below the scroller, so it lands in one place and the diff above it
  // keeps its own scroll instead of being pushed.
  assert.match(panel, /<\/div>\s*\n\s*\{editor\}\s*\n\s*<\/main>/);
  assert.match(panel, /className="reviewFeedbackDock"/);
  assert.doesNotMatch(panel, /inlineReviewCommentAnchor/);
  assert.doesNotMatch(diffStyles, /inlineReviewCommentAnchor/);
  // Neither view renders it any more, so neither needs to be told where it is.
  for (const view of [diffFileView, documentPreview]) {
    assert.doesNotMatch(view, /\{editor\}/);
    assert.doesNotMatch(view, /\beditor: React\.ReactNode/);
  }
  // And the selection no longer has to name a row to be anchored under.
  assert.doesNotMatch(diffRow, /rowId/);
  const dock = declarations(diffStyles, ".reviewFeedbackDock");
  assert.match(dock, /flex:\s*0 0 auto/);
  assert.match(dock, /border-top/);
  assert.match(motionStyles, /\.reviewFeedbackDock \{ animation-name: none !important; \}/);
});

test("cancel, escape, and hiding the panel all leave feedback mode", () => {
  // The mode used to stay armed with the button still reading "Done", which
  // left the toolbar looking stuck in a state nobody chose.
  assert.match(panel, /const stopCommenting = \(\) => \{\s*\n\s*setCommenting\(false\);/);
  assert.match(panel, /onClick=\{stopCommenting\}>Cancel</);
  // Escape works from anywhere in the panel, not only from inside the box:
  // with nothing selected there is no box to press it in.
  assert.match(panel, /if \(event\.key !== "Escape" \|\| !commenting\) return;/);
  assert.match(panel, /if \(open\) return;\s*\n\s*setCommenting\(false\);/);
  // False the moment the panel is asked to close, so an interrupted animation
  // cannot leave the mode armed behind a panel nobody can see.
  assert.match(main, /open=\{reviewOpen && !reviewClosing\}/);
});

test("the review layout and wrap preferences are one live value", () => {
  // Both places used to hold their own useState copy seeded at mount, and both
  // are mounted at once — so neither ever saw the other's change and the
  // settings rows looked like they did nothing.
  assert.match(preferences, /export function useReviewLayout\(\)/);
  assert.match(preferences, /export function useReviewWrap\(\)/);
  assert.match(preferences, /useSyncExternalStore/);
  for (const source of [panel, generalSettings]) {
    assert.match(source, /useReviewLayout\(\)/);
    assert.match(source, /useReviewWrap\(\)/);
    // No second copy of the value, and no direct writes behind the store's back.
    assert.doesNotMatch(source, /localStorage\.getItem\((?:reviewViewModeKey|reviewWrapKey)\)/);
    assert.doesNotMatch(source, /localStorage\.setItem\((?:reviewViewModeKey|reviewWrapKey)/);
  }
});

test("one possible scope is stated, not offered as a menu of one", () => {
  // Whole diff compares against HEAD, so a chat working outside a git folder
  // has no second scope. The picker still opened, on a single row.
  assert.match(panel, /\{canUseWorktreeScope \? \(/);
  assert.match(panel, /className="reviewScopeLabel"/);
  // Inside the menu the option is unconditional now — the branch that used to
  // hide it there is what produced the one-row menu.
  const menu = panel.slice(panel.indexOf('className="reviewScopeMenu"'), panel.indexOf("reviewScopeLabel"));
  assert.doesNotMatch(menu, /canUseWorktreeScope/);
  // Nothing about the label invites a press.
  const label = declarations(workspaceStyles, ".reviewScopeLabel");
  assert.doesNotMatch(label, /border:/);
});

test("every real line answers a click, in both layouts", () => {
  // Side by side used to accept the new side only, so half the pane swallowed
  // clicks in silence — while unified accepted the very deletions it refused.
  assert.match(diffRow, /const canSelect = \(cell: DiffCell\) => cell\.line !== null && cell\.origin !== "empty";/);
  assert.doesNotMatch(diffRow, /newSideOnly/);
  assert.doesNotMatch(diffFileView, /newSideOnly/);
  // The hover outline and pointer cursor are what say so, at no cost in layout.
  assert.match(diffStyles, /\.reviewDiffCanvas\.isCommenting \.reviewDiffCell\.isPickable:hover/);
  assert.match(declarations(diffStyles, ".reviewDiffCanvas.isCommenting .reviewDiffCell.isPickable:hover"), /cursor:\s*pointer/);
  // The editor still opens itself on the first selection rather than waiting
  // behind a confirm step.
  assert.match(panel, /if \(hasSelection\) setEditorOpen\(true\);/);
});
