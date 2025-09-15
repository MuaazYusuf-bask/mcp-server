import OpenAI from "openai";
import * as dotenv from "dotenv";
import z from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vectorStoreUpdater } from "./webhookHandler.js";
import helmet from "helmet";
import cors from "cors";

dotenv.config();

export const logger = {
  info: (message: string, meta?: any) => {
    if (meta) {
      console.log(`[INFO] ${new Date().toISOString()} - ${message}`, meta);
    } else {
      console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
    }
  },
  error: (message: string, meta?: any) => {
    if (meta) {
      console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, meta);
    } else {
      console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
    }
  },
  warn: (message: string, meta?: any) => {
    if (meta) {
      console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, meta);
    } else {
      console.warn(`[WARN] ${new Date().toISOString()} - ${message}`);
    }
  },
};

// OpenAI configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export let VECTOR_STORE_ID: string = process.env.VECTOR_STORE_ID || "";
export const openaiClient = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

async function getOrCreateVectorStore(id: string) {
  if (id) return id;
  const response = await openaiClient.vectorStores.create({ name: id });
  VECTOR_STORE_ID = response.id;
  logger.info("Created vector store: " + VECTOR_STORE_ID);
  return VECTOR_STORE_ID;
}

interface SearchResult {
  id: string;
  title: string;
  text: string;
  url?: string;
}

interface FetchResponse {
  id: string;
  title: string;
  text: string;
  url?: string;
  metadata?: any;
}

/**
 * Handle search tool execution
 */
async function handleSearch(args: {
  query: string;
}): Promise<{ content: any[] }> {
  const { query } = args;

  if (!query || !query.trim()) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ results: [] }),
        },
      ],
    };
  }

  if (!openaiClient) {
    logger.error("OpenAI client not initialized - API key missing");
    throw new Error("OpenAI API key is required for vector store search");
  }

  try {
    logger.info(`Searching ${VECTOR_STORE_ID} for query: '${query}'`);

    // Search implementation
    const response = await openaiClient.vectorStores.search(VECTOR_STORE_ID, {
      query,
      rewrite_query: true,
    });

    const results: SearchResult[] = [];

    for (let i = 0; i < response.data.length; i++) {
      const item = response.data[i];
      // Extract text content from the content array
      const contentList = (item as any).content || [];
      let textContent = "";
      if (contentList && contentList.length > 0) {
        const firstContent = contentList[0];
        if (typeof firstContent === "object" && firstContent !== null) {
          if ("text" in firstContent) {
            textContent = firstContent.text;
          } else if (typeof firstContent === "object") {
            textContent = (firstContent as any).text || "";
          }
        }
      }
      if (!textContent) {
        textContent = "No content available";
      }
      // Create a snippet from content
      const textSnippet =
        textContent.length > 200
          ? textContent.slice(0, 200) + "..."
          : textContent;

      const result: SearchResult = {
        id: item.file_id || `vs_${i}`,
        title: item.filename || `Document ${i + 1}`,
        text: textSnippet,
        url: `https://platform.openai.com/storage/files/${item.file_id}`,
      };

      results.push(result);
    }

    logger.info(`Vector store search returned ${results.length} results`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ results }),
        },
      ],
    };
  } catch (error) {
    logger.error(`Search error: ${error}`, { query });
    throw error;
  }
}

/**
 * Handle fetch tool execution
 */
async function handleFetch(args: { id: string }): Promise<{ content: any[] }> {
  const { id } = args;

  if (!id) {
    throw new Error("Document ID is required");
  }

  if (!openaiClient) {
    logger.error("OpenAI client not initialized - API key missing");
    throw new Error(
      "OpenAI API key is required for vector store file retrieval"
    );
  }

  try {
    logger.info(`Fetching content from vector store for file ID: ${id}`);

    const fileInfo = await openaiClient.vectorStores.files.retrieve(
      VECTOR_STORE_ID,
      id
    );

    const fileContent = await openaiClient.files.content(id);

    let content = "";
    // If fileContent is an array (paginated/chunked), concatenate all text fields
    if (Array.isArray(fileContent) && fileContent.length > 0) {
      const contentParts: string[] = [];
      for (const contentItem of fileContent) {
        if (
          typeof contentItem === "object" &&
          contentItem !== null &&
          "text" in contentItem
        ) {
          contentParts.push((contentItem as any).text);
        }
      }
      content = contentParts.join("\n");
    } else if (typeof fileContent === "string") {
      content = fileContent;
    } else if (Buffer.isBuffer(fileContent)) {
      content = fileContent.toString("utf-8");
    } else {
      content = "No content available";
    }

    // Use filename as title if available
    const filename =
      fileInfo && (fileInfo as any).filename
        ? (fileInfo as any).filename
        : `Document ${id}`;

    const result: FetchResponse = {
      id: id,
      title: filename,
      text: content,
      url: `https://platform.openai.com/storage/files/${id}`,
      metadata:
        fileInfo && (fileInfo as any).attributes
          ? (fileInfo as any).attributes
          : null,
    };

    logger.info(`Fetched vector store file: ${id}`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  } catch (error) {
    logger.error(`Fetch error: ${error}`, { id });
    throw error;
  }
}

/**
 * Create and configure the MCP server
 */
async function createServer() {
  const server = new McpServer({
    name: "example-server",
    version: "1.0.0",
  });

  const searchSchema = z.object({
    query: z
      .string()
      .min(2)
      .describe(
        "Search query string. Natural language queries work best for semantic search."
      ),
  });
  const fetchSchema = z.object({
    id: z
      .string()
      .describe("File ID from vector store (file-xxx) or local document ID"),
  });

  server.registerTool(
    "search",
    {
      title: "Search",
      description: `Search for documents using OpenAI Vector Store search.\nThis tool searches through the vector store to find semantically relevant matches. Returns a list of search results with basic information. Use the fetch tool to get complete document content.`,
      inputSchema: searchSchema.shape,
      outputSchema: z.object({
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            text: z.string(),
            url: z.string(),
          })
        ),
      }).shape,
    },
    handleSearch
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch",
      description: "Fetch complete document content by ID.",
      inputSchema: fetchSchema.shape,
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string(),
        metadata: z.any().nullable(),
      }).shape,
    },
    handleFetch
  );

  return server;
}

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers["authorization"];
  if (!API_KEY || !authHeader || authHeader !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const app = express();
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "MCP-Session-Id",
      "mcp-session-id",
    ],
    credentials: false,
  })
);
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
app.use(express.raw({ type: "application/json" }));

const API_KEY = process.env.API_KEY;

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Handle POST requests for client-to-server communication
app.post("/mcp", authMiddleware, async (req, res) => {
  try {
    // Check for existing session ID
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID
          transports[sessionId] = transport;
        },
      });

      // Clean up transport when closed
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };
      const server = await createServer();
      // Connect to the MCP server
      await server.connect(transport);
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error(`Server error: ${error}`, {
      url: req.url,
      method: req.method,
      ip: req.ip,
    });
    res.status(400).json({
      jsonrpc: "2.0",
    });
    return;
  }
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (
  req: express.Request,
  res: express.Response
) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get("/mcp", authMiddleware, handleSessionRequest);

// Handle DELETE requests for session termination
app.delete("/mcp", authMiddleware, handleSessionRequest);

// Webhook endpoint for repo updates

app.post("/webhook", express.raw({ type: "application/json" }), (req, res) =>
  vectorStoreUpdater.handleWebhook(req, res)
);

app.listen(process.env.PORT || 3000, () => {
  logger.info(`Server listening on port ${process.env.PORT || 3000}`);
});

export default app;
