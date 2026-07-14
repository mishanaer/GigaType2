const test = require("node:test");
const assert = require("node:assert/strict");

const GigaamLocalAsrManager = require("../../src/helpers/gigaamLocalAsr");

function createResponse() {
  const headers = new Map();
  return {
    statusCode: null,
    body: "",
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    writeHead(statusCode, values = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
    },
    end(body = "") {
      this.body += body;
    },
  };
}

test("local GigaAM allows the loopback dev renderer origin", async () => {
  const manager = new GigaamLocalAsrManager();
  const response = createResponse();

  await manager._handleRequest(
    {
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5183" },
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.getHeader("Access-Control-Allow-Origin"), "http://localhost:5183");
  assert.equal(response.getHeader("Vary"), "Origin");
});

test("local GigaAM answers loopback CORS preflight requests", async () => {
  const manager = new GigaamLocalAsrManager();
  const response = createResponse();

  await manager._handleRequest(
    {
      method: "OPTIONS",
      url: "/v1/audio/transcriptions",
      headers: { origin: "http://127.0.0.1:5183" },
    },
    response
  );

  assert.equal(response.statusCode, 204);
  assert.equal(response.getHeader("Access-Control-Allow-Origin"), "http://127.0.0.1:5183");
  assert.equal(response.getHeader("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
});

test("local GigaAM does not grant CORS access to external origins", async () => {
  const manager = new GigaamLocalAsrManager();
  const response = createResponse();

  await manager._handleRequest(
    {
      method: "GET",
      url: "/health",
      headers: { origin: "https://example.com" },
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.getHeader("Access-Control-Allow-Origin"), undefined);
});
