#!/usr/bin/env node
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import OpenAI from "openai";
import path from "path";
import { VECTOR_STORE_ID } from "./index.js";
import { BatchProcessor, SUPPORTED_EXTENSIONS } from "./webhookHandler.js";

dotenv.config();

const githubToken = process.env.GITHUB_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;
const repoFullName = process.env.REPO_FULL_NAME!;
const vectorStoreId = VECTOR_STORE_ID;

if (!githubToken || !openaiApiKey || !repoFullName || !vectorStoreId) {
  console.error(
    "Missing required environment variables: GITHUB_TOKEN, OPENAI_API_KEY, REPO_FULL_NAME, VECTOR_STORE_ID"
  );
  process.exit(1);
}

const octokit = new Octokit({ auth: githubToken });
const openai = new OpenAI({ apiKey: openaiApiKey });

async function listAllFiles(
  owner: string,
  repo: string,
  ref = "main",
  dir = ""
): Promise<string[]> {
  const files: string[] = [];
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path: dir,
    ref,
  });
  if (Array.isArray(response.data)) {
    for (const item of response.data) {
      if (item.type === "file") {
        files.push(item.path);
      } else if (item.type === "dir") {
        const subFiles = await listAllFiles(owner, repo, ref, item.path);
        files.push(...subFiles);
      }
    }
  }
  return files;
}

async function fetchFileContent(
  owner: string,
  repo: string,
  filePath: string,
  ref = "main"
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref,
    });
    if ("content" in response.data && response.data.content) {
      return Buffer.from(response.data.content, "base64").toString("utf-8");
    }
    return null;
  } catch (error) {
    console.error(`Error fetching file content for ${filePath}:`, error);
    return null;
  }
}

async function main() {
  const [owner, repo] = repoFullName.split("/");
  console.log(`Listing all files in ${repoFullName}...`);
  const allFiles = await listAllFiles(owner, repo);
  const supportedFiles = allFiles.filter((file) => {
    const ext = path.extname(file).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  });
  console.log(`Found ${supportedFiles.length} supported files.`);

  const batch = [];
  for (const file of supportedFiles) {
    const content = await fetchFileContent(owner, repo, file);
    if (content) {
      batch.push({ filename: file, status: "added" as const, content });
    }
  }

  const processor = new BatchProcessor();
  console.log(`Uploading ${batch.length} files to vector store...`);
  await processor.processFileBatch(repoFullName, batch);
  console.log("Initial sync complete.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Initial sync failed:", err);
  process.exit(1);
});
