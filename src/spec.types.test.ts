/**
 * This contains:
 * - Static type checks to verify the Spec's types are compatible with the SDK's types
 *   (mutually assignable, w/ slight affordances to get rid of ZodObject.passthrough() index signatures, etc)
 * - Runtime checks to verify each Spec type has a static check
 *   (note: a few don't have SDK types, see MISSING_SDK_TYPES below)
 */
import * as SDKTypes from "./types.js";
import * as SpecTypes from "../spec.types.js";
import fs from "node:fs";

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

// Removes index signatures added by ZodObject.passthrough().
type RemovePassthrough<T> = T extends object
  ? T extends Array<infer U>
    ? Array<RemovePassthrough<U>>
    : T extends Function
        ? T
        : {[K in keyof T as string extends K ? never : K]: RemovePassthrough<T[K]>}
    : T;

type IsUnknown<T> = [unknown] extends [T] ? [T] extends [unknown] ? true : false : false;

// Turns {x?: unknown} into {x: unknown} but keeps {_meta?: unknown} unchanged (and leaves other optional properties unchanged, e.g. {x?: string}).
// This works around an apparent quirk of ZodObject.unknown() (makes fields optional)
type MakeUnknownsNotOptional<T> =
  IsUnknown<T> extends true
    ? unknown
    : (T extends object
      ? (T extends Array<infer U>
        ? Array<MakeUnknownsNotOptional<U>>
        : (T extends Function
          ? T
          : Pick<T, never> & {
            // Start with empty object to avoid duplicates
            // Make unknown properties required (except _meta)
            [K in keyof T as '_meta' extends K ? never : IsUnknown<T[K]> extends true ? K : never]-?: unknown;
          } &
          Pick<T, {
            // Pick all _meta and non-unknown properties with original modifiers
            [K in keyof T]: '_meta' extends K ? K : IsUnknown<T[K]> extends true ? never : K
          }[keyof T]> & {
            // Recurse on the picked properties
            [K in keyof Pick<T, {[K in keyof T]: '_meta' extends K ? K : IsUnknown<T[K]> extends true ? never : K}[keyof T]>]: MakeUnknownsNotOptional<T[K]>
          }))
      : T);

// Strip JSONRPC envelope fields (jsonrpc, id) from spec types.
// The SDK defines individual request/notification types without these fields;
// they are added at the protocol layer (JSONRPCRequestSchema/JSONRPCNotificationSchema).
type StripEnvelope<T> = Omit<T, 'jsonrpc' | 'id'>;

// Distributive StripEnvelope for union types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripEnvelopeUnion<T> = T extends any ? StripEnvelope<T> : never;

function checkCancelledNotification(
  sdk: RemovePassthrough<SDKTypes.CancelledNotification>,
  spec: StripEnvelope<SpecTypes.CancelledNotification>
) {
  sdk = spec;
  // @ts-expect-error - SDK makes CancelledNotification.params.requestId optional,
  // whereas the 2025-06-18 spec requires it (RequestIdSchema.optional() vs requestId: RequestId).
  spec = sdk;
}
function checkBaseMetadata(
  sdk: RemovePassthrough<SDKTypes.BaseMetadata>,
  spec: SpecTypes.BaseMetadata
) {
  sdk = spec;
  spec = sdk;
}
function checkImplementation(
  sdk: RemovePassthrough<SDKTypes.Implementation>,
  spec: SpecTypes.Implementation
) {
  sdk = spec;
  spec = sdk;
}
function checkProgressNotification(
  sdk: RemovePassthrough<SDKTypes.ProgressNotification>,
  spec: StripEnvelope<SpecTypes.ProgressNotification>
) {
  sdk = spec;
  spec = sdk;
}

