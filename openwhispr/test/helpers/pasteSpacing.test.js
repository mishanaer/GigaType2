const test = require("node:test");
const assert = require("node:assert/strict");

async function load() {
  return await import("../../src/utils/pasteSpacing.js");
}

test("adds a space between two recent word-ending/word-starting pastes", async () => {
  const { computeSmartSpacingPrefix } = await load();
  const prev = { text: "Оля просила при ней не курить", pastedAt: 1000 };
  assert.equal(computeSmartSpacingPrefix(prev, "Потому что она сама бросала", 31000), " ");
});

test("adds a space after a closing straight quote", async () => {
  const { computeSmartSpacingPrefix } = await load();
  assert.equal(
    computeSmartSpacingPrefix({ text: 'он сказал "да"', pastedAt: 1000 }, "Потом ушёл", 2000),
    " "
  );
});

test("adds a space after an em dash (Russian dashes are spaced on both sides)", async () => {
  const { computeSmartSpacingPrefix } = await load();
  assert.equal(
    computeSmartSpacingPrefix({ text: "Москва —", pastedAt: 1000 }, "столица России", 2000),
    " "
  );
});

test("adds a space before an opening bracket or guillemet", async () => {
  const { computeSmartSpacingPrefix } = await load();
  const prev = { text: "он сказал", pastedAt: 1000 };
  assert.equal(computeSmartSpacingPrefix(prev, "«Привет» и ушёл", 2000), " ");
  assert.equal(computeSmartSpacingPrefix(prev, "(в скобках)", 2000), " ");
});

test("no space when previous paste ended with whitespace", async () => {
  const { computeSmartSpacingPrefix } = await load();
  assert.equal(computeSmartSpacingPrefix({ text: "привет ", pastedAt: 1000 }, "мир", 2000), "");
  assert.equal(computeSmartSpacingPrefix({ text: "строка\n", pastedAt: 1000 }, "мир", 2000), "");
});

test("no space when next text starts with punctuation, whitespace, or a command", async () => {
  const { computeSmartSpacingPrefix } = await load();
  const prev = { text: "конец фразы", pastedAt: 1000 };
  for (const next of [", продолжение", ".", " уже с пробелом", ") скобка", "!", "…", "/remind me", "@user", "#tag"]) {
    assert.equal(computeSmartSpacingPrefix(prev, next, 2000), "", `next=${JSON.stringify(next)}`);
  }
});

test("no space when previous paste ended with an opening bracket/quote or hyphen", async () => {
  const { computeSmartSpacingPrefix } = await load();
  for (const prevText of ["скобка (", "кавычка «", "дефис -", "путь /"]) {
    assert.equal(
      computeSmartSpacingPrefix({ text: prevText, pastedAt: 1000 }, "слово", 2000),
      "",
      `prev=${JSON.stringify(prevText)}`
    );
  }
});

test("no space when the previous paste is outside the window (either direction)", async () => {
  const { computeSmartSpacingPrefix, SMART_SPACING_WINDOW_MS } = await load();
  const prev = { text: "старый текст", pastedAt: 1000 };
  assert.equal(computeSmartSpacingPrefix(prev, "новый", 1000 + SMART_SPACING_WINDOW_MS + 1), "");
  assert.equal(computeSmartSpacingPrefix(prev, "новый", 1000 + SMART_SPACING_WINDOW_MS), " ");
  assert.equal(
    computeSmartSpacingPrefix({ text: "текст", pastedAt: 5000 + SMART_SPACING_WINDOW_MS }, "новый", 1000),
    ""
  );
});

test("no space without a previous paste or with malformed state", async () => {
  const { computeSmartSpacingPrefix } = await load();
  assert.equal(computeSmartSpacingPrefix(null, "текст", 1000), "");
  assert.equal(computeSmartSpacingPrefix(undefined, "текст", 1000), "");
  assert.equal(computeSmartSpacingPrefix({ text: "", pastedAt: 1 }, "текст", 1000), "");
  assert.equal(computeSmartSpacingPrefix({ text: "а", pastedAt: NaN }, "текст", 1000), "");
  assert.equal(computeSmartSpacingPrefix({ text: "а", pastedAt: 1 }, "", 1000), "");
});
