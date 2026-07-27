import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../site/metrica.js", import.meta.url),
  "utf8",
);
const storage = new Map();

class FakeElement {
  constructor(href, download) {
    this.href = href;
    this.download = download;
  }

  closest(selector) {
    return selector === "a[download]" ? this : null;
  }

  getAttribute(name) {
    return name === "download" ? this.download : null;
  }
}

function loadPage() {
  const calls = [];
  const navigations = [];
  let clickHandler;
  const context = {
    Date,
    Element: FakeElement,
    window: {
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      location: {
        assign: (url) => navigations.push(url),
      },
      setTimeout: (callback) => callback(),
    },
    document: {
      scripts: [],
      createElement: () => ({}),
      getElementsByTagName: () => [
        { parentNode: { insertBefore() {} } },
      ],
      addEventListener: (name, handler) => {
        if (name === "click") {
          clickHandler = handler;
        }
      },
    },
    ym: (...args) => {
      calls.push(args);

      if (typeof args.at(-1) === "function") {
        args.at(-1)();
      }
    },
  };

  context.window.ym = context.ym;
  vm.createContext(context);
  vm.runInContext(source, context);

  return { calls, clickHandler, navigations };
}

function clickDownload(page, href, download) {
  page.clickHandler({
    target: new FakeElement(href, download),
    preventDefault() {},
  });
}

const firstVisit = loadPage();
clickDownload(firstVisit, "https://example.test/Type.dmg", "Type.dmg");
clickDownload(firstVisit, "https://example.test/Type.exe", "Type.exe");

const firstVisitGoals = firstVisit.calls.slice(1).map((call) => call[2]);
const expectedFirstVisitGoals = [
  "click_button_download",
  "click_button_download_macos",
  "click_button_download_uniq",
  "click_button_download",
  "click_button_download_windows",
];

if (
  JSON.stringify(firstVisitGoals) !==
  JSON.stringify(expectedFirstVisitGoals)
) {
  throw new Error(`Unexpected first-visit goals: ${firstVisitGoals.join(", ")}`);
}

if (firstVisit.navigations.length !== 2) {
  throw new Error("Downloads did not continue after analytics callbacks");
}

const repeatVisit = loadPage();
clickDownload(repeatVisit, "https://example.test/Type.dmg", "Type.dmg");

const repeatVisitGoals = repeatVisit.calls.slice(1).map((call) => call[2]);
const expectedRepeatVisitGoals = [
  "click_button_download",
  "click_button_download_macos",
];

if (
  JSON.stringify(repeatVisitGoals) !==
  JSON.stringify(expectedRepeatVisitGoals)
) {
  throw new Error(`Unexpected repeat-visit goals: ${repeatVisitGoals.join(", ")}`);
}

console.log(
  "Counter initialized; common/platform goals fire per download; unique goal fires once across visits.",
);
