import fs from "fs";
import { convertMdxToMd } from "./convertMdxContentToMd.js";

async function run() {
  const inputPath = "./src/sample.mdx";
  const mdxContent = fs.readFileSync(inputPath, "utf8");
  const md = convertMdxToMd(mdxContent);
  console.log("--- Converted Markdown Output ---\n");
  console.log(md);
}

run();
