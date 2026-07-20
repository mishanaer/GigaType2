const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const GigaamLocalAsrManager = require("../../src/helpers/gigaamLocalAsr");

const {
  MAX_TRANSCRIPTION_CHUNK_SECONDS,
  MAX_TRANSCRIPTION_CHUNK_SAMPLES,
  findDuplicateSeamWordCount,
  getPcmChunkRanges,
  mergeTranscriptChunk,
  transcribePcmInChunks,
} = GigaamLocalAsrManager._testing;

const SAMPLE_RATE = 16000;

function createPcm16Wav(durationSeconds) {
  const samples = durationSeconds * SAMPLE_RATE;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function createResponse() {
  return {
    statusCode: null,
    body: "",
    endCalls: 0,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body = "") {
      this.endCalls += 1;
      this.body += body;
    },
    setHeader() {},
  };
}

test("local GigaAM keeps recordings up to 25 seconds in one chunk", () => {
  assert.equal(MAX_TRANSCRIPTION_CHUNK_SECONDS, 25);
  assert.equal(MAX_TRANSCRIPTION_CHUNK_SAMPLES, 25 * SAMPLE_RATE);
  assert.deepEqual(getPcmChunkRanges(10 * SAMPLE_RATE), [{ start: 0, end: 10 * SAMPLE_RATE }]);
  assert.deepEqual(getPcmChunkRanges(25 * SAMPLE_RATE), [{ start: 0, end: 25 * SAMPLE_RATE }]);
});

test("local GigaAM splits a 26-second recording into exact sequential buffers", async () => {
  const pcm = new Float32Array(26 * SAMPLE_RATE);
  const calls = [];
  let active = 0;
  let maxActive = 0;

  const result = await transcribePcmInChunks(pcm, async (pcmBuffer, chunk) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({ byteLength: pcmBuffer.byteLength, ...chunk });
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { text: chunk.chunkIndex === 1 ? " первая " : " вторая " };
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(
    calls.map(({ byteLength, samples, chunkIndex, chunksTotal }) => ({
      byteLength,
      samples,
      chunkIndex,
      chunksTotal,
    })),
    [
      {
        byteLength: 25 * SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT,
        samples: 25 * SAMPLE_RATE,
        chunkIndex: 1,
        chunksTotal: 2,
      },
      {
        byteLength: SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT,
        samples: SAMPLE_RATE,
        chunkIndex: 2,
        chunksTotal: 2,
      },
    ]
  );
  assert.deepEqual(result, { text: "первая вторая", chunksTotal: 2 });
});

test("local GigaAM makes one worker request for exactly 25 seconds", async () => {
  let calls = 0;
  const result = await transcribePcmInChunks(new Float32Array(25 * SAMPLE_RATE), async () => {
    calls += 1;
    return { text: "готово" };
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { text: "готово", chunksTotal: 1 });
});

test("local GigaAM removes exact duplicate words at a chunk seam", () => {
  assert.equal(findDuplicateSeamWordCount("Важно, чтобы", "Чтобы приложение"), 1);
  assert.equal(
    mergeTranscriptChunk("Важно, чтобы", "Чтобы приложение работало"),
    "Важно, чтобы приложение работало"
  );
  assert.equal(
    mergeTranscriptChunk("команда, затем", "Затем проверяет изменения"),
    "команда, затем проверяет изменения"
  );
  assert.equal(
    mergeTranscriptChunk("проверить весь текст", "весь текст после записи"),
    "проверить весь текст весь текст после записи"
  );
});

test("local GigaAM preserves likely intentional repetitions", () => {
  assert.equal(
    mergeTranscriptChunk("Он сказал да", "Да, именно так"),
    "Он сказал да Да, именно так"
  );
  assert.equal(mergeTranscriptChunk("Это важно.", "Важно проверить"), "Это важно. Важно проверить");
  assert.equal(
    mergeTranscriptChunk("Это очень важно.", "Это очень важно. Повторяю"),
    "Это очень важно. Это очень важно. Повторяю"
  );
  assert.equal(mergeTranscriptChunk("это важно", "Важно! Потом"), "это важно Важно! Потом");
  assert.equal(
    mergeTranscriptChunk("это важно", "(Важно продолжить)"),
    "это важно (Важно продолжить)"
  );
  assert.equal(
    mergeTranscriptChunk("он сказал «важно!»", "Важно продолжить"),
    "он сказал «важно!» Важно продолжить"
  );
  assert.equal(mergeTranscriptChunk("очень", "длинное сообщение"), "очень длинное сообщение");
});

test("local GigaAM preserves order and ignores empty chunk transcripts", async () => {
  const longRanges = getPcmChunkRanges(180 * SAMPLE_RATE);
  assert.equal(longRanges.length, 8);
  assert.deepEqual(longRanges[0], { start: 0, end: 25 * SAMPLE_RATE });
  assert.deepEqual(longRanges.at(-1), {
    start: 175 * SAMPLE_RATE,
    end: 180 * SAMPLE_RATE,
  });

  const ranges = getPcmChunkRanges(310 * SAMPLE_RATE);
  assert.equal(ranges.length, 13);
  assert.deepEqual(ranges[0], { start: 0, end: 25 * SAMPLE_RATE });
  assert.deepEqual(ranges.at(-1), {
    start: 300 * SAMPLE_RATE,
    end: 310 * SAMPLE_RATE,
  });

  const replies = ["первая", "   ", "третья"];
  const result = await transcribePcmInChunks(
    new Float32Array(10),
    async (_pcmBuffer, chunk) => ({ text: replies[chunk.chunkIndex - 1] }),
    { maxChunkSamples: 4 }
  );

  assert.deepEqual(result, { text: "первая третья", chunksTotal: 3 });

  const separatedReplies = ["это важно", "", "Важно продолжить"];
  const separated = await transcribePcmInChunks(
    new Float32Array(10),
    async (_pcmBuffer, chunk) => ({ text: separatedReplies[chunk.chunkIndex - 1] }),
    { maxChunkSamples: 4 }
  );
  assert.deepEqual(separated, {
    text: "это важно Важно продолжить",
    chunksTotal: 3,
  });
});

test("local GigaAM does not return partial text when a chunk fails", async () => {
  const calls = [];

  await assert.rejects(
    transcribePcmInChunks(
      new Float32Array(10),
      async (_pcmBuffer, chunk) => {
        calls.push(chunk.chunkIndex);
        if (chunk.chunkIndex === 2) throw new Error("chunk failed");
        return { text: `part ${chunk.chunkIndex}` };
      },
      { maxChunkSamples: 4 }
    ),
    /chunk failed/
  );

  assert.deepEqual(calls, [1, 2]);
});

test("local GigaAM endpoint returns one combined response for long audio", async () => {
  const boundary = "type-long-audio-test";
  const wav = createPcm16Wav(26);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    ),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const manager = new GigaamLocalAsrManager();
  manager.healthStatus = "ok";
  const workerBufferLengths = [];
  manager._requestGigaamChunk = async (pcmBuffer) => {
    workerBufferLengths.push(pcmBuffer.byteLength);
    return { text: workerBufferLengths.length === 1 ? "первая" : "вторая" };
  };

  const request = new PassThrough();
  request.method = "POST";
  request.url = "/v1/audio/transcriptions";
  request.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const response = createResponse();

  const pending = manager._handleRequest(request, response);
  request.end(body);
  await pending;

  assert.deepEqual(workerBufferLengths, [
    25 * SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT,
    SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT,
  ]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.endCalls, 1);
  assert.deepEqual(JSON.parse(response.body), { text: "первая вторая" });
});
