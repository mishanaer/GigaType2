/*
MIT License

Copyright (c) 2020 Flavio Maria De Stefano

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Derived from siriwave's iOS9 renderer and adapted for GigaType.
*/

class IOS9Curve {
  GRAPH_X = 25;
  AMPLITUDE_FACTOR = 0.8;
  SPEED_FACTOR = 1;
  DEAD_PX = 2;
  ATT_FACTOR = 4;
  DESPAWN_FACTOR = 0.02;

  DEFAULT_NO_OF_CURVES_RANGES = [2, 5];
  DEFAULT_AMPLITUDE_RANGES = [0.3, 1];
  DEFAULT_OFFSET_RANGES = [-3, 3];
  DEFAULT_WIDTH_RANGES = [1, 3];
  DEFAULT_SPEED_RANGES = [0.5, 1];
  DEFAULT_DESPAWN_TIMEOUT_RANGES = [500, 2000];

  constructor(ctrl, definition) {
    this.ctrl = ctrl;
    this.definition = definition;
    this.spawnAt = 0;
    this.noOfCurves = 0;
    this.prevMaxY = 0;
    this.phases = [];
    this.amplitudes = [];
    this.despawnTimeouts = [];
    this.offsets = [];
    this.speeds = [];
    this.finalAmplitudes = [];
    this.widths = [];
    this.verses = [];
  }

  getRandomRange(range) {
    return range[0] + Math.random() * (range[1] - range[0]);
  }

  spawnSingle(curveIndex) {
    const ranges = this.ctrl.opt.ranges || {};

    this.phases[curveIndex] = 0;
    this.amplitudes[curveIndex] = 0;
    this.despawnTimeouts[curveIndex] = this.getRandomRange(
      ranges.despawnTimeout || this.DEFAULT_DESPAWN_TIMEOUT_RANGES
    );
    this.offsets[curveIndex] = this.getRandomRange(ranges.offset || this.DEFAULT_OFFSET_RANGES);
    this.speeds[curveIndex] = this.getRandomRange(ranges.speed || this.DEFAULT_SPEED_RANGES);
    this.finalAmplitudes[curveIndex] = this.getRandomRange(
      ranges.amplitude || this.DEFAULT_AMPLITUDE_RANGES
    );
    this.widths[curveIndex] = this.getRandomRange(ranges.width || this.DEFAULT_WIDTH_RANGES);
    this.verses[curveIndex] = this.getRandomRange([-1, 1]);
  }

  spawn() {
    const ranges = this.ctrl.opt.ranges || {};

    this.spawnAt = Date.now();
    this.noOfCurves = Math.floor(
      this.getRandomRange(ranges.noOfCurves || this.DEFAULT_NO_OF_CURVES_RANGES)
    );

    this.phases = new Array(this.noOfCurves);
    this.offsets = new Array(this.noOfCurves);
    this.speeds = new Array(this.noOfCurves);
    this.finalAmplitudes = new Array(this.noOfCurves);
    this.widths = new Array(this.noOfCurves);
    this.amplitudes = new Array(this.noOfCurves);
    this.despawnTimeouts = new Array(this.noOfCurves);
    this.verses = new Array(this.noOfCurves);

    for (let curveIndex = 0; curveIndex < this.noOfCurves; curveIndex += 1) {
      this.spawnSingle(curveIndex);
    }
  }

  curveAttenuation(x) {
    return Math.pow(this.ATT_FACTOR / (this.ATT_FACTOR + Math.pow(x, 2)), this.ATT_FACTOR);
  }

  edgeEnvelope(i) {
    const fadeStart = Math.min(Math.max(this.ctrl.opt.edgeFadeStart ?? 0.82, 0), 0.98);
    const distanceFromCenter = Math.min(Math.abs(i / this.GRAPH_X), 1);

    if (distanceFromCenter <= fadeStart) {
      return 1;
    }

    const t = (distanceFromCenter - fadeStart) / (1 - fadeStart);
    return 1 - t * t * (3 - 2 * t);
  }

  yRelativePos(i) {
    let y = 0;

    for (let curveIndex = 0; curveIndex < this.noOfCurves; curveIndex += 1) {
      let t = 4 * (-1 + (curveIndex / (this.noOfCurves - 1)) * 2);
      t += this.offsets[curveIndex];

      const k = 1 / this.widths[curveIndex];
      const x = i * k - t;

      y += Math.abs(
        this.amplitudes[curveIndex] *
          Math.sin(this.verses[curveIndex] * x - this.phases[curveIndex]) *
          this.curveAttenuation(x)
      );
    }

    return y / this.noOfCurves;
  }

  yPos(i) {
    return (
      this.AMPLITUDE_FACTOR *
      this.ctrl.heightMax *
      this.ctrl.amplitude *
      this.yRelativePos(i) *
      this.edgeEnvelope(i)
    );
  }

  xPos(i) {
    return this.ctrl.width * ((i + this.GRAPH_X) / (this.GRAPH_X * 2));
  }

  drawSupportLine() {
    const { ctx } = this.ctrl;
    const y = this.ctrl.centerY;
    const gradient = ctx.createLinearGradient(0, y, this.ctrl.width, y);

    gradient.addColorStop(0, "transparent");
    gradient.addColorStop(0.1, "rgba(255,255,255,.5)");
    gradient.addColorStop(0.9, "rgba(255,255,255,.5)");
    gradient.addColorStop(1, "transparent");

    ctx.fillStyle = gradient;
    ctx.fillRect(0, y, this.ctrl.width, 1);
  }

