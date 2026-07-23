const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { mapEvent } = require("./tractionEventMapper");

// Продуктовая статистика Traction (stats/ в корне репо; хаб stats.multitool.works).
// Дистиллят телеметрии: TelemetryService.capture() отдаёт сюда уже
// санитизированные события. Маппер оставляет только поля продуктового контракта
// и общий event_id, чтобы direct ingest дедуплицировался с PostHog-backfill.
// Токен write-only и, как и PostHog-ключ выше по конвенции, вшит дефолтом;
// в dev (не packaged) шлём на локальный модуль без токена.
const DEFAULT_PROD_INGEST_URL = "https://stats.multitool.works/p/gigatype/events";
const DEFAULT_PROD_INGEST_TOKEN = "1bfde59ccc9a330b6ae1c7ef3785fa71b398f7ac888a71c0";
const DEFAULT_DEV_INGEST_URL = "http://127.0.0.1:9902/events";

const FLUSH_INTERVAL_MS = 30 * 1000;
const FLUSH_BATCH_SIZE = 200; // сервер принимает ≤500 событий за POST
const MAX_QUEUE_EVENTS = 1000;
const REQUEST_TIMEOUT_MS = 5000;

class TractionAnalytics {
  constructor({ deviceId, queueDir }) {
    this.deviceId = deviceId;
    this.queuePath = path.join(queueDir, "traction-queue.jsonl");
    this.url =
      process.env.GIGATYPE_STATS_INGEST_URL ||
      (app.isPackaged ? DEFAULT_PROD_INGEST_URL : DEFAULT_DEV_INGEST_URL);
    this.token =
      process.env.GIGATYPE_STATS_INGEST_TOKEN ??
      (app.isPackaged ? DEFAULT_PROD_INGEST_TOKEN : "");
    this.flushTimer = null;
    this.flushing = false;
  }

  start() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    setImmediate(() => this.flush().catch(() => {}));
  }

  record(event, properties) {
    const mapped = mapEvent(event, properties);
    if (!mapped) return;
    const line = JSON.stringify({ ts: Date.now() / 1000, ...mapped });
    try {
      fs.appendFileSync(this.queuePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      debugLogger.warn("Traction enqueue failed", { error: error?.message }, "telemetry");
    }
  }

  _readQueue() {
    try {
      const text = fs.readFileSync(this.queuePath, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((item) => item?.name)
        .slice(-MAX_QUEUE_EVENTS);
    } catch {
      return [];
    }
  }

  _writeQueue(items) {
    if (!items.length) {
      try {
        fs.unlinkSync(this.queuePath);
      } catch {}
      return;
    }
    const text = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
    fs.writeFileSync(this.queuePath, text, { mode: 0o600 });
  }

  async flush() {
    if (this.flushing) return { sent: 0 };
    const items = this._readQueue();
    if (!items.length) return { sent: 0 };

    const batch = items.slice(0, FLUSH_BATCH_SIZE);
    this.flushing = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.token ? { "X-Ingest-Token": this.token } : {}),
          },
          body: JSON.stringify({ device_id: this.deviceId, events: batch }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Traction ingest failed: ${response.status}`);
        }
      } finally {
        clearTimeout(timeout);
      }
      // Перечитываем файл: события, дописанные record() во время POST, живут
      // в хвосте — срезаем ровно отправленный батч, а не пишем старый снимок.
      this._writeQueue(this._readQueue().slice(batch.length));
      return { sent: batch.length };
    } catch (error) {
      // Оффлайн/модуль не запущен — батч остаётся; перезапись капит файл
      // (иначе он растёт без предела: _readQueue режет только прочитанное).
      this._writeQueue(this._readQueue());
      debugLogger.debug(
        "Traction flush failed",
        { error: error?.message, count: batch.length },
        "telemetry"
      );
      return { sent: 0, error: error?.message };
    } finally {
      this.flushing = false;
    }
  }

  async shutdown() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush().catch(() => {});
  }
}

module.exports = TractionAnalytics;