function checkSubscribeRequest(
  sdk: RemovePassthrough<SDKTypes.SubscribeRequest>,
  spec: StripEnvelope<SpecTypes.SubscribeRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkUnsubscribeRequest(
  sdk: RemovePassthrough<SDKTypes.UnsubscribeRequest>,
  spec: StripEnvelope<SpecTypes.UnsubscribeRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkPaginatedRequest(
  sdk: RemovePassthrough<SDKTypes.PaginatedRequest>,
  spec: StripEnvelope<SpecTypes.PaginatedRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkPaginatedResult(
  sdk: SDKTypes.PaginatedResult,
  spec: SpecTypes.PaginatedResult
) {
  sdk = spec;
  spec = sdk;
}
function checkListRootsRequest(
  sdk: RemovePassthrough<SDKTypes.ListRootsRequest>,
  spec: StripEnvelope<SpecTypes.ListRootsRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkListRootsResult(
  sdk: RemovePassthrough<SDKTypes.ListRootsResult>,
  spec: SpecTypes.ListRootsResult
) {
  sdk = spec;
  spec = sdk;
}
function checkRoot(
  sdk: RemovePassthrough<SDKTypes.Root>,
  spec: SpecTypes.Root
) {
  sdk = spec;
  spec = sdk;
}
function checkElicitRequest(
  sdk: RemovePassthrough<SDKTypes.ElicitRequest>,
  spec: StripEnvelope<SpecTypes.ElicitRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkElicitResult(
  sdk: RemovePassthrough<SDKTypes.ElicitResult>,
  spec: SpecTypes.ElicitResult
) {
  sdk = spec;
  spec = sdk;
}
function checkCompleteRequest(
  sdk: RemovePassthrough<SDKTypes.CompleteRequest>,
  spec: StripEnvelope<SpecTypes.CompleteRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkCompleteResult(
  sdk: SDKTypes.CompleteResult,
  spec: SpecTypes.CompleteResult
) {
  sdk = spec;
  spec = sdk;
}
function checkProgressToken(
  sdk: SDKTypes.ProgressToken,
  spec: SpecTypes.ProgressToken
) {
  sdk = spec;
  spec = sdk;
}
function checkCursor(
  sdk: SDKTypes.Cursor,
  spec: SpecTypes.Cursor
) {
  sdk = spec;
  spec = sdk;
}
function checkRequest(
  sdk: SDKTypes.Request,
  spec: SpecTypes.Request
) {
  sdk = spec;
  spec = sdk;
}
function checkResult(
  sdk: SDKTypes.Result,
  spec: SpecTypes.Result
) {
  sdk = spec;
  spec = sdk;
}
function checkRequestId(
  sdk: SDKTypes.RequestId,
  spec: SpecTypes.RequestId
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCRequest(
  sdk: SDKTypes.JSONRPCRequest,
  spec: SpecTypes.JSONRPCRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCNotification(
  sdk: SDKTypes.JSONRPCNotification,
  spec: SpecTypes.JSONRPCNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCResponse(
  sdk: SDKTypes.JSONRPCResponse,
  spec: SpecTypes.JSONRPCResponse
) {
  sdk = spec;
  spec = sdk;
}
function checkEmptyResult(
  sdk: SDKTypes.EmptyResult,
  spec: SpecTypes.EmptyResult
) {
  sdk = spec;
  spec = sdk;
}
function checkNotification(
  sdk: SDKTypes.Notification,
  spec: SpecTypes.Notification
) {
  sdk = spec;
  spec = sdk;
}
function checkClientResult(
  sdk: SDKTypes.ClientResult,
  spec: SpecTypes.ClientResult
) {
  sdk = spec;
  spec = sdk;
}
function checkClientNotification(
  sdk: RemovePassthrough<SDKTypes.ClientNotification>,
  spec: StripEnvelopeUnion<SpecTypes.ClientNotification>
) {
  sdk = spec;
  // @ts-expect-error - SDK makes CancelledNotification.params.requestId optional,
  // whereas the 2025-06-18 spec requires it (CancelledNotification is part of this union).
  spec = sdk;
}
function checkServerResult(
  sdk: SDKTypes.ServerResult,
  spec: SpecTypes.ServerResult
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceTemplateReference(
  sdk: RemovePassthrough<SDKTypes.ResourceTemplateReference>,
  spec: SpecTypes.ResourceTemplateReference
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptReference(
  sdk: RemovePassthrough<SDKTypes.PromptReference>,
  spec: SpecTypes.PromptReference
) {
  sdk = spec;
  spec = sdk;
}
function checkToolAnnotations(
  sdk: RemovePassthrough<SDKTypes.ToolAnnotations>,
  spec: SpecTypes.ToolAnnotations
) {
  sdk = spec;
  spec = sdk;
}
function checkTool(
  sdk: RemovePassthrough<SDKTypes.Tool>,
  spec: SpecTypes.Tool
) {
  sdk = spec;
  spec = sdk;
}
function checkListToolsRequest(
  sdk: RemovePassthrough<SDKTypes.ListToolsRequest>,
  spec: StripEnvelope<SpecTypes.ListToolsRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkListToolsResult(
  sdk: RemovePassthrough<SDKTypes.ListToolsResult>,
  spec: SpecTypes.ListToolsResult
) {
  sdk = spec;
  spec = sdk;
}
function checkCallToolResult(
  sdk: RemovePassthrough<SDKTypes.CallToolResult>,
  spec: SpecTypes.CallToolResult
) {
  sdk = spec;
  spec = sdk;
}
function checkCallToolRequest(
  sdk: RemovePassthrough<SDKTypes.CallToolRequest>,
  spec: StripEnvelope<SpecTypes.CallToolRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkToolListChangedNotification(
  sdk: RemovePassthrough<SDKTypes.ToolListChangedNotification>,
  spec: StripEnvelope<SpecTypes.ToolListChangedNotification>
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceListChangedNotification(
  sdk: RemovePassthrough<SDKTypes.ResourceListChangedNotification>,
  spec: StripEnvelope<SpecTypes.ResourceListChangedNotification>
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptListChangedNotification(
  sdk: RemovePassthrough<SDKTypes.PromptListChangedNotification>,
  spec: StripEnvelope<SpecTypes.PromptListChangedNotification>
) {
  sdk = spec;
  spec = sdk;
}
function checkRootsListChangedNotification(
  sdk: RemovePassthrough<SDKTypes.RootsListChangedNotification>,
  spec: StripEnvelope<SpecTypes.RootsListChangedNotification>
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceUpdatedNotification(
  sdk: RemovePassthrough<SDKTypes.ResourceUpdatedNotification>,
  spec: StripEnvelope<SpecTypes.ResourceUpdatedNotification>
) {
  sdk = spec;
  spec = sdk;
}
function checkSamplingMessage(
  sdk: RemovePassthrough<SDKTypes.SamplingMessage>,
  spec: SpecTypes.SamplingMessage
) {
  sdk = spec;
  spec = sdk;
}
function checkCreateMessageResult(
  sdk: RemovePassthrough<SDKTypes.CreateMessageResult>,
  spec: SpecTypes.CreateMessageResult
) {
  sdk = spec;
  spec = sdk;
}
function checkSetLevelRequest(
  sdk: RemovePassthrough<SDKTypes.SetLevelRequest>,
  spec: StripEnvelope<SpecTypes.SetLevelRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkPingRequest(
  sdk: RemovePassthrough<SDKTypes.PingRequest>,
  spec: StripEnvelope<SpecTypes.PingRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkInitializedNotification(
  sdk: RemovePassthrough<SDKTypes.InitializedNotification>,
  spec: StripEnvelope<SpecTypes.InitializedNotification>
) {
  sdk = spec;
  spec = sdk;
}
function checkListResourcesRequest(
  sdk: RemovePassthrough<SDKTypes.ListResourcesRequest>,
  spec: StripEnvelope<SpecTypes.ListResourcesRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkListResourcesResult(
  sdk: RemovePassthrough<SDKTypes.ListResourcesResult>,
  spec: SpecTypes.ListResourcesResult
) {
  sdk = spec;
  spec = sdk;
}
function checkListResourceTemplatesRequest(
  sdk: RemovePassthrough<SDKTypes.ListResourceTemplatesRequest>,
  spec: StripEnvelope<SpecTypes.ListResourceTemplatesRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkListResourceTemplatesResult(
  sdk: RemovePassthrough<SDKTypes.ListResourceTemplatesResult>,
  spec: SpecTypes.ListResourceTemplatesResult
) {
  sdk = spec;
  spec = sdk;
}
function checkReadResourceRequest(
  sdk: RemovePassthrough<SDKTypes.ReadResourceRequest>,
  spec: StripEnvelope<SpecTypes.ReadResourceRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkReadResourceResult(
  sdk: RemovePassthrough<SDKTypes.ReadResourceResult>,
  spec: SpecTypes.ReadResourceResult
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceContents(
  sdk: RemovePassthrough<SDKTypes.ResourceContents>,
  spec: SpecTypes.ResourceContents
) {
  sdk = spec;
  spec = sdk;
}
function checkTextResourceContents(
  sdk: RemovePassthrough<SDKTypes.TextResourceContents>,
  spec: SpecTypes.TextResourceContents
) {
  sdk = spec;
  spec = sdk;
}
function checkBlobResourceContents(
  sdk: RemovePassthrough<SDKTypes.BlobResourceContents>,
  spec: SpecTypes.BlobResourceContents
) {
  sdk = spec;
  spec = sdk;
}
function checkResource(
  sdk: RemovePassthrough<SDKTypes.Resource>,
  spec: SpecTypes.Resource
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceTemplate(
  sdk: RemovePassthrough<SDKTypes.ResourceTemplate>,
  spec: SpecTypes.ResourceTemplate
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptArgument(
  sdk: RemovePassthrough<SDKTypes.PromptArgument>,
  spec: SpecTypes.PromptArgument
) {
  sdk = spec;
  spec = sdk;
}
function checkPrompt(
  sdk: RemovePassthrough<SDKTypes.Prompt>,
  spec: SpecTypes.Prompt
) {
  sdk = spec;
  spec = sdk;
}
function checkListPromptsRequest(
  sdk: RemovePassthrough<SDKTypes.ListPromptsRequest>,
  spec: StripEnvelope<SpecTypes.ListPromptsRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkListPromptsResult(
  sdk: RemovePassthrough<SDKTypes.ListPromptsResult>,
  spec: SpecTypes.ListPromptsResult
) {
  sdk = spec;
  spec = sdk;
}
function checkGetPromptRequest(
  sdk: RemovePassthrough<SDKTypes.GetPromptRequest>,
  spec: StripEnvelope<SpecTypes.GetPromptRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkTextContent(
  sdk: RemovePassthrough<SDKTypes.TextContent>,
  spec: SpecTypes.TextContent
) {
  sdk = spec;
  spec = sdk;
}
function checkImageContent(
  sdk: RemovePassthrough<SDKTypes.ImageContent>,
  spec: SpecTypes.ImageContent
) {
  sdk = spec;
  spec = sdk;
}
function checkAudioContent(
  sdk: RemovePassthrough<SDKTypes.AudioContent>,
  spec: SpecTypes.AudioContent
) {
  sdk = spec;
  spec = sdk;
}
function checkEmbeddedResource(
  sdk: RemovePassthrough<SDKTypes.EmbeddedResource>,
  spec: SpecTypes.EmbeddedResource
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceLink(
  sdk: RemovePassthrough<SDKTypes.ResourceLink>,
  spec: SpecTypes.ResourceLink
) {
  sdk = spec;
  spec = sdk;
}
function checkContentBlock(
  sdk: RemovePassthrough<SDKTypes.ContentBlock>,
  spec: SpecTypes.ContentBlock
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptMessage(
  sdk: RemovePassthrough<SDKTypes.PromptMessage>,
  spec: SpecTypes.PromptMessage
) {
  sdk = spec;
  spec = sdk;
}
function checkGetPromptResult(
  sdk: RemovePassthrough<SDKTypes.GetPromptResult>,
  spec: SpecTypes.GetPromptResult
) {
  sdk = spec;
  spec = sdk;
}
function checkBooleanSchema(
  sdk: RemovePassthrough<SDKTypes.BooleanSchema>,
  spec: SpecTypes.BooleanSchema
) {
  sdk = spec;
  spec = sdk;
}
function checkStringSchema(
  sdk: RemovePassthrough<SDKTypes.StringSchema>,
  spec: SpecTypes.StringSchema
) {
  sdk = spec;
  spec = sdk;
}
function checkNumberSchema(
  sdk: RemovePassthrough<SDKTypes.NumberSchema>,
  spec: SpecTypes.NumberSchema
) {
  sdk = spec;
  spec = sdk;
}
function checkEnumSchema(
  sdk: RemovePassthrough<SDKTypes.EnumSchema>,
  spec: SpecTypes.EnumSchema
) {
  sdk = spec;
  spec = sdk;
}
function checkPrimitiveSchemaDefinition(
  sdk: RemovePassthrough<SDKTypes.PrimitiveSchemaDefinition>,
  spec: SpecTypes.PrimitiveSchemaDefinition
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCError(
  sdk: SDKTypes.JSONRPCError,
  spec: SpecTypes.JSONRPCError
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCMessage(
  sdk: SDKTypes.JSONRPCMessage,
  spec: SpecTypes.JSONRPCMessage
) {
  sdk = spec;
  spec = sdk;
}
function checkCreateMessageRequest(
  sdk: RemovePassthrough<SDKTypes.CreateMessageRequest>,
  spec: StripEnvelope<SpecTypes.CreateMessageRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkInitializeRequest(
  sdk: RemovePassthrough<SDKTypes.InitializeRequest>,
  spec: StripEnvelope<SpecTypes.InitializeRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkInitializeResult(
  sdk: RemovePassthrough<SDKTypes.InitializeResult>,
  spec: SpecTypes.InitializeResult
) {
  sdk = spec;
  spec = sdk;
}
function checkClientCapabilities(
  sdk: RemovePassthrough<SDKTypes.ClientCapabilities>,
  spec: SpecTypes.ClientCapabilities
) {
  sdk = spec;
  spec = sdk;
}
function checkServerCapabilities(
  sdk: RemovePassthrough<SDKTypes.ServerCapabilities>,
  spec: SpecTypes.ServerCapabilities
) {
  sdk = spec;
  spec = sdk;
}
function checkClientRequest(
  sdk: RemovePassthrough<SDKTypes.ClientRequest>,
  spec: StripEnvelopeUnion<SpecTypes.ClientRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkServerRequest(
  sdk: RemovePassthrough<SDKTypes.ServerRequest>,
  spec: StripEnvelopeUnion<SpecTypes.ServerRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkLoggingMessageNotification(
  sdk: RemovePassthrough<MakeUnknownsNotOptional<SDKTypes.LoggingMessageNotification>>,
  spec: StripEnvelope<SpecTypes.LoggingMessageNotification>
) {
  sdk = spec;
  spec = sdk;
}
function checkServerNotification(
  sdk: RemovePassthrough<MakeUnknownsNotOptional<SDKTypes.ServerNotification>>,
  spec: StripEnvelopeUnion<SpecTypes.ServerNotification>
) {
  sdk = spec;
  // @ts-expect-error - SDK makes CancelledNotification.params.requestId optional,
  // whereas the 2025-06-18 spec requires it (RequestIdSchema.optional() vs requestId: RequestId).
  spec = sdk;
}
function checkLoggingLevel(
  sdk: SDKTypes.LoggingLevel,
  spec: SpecTypes.LoggingLevel
) {
  sdk = spec;
  spec = sdk;
}

// This file is .gitignore'd, and fetched by `npm run fetch:spec-types` (called by `npm run test`)
const SPEC_TYPES_FILE  = 'spec.types.ts';
const SDK_TYPES_FILE  = 'src/types.ts';

const MISSING_SDK_TYPES = [
  // These are inlined in the SDK:
  'Role',

  // These aren't supported by the SDK yet:
  'Annotations',
  'ModelHint',
  'ModelPreferences',

  // Params types (SDK inlines these into their parent schemas):
  'CallToolRequestParams',
  'CancelledNotificationParams',
  'CompleteRequestParams',
  'CreateMessageRequestParams',
  'ElicitRequestFormParams',
  'ElicitRequestParams',
  'ElicitRequestURLParams',
  'GetPromptRequestParams',
  'InitializeRequestParams',
  'LoggingMessageNotificationParams',
  'NotificationParams',
  'PaginatedRequestParams',
  'ProgressNotificationParams',
  'ReadResourceRequestParams',
  'RequestMetaObject',
  'RequestParams',
  'ResourceRequestParams',
  'ResourceUpdatedNotificationParams',
  'SetLevelRequestParams',
  'SubscribeRequestParams',
  'TaskAugmentedRequestParams',
  'UnsubscribeRequestParams',

  // Response wrapper types (SDK doesn't wrap results in response envelopes):
  'CallToolResultResponse',
  'CompleteResultResponse',
  'CreateMessageResultResponse',
  'CreateTaskResultResponse',
  'ElicitResultResponse',
  'GetPromptResultResponse',
  'GetTaskPayloadResultResponse',
  'GetTaskResultResponse',
  'CancelTaskResultResponse',
  'InitializeResultResponse',
  'JSONRPCResultResponse',
  'ListPromptsResultResponse',
  'ListResourcesResultResponse',
  'ListResourceTemplatesResultResponse',
  'ListRootsResultResponse',
  'ListTasksResultResponse',
  'ListToolsResultResponse',
  'PingResultResponse',
  'ReadResourceResultResponse',
  'SetLevelResultResponse',
  'SubscribeResultResponse',
  'UnsubscribeResultResponse',

  // Error types (SDK has ErrorCode enum + McpError class instead):
  'Error',
  'InternalError',
  'InvalidParamsError',
  'InvalidRequestError',
  'MethodNotFoundError',
  'ParseError',
  'URLElicitationRequiredError',

  // Task types (not yet supported by SDK):
  'CancelTaskRequest',
  'CancelTaskResult',
  'CreateTaskResult',
  'ElicitationCompleteNotification',
  'GetTaskPayloadRequest',
  'GetTaskPayloadResult',
  'GetTaskRequest',
  'GetTaskResult',
  'ListTasksRequest',
  'ListTasksResult',
  'RelatedTaskMetadata',
  'Task',
  'TaskMetadata',
  'TaskStatus',
  'TaskStatusNotification',
  'TaskStatusNotificationParams',

  // Enum schema subtypes (SDK has simpler EnumSchema):
  'LegacyTitledEnumSchema',
  'MultiSelectEnumSchema',
  'SingleSelectEnumSchema',
  'TitledMultiSelectEnumSchema',
  'TitledSingleSelectEnumSchema',
  'UntitledMultiSelectEnumSchema',
  'UntitledSingleSelectEnumSchema',

  // Content types not yet in SDK:
  'ToolUseContent',
  'ToolResultContent',
  'SamplingMessageContentBlock',

  // Other new spec types not yet in SDK:
  'Icon',
  'Icons',
  'JSONArray',
  'JSONObject',
  'JSONValue',
  'MetaObject',
  'ToolChoice',
  'ToolExecution',
]

function extractExportedTypes(source: string): string[] {
  return [...source.matchAll(/export\s+(?:interface|class|type)\s+(\w+)\b/g)].map(m => m[1]);
}

describe('Spec Types', () => {
  const specTypes = extractExportedTypes(fs.readFileSync(SPEC_TYPES_FILE, 'utf-8'));
  const sdkTypes = extractExportedTypes(fs.readFileSync(SDK_TYPES_FILE, 'utf-8'));
  const testSource = fs.readFileSync(__filename, 'utf-8');

  it('should define some expected types', () => {
    expect(specTypes).toContain('JSONRPCNotification');
    expect(specTypes).toContain('ElicitResult');
    expect(specTypes.length).toBeGreaterThanOrEqual(91);
  });

  it('should have up to date list of missing sdk types', () => {
    for (const typeName of MISSING_SDK_TYPES) {
      expect(sdkTypes).not.toContain(typeName);
    }
  });

  for (const type of specTypes) {
    if (MISSING_SDK_TYPES.includes(type)) {
      continue; // Skip missing SDK types
    }
    it(`${type} should have a compatibility test`, () => {
      expect(testSource).toContain(`function check${type}(`);
    });
  }
});
