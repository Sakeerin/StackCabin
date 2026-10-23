import { verifyCatalog } from "./catalog-lib.mjs";
const catalog = await verifyCatalog(
  undefined,
  process.argv.includes("--release"),
);
console.log(
  `Catalog signature valid; ${catalog.artifacts.length} pinned artifacts.`,
);
