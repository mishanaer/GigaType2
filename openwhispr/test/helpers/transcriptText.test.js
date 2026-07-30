const test = require("node:test");
const assert = require("node:assert/strict");

const { transcriptsOverlap, transcriptsLooselyOverlap } = require("../../src/helpers/transcriptText");
const transcriptionFormatting = import("../../src/utils/transcriptionFormatting.js");

test("stripSingleTerminalPeriod removes only a final standalone period", async () => {
  const { stripSingleTerminalPeriod } = await transcriptionFormatting;
  assert.equal(stripSingleTerminalPeriod("Готово."), "Готово");
  assert.equal(stripSingleTerminalPeriod("  Готово.  "), "Готово");
  assert.equal(stripSingleTerminalPeriod("Версия 1.2 готова."), "Версия 1.2 готова");
});

test("stripSingleTerminalPeriod preserves other terminal punctuation", async () => {
  const { stripSingleTerminalPeriod } = await transcriptionFormatting;
  assert.equal(stripSingleTerminalPeriod("Готово..."), "Готово...");
  assert.equal(stripSingleTerminalPeriod("Готово.."), "Готово..");
  assert.equal(stripSingleTerminalPeriod("Готово?"), "Готово?");
  assert.equal(stripSingleTerminalPeriod("Готово!"), "Готово!");
  assert.equal(stripSingleTerminalPeriod(""), "");
});

test("stripHesitationEs removes standalone hesitation variants", async () => {
  const { stripHesitationEs } = await transcriptionFormatting;

  assert.equal(stripHesitationEs("Я э думаю."), "Я думаю.");
  assert.equal(stripHesitationEs("Я, э-э-э, думаю."), "Я, думаю.");
  assert.equal(stripHesitationEs("Э-э-э. Продолжаем."), "Продолжаем.");
  assert.equal(stripHesitationEs("Э-э-э... Продолжаем."), "Продолжаем.");
  assert.equal(stripHesitationEs("э ээ эээ э-э э-э-э э... э…"), "");
  assert.equal(stripHesitationEs("Э — Э — Э, продолжаем."), "продолжаем.");
});

test("stripHesitationEs preserves words containing the letter э", async () => {
  const { stripHesitationEs } = await transcriptionFormatting;

  assert.equal(
    stripHesitationEs("Эмма изучает поэзию и эмпатию."),
    "Эмма изучает поэзию и эмпатию."
  );
});

test("normalizeTranscriptionText removes hesitations before the terminal period", async () => {
  const { normalizeTranscriptionText } = await transcriptionFormatting;

  assert.equal(normalizeTranscriptionText("Я, э..., думаю."), "Я, думаю");
  assert.equal(normalizeTranscriptionText("э-э-э."), "");
});

test("transcriptsOverlap matches near-duplicate meeting transcripts", () => {
  assert.equal(
    transcriptsOverlap(
      "a distribution mechanism? Is it a future product? Is it one of N ways people are",
      "mechanism as a future product? Is it one of the ways we are going to interact wi"
    ),
    true
  );

  assert.equal(
    transcriptsOverlap(
      "with the world? I feel like in search with every shift, you're able to do more w",
      "I feel like in search with every step you're able to do more."
    ),
    true
  );
});

test("transcriptsOverlap stays conservative for short generic fragments", () => {
  assert.equal(transcriptsOverlap("and you know we have", "you know, be a..."), false);
  assert.equal(transcriptsOverlap("Thank you.", "Thanks."), false);
});

test("transcriptsLooselyOverlap catches chunk-boundary paraphrases without matching filler", () => {
  assert.equal(
    transcriptsLooselyOverlap(
      "or just information-seeking queries, will be agent-taken search, You'll be completing tasks, you'll have many threads running. Well, search exist",
      "The inquiry will be agent in search. You will be completing"
    ),
    true
  );

  assert.equal(
    transcriptsLooselyOverlap(
      "You'll be completing tasks, you'll have many threads running. Well, search exist in 10 years? Well, you know, you may... Or it just evolves into something else.",
      "I don't see that many threads running. So, it takes us 10 years? What?"
    ),
    true
  );

  assert.equal(transcriptsLooselyOverlap("and you know we have", "you know, be a..."), false);
});
