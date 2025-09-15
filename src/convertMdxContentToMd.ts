import markdownit from "markdown-it";

function preprocessMdx(content: string) {
  let result = content;

  // Extract and preserve frontmatter
  const frontmatterMatch = result.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : "";
  if (frontmatter) {
    result = result.replace(/^---\n[\s\S]*?\n---\n/, "");
  }

  // Remove import/export statements
  result = result.replace(/^import\s+.*$/gm, "");
  result = result.replace(/^export\s+.*$/gm, "");

  // Convert JSX components to markdown
  const conversions = [
    // Callouts and alerts
    {
      pattern: /<(Callout|Note|Info)([^>]*?)>([\s\S]*?)<\/\1>/gi,
      replacement: "> **Note:** $3",
    },
    {
      pattern: /<(Warning|Alert)([^>]*?)>([\s\S]*?)<\/\1>/gi,
      replacement: "> **⚠️ Warning:** $3",
    },
    {
      pattern: /<(Tip)([^>]*?)>([\s\S]*?)<\/\1>/gi,
      replacement: "> **💡 Tip:** $3",
    },

    // Code blocks
    {
      pattern:
        /<CodeBlock\s+language=['"]([^'"]*?)['"]([^>]*?)>([\s\S]*?)<\/CodeBlock>/gi,
      replacement: "```$1\n$3\n```",
    },
    {
      pattern: /<pre([^>]*?)>([\s\S]*?)<\/pre>/gi,
      replacement: "```\n$2\n```",
    },
    {
      pattern: /<code([^>]*?)>([\s\S]*?)<\/code>/gi,
      replacement: "`$2`",
    },

    // Tabs
    {
      pattern: /<Tab\s+title=['"]([^'"]*?)['"]([^>]*?)>([\s\S]*?)<\/Tab>/gi,
      replacement: "#### $1\n\n$3\n",
    },
    {
      pattern: /<Tabs([^>]*?)>([\s\S]*?)<\/Tabs>/gi,
      replacement: "$2",
    },

    // Details/Summary
    {
      pattern:
        /<Details\s+summary=['"]([^'"]*?)['"]([^>]*?)>([\s\S]*?)<\/Details>/gi,
      replacement: "<details>\n<summary>$1</summary>\n\n$3\n\n</details>",
    },

    // Self-closing components
    {
      pattern: /<(br|BR)\s*\/?>/gi,
      replacement: "\n\n",
    },
    {
      pattern: /<(hr|HR)\s*\/?>/gi,
      replacement: "\n---\n",
    },

    // Generic component removal (keep content)
    {
      pattern: /<([A-Z][a-zA-Z0-9]*?)([^>]*?)>([\s\S]*?)<\/\1>/g,
      replacement: "$3",
    },

    // Remove remaining self-closing components
    {
      pattern: /<[A-Z][a-zA-Z0-9]*?[^>]*?\s*\/>/g,
      replacement: "",
    },
  ];

  // Apply all conversions
  conversions.forEach(({ pattern, replacement }) => {
    result = result.replace(pattern, replacement);
  });

  // Clean up JSX expressions
  result = result.replace(/\{(['"`])(.*?)\1\}/g, "$2");
  result = result.replace(/\{([^}]+)\}/g, "`$1`");

  // Clean up whitespace
  result = result.replace(/\n\s*\n\s*\n/g, "\n\n").trim();

  return frontmatter + result;
}

export function convertMdxToMd(mdxContent: string): string {
  const preprocessed = preprocessMdx(mdxContent);
  const md = markdownit({
    html: true,
    breaks: false,
    linkify: true,
  });
  const rendered = md.render(preprocessed);
  return rendered;
}