  draw() {
    const { ctx } = this.ctrl;

    ctx.globalAlpha = 0.7;
    ctx.globalCompositeOperation = this.ctrl.opt.globalCompositeOperation;

    if (this.spawnAt === 0) {
      this.spawn();
    }

    if (this.definition.supportLine) {
      this.drawSupportLine();
      return;
    }

    for (let curveIndex = 0; curveIndex < this.noOfCurves; curveIndex += 1) {
      if (this.spawnAt + this.despawnTimeouts[curveIndex] <= Date.now()) {
        this.amplitudes[curveIndex] -= this.DESPAWN_FACTOR;
      } else {
        this.amplitudes[curveIndex] += this.DESPAWN_FACTOR;
      }

      this.amplitudes[curveIndex] = Math.min(
        Math.max(this.amplitudes[curveIndex], 0),
        this.finalAmplitudes[curveIndex]
      );
      this.phases[curveIndex] =
        (this.phases[curveIndex] + this.ctrl.speed * this.speeds[curveIndex] * this.SPEED_FACTOR) %
        (2 * Math.PI);
    }

    let maxY = -Infinity;

    for (const sign of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(0, this.ctrl.centerY);

      for (let i = -this.GRAPH_X; i <= this.GRAPH_X; i += this.ctrl.opt.pixelDepth) {
        const x = this.xPos(i);
        const y = this.yPos(i);
        ctx.lineTo(x, this.ctrl.centerY - sign * y);
        maxY = Math.max(maxY, y);
      }

      ctx.lineTo(this.ctrl.width, this.ctrl.centerY);
      ctx.closePath();
      ctx.fillStyle = `rgba(${this.definition.color}, 1)`;
      ctx.strokeStyle = `rgba(${this.definition.color}, 1)`;
      ctx.fill();
    }

    if (maxY < this.DEAD_PX && this.prevMaxY > maxY) {
      this.spawnAt = 0;
    }

    this.prevMaxY = maxY;
  }

  static getDefinition() {
    return [
      { color: "255,255,255", supportLine: true },
      { color: "15, 82, 169" },
      { color: "173, 57, 76" },
      { color: "48, 220, 155" },
    ];
  }
}

export default class CustomSiriWave {
  constructor({ container, ...rest }) {
    const csStyle = window.getComputedStyle(container);

    this.opt = {
      container,
      style: "ios9",
      ratio: window.devicePixelRatio || 1,
      speed: 0.2,
      amplitude: 1,
      cover: false,
      width: parseInt(csStyle.width.replace("px", ""), 10),
      height: parseInt(csStyle.height.replace("px", ""), 10),
      autostart: true,
      pixelDepth: 0.02,
      lerpSpeed: 0.1,
      globalCompositeOperation: "lighter",
      edgeFadeStart: 0.82,
      ...rest,
    };

    this.phase = 0;
    this.run = false;
    this.speed = Number(this.opt.speed);
    this.amplitude = Number(this.opt.amplitude);
    this.width = Number(this.opt.ratio * this.opt.width);
    this.height = Number(this.opt.ratio * this.opt.height);
    this.centerY = Number(this.height / 2);
    this.heightMax = Number(this.height / 2) - 6;
    this.interpolation = {
      speed: this.speed,
      amplitude: this.amplitude,
    };

    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Unable to create 2D Context");
    }
    this.ctx = ctx;

    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.display = "block";

    if (this.opt.cover) {
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
    } else {
      this.canvas.style.width = `${this.width / this.opt.ratio}px`;
      this.canvas.style.height = `${this.height / this.opt.ratio}px`;
    }

    this.curves = (this.opt.curveDefinition || IOS9Curve.getDefinition()).map(
      (definition) => new IOS9Curve(this, definition)
    );

    this.opt.container.appendChild(this.canvas);

    if (this.opt.autostart) {
      this.start();
    }
  }

  intLerp(v0, v1, t) {
    return v0 * (1 - t) + v1 * t;
  }

  lerp(propertyStr) {
    const prop = this.interpolation[propertyStr];
    if (prop !== null) {
      this[propertyStr] = this.intLerp(this[propertyStr], prop, this.opt.lerpSpeed);
      if (this[propertyStr] - prop === 0) {
        this.interpolation[propertyStr] = null;
      }
    }
    return this[propertyStr];
  }

  clear() {
    this.ctx.globalCompositeOperation = "destination-out";
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.globalCompositeOperation = "source-over";
  }

  draw() {
    this.curves.forEach((curve) => curve.draw());
  }

  startDrawCycle() {
    this.clear();
    this.lerp("amplitude");
    this.lerp("speed");
    this.draw();

    if (window.requestAnimationFrame) {
      this.animationFrameId = window.requestAnimationFrame(this.startDrawCycle.bind(this));
    } else {
      this.timeoutId = setTimeout(this.startDrawCycle.bind(this), 20);
    }
  }

  start() {
    if (!this.canvas) {
      throw new Error("This instance of CustomSiriWave has been disposed");
    }

    this.phase = 0;
    if (!this.run) {
      this.run = true;
      this.startDrawCycle();
    }
  }

  stop() {
    this.phase = 0;
    this.run = false;

    if (this.animationFrameId) {
      window.cancelAnimationFrame(this.animationFrameId);
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
  }

  dispose() {
    this.stop();
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
  }

  set(propertyStr, value) {
    this.interpolation[propertyStr] = value;
  }

  setSpeed(value) {
    this.set("speed", value);
  }

  setAmplitude(value) {
    this.set("amplitude", value);
  }
}
