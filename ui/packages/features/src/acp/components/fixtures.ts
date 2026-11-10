import type {
  AudioContent,
  ContentBlock,
  Diff,
  EmbeddedResource,
  ImageContent,
  Plan,
  ResourceLink,
  Terminal,
  ToolCall,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { WorkspaceFolder } from "@camber/rpc";
import type { AgentMessage, AgentThought, ModeChange, SessionEvent, UserMessage } from "../types";

const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s8vH4QAAAAASUVORK5CYII=";

const audioData = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

export const storyWorkspaceFolders = [
  {
    path: "/Users/poolie/Developer/camber/camber-books-api-demo",
    name: "camber-books-api-demo",
    index: 0,
  },
  {
    path: "/Users/poolie/Developer/camber/camber-shared-ui",
    name: "camber-shared-ui",
    index: 1,
  },
] satisfies WorkspaceFolder[];

export const textBlock = {
  type: "text",
  text: "I checked the project and found the relevant files.",
} satisfies ContentBlock;

export const resourceLinkBlock = {
  type: "resource_link",
  name: "README.md",
  title: "README.md",
  uri: "/Users/poolie/camber/assistant/README.md",
  description: "Repository overview",
} satisfies ResourceLink & { type: "resource_link" };

export const embeddedTextResourceBlock = {
  type: "resource",
  resource: {
    uri: "memory://summary.md",
    mimeType: "text/markdown",
    text: "## Summary\n\nEmbedded text content",
  },
} satisfies EmbeddedResource & { type: "resource" };

export const embeddedBlobResourceBlock = {
  type: "resource",
  resource: {
    uri: "memory://image.bin",
    mimeType: "application/octet-stream",
    blob: "AAAA",
  },
} satisfies EmbeddedResource & { type: "resource" };

export const imageBlock = {
  type: "image",
  mimeType: "image/png",
  data: imageData,
} satisfies ImageContent & { type: "image" };

export const audioBlock = {
  type: "audio",
  mimeType: "audio/wav",
  data: audioData,
} satisfies AudioContent & { type: "audio" };

export const mixedContent = [
  textBlock,
  resourceLinkBlock,
  embeddedTextResourceBlock,
] satisfies ContentBlock[];

export const userMessage = {
  eventKind: "user_message",
  messageId: "user-1",
  content: mixedContent,
} satisfies UserMessage;

export const agentMessage = {
  eventKind: "agent_message",
  messageId: "assistant-1",
  content: [textBlock, imageBlock],
} satisfies AgentMessage;

export const agentThought = {
  eventKind: "agent_thought",
  messageId: "thought-1",
  content: [
    {
      type: "text",
      text: "Let me inspect the relevant files and compare the previous implementation.",
    },
  ],
} satisfies AgentThought;

export const inlineToolContent = {
  type: "content",
  content: {
    type: "text",
    text: "Read 42 lines from README.md",
  },
} satisfies ToolCallContent;

export const diffContent = {
  type: "diff",
  path: "/Users/poolie/camber/assistant/src/index.ts",
  oldText: "const answer = 41;\n",
  newText: "const answer = 42;\n",
} satisfies Diff & { type: "diff" };

export const terminalContent = {
  type: "terminal",
  terminalId: "shell-123",
} satisfies Terminal & { type: "terminal" };

export const contentToolCall = {
  eventKind: "tool_call",
  toolCallId: "tool-1",
  title: "Read README.md",
  kind: "read",
  status: "completed",
  locations: [{ path: "/Users/poolie/camber/assistant/README.md" }],
  rawInput: { path: "/Users/poolie/camber/assistant/README.md" },
  rawOutput: { lines: 42 },
  content: [inlineToolContent],
} satisfies ToolCall & SessionEvent;

export const diffToolCall = {
  eventKind: "tool_call",
  toolCallId: "tool-2",
  title: "Edit src/index.ts",
  kind: "edit",
  status: "completed",
  locations: [{ path: "/Users/poolie/camber/assistant/src/index.ts" }],
  content: [diffContent],
} satisfies ToolCall & SessionEvent;

export const terminalToolCall = {
  eventKind: "tool_call",
  toolCallId: "tool-3",
  title: "Run pnpm test",
  kind: "execute",
  status: "completed",
  rawInput: {
    cmd: "pnpm test",
    cwd: "/Users/poolie/camber/assistant",
  },
  rawOutput: {
    output: "PASS  src/example.test.ts\n",
  },
  content: [terminalContent],
} satisfies ToolCall & SessionEvent;

export const pendingToolCall = {
  ...contentToolCall,
  toolCallId: "tool-4",
  title: "Search the project",
  kind: "search",
  status: "in_progress",
} satisfies ToolCall & SessionEvent;

export const failedToolCall = {
  ...contentToolCall,
  toolCallId: "tool-5",
  title: "Delete temporary file",
  kind: "delete",
  status: "failed",
  rawOutput: { error: "Permission denied" },
  content: undefined,
} satisfies ToolCall & SessionEvent;

export const modeChange = {
  eventKind: "mode_change",
  currentModeId: "plan",
} satisfies ModeChange;

export const plan = {
  entries: [
    { content: "Inspect the existing ACP transport", priority: "high", status: "completed" },
    { content: "Build ACP transcript components", priority: "high", status: "in_progress" },
    { content: "Add Storybook coverage", priority: "medium", status: "pending" },
  ],
} satisfies Plan;

export const planEvent = {
  eventKind: "plan",
  ...plan,
};

export const transcriptEvents = [
  userMessage,
  agentThought,
  contentToolCall,
  terminalToolCall,
  modeChange,
  agentMessage,
] satisfies SessionEvent[];

export const fullSessionEvents = [
  userMessage,
  agentThought,
  diffToolCall,
  terminalToolCall,
  modeChange,
  agentMessage,
] satisfies SessionEvent[];

export const events = [
  {
    eventKind: "agent_message",
    messageId: null,
    content: [
      {
        text: "I'll help you create a Book type in index.ts. Let me first check the current state of the file to understand the existing structure.\n",
        type: "text",
      },
    ],
  },
  {
    eventKind: "tool_call",
    kind: "read",
    locations: [
      {
        path: "/Users/poolie/Developer/camber/camber-books-api-demo/index.ts",
      },
    ],
    rawInput: {
      path: "/Users/poolie/Developer/camber/camber-books-api-demo/index.ts",
    },
    status: "completed",
    title: "Read index.ts",
    toolCallId: "chatcmpl-tool-b77aaf6964bcf2a7",
    content: [
      {
        content: {
          text: "Error: file does not exist",
          type: "text",
        },
        type: "content",
      },
    ],
    rawOutput: {
      error: true,
      observation: "file does not exist",
    },
  },
  {
    eventKind: "agent_message",
    messageId: null,
    content: [
      {
        text: "Let me check what files exist in the project directory:\n",
        type: "text",
      },
    ],
  },
  {
    eventKind: "tool_call",
    kind: "read",
    locations: [
      {
        path: "/Users/poolie/Developer/camber/camber-books-api-demo",
      },
    ],
    rawInput: {
      path: "/Users/poolie/Developer/camber/camber-books-api-demo",
    },
    status: "completed",
    title: "List Directory .",
    toolCallId: "chatcmpl-tool-b1fbd59a1296ee4a",
    content: [
      {
        content: {
          text: "Directory /Users/poolie/Developer/camber/camber-books-api-demo contains:\n- File: .DS_Store\n- File: .gitignore\n- File: README.md\n- File: package.json\n- File: pnpm-lock.yaml\n- File: temp.bin\n- File: tsconfig.json\n- Directory: .git\n- Directory: .poolside\n- Directory: node_modules\n- Directory: src\n",
          type: "text",
        },
        type: "content",
      },
    ],
    rawOutput: {
      observation:
        "Directory /Users/poolie/Developer/camber/camber-books-api-demo contains:\n- File: .DS_Store\n- File: .gitignore\n- File: README.md\n- File: package.json\n- File: pnpm-lock.yaml\n- File: temp.bin\n- File: tsconfig.json\n- Directory: .git\n- Directory: .poolside\n- Directory: node_modules\n- Directory: src\n",
    },
  },
  {
    eventKind: "agent_message",
    messageId: null,
    content: [
      {
        text: "Let me check the src directory to see if there's already an index.ts file there:\n",
        type: "text",
      },
    ],
  },
  {
    eventKind: "tool_call",
    kind: "read",
    locations: [
      {
        path: "/Users/poolie/Developer/camber/camber-books-api-demo/src",
      },
    ],
    rawInput: {
      path: "/Users/poolie/Developer/camber/camber-books-api-demo/src",
    },
    status: "completed",
    title: "List Directory src",
    toolCallId: "chatcmpl-tool-95e38f26935991a0",
    content: [
      {
        content: {
          text: "Directory /Users/poolie/Developer/camber/camber-books-api-demo/src contains:\n- File: index.ts\n",
          type: "text",
        },
        type: "content",
      },
    ],
    rawOutput: {
      observation:
        "Directory /Users/poolie/Developer/camber/camber-books-api-demo/src contains:\n- File: index.ts\n",
    },
  },
  {
    eventKind: "agent_message",
    messageId: null,
    content: [
      {
        text: "Now let me read the existing index.ts file:\n",
        type: "text",
      },
    ],
  },
  {
    eventKind: "tool_call",
    kind: "read",
    locations: [
      {
        path: "/Users/poolie/Developer/camber/camber-books-api-demo/src/index.ts",
      },
    ],
    rawInput: {
      path: "/Users/poolie/Developer/camber/camber-books-api-demo/src/index.ts",
    },
    status: "completed",
    title: "Read src/index.ts",
    toolCallId: "chatcmpl-tool-a83c1bd77848fefb",
    content: [
      {
        content: {
          text: "```typescript\ntype Author = {\n  id: string;\n  name: string;\n  email: string;\n  website: string;\n  country: string;\n};\n\ntype Publisher = {\n  id: string;\n  name: string;\n  address: string;\n  website: string;\n  email: string;\n  foundedYear: number;\n  country: string;\n};\n```",
          type: "text",
        },
        type: "content",
      },
    ],
    rawOutput: {
      observation:
        "/Users/poolie/Developer/camber/camber-books-api-demo/src/index.ts has 18 total lines. Showing lines 1-18.\n\n```\n1|◊|type Author = {\n2|◊|  id: string;\n3|◊|  name: string;\n4|◊|  email: string;\n5|◊|  website: string;\n6|◊|  country: string;\n7|◊|};\n8|◊|\n9|◊|type Publisher = {\n10|◊|  id: string;\n11|◊|  name: string;\n12|◊|  address: string;\n13|◊|  website: string;\n14|◊|  email: string;\n15|◊|  foundedYear: number;\n16|◊|  country: string;\n17|◊|};\n18|◊|\n```\n",
    },
  },
  {
    eventKind: "agent_message",
    messageId: null,
    content: [
      {
        text: "Perfect! I can see the file already has types for `Author` and `Publisher`. Now I'll add a `Book` type that would logically relate to these existing types. Let me add it to the file:\n",
        type: "text",
      },
    ],
  },
  {
    eventKind: "tool_call",
    kind: "edit",
    locations: [
      {
        path: "/Users/poolie/Developer/camber/camber-books-api-demo/src/index.ts",
      },
    ],
    rawInput: {
      new_string:
        "type Publisher = {\n  id: string;\n  name: string;\n  address: string;\n  website: string;\n  email: string;\n  foundedYear: number;\n  country: string;\n};\n\ntype Book = {\n  id: string;\n  title: string;\n  isbn: string;\n  publicationDate: Date;\n  edition: string;\n  pages: number;\n  language: string;\n  authorId: string;\n  publisherId: string;\n  price: number;\n  description: string;\n  genre: string;\n  available: boolean;\n};",
      old_string:
        "type Publisher = {\n  id: string;\n  name: string;\n  address: string;\n  website: string;\n  email: string;\n  foundedYear: number;\n  country: string;\n};",
      path: "/Users/poolie/Developer/camber/camber-books-api-demo/src/index.ts",
    },
    status: "completed",
    title: "Edit src/index.ts",
    toolCallId: "chatcmpl-tool-86fe26fd59c1eb1f",
    content: [
      {
        newText:
          "type Publisher = {\n  id: string;\n  name: string;\n  address: string;\n  website: string;\n  email: string;\n  foundedYear: number;\n  country: string;\n};\n\ntype Book = {\n  id: string;\n  title: string;\n  isbn: string;\n  publicationDate: Date;\n  edition: string;\n  pages: number;\n  language: string;\n  authorId: string;\n  publisherId: string;\n  price: number;\n  description: string;\n  genre: string;\n  available: boolean;\n};",
        oldText:
          "type Publisher = {\n  id: string;\n  name: string;\n  address: string;\n  website: string;\n  email: string;\n  foundedYear: number;\n  country: string;\n};",
        path: "/Users/poolie/Developer/camber/camber-books-api-demo/src/index.ts",
        type: "diff",
      },
    ],
    rawOutput: {
      observation:
        "Edit applied to file /Users/poolie/Developer/camber/camber-books-api-demo/src/index.ts",
    },
  },
  {
    eventKind: "agent_message",
    messageId: null,
    content: [
      {
        text: "Great! I've successfully created a `Book` type in `/Users/poolie/Developer/camber/camber-books-api-demo/src/index.ts`. The type includes:\n\n- **id**: Unique identifier for the book\n- **title**: The book's title\n- **isbn**: International Standard Book Number\n- **publicationDate**: When the book was published\n- **edition**: Edition information (e.g., \"First\", \"Second\")\n- **pages**: Number of pages in the book\n- **language**: Language of the book\n- **authorId**: Reference to the Author type (foreign key)\n- **publisherId**: Reference to the Publisher type (foreign key)\n- **price**: Book's price\n- **description**: Brief description of the book\n- **genre**: Book's genre/category\n- **available**: Availability status (in stock or not)\n\nThe Book type is designed to work well with the existing Author and Publisher types you already have in the file.\n",
        type: "text",
      },
    ],
  },
] satisfies SessionEvent[];
