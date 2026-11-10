import type { AttachedUrl } from "@camber/rpc";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { Readable } from "node:stream";
import type { System } from "../../system";

// Arbitrary limit that seems reasonable: there's not much hope
// that an HTML page with >10mb of data is going to fit in the request
// Probably could be set higher
const MAX_BYTES = 10 * 1024 * 1024;
// unlikely user will want to hang around longer
const REQUEST_TIMEOUT = 20_000;

/**
 * will return an attached URL or throw a descriptive error
 */
export async function getUrlContents(system: System, url: string): Promise<AttachedUrl> {
  const response = await fetchWithTimeout(url, system);
  if (!response.ok) {
    throw new Error(
      `Attempting to access that URL resulted in a HTTP error ${response.status} ${response.statusText}`,
    );
  }

  const body = response.body;
  if (body == null) {
    throw new Error("No content in HTTP response");
  }

  const contentType = response.headers.get("Content-Type") || "";
  // refuse to attach stuff that's just going to confuse the model
  if (_isBinaryMime(contentType)) {
    throw new Error("Sorry, you cannot attach a binary file");
  }

  // node typings disagree that fetch.response.body is the right flavour of stream, but it is
  // TODO consider character encodings - e.g. in mime + https://www.npmjs.com/package/jschardet
  const content = await readWithLimit(Readable.fromWeb(body as any), MAX_BYTES);

  if (_treatAsHTML(contentType, content)) {
    try {
      const parsed = await parseAsHTML(content);
      return { url, content: parsed.content, title: parsed.title };
    } catch (_e) {
      // fallback if we couldn't parse
      // TODO catch more specific errors
    }
  }

  if (content.includes("\x00")) {
    throw new Error("Sorry, you cannot attach a binary file");
  }

  return { url, content };
}

async function fetchWithTimeout(url: string, system: System) {
  const timeoutErr = "timeout awaiting response";
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new Error(timeoutErr));
  }, REQUEST_TIMEOUT);

  try {
    return await fetch(url, {
      headers: {
        Accept: "text/*, application/*",
      },
      signal: controller.signal,
    });
  } catch (e) {
    if (!(e instanceof Error)) {
      system.telemetry.reportError(new Error("unexpected non-error thrown:" + e));
      throw new Error(`Unexpected error`);
    }
    if (e.message.includes(timeoutErr)) {
      throw new Error(`Timeout awaiting response`);
    }
    if (e.name === "TypeError") {
      throw e;
    }
    throw new Error(`Unknown error while accessing URL: ` + e);
  }
}

async function parseAsHTML(content: string) {
  const doc = parseHTML(content).window.document;
  if (!doc) {
    return { content };
  }

  const reader = new Readability(doc);
  const article = reader.parse();
  content = article?.textContent ?? article?.content ?? doc.documentElement.innerText ?? "";

  if (content === "") {
    throw new Error("Failed to parse content");
  }

  return {
    content,
    title: article?.title ?? doc.title,
  };
}

async function readWithLimit(body: Readable, maxBytes: number): Promise<string> {
  let receivedLength = 0;
  const parts = [];
  for await (const chunk of body) {
    receivedLength += chunk.length;

    if (receivedLength > maxBytes) {
      throw new Error("Response size exceeds limit");
    }

    parts.push(chunk.toString());
  }
  return parts.join("");
}

export function _isBinaryMime(contentType: string) {
  return (
    /\b(image|audio|video|font|model)\//i.test(contentType) ||
    /\bapplication\/(x-|vnd\.|pdf|octet-stream|zip)/i.test(contentType)
  );
}

export function _treatAsHTML(mimeType: string, contents: string): boolean {
  if (/\b(text\/html|application\/\S*html)/i.test(mimeType)) {
    return true;
  }
  if (mimeType === "") {
    // if content type missing, sniff for HTML
    return /^\s*(<!doctype html|<html|<head|<body|<title|<!--)/i.test(contents);
  }
  return false;
}
