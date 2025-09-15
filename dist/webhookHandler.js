import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { promisify } from "util";
import { EventEmitter } from "events";
import dotenv from "dotenv";
import { VECTOR_STORE_ID } from "./index.js";
dotenv.config();
let encoder = new TextEncoder();
// Configuration
const config = {
    githubToken: process.env.GITHUB_TOKEN,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    openaiApiKey: process.env.OPENAI_API_KEY,
    tempDir: process.env.TEMP_DIR || "/tmp/webhook-files",
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || "3"),
    queueMaxSize: parseInt(process.env.QUEUE_MAX_SIZE || "100"),
    batchSize: parseInt(process.env.BATCH_SIZE || "10"),
    batchTimeout: parseInt(process.env.BATCH_TIMEOUT_MS || "30000"), // 30 seconds
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || "20"),
    rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"), // 1 minute
};
const octokit = new Octokit({ auth: config.githubToken });
const openai = new OpenAI({ apiKey: config.openaiApiKey });
if (!fs.existsSync(config.tempDir)) {
    fs.mkdirSync(config.tempDir, { recursive: true });
}
export const SUPPORTED_EXTENSIONS = new Set([
    ".md",
    ".txt",
    ".json",
    ".xml",
    ".csv",
    ".pdf",
    ".docx",
]);
class JobQueue extends EventEmitter {
    maxConcurrent;
    maxSize;
    queue = [];
    processing = new Set();
    completed = new Map();
    constructor(maxConcurrent = 3, maxSize = 100) {
        super();
        this.maxConcurrent = maxConcurrent;
        this.maxSize = maxSize;
        this.processQueue();
    }
    addJob(job) {
        if (this.queue.length >= this.maxSize) {
            throw new Error("Queue is at maximum capacity");
        }
        const queueJob = {
            id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            createdAt: new Date(),
            attempts: 0,
            status: "pending",
            ...job,
        };
        // Insert job based on priority (higher priority first)
        const insertIndex = this.queue.findIndex((j) => j.priority < job.priority);
        if (insertIndex === -1) {
            this.queue.push(queueJob);
        }
        else {
            this.queue.splice(insertIndex, 0, queueJob);
        }
        console.log(`Job ${queueJob.id} added to queue (priority: ${job.priority})`);
        this.emit("jobAdded", queueJob);
        return queueJob.id;
    }
    async processQueue() {
        setInterval(() => {
            while (this.processing.size < this.maxConcurrent &&
                this.queue.length > 0) {
                const job = this.queue.find((j) => j.status === "pending");
                if (job) {
                    this.processJob(job);
                }
                else {
                    break;
                }
            }
        }, 1000);
    }
    async processJob(job) {
        job.status = "processing";
        job.attempts++;
        this.processing.add(job.id);
        console.log(`Processing job ${job.id} (attempt ${job.attempts})`);
        this.emit("jobStarted", job);
        try {
            const processor = new BatchProcessor();
            const result = await processor.processFileBatch(job.repository, job.files);
            job.status = "completed";
            this.completed.set(job.id, { status: "completed", result });
            console.log(`Job ${job.id} completed successfully`);
            this.emit("jobCompleted", job, result);
        }
        catch (error) {
            console.error(`Job ${job.id} failed:`, error);
            if (job.attempts < 3) {
                // Retry with exponential backoff
                job.status = "retrying";
                setTimeout(() => {
                    job.status = "pending";
                }, Math.pow(2, job.attempts) * 1000);
                this.emit("jobRetrying", job, error);
            }
            else {
                job.status = "failed";
                job.error = error instanceof Error ? error.message : "Unknown error";
                this.completed.set(job.id, {
                    status: "failed",
                    error: job.error,
                });
                this.emit("jobFailed", job, error);
            }
        }
        finally {
            this.processing.delete(job.id);
            // Remove completed/failed jobs from queue after some time
            setTimeout(() => {
                const index = this.queue.findIndex((j) => j.id === job.id);
                if (index !== -1 &&
                    (job.status === "completed" || job.status === "failed")) {
                    this.queue.splice(index, 1);
                }
            }, 5 * 60 * 1000); // 5 minutes
        }
    }
    getJobStatus(jobId) {
        const queuedJob = this.queue.find((j) => j.id === jobId);
        if (queuedJob) {
            return {
                id: queuedJob.id,
                status: queuedJob.status,
                attempts: queuedJob.attempts,
                createdAt: queuedJob.createdAt,
                error: queuedJob.error,
            };
        }
        const completed = this.completed.get(jobId);
        if (completed) {
            return { id: jobId, ...completed };
        }
        return null;
    }
    getQueueStats() {
        return {
            total: this.queue.length,
            pending: this.queue.filter((j) => j.status === "pending").length,
            processing: this.processing.size,
            retrying: this.queue.filter((j) => j.status === "retrying").length,
            completed: Array.from(this.completed.values()).filter((j) => j.status === "completed").length,
            failed: Array.from(this.completed.values()).filter((j) => j.status === "failed").length,
        };
    }
}
export class BatchProcessor {
    async processFileBatch(repository, files) {
        const batchId = `batch_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;
        console.log(`Starting batch processing for ${files.length} files in ${repository}`);
        const batch = {
            id: batchId,
            repository,
            files,
            vectorStoreId: "",
            status: "processing",
            startedAt: new Date(),
            results: [],
        };
        try {
            // Get or create vector store
            batch.vectorStoreId = await this.getOrCreateVectorStore(repository);
            // Process files in batches
            const results = await this.processBatchFiles(batch.vectorStoreId, files);
            batch.results = results;
            batch.status = "completed";
            batch.completedAt = new Date();
            console.log(`Batch ${batchId} completed: ${results.filter((r) => r.status === "success").length}/${results.length} files processed successfully`);
        }
        catch (error) {
            console.error(`Batch ${batchId} failed:`, error);
            batch.status = "failed";
            batch.error = error instanceof Error ? error.message : "Unknown error";
            batch.completedAt = new Date();
        }
        return batch;
    }
    async getOrCreateVectorStore(repoFullName) {
        try {
            // Try to find existing vector store
            const vectorStores = await openai.vectorStores.list();
            const existingStore = vectorStores.data.find((store) => store.name === `repo-${repoFullName.replace("/", "-")}`);
            let vectorStoreId;
            if (VECTOR_STORE_ID) {
                vectorStoreId = VECTOR_STORE_ID;
                console.log(`Using existing vector store: ${vectorStoreId}`);
            }
            else {
                const vectorStore = await openai.vectorStores.create({
                    name: `repo-${repoFullName.replace("/", "-")}`,
                    expires_after: {
                        anchor: "last_active_at",
                        days: 30,
                    },
                });
                vectorStoreId = vectorStore.id;
                console.log(`Created new vector store: ${vectorStoreId}`);
            }
            return vectorStoreId;
        }
        catch (error) {
            console.error("Error getting/creating vector store:", error);
            throw error;
        }
    }
    async processBatchFiles(vectorStoreId, files) {
        const results = [];
        // Group files by operation type for more efficient processing
        const operations = {
            toRemove: files.filter((f) => f.status === "removed"),
            toAddOrUpdate: files.filter((f) => f.status !== "removed" && f.content),
        };
        // Process removals first (batch delete)
        if (operations.toRemove.length > 0) {
            await this.batchRemoveFiles(vectorStoreId, operations.toRemove, results);
        }
        // Process additions/updates in batches
        if (operations.toAddOrUpdate.length > 0) {
            await this.batchAddOrUpdateFiles(vectorStoreId, operations.toAddOrUpdate, results);
        }
        return results;
    }
    async batchRemoveFiles(vectorStoreId, files, results) {
        console.log(`Batch removing ${files.length} files`);
        try {
            // Get all files in vector store
            const vectorStoreFiles = await openai.vectorStores.files.list(vectorStoreId);
            const vectorStoreFileMap = new Map();
            // Build filename to file ID mapping
            for (const file of vectorStoreFiles.data) {
                try {
                    const fileDetails = await openai.files.retrieve(file.id);
                    vectorStoreFileMap.set(fileDetails.filename, file.id);
                }
                catch (error) {
                    console.error(`Error retrieving file details for ${file.id}:`, error);
                }
            }
            // Remove files in parallel batches
            const removePromises = files.map(async (file) => {
                try {
                    const fileId = vectorStoreFileMap.get(file.filename);
                    if (fileId) {
                        await openai.vectorStores.files.del(vectorStoreId, fileId);
                        await openai.files.del(fileId);
                        results.push({ filename: file.filename, status: "success" });
                        console.log(`Removed: ${file.filename}`);
                    }
                    else {
                        results.push({ filename: file.filename, status: "success" });
                    }
                }
                catch (error) {
                    console.error(`Error removing ${file.filename}:`, error);
                    results.push({
                        filename: file.filename,
                        status: "failed",
                        error: error instanceof Error ? error.message : "Unknown error",
                    });
                }
            });
            // Process in batches to avoid overwhelming the API
            const batchSize = 5;
            for (let i = 0; i < removePromises.length; i += batchSize) {
                const batch = removePromises.slice(i, i + batchSize);
                await Promise.all(batch);
                // Add small delay between batches to respect rate limits
                if (i + batchSize < removePromises.length) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        }
        catch (error) {
            console.error("Error in batch remove:", error);
            // Mark all files as failed if batch operation fails
            files.forEach((file) => {
                if (!results.find((r) => r.filename === file.filename)) {
                    results.push({
                        filename: file.filename,
                        status: "failed",
                        error: "Batch remove operation failed",
                    });
                }
            });
        }
    }
    async batchAddOrUpdateFiles(vectorStoreId, files, results) {
        console.log(`Batch adding/updating ${files.length} files`);
        // Create temporary files and upload in batches
        const tempFiles = [];
        try {
            // Create all temporary files with encoded filenames
            for (const file of files) {
                if (file.content) {
                    const encodedFilename = file.filename.replace(/[\/\\]/g, "_");
                    const tempPath = await this.createTemporaryFile(encodedFilename, file.content);
                    tempFiles.push({ encodedFilename: encodedFilename, tempPath, file });
                }
            }
            // Upload files in batches using OpenAI batch upload
            const uploadPromises = tempFiles.map(async ({ encodedFilename, tempPath, file }) => {
                try {
                    // For modified files, remove existing version first
                    if (file.status === "modified") {
                        await this.removeExistingFile(vectorStoreId, encodedFilename);
                    }
                    // Upload new file (filename is taken from the temp file's name)
                    const uploadedFile = await openai.files.create({
                        file: fs.createReadStream(tempPath),
                        purpose: "user_data",
                    });
                    // Add to vector store
                    await openai.vectorStores.files.create(vectorStoreId, {
                        file_id: uploadedFile.id,
                    });
                    results.push({ filename: encodedFilename, status: "success" });
                    console.log(`Processed: ${encodedFilename} (${file.status})`);
                }
                catch (error) {
                    console.error(`Error processing ${encodedFilename}:`, error);
                    results.push({
                        filename: encodedFilename,
                        status: "failed",
                        error: error instanceof Error ? error.message : "Unknown error",
                    });
                }
            });
            // Process uploads in smaller batches to respect rate limits
            const batchSize = 3;
            for (let i = 0; i < uploadPromises.length; i += batchSize) {
                const batch = uploadPromises.slice(i, i + batchSize);
                await Promise.all(batch);
                // Add delay between batches
                if (i + batchSize < uploadPromises.length) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
        }
        finally {
            // Clean up temporary files
            const cleanupPromises = tempFiles.map(({ tempPath }) => this.cleanupTemporaryFile(tempPath));
            await Promise.allSettled(cleanupPromises);
        }
    }
    async removeExistingFile(vectorStoreId, encodedFilename) {
        try {
            const files = await openai.vectorStores.files.list(vectorStoreId);
            for (const file of files.data) {
                const fileDetails = await openai.files.retrieve(file.id);
                if (fileDetails.filename === encodedFilename) {
                    await openai.vectorStores.files.del(vectorStoreId, file.id);
                    await openai.files.del(file.id);
                    break;
                }
            }
        }
        catch (error) {
            console.error(`Error removing existing file ${encodedFilename}:`, error);
        }
    }
    async createTemporaryFile(filename, content) {
        const tempFilePath = path.join(config.tempDir, `${path.basename(filename)}`);
        await promisify(fs.writeFile)(tempFilePath, content, "utf-8");
        return tempFilePath;
    }
    async cleanupTemporaryFile(filePath) {
        try {
            await promisify(fs.unlink)(filePath);
        }
        catch (error) {
            console.error("Error cleaning up temporary file:", error);
        }
    }
}
class OpenAIVectorStoreUpdater {
    jobQueue;
    constructor(jobQueue) {
        this.jobQueue = jobQueue;
    }
    async verifySignature(secret, header, payload) {
        let parts = header.split("=");
        let sigHex = parts[1];
        let algorithm = { name: "HMAC", hash: { name: "SHA-256" } };
        let keyBytes = encoder.encode(secret);
        let extractable = false;
        let key = await crypto.subtle.importKey("raw", keyBytes, algorithm, extractable, ["sign", "verify"]);
        let sigBytes = this.hexToBytes(sigHex);
        let dataBytes = encoder.encode(payload);
        let equal = await crypto.subtle.verify(algorithm.name, key, sigBytes, dataBytes);
        return equal;
    }
    hexToBytes(hex) {
        let len = hex.length / 2;
        let bytes = new Uint8Array(len);
        let index = 0;
        for (let i = 0; i < hex.length; i += 2) {
            let c = hex.slice(i, i + 2);
            let b = parseInt(c, 16);
            bytes[index] = b;
            index += 1;
        }
        return bytes;
    }
    shouldProcessFile(filename) {
        const ext = path.extname(filename).toLowerCase();
        // Skip certain directories and files
        if (filename.includes("node_modules") ||
            filename.includes(".git") ||
            filename.includes("dist") ||
            filename.includes("build") ||
            filename.startsWith(".")) {
            return false;
        }
        return SUPPORTED_EXTENSIONS.has(ext);
    }
    async getFileContent(owner, repo, path, ref) {
        try {
            const response = await octokit.rest.repos.getContent({
                owner,
                repo,
                path,
                ref,
            });
            if ("content" in response.data && response.data.content) {
                return Buffer.from(response.data.content, "base64").toString("utf-8");
            }
            return null;
        }
        catch (error) {
            console.error(`Error fetching file content for ${path}:`, error);
            return null;
        }
    }
    async getChangedFiles(payload) {
        const { repository, commits, pull_request, before, after } = payload;
        console.log("Webhook payload:", JSON.stringify(payload));
        const owner = repository.owner.login;
        const repo = repository.name;
        let changedFiles = [];
        try {
            if (commits && commits.length > 0) {
                // Handle push events
                for (const commit of commits) {
                    const added = commit.added.map((f) => ({
                        filename: f,
                        status: "added",
                    }));
                    const modified = commit.modified.map((f) => ({
                        filename: f,
                        status: "modified",
                    }));
                    const removed = commit.removed.map((f) => ({
                        filename: f,
                        status: "removed",
                    }));
                    changedFiles.push(...added, ...modified, ...removed);
                }
            }
            else if (pull_request && pull_request.merged) {
                // Handle merged pull request
                const comparison = await octokit.rest.repos.compareCommits({
                    owner,
                    repo,
                    base: before || pull_request.base.ref,
                    head: after || pull_request.head.sha,
                });
                changedFiles =
                    comparison.data.files?.map((file) => ({
                        filename: file.filename,
                        status: file.status,
                        size: file.changes,
                    })) || [];
            }
            // Filter supported files and fetch content
            const supportedFiles = changedFiles.filter((file) => this.shouldProcessFile(file.filename));
            // Fetch content for added/modified files (in parallel with limit)
            const contentPromises = supportedFiles
                .filter((file) => file.status !== "removed")
                .map(async (file) => {
                const content = await this.getFileContent(owner, repo, file.filename, after);
                file.content = content === null ? undefined : content;
                return file;
            });
            // Process in batches to avoid overwhelming GitHub API
            const batchSize = 10;
            for (let i = 0; i < contentPromises.length; i += batchSize) {
                const batch = contentPromises.slice(i, i + batchSize);
                await Promise.all(batch);
            }
            return supportedFiles.filter((file) => file.status === "removed" || file.content);
        }
        catch (error) {
            console.error("Error getting changed files:", error);
            return [];
        }
    }
    calculatePriority(files) {
        // Higher priority for fewer files (faster processing)
        // Higher priority for critical file types
        let priority = Math.max(1, 10 - Math.floor(files.length / 5));
        const criticalExtensions = [
            ".md",
            ".txt",
            ".json",
            ".xml",
            ".csv",
            ".pdf",
            ".docx",
        ];
        const hasCriticalFiles = files.some((f) => criticalExtensions.some((ext) => f.filename.endsWith(ext)));
        if (hasCriticalFiles)
            priority += 2;
        return Math.min(10, priority);
    }
    async handleWebhook(req, res) {
        try {
            const signature = req.headers["x-hub-signature-256"];
            const payload = JSON.stringify(req.body.payload);
            const clientIp = req.ip || req.socket.remoteAddress || "unknown";
            res.status(202).send("Accepted");
            // Verify GitHub signature
            if (!this.verifySignature(config.githubWebhookSecret, signature, payload)) {
                console.warn(`Invalid signature from IP: ${clientIp}`);
                return;
            }
            const webhookPayload = JSON.parse(req.body.payload);
            // Only process master branch changes
            if (webhookPayload.ref && !webhookPayload.ref.endsWith("/master")) {
                return;
            }
            // Only process merged PRs or push events
            if (webhookPayload.pull_request && !webhookPayload.pull_request.merged) {
                return;
            }
            console.log(`Processing webhook for repository: ${webhookPayload.repository.full_name}`);
            // Get changed files
            const changedFiles = await this.getChangedFiles(webhookPayload);
            console.log(`Found ${changedFiles.length} changed supported files`);
            if (changedFiles.length === 0) {
                return;
            }
            // Add job to queue
            const priority = this.calculatePriority(changedFiles);
            const jobId = this.jobQueue.addJob({
                repository: webhookPayload.repository.full_name,
                files: changedFiles,
                priority,
            });
        }
        catch (error) {
            console.error("Webhook processing error:", error);
        }
    }
    async getJobStatus(req, res) {
        try {
            const jobId = req.params.jobId;
            const status = this.jobQueue.getJobStatus(jobId);
            if (!status) {
                res.status(404).json({ error: "Job not found" });
                return;
            }
            res.json(status);
        }
        catch (error) {
            console.error("Error getting job status:", error);
            res.status(500).json({ error: "Failed to get job status" });
        }
    }
    async getQueueStats(req, res) {
        try {
            const stats = this.jobQueue.getQueueStats();
            res.json({
                queue: stats,
                rateLimit: {
                    perMinute: config.rateLimitPerMinute,
                    windowMs: config.rateLimitWindow,
                },
                batch: {
                    size: config.batchSize,
                    timeoutMs: config.batchTimeout,
                    maxConcurrent: config.maxConcurrentJobs,
                },
            });
        }
        catch (error) {
            console.error("Error getting queue stats:", error);
            res.status(500).json({ error: "Failed to get queue stats" });
        }
    }
}
const jobQueue = new JobQueue(config.maxConcurrentJobs, config.queueMaxSize);
export const vectorStoreUpdater = new OpenAIVectorStoreUpdater(jobQueue);
// Queue event listeners
jobQueue.on("jobAdded", (job) => {
    console.log(`📝 Job added: ${job.id} (${job.files.length} files, priority: ${job.priority})`);
});
jobQueue.on("jobStarted", (job) => {
    console.log(`🚀 Job started: ${job.id}`);
});
jobQueue.on("jobCompleted", (job, result) => {
    console.log(`✅ Job completed: ${job.id} - processed ${result.results.length} files`);
});
jobQueue.on("jobFailed", (job, error) => {
    console.log(`❌ Job failed: ${job.id} - ${error}`);
});
