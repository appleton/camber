import { TelemetryEventInputEventType, type TelemetryEventInputMetadata } from "@camber/rpc";
import { DateTime } from "luxon";
import { serializeError, type ErrorObject } from "serialize-error";
import * as vscode from "vscode";
import { getExtensionIdentity } from "../extensionIdentity";

/** Local diagnostic logger; no errors or usage events are sent to a reporting service. */
export class TelemetryLogger {
  #output: vscode.OutputChannel;
  #disposed = false;

  constructor() {
    this.#output = vscode.window.createOutputChannel(
      getExtensionIdentity().telemetryOutputChannelName,
      "json",
    );
  }

  deactivate() {
    this.#disposed = true;
    this.#output.dispose();
  }

  log(message: string, args: object) {
    if (this.#disposed) return;
    this.#output.appendLine(
      JSON.stringify({
        timestamp: DateTime.now().toISO(),
        ...args,
        message,
      }),
    );
  }

  reportUsage(eventType: TelemetryEventInputEventType, data: TelemetryEventInputMetadata) {
    if (this.#disposed) return;
    this.#output.appendLine(
      JSON.stringify({
        timestamp: DateTime.now().toISO(),
        event_type: eventType,
        session_id: vscode.env.sessionId,
        metadata: data,
      }),
    );
  }

  // this is called when we report an error from the UI process
  reportErrorFromUI(error: ErrorObject) {
    if (this.#disposed) return;
    this.reportError(error, {
      tags: {
        ui_error: "true",
      },
    });
  }

  reportError(
    input: ErrorObject | Error,
    {
      tags = undefined,
    }: {
      tags?: Record<string, string>;
    } = {},
  ) {
    if (this.#disposed) return;
    let serialized: ErrorObject;

    // determine if input is already serialized and handle accordingly
    if (input instanceof Error) {
      serialized = serializeError(input);
    } else {
      serialized = input;
    }

    if (serialized) {
      // drop stack as we will already have included that if present
      const { stack: _, ...kept } = serialized as Record<string, any>;
      this.#output.appendLine(
        [
          `[${DateTime.now().toISO()}] Error: ${serialized.stack || serialized}`,
          ...(tags ? [`Tags: ${JSON.stringify(tags, null, 4)}`] : []),
          `Error properties: ${JSON.stringify(kept, null, 4)}`,
        ].join("\n\t"),
      );
    }
  }
}
