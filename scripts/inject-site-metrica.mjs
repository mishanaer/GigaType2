import { readFile, writeFile } from "node:fs/promises";

const indexPath = new URL("../site/index.html", import.meta.url);
const counterId = "110570567";
const scriptReference = '<script src="/metrica.js?v=20260727-1"></script>';
const fallbackCounter =
  `<noscript><div><img src="https://mc.yandex.ru/watch/${counterId}" ` +
  'style="position:absolute;left:-9999px" alt=""/></div></noscript>';
const source = await readFile(indexPath, "utf8");

if (!source.includes("</head>") || !source.includes("<body>")) {
  throw new Error("Unexpected exported HTML structure");
}

const withoutOldScript = source.replace(
  /<script src="\/metrica\.js(?:\?[^"]*)?"><\/script>/,
  "",
);
const withoutOldFallback = withoutOldScript.replace(
  new RegExp(
    `<noscript><div><img src="https://mc\\.yandex\\.ru/watch/${counterId}"[^>]*>` +
      `</div></noscript>`,
  ),
  "",
);
const withScript = withoutOldFallback.replace(
  "</head>",
  `${scriptReference}</head>`,
);
const result = withScript.replace(
  "<body>",
  `<body>${fallbackCounter}`,
);

if (result !== source) {
  await writeFile(indexPath, result);
}
